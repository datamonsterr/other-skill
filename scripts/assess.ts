#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseSkillContent } from "../lib/parse_skill";
import { DecisionProvider } from "../lib/provider";
import { resolveSkillsSearchPaths } from "../index";
import { DEFAULT_DECISION_MODEL } from "../lib/decision_models";

export type SkillClassification = "ALWAYS_ON" | "ROUTED";

export interface SkillAssessmentResult {
  skillName: string;
  sourcePath?: string;
  classification: SkillClassification;
  confidence: number;
  reason: string;
  recommendedDir: string;
  moved?: boolean;
  destinationPath?: string;
}

/**
 * Heuristics to quickly identify always-on universal skills (like caveman or persona modifiers)
 */
const ALWAYS_ON_PATTERNS = [
  /\bcaveman\b/i,
  /\bpersona\b/i,
  /\bterse\b/i,
  /\bconcise\s+(persona|mode|tone|reply|replies|answers?|style)\b|\b(be|talk|speak|keep)\s+concise\b/i,
  /\btone\b/i,
  /\balways\s+active\b/i,
  /\balways\s+use\b/i,
  /\balways\s+load\b/i,
  /\buniversal\b/i,
  /\bcore\s+discipline\b/i,
  /\bdiscipline\s+runner\b/i,
  /\bsuperpowers\b/i,
  /\bsystem\s+prompt\b/i,
  /\bresponse\s+style\b/i,
];

/**
 * Heuristics to identify task-specific / domain-specific skills suitable for decision routing
 */
const ROUTED_PATTERNS = [
  /\bwhen\s+to\s+use\b/i,
  /\btrigger\s+with\b/i,
  /\buse\s+when\b/i,
  /\b(react|next\.?js|vue|svelte|angular|tailwind|typescript|python|rust|golang|lua)\b/i,
  /\b(docker|kubernetes|k8s|ansible|git|github|gitlab|argo|supabase|vercel|database|sql|postgres)\b/i,
  /\b(testing|tdd|e2e|playwright|jest|pytest|benchmark|coverage|debugging|triage)\b/i,
  /\b(api\s+design|diagram|plantuml|mermaid|draw\.?io|srs|prd|user\s+story|use\s+case)\b/i,
];

/**
 * Perform quick classification of a skill into ALWAYS_ON vs ROUTED
 */
export async function assessSkill(params: {
  skillPathOrName: string;
  useDecisionModel?: boolean;
  /** @deprecated Use `useDecisionModel`. */
  useJevModel?: boolean;
  global?: boolean;
  cwd?: string;
}): Promise<SkillAssessmentResult> {
  const cwd = params.cwd || process.cwd();
  const homeDir = os.homedir();
  let resolvedPath = "";
  let skillName = "";
  let content = "";

  // 1. Locate the skill folder or file
  const candidate = path.resolve(cwd, params.skillPathOrName);
  if (fs.existsSync(candidate)) {
    if (fs.statSync(candidate).isDirectory()) {
      resolvedPath = candidate;
      const skillMd = path.join(candidate, "SKILL.md");
      if (fs.existsSync(skillMd)) {
        content = fs.readFileSync(skillMd, "utf-8");
      }
      skillName = path.basename(candidate);
    } else {
      resolvedPath = path.dirname(candidate);
      content = fs.readFileSync(candidate, "utf-8");
      skillName = path.basename(resolvedPath);
    }
  } else {
    // Search in skills directories
    const searchDirs = resolveSkillsSearchPaths({ cwd });
    for (const dir of searchDirs) {
      const p = path.join(dir, params.skillPathOrName);
      if (fs.existsSync(p)) {
        resolvedPath = p;
        skillName = params.skillPathOrName;
        const skillMd = path.join(p, "SKILL.md");
        if (fs.existsSync(skillMd)) {
          content = fs.readFileSync(skillMd, "utf-8");
        }
        break;
      }
    }
  }

  if (!resolvedPath && !content) {
    throw new Error(
      `Skill "${params.skillPathOrName}" not found on filesystem.`,
    );
  }

  const parsed = parseSkillContent(
    content,
    skillName,
    resolvedPath ? path.join(resolvedPath, "SKILL.md") : undefined,
  );
  skillName = parsed.name || skillName;

  const combinedText = `${skillName}\n${parsed.description}\n${parsed.whenToUse}\n${content.slice(0, 1000)}`;

  // 2. Run heuristics
  let classification: SkillClassification = "ROUTED";
  let confidence = 0.85;
  let reason = "";

  const alwaysMatch = ALWAYS_ON_PATTERNS.find((pat) => pat.test(combinedText));
  const routedMatch = ROUTED_PATTERNS.find((pat) => pat.test(combinedText));

  if (alwaysMatch && !routedMatch) {
    classification = "ALWAYS_ON";
    confidence = 0.95;
    reason = `Matches always-on behavioral pattern (${alwaysMatch.source}). Universal tone/guideline to load with LLM by default.`;
  } else if (alwaysMatch && routedMatch) {
    // Ambiguous: check if name matches caveman or persona explicitly
    if (/caveman|persona|tone|terse/i.test(skillName)) {
      classification = "ALWAYS_ON";
      confidence = 0.9;
      reason = `Skill "${skillName}" modifies universal model demeanor/personality across all prompts.`;
    } else {
      classification = "ROUTED";
      confidence = 0.8;
      reason = `Contains specific tool/domain workflows (${routedMatch.source}). Best routed on-demand by OtherSkill to preserve context.`;
    }
  } else {
    classification = "ROUTED";
    confidence = 0.92;
    reason = `Task-specific or tool-specific capability. Suitable for dynamic on-demand selection via OtherSkill.`;
  }

  // 3. Optional: Use decision model if requested and API key present
  if (
    (params.useDecisionModel ?? params.useJevModel) &&
    (process.env.OPENROUTER_API_KEY || process.env.JEV_API_KEY)
  ) {
    try {
      const provider = new DecisionProvider();
      const response = await provider.sendDecisionRequest({
        model: process.env.MODEL || DEFAULT_DECISION_MODEL,
        state: {
          skill_name: skillName,
          description: parsed.description,
          when_to_use: parsed.whenToUse,
          sample_body: content.slice(0, 500),
        },
        questions: {
          placement: {
            type: "choice",
            instructions:
              "Determine if this skill should be ALWAYS loaded directly with LLM (universal persona/tone like caveman) or ROUTED (optional task-specific skill loaded dynamically).",
            criteria: {
              ALWAYS_ON:
                "Universal persona, terse style modifier like caveman, or core behavioral guideline loaded on every prompt",
              ROUTED:
                "Task-specific, domain-specific, tool-specific, or language-specific skill loaded dynamically only when needed",
            },
          },
        },
      });

      const ans = response.answers?.placement;
      if (ans && (ans.choice === "ALWAYS_ON" || ans.choice === "ROUTED")) {
        classification = ans.choice as SkillClassification;
        confidence = ans.confidence ?? confidence;
        reason = `Decision model classified this skill as ${classification} (confidence: ${(confidence * 100).toFixed(0)}%).`;
      }
    } catch {
      // Fallback to heuristic decision
    }
  }

  // 4. Determine recommended destination directory
  let recommendedDir = "";
  if (classification === "ALWAYS_ON") {
    // Normal skills folder
    recommendedDir = params.global
      ? path.join(homeDir, ".agents", "skills", skillName)
      : path.join(cwd, ".agents", "skills", skillName);
  } else {
    // Routed skills bank
    recommendedDir = params.global
      ? path.join(homeDir, ".agents", "other_skills", skillName)
      : path.join(cwd, ".agents", "other_skills", skillName);
  }

  return {
    skillName,
    sourcePath: resolvedPath,
    classification,
    confidence,
    reason,
    recommendedDir,
  };
}

