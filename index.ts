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

/**
 * Core logic to select relevant skills from a list of candidates.
 * Shared by the bootstrap hook and the manual tool.
 */
async function selectRelevantSkills(api: any, query: string, candidateSkills: string[]): Promise<{
    selected: string[],
    strategies: { exemptions: string[], hardMatches: string[], semanticMatches: string[] }
}> {
    const qLower = query.toLowerCase();

    // 1. Exemptions (Must Keep)
    // Read from plugin config or use defaults
    const configExemptions = (api.pluginConfig?.exemptions as string[]) || ["zesty-*", "qmd"];
    const exemptions = candidateSkills.filter(s => isExempt(s, configExemptions));

    // 2. Hard Keyword Matches
    // Rule: Skill name is explicitly mentioned in the query string.
    const hardMatches = candidateSkills.filter(s => {
        if (exemptions.includes(s)) return false;
        return qLower.includes(s.toLowerCase());
    });

    // 3. Semantic Search (LLM-based)
    // Ask the configured routerModel to pick the best skills.
    const routerModel = api.pluginConfig?.routerModel || "github-copilot/gpt-5-mini";
    const alreadySelected = new Set([...exemptions, ...hardMatches]);
    const potentialSemantic = candidateSkills.filter(s => !alreadySelected.has(s));
    
    let semanticMatches: string[] = [];

    // Only run LLM check if we have potential candidates and LLM capability
    if (potentialSemantic.length > 0 && api.runtime?.llm?.generateText) {
        try {
            const prompt = `
You are a smart skill dispatcher for an AI agent.
User Query: "${query}"

Available Skills:
${JSON.stringify(potentialSemantic)}

Task:
Select the skills from the list above that are highly relevant to handling the user's query.
Return ONLY a JSON array of strings (e.g. ["skill-a", "skill-b"]). 
If none are relevant, return [].
Do not explain.
`.trim();

            const response = await api.runtime.llm.generateText({
                model: routerModel,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.1
            });

            const text = response.text || response.content || "";
            // Robust JSON extraction
            const jsonMatch = text.match(/\[.*\]/s);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (Array.isArray(parsed)) {
                    semanticMatches = parsed;
                }
            } else {
                 api.logger.warn("[zesty-dispatcher] LLM response did not contain JSON array.");
            }
        } catch (err: any) {
            api.logger.warn(`[zesty-dispatcher] LLM dispatch check failed: ${err.message}`);
        }
    }

    // Verify semantic matches exist in candidates (hallucination check)
    semanticMatches = semanticMatches.filter(s => candidateSkills.includes(s));

    const finalSet = new Set([...exemptions, ...hardMatches, ...semanticMatches]);

    return {
        selected: Array.from(finalSet),
        strategies: {
            exemptions,
            hardMatches,
            semanticMatches
        }
    };
}

