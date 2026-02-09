import { Type } from "@sinclair/typebox";
import * as fs from "fs/promises";
import * as path from "path";

// Define the tool schema
const DispatchSkillsSchema = Type.Object({
  query: Type.String({ description: "The user's original query or intent." }),
});

interface SkillMetadata {
    name: string;
    description: string;
}

/**
 * Robustly parses the YAML-like frontmatter of a SKILL.md file.
 */
function parseSkillMetadata(content: string): SkillMetadata {
    const meta: SkillMetadata = { name: "", description: "" };
    // More lenient regex: don't anchor to start of string, handle potential BOM/spaces
    const frontmatterMatch = content.match(/---\s*([\s\S]*?)\s*---/);
    
    if (frontmatterMatch) {
        const lines = frontmatterMatch[1].split(/\r?\n/);
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine || trimmedLine === "---") continue;

            const colonIndex = trimmedLine.indexOf(":");
            if (colonIndex !== -1) {
                const key = trimmedLine.slice(0, colonIndex).trim().toLowerCase();
                let value = trimmedLine.slice(colonIndex + 1).trim();
                
                // Remove optional surrounding quotes (common in generated YAML)
                if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1).trim();
                }
                
                if (key === "name") meta.name = value;
                if (key === "description") meta.description = value;
            }
        }
    }
    return meta;
}

/**
 * Check if a skill name matches any exemption pattern.
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
 * Core Logic: Weighted Skill Selection
 */
async function selectRelevantSkills(api: any, query: string, skillFiles: Map<string, string>): Promise<{
    selected: string[],
    scores: Record<string, number>,
    breakdown: Record<string, string[]>
}> {
    const qLower = query.toLowerCase();
    const candidateNames = Array.from(skillFiles.keys());
    const scores: Record<string, number> = {};
    const breakdown: Record<string, string[]> = {};
    const selected: string[] = [];

    // 1. Exemptions (Priority 0: Direct Pass)
    const configExemptions = (api.pluginConfig?.exemptions as string[]) || ["zesty-*", "qmd"];
    const exemptions = candidateNames.filter(s => isExempt(s, configExemptions));
    for (const s of exemptions) {
        selected.push(s);
        scores[s] = 999;
        breakdown[s] = ["Exemption"];
    }

    // Prepare non-exempt candidates
    const nonExempt = candidateNames.filter(s => !exemptions.includes(s));
    
    // 2. LLM Semantic Recommendation (Pre-calculate for batching)
    let llmRecommended: string[] = [];
    const routerModel = api.pluginConfig?.routerModel || "github-copilot/gpt-5-mini";
    
    if (nonExempt.length > 0 && api.runtime?.llm?.generateText) {
        try {
            const prompt = `Select highly relevant skills for: "${query}" from: ${JSON.stringify(nonExempt)}. Return JSON array only.`;
            const response = await api.runtime.llm.generateText({
                model: routerModel,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.1
            });
            const text = response.text || response.content || "";
            const jsonMatch = text.match(/\[.*\]/s);
            if (jsonMatch) llmRecommended = JSON.parse(jsonMatch[0]);
        } catch (e) { api.logger.warn(`[zesty-dispatcher] LLM fail: ${e.message}`); }
    }

    // 3. Detailed Scoring Loop
    for (const skillName of nonExempt) {
        let score = 0;
        const reasons: string[] = [];

        // Exact Name Match (60 pts) - Now using Whole Word Match
        const nameRegex = new RegExp(`\\b${skillName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (nameRegex.test(qLower)) {
            score += 60;
            reasons.push("Name Match (+60)");
        }

        // LLM Recommendation (60 pts)
        if (llmRecommended.includes(skillName)) {
            score += 60;
            reasons.push("LLM Recommended (+60)");
        }

        // Description Keyword Match (Max 30 pts) - Now based on keyword density
        const skillPath = skillFiles.get(skillName);
        if (skillPath) {
            try {
                const handle = await fs.open(skillPath, 'r');
                const { buffer } = await handle.read({ buffer: Buffer.alloc(1024), length: 1024 });
                await handle.close();
                
                const meta = parseSkillMetadata(buffer.toString());
                const desc = meta.description.toLowerCase();
                
                const keywords = qLower.split(/\s+/).filter(w => w.length > 2);
                const matchedKeywords = keywords.filter(k => {
                    const kRegex = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                    return kRegex.test(desc);
                });

                if (matchedKeywords.length > 0) {
                    const descScore = Math.min(30, matchedKeywords.length * 10);
                    score += descScore;
                    reasons.push(`Desc Keywords: ${matchedKeywords.join(", ")} (+${descScore})`);
                }
            } catch (e) { /* ignore */ }
        }

        scores[skillName] = score;
        breakdown[skillName] = reasons;

        // 4. Threshold Filter (60 pts)
        if (score >= 60) {
            selected.push(skillName);
        }
    }

    return { selected, scores, breakdown };
}

const zestyDispatcherPlugin = {
  id: "zesty-dispatcher",
  name: "Zesty Dispatcher",
  description: "Weighted skill dispatcher using Name, Description, and LLM signals.",
  
  register(api: any) {
    api.registerHook("agent:bootstrap", async (event: any) => {
        try {
            const { sessionEntry, bootstrapFiles } = event.context;
            const lastUserMsg = [...(sessionEntry || [])].reverse().find((m: any) => m.role === 'user');
            const query = lastUserMsg ? lastUserMsg.content : '';
            if (!query) return;

            const skillPaths = new Map<string, string>();
            const nonSkillFiles: any[] = [];

            for (const file of bootstrapFiles) {
                const filePath = file.path || (typeof file === 'string' ? file : '');
                const match = filePath.match(/[\\/]skills[\\/]([^\\/]+)/);
                if (match) {
                    const skillName = match[1];
                    if (filePath.endsWith("SKILL.md")) {
                        skillPaths.set(skillName, filePath);
                    }
                } else {
                    nonSkillFiles.push(file);
                }
            }

            // Identify all skill names from the files provided
            const allSkillNames = Array.from(new Set(
                bootstrapFiles
                    .map((f: any) => (f.path || f).match(/[\\/]skills[\\/]([^\\/]+)/)?.[1])
                    .filter(Boolean)
            )) as string[];

            const { selected, scores, breakdown } = await selectRelevantSkills(api, query, skillPaths);

            const keptFiles = [...nonSkillFiles];
            for (const file of bootstrapFiles) {
                const filePath = file.path || file;
                const skillMatch = filePath.match(/[\\/]skills[\\/]([^\\/]+)/);
                if (skillMatch && selected.includes(skillMatch[1])) {
                    keptFiles.push(file);
                }
            }

            bootstrapFiles.length = 0;
            bootstrapFiles.push(...keptFiles);

            if (selected.length > 0) {
                bootstrapFiles.push({
                    path: "zesty-dispatcher-report.md",
                    content: `\n\n[Zesty Dispatcher] Active Skills (Threshold 60): ${selected.join(", ")}.\n`
                });
            }
        } catch (error: any) {
            api.logger.error(`[zesty-dispatcher] Error: ${error.message}`);
        }
    });

    if (api.pluginConfig?.enableTool) {
        api.registerTool({
          name: "dispatch_skills",
          parameters: DispatchSkillsSchema,
          execute: async (_id: string, params: { query: string }) => {
            // Tool implementation would be similar but needs to scan disk manually
            return { content: [{ type: "text", text: "Tool updated to use new weighted logic." }] };
          }
        });
    }
  }
};

export default zestyDispatcherPlugin;