/**
 * Move skill folder to target destination
 */
export function moveSkill(sourcePath: string, targetDir: string): boolean {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source path "${sourcePath}" does not exist.`);
  }

  const targetParent = path.dirname(targetDir);
  if (!fs.existsSync(targetParent)) {
    fs.mkdirSync(targetParent, { recursive: true });
  }

  // If already at destination
  if (path.resolve(sourcePath) === path.resolve(targetDir)) {
    return false;
  }

  // Copy then remove to support cross-device moves safely
  if (fs.statSync(sourcePath).isDirectory()) {
    fs.cpSync(sourcePath, targetDir, { recursive: true });
    fs.rmSync(sourcePath, { recursive: true, force: true });
  } else {
    fs.copyFileSync(sourcePath, targetDir);
    fs.unlinkSync(sourcePath);
  }

  return true;
}

// CLI Execution
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
OtherSkill Placement Assessor (assess.ts)
Classifies skills into:
  1. ALWAYS_ON: Universal persona/tone modifiers (e.g. caveman) loaded directly with LLM.
  2. ROUTED: Task-specific skills routed dynamically on-demand via OtherSkill.

Usage:
  bun run scripts/assess.ts <skill-path-or-name> [options]

Options:
  --move, -m     Automatically move the skill to the recommended folder
  --global, -g   Target global (~/.agents/) instead of project-local (./.agents/)
  --decision-model    Use decision model on OpenRouter for classification
  --json         Output results as JSON
  --help, -h     Show this help message
`);
    process.exit(0);
  }

  let skillArg = "";
  let shouldMove = false;
  let isGlobal = false;
  let useDecisionModel = false;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--move" || arg === "-m") shouldMove = true;
    else if (arg === "--global" || arg === "-g") isGlobal = true;
    else if (arg === "--decision-model" || arg === "--jev-model")
      useDecisionModel = true; // --jev-model is a deprecated alias
    else if (arg === "--json") jsonOutput = true;
    else if (!arg.startsWith("-") && !skillArg) skillArg = arg;
  }

  if (!skillArg) {
    console.error("Error: Please provide a skill name or path.");
    process.exit(1);
  }

  assessSkill({
    skillPathOrName: skillArg,
    useDecisionModel,
    global: isGlobal,
  })
    .then((res) => {
      if (
        shouldMove &&
        res.sourcePath &&
        res.sourcePath !== res.recommendedDir
      ) {
        moveSkill(res.sourcePath, res.recommendedDir);
        res.moved = true;
        res.destinationPath = res.recommendedDir;
      }

      if (jsonOutput) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log("\n🔍 Skill Placement Assessment");
        console.log(`Skill:          ${res.skillName}`);
        console.log(`Source:         ${res.sourcePath || "N/A"}`);
        console.log(
          `Classification: ${res.classification === "ALWAYS_ON" ? "🟢 ALWAYS_ON (Normal Skill)" : "🎯 ROUTED (OtherSkill Bank)"}`,
        );
        console.log(`Confidence:     ${(res.confidence * 100).toFixed(0)}%`);
        console.log(`Reason:         ${res.reason}`);
        console.log(`Recommended:    ${res.recommendedDir}`);
        if (res.moved) {
          console.log(
            `\n✓ Successfully moved skill to: ${res.destinationPath}`,
          );
        } else if (shouldMove) {
          console.log(`\n• Skill is already in the recommended directory.`);
        }
      }
    })
    .catch((err) => {
      console.error(`Assessment error: ${err.message}`);
      process.exit(1);
    });
}