const zestyDispatcherPlugin = {
  id: "zesty-dispatcher",
  name: "Zesty Dispatcher",
  description: "Dynamically dispatches relevant skills based on user query to reduce context bloat.",
  
  register(api: any) {
    api.logger.info("[zesty-dispatcher] Plugin loading...");

    // --------------------------------------------------------------------------------
    // HOOK: agent:bootstrap
    // Automatically filters skills for every turn based on the last user message.
    // --------------------------------------------------------------------------------
    api.registerHook("agent:bootstrap", async (event: any) => {
        try {
            const { sessionEntry, bootstrapFiles } = event.context;

            // 1. Extract Query from History
            // We look for the last message from the user to determine intent.
            const history = sessionEntry || [];
            const lastUserMsg = [...history].reverse().find((m: any) => m.role === 'user');
            const query = lastUserMsg ? lastUserMsg.content : '';

            if (!query) {
                // No user query found (e.g., system init), skip filtering to be safe.
                return;
            }

            // 2. Identify Candidates from bootstrapFiles
            // We map file paths to skill names to create a list of candidates.
            const skillMap = new Map<string, any[]>();
            const nonSkillFiles: any[] = [];
            const candidateSkills: string[] = [];

            for (const file of bootstrapFiles) {
                const filePath = file.path || (typeof file === 'string' ? file : '');
                
                // Heuristic: Check for /skills/<skillName>/ structure
                const match = filePath.match(/[\\/]skills[\\/]([^\\/]+)/);
                if (match) {
                    const skillName = match[1];
                    if (!skillMap.has(skillName)) {
                        skillMap.set(skillName, []);
                        candidateSkills.push(skillName);
                    }
                    skillMap.get(skillName)?.push(file);
                } else {
                    // Keep non-skill files (system prompts, memory, etc.)
                    nonSkillFiles.push(file);
                }
            }

            if (candidateSkills.length === 0) return;

            // 3. Execute Selection Logic
            const { selected, strategies } = await selectRelevantSkills(api, query, candidateSkills);

            // 4. Update bootstrapFiles (In-Place Modification)
            // We rebuild the list with only the selected skills + non-skill files.
            const keptFiles = [...nonSkillFiles];
            for (const skill of selected) {
                const files = skillMap.get(skill);
                if (files) keptFiles.push(...files);
            }

            const removedCount = bootstrapFiles.length - keptFiles.length;
            
            // Apply changes to the referenced array
            bootstrapFiles.length = 0;
            bootstrapFiles.push(...keptFiles);

            if (removedCount > 0) {
                api.logger.info(`[zesty-dispatcher] Auto-filter: "${query.substring(0, 30)}..." -> Kept ${selected.length} skills, Removed ${removedCount} files.`);
            }

        } catch (error: any) {
            api.logger.error(`[zesty-dispatcher] Bootstrap hook error: ${error.message}`);
        }
    }, { name: "zesty-dispatcher-bootstrap" });

    // --------------------------------------------------------------------------------
    // TOOL: dispatch_skills
    // Manual trigger for debugging or explicit use.
    // Default disabled to reduce clutter; enable in config.
    // --------------------------------------------------------------------------------
    if (api.pluginConfig?.enableTool) {
        api.registerTool({
          name: "dispatch_skills",
          label: "Dispatch Skills",
          description: "Analyze the user's request and recommend the most relevant skills to load.",
          parameters: DispatchSkillsSchema,
          execute: async (_toolCallId: string, params: { query: string }) => {
            const { query } = params;
            
            try {
              // 1. Scan skills directory to get ALL candidates (since we are not in bootstrap context)
              const skillsDir = path.join(os.homedir(), ".openclaw", "skills");
              let entries;
              try {
                entries = await fs.readdir(skillsDir, { withFileTypes: true });
              } catch (err) {
                 return { content: [{ type: "text", text: "Error: Could not access skills directory." }] };
              }
    
              const allSkills = entries
                .filter(e => e.isDirectory() && !e.name.startsWith("."))
                .map(e => e.name);
    
              // 2. Run Logic
              const { selected, strategies } = await selectRelevantSkills(api, query, allSkills);
    
              return {
                content: [{ 
                  type: "text", 
                  text: JSON.stringify({
                    query,
                    strategies,
                    recommended_skills: selected,
                    count: selected.length
                  }, null, 2)
                }]
              };
    
            } catch (error: any) {
              api.logger.error(`[zesty-dispatcher] Tool Error: ${error.message}`);
              return {
                content: [{ type: "text", text: `Error processing dispatch: ${error.message}` }]
              };
            }
          }
        });
        api.logger.info("[zesty-dispatcher] Tool 'dispatch_skills' registered.");
    } else {
        api.logger.debug("[zesty-dispatcher] Tool 'dispatch_skills' disabled by config.");
    }

    api.logger.info("[zesty-dispatcher] Plugin loaded.");
  }
};

export default zestyDispatcherPlugin;
