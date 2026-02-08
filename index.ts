import { Type } from "@sinclair/typebox";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// Define the tool schema
const DispatchSkillsSchema = Type.Object({
  query: Type.String({ description: "The user's original query or intent." }),
});

/**
 * Check if a skill name matches any exemption pattern.
 * Supports exact match and prefix wildcard (e.g. "zesty-*").
 */
function isExempt(skillName: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      return skillName.startsWith(prefix);
    }
    return skillName === pattern;
  });
}

const zestyDispatcherPlugin = {
  id: "zesty-dispatcher",
  name: "Zesty Dispatcher",
  description: "Dynamically dispatches relevant skills based on user query to reduce context bloat.",
  
  register(api: any) {
    api.logger.info("[zesty-dispatcher] Plugin loading...");

    // --------------------------------------------------------------------------------
    // TODO: HOOK INTEGRATION
    // --------------------------------------------------------------------------------
    // In future OpenClaw SDK versions, we should hook directly into message processing.
    // Ideally:
    // 
    // api.registerHook("message:received", async (event) => {
    //   const { query } = event;
    //   const result = await dispatchLogic(query, api);
    //   // Automatically load skills here or attach suggestion to context
    // });
    //
    // For now, we expose this as a tool (`dispatch_skills`) that the Agent can call manually.
    // --------------------------------------------------------------------------------

    api.registerTool({
      name: "dispatch_skills",
      label: "Dispatch Skills",
      description: "Analyze the user's request and recommend the most relevant skills to load.",
      parameters: DispatchSkillsSchema,
      execute: async (_toolCallId: string, params: { query: string }) => {
        const { query } = params;
        const qLower = query.toLowerCase();
        
        try {
          // 1. Scan skills directory
          const skillsDir = path.join(os.homedir(), ".openclaw", "skills");
          
          let entries;
          try {
            entries = await fs.readdir(skillsDir, { withFileTypes: true });
          } catch (err) {
            api.logger.error(`[zesty-dispatcher] Failed to read skills dir: ${err}`);
            return {
              content: [{ type: "text", text: "Error: Could not access skills directory." }]
            };
          }

          const allSkills = entries
            .filter(e => e.isDirectory() && !e.name.startsWith("."))
            .map(e => e.name);

          // --- Strategy 1: Exemptions (Must Keep) ---
          // Load exemptions from config or use default
          const configExemptions = (api.pluginConfig?.exemptions as string[]) || ["zesty-*", "qmd"];
          const exemptions = allSkills.filter(s => isExempt(s, configExemptions));

          // --- Strategy 2: Hard Keyword Matches ---
          // Rules: Skill name is explicitly mentioned in the query string.
          const hardMatches = allSkills.filter(s => {
             // Skip if already exempted to keep categories clean
             if (exemptions.includes(s)) return false;
             return qLower.includes(s.toLowerCase());
          });

          // --- Strategy 3: Semantic Search (LLM-based) ---
          // Rules: Ask the configured routerModel to pick the best skills.
          
          const routerModel = api.pluginConfig?.routerModel || "github-copilot/gpt-5-mini";
          const alreadySelected = new Set([...exemptions, ...hardMatches]);
          const candidateSkills = allSkills.filter(s => !alreadySelected.has(s));

          let semanticMatches: string[] = [];
          
          if (candidateSkills.length > 0) {
            try {
              if (api.runtime?.llm?.generateText) {
                const prompt = `
You are a smart skill dispatcher for an AI agent.
User Query: "${query}"

Available Skills:
${JSON.stringify(candidateSkills)}

Task:
Select the top 3-5 skills from the list above that are most relevant to handling the user's query.
Return ONLY a JSON array of strings (e.g. ["skill-a", "skill-b"]). Do not explain. If none are relevant, return [].
                `.trim();

                const response = await api.runtime.llm.generateText({
                  model: routerModel,
                  messages: [{ role: "user", content: prompt }],
                  temperature: 0.1
                });

                const text = response.text || response.content || ""; // Adjust based on actual API shape
                // Extract JSON from response
                const jsonMatch = text.match(/\[.*\]/s);
                if (jsonMatch) {
                    semanticMatches = JSON.parse(jsonMatch[0]);
                } else {
                    api.logger.warn("[zesty-dispatcher] LLM response did not contain JSON array.");
                }
              } else {
                 api.logger.warn("[zesty-dispatcher] api.runtime.llm.generateText not available. Skipping semantic check.");
              }
            } catch (llmErr: any) {
               api.logger.error(`[zesty-dispatcher] LLM Dispatch failed: ${llmErr.message}`);
               // Fallback to empty semantic matches
            }
          }

          // --- Union & De-duplication ---
          const finalSet = new Set([
              ...exemptions,
              ...hardMatches,
              ...semanticMatches
          ]);
          
          // Verify existence (in case LLM hallucinated a name)
          const validSkills = Array.from(finalSet).filter(s => allSkills.includes(s));

          return {
            content: [{ 
              type: "text", 
              text: JSON.stringify({
                query,
                strategies: {
                    exempted: exemptions,
                    hard_matched: hardMatches,
                    semantic_matched: semanticMatches
                },
                recommended_skills: validSkills,
                count: validSkills.length
              }, null, 2)
            }]
          };

        } catch (error: any) {
          api.logger.error(`[zesty-dispatcher] Error: ${error.message}`);
          return {
            content: [{ type: "text", text: `Error processing dispatch: ${error.message}` }]
          };
        }
      }
    });

    api.logger.info("[zesty-dispatcher] Tool 'dispatch_skills' registered.");
  }
};

export default zestyDispatcherPlugin;
