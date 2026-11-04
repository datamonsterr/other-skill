#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import {
  type Skill,
  type SelectedSkill,
  type SkillSelectionResult,
  type OtherSkillOptions,
  type UsageMetrics,
  formatSkillSummary,
  formatSkillContent,
} from "./lib/model";
import { DecisionProvider, DEFAULT_DECISION_MODEL } from "./lib/provider";
import { buildDecisionInstructions } from "./lib/system_prompt";
import { compactUserPromptForDecision } from "./lib/parse_skill";
import type {
  DecisionState,
  DecisionChoiceQuestion,
  DecisionRequest,
  DecisionChoiceAnswer,
  DecisionResponse,
} from "./lib/model";
import {
  loadSkillsFromDir,
  parseSkillFile,
  parseSkillContent,
} from "./lib/parse_skill";
import { DEFAULT_SYSTEM_PROMPT } from "./lib/system_prompt";
import { loadEnvironment } from "./lib/env";
import { dirnameCompat } from "./lib/compat";

// Ensure environment variables (.env) are automatically loaded across harnesses & workspaces
loadEnvironment();

/**
 * Walk up directory tree from `startDir` to find nearest workspace skills directory.
 * Looks for `.agents/other_skills`, legacy `.agents/jev_skills`, or `skills`.
 */
export function findNearestWorkspaceSkillsDir(startDir: string): string | null {
  let curr = path.resolve(startDir);
  const root = path.parse(curr).root;

  while (curr && curr !== root) {
    const candidateOther = path.join(curr, ".agents", "other_skills");
    if (fs.existsSync(candidateOther)) return candidateOther;

    const candidateLegacy = path.join(curr, ".agents", "jev_skills");
    if (fs.existsSync(candidateLegacy)) return candidateLegacy;

    // Check if git root
    const gitDir = path.join(curr, ".git");
    if (fs.existsSync(gitDir)) {
      if (fs.existsSync(candidateOther)) return candidateOther;
      if (fs.existsSync(candidateLegacy)) return candidateLegacy;
      const skillsDir = path.join(curr, "skills");
      if (fs.existsSync(skillsDir)) return skillsDir;
      break;
    }

    curr = path.dirname(curr);
  }
  return null;
}

/**
 * Resolve all search paths for skills bank directories.
 * Precedence:
 *  1. Explicit path(s) passed directly
 *  2. Project-level nearest ancestor discovery (.agents/other_skills, legacy .agents/jev_skills)
 *     (Project skills override global EVEN WITH global SKILLS_BANK_PATH)
 *  3. Workspace-specific paths
 *  4. Environment variable overrides (OTHERSKILL_BANK_PATH, legacy SKILL_SELECTOR_BANK_PATH, SKILLS_BANK_PATH)
 *  5. Global skills bank (~/.agents/other_skills/, legacy ~/.agents/jev_skills/)
 *  6. Realpath deduplication across all resolved paths
 */
export function resolveSkillsSearchPaths(options?: {
  customPath?: string | string[];
  skillsDir?: string | string[];
  workspacePaths?: string[];
  cwd?: string;
}): string[] {
  const paths: string[] = [];
  const seenRealpaths = new Set<string>();
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const cwd = options?.cwd || process.cwd();

  const addPath = (p: string | null | undefined): boolean => {
    if (!p) return false;
    const resolved = p.startsWith("~")
      ? path.join(homeDir, p.slice(1))
      : path.resolve(cwd, p);
    if (!fs.existsSync(resolved)) return false;

    let real = resolved;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      real = resolved;
    }

    if (!seenRealpaths.has(real)) {
      seenRealpaths.add(real);
      paths.push(resolved);
      return true;
    }
    return false;
  };

  // 1. Explicit path(s) passed directly
  const explicit = options?.customPath || options?.skillsDir;
  if (explicit) {
    const list = Array.isArray(explicit) ? explicit : [explicit];
    for (const p of list) {
      addPath(p);
    }
    if (paths.length > 0) return paths;
  }

  // 2. Project-level nearest workspace ancestor discovery (Project overrides Global)
  const nearestProjectBank = findNearestWorkspaceSkillsDir(cwd);
  if (nearestProjectBank) {
    addPath(nearestProjectBank);
  }

  // 3. Workspace-specific paths
  if (options?.workspacePaths) {
    for (const ws of options.workspacePaths) {
      addPath(path.resolve(ws, ".agents", "other_skills"));
      addPath(path.resolve(ws, ".agents", "jev_skills"));
    }
  }

  // 4. Agent-specific skills path (OTHERSKILL_AGENT_SKILLS_PATH, legacy SKILL_SELECTOR_AGENT_SKILLS_PATH, AGENT_SKILLS_PATH)
  const agentEnv =
    process.env.OTHERSKILL_AGENT_SKILLS_PATH ||
    process.env.SKILL_SELECTOR_AGENT_SKILLS_PATH ||
    process.env.AGENT_SKILLS_PATH ||
    process.env.SKILLS_AGENT_DIR;
  if (agentEnv) {
    addPath(agentEnv);
  }

  addPath(path.resolve(cwd, ".agents", "other_skills"));
  addPath(path.resolve(cwd, ".agents", "jev_skills"));
  addPath(path.resolve(cwd, "skills"));
  addPath(path.resolve(dirnameCompat(import.meta), ".agents", "other_skills"));
  addPath(path.resolve(dirnameCompat(import.meta), ".agents", "jev_skills"));
  addPath(path.resolve(dirnameCompat(import.meta), "skills"));

  // 5. Environment variable overrides (OTHERSKILL_BANK_PATH, legacy SKILL_SELECTOR_BANK_PATH, SKILLS_BANK_PATH, SKILLS_DIR)
  const envPath =
    process.env.OTHERSKILL_BANK_PATH ||
    process.env.SKILL_SELECTOR_BANK_PATH ||
    process.env.SKILLS_BANK_PATH ||
    process.env.SKILLS_DIR;
  if (envPath) {
    const parts = envPath
      .split(/[:;,]/)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const p of parts) {
      addPath(p);
    }
  }

  // 6. Global skills path (default: ~/.agents/other_skills/, legacy ~/.agents/jev_skills/)
  const globalEnv =
    process.env.OTHERSKILL_GLOBAL_SKILLS_PATH ||
    process.env.SKILL_SELECTOR_GLOBAL_SKILLS_PATH ||
    process.env.GLOBAL_SKILLS_PATH ||
    process.env.SKILLS_GLOBAL_DIR;
  if (globalEnv) {
    addPath(globalEnv);
  }

  addPath(path.join(homeDir, ".agents", "other_skills"));
  addPath(path.join(homeDir, ".agents", "jev_skills"));
  addPath(path.join(homeDir, ".agents", "skills_bank"));
  addPath(path.join(homeDir, ".gemini", "config", "skills"));

  // Default fallback if none exists yet
  if (paths.length === 0) {
    paths.push(path.resolve(cwd, ".agents", "other_skills"));
  }

  return paths;
}

/**
 * Dynamically resolve the primary skills bank directory path from environment or defaults
 */
export function resolveSkillsBankPath(customPath?: string): string {
  const searchPaths = resolveSkillsSearchPaths({ customPath });
  return (
    searchPaths[0] || path.resolve(process.cwd(), ".agents", "other_skills")
  );
}

export {
  DecisionProvider,
  loadSkillsFromDir,
  parseSkillFile,
  parseSkillContent,
  formatSkillSummary,
  formatSkillContent,
  DEFAULT_SYSTEM_PROMPT,
  loadEnvironment,
};
export {
  setupClaude,
  setupCodex,
  setupAntigravity,
  setupOpenCode,
  setupAll,
  checkAgentStatus,
  runSetupCli,
} from "./scripts/setup-agent";
export { migrateSkills, DEFAULT_KEEP_SKILLS } from "./lib/migrate";
export type {
  Skill,
  SelectedSkill,
  SkillSelectionResult,
  OtherSkillOptions,
  UsageMetrics,
};

/** @deprecated Use `DecisionProvider`. */
export const JevProvider = DecisionProvider;
/** @deprecated Use `DecisionProvider`. */
export type JevProvider = DecisionProvider;
/** @deprecated Use `OtherSkillOptions`. */
export type SkillSelectorOptions = OtherSkillOptions;
/** @deprecated Use `DecisionState`. */
export type JevState = DecisionState;
/** @deprecated Use `DecisionChoiceQuestion`. */
export type JevChoiceQuestion = DecisionChoiceQuestion;
/** @deprecated Use `DecisionRequest`. */
export type JevDecisionRequest = DecisionRequest;
/** @deprecated Use `DecisionChoiceAnswer`. */
export type JevChoiceAnswer = DecisionChoiceAnswer;
/** @deprecated Use `DecisionResponse`. */
export type JevDecisionResponse = DecisionResponse;
/** @deprecated Use `DEFAULT_DECISION_MODEL`. */
export const DEFAULT_JEV_MODEL = DEFAULT_DECISION_MODEL;
/** @deprecated Use `buildDecisionInstructions`. */
export const buildJevInstructions = buildDecisionInstructions;
/** @deprecated Use `compactUserPromptForDecision`. */
export const compactUserPromptForJev = compactUserPromptForDecision;

/**
 * High-level programmatic API to select skills using the decision model
 */
export async function selectSkills(params: {
  userPrompt: string;
  systemPrompt?: string;
  skillsDir?: string | string[];
  options?: OtherSkillOptions;
}): Promise<SkillSelectionResult> {
  const { userPrompt, systemPrompt, skillsDir, options = {} } = params;
  const targetDirs = resolveSkillsSearchPaths({
    skillsDir: skillsDir || options.skillsDir,
  });

  const skills = loadSkillsFromDir(targetDirs);
  if (skills.length === 0) {
    throw new Error(`No skills found in directories: ${targetDirs.join(", ")}`);
  }

  const provider =
    options.provider ||
    new DecisionProvider({
      apiKey: options.apiKey,
      model: options.model,
      allowPaidModels: options.allowPaidModels,
      retries: options.retries,
      retryDelayMs: options.retryDelayMs,
      fetchFn: options.fetchFn,
    });

  return provider.selectSkills({
    userPrompt,
    skills,
    systemPrompt: systemPrompt || options.systemPrompt,
    options,
  });
}

function printHelp(): void {
  console.log(`
OtherSkill (otherskill)
Usage:
  otherskill "<user prompt>" [options]
  otherskill setup [agent] [options]
  otherskill migrate [options]
  otherskill --prompt "<user prompt>" --content
  otherskill --skill "<skill-name>"
  echo '{"userPrompt": "..."}' | otherskill

Commands:
  setup [agent]            Configure agent harness (claude, codex, agy, opencode, all)
  migrate                  Safely relocate optional skills to .agents/other_skills

Options:
  --prompt, -p <text>      The user prompt / task to evaluate
  --content, -c            Output full SKILL.md instructions for selected skills
  --skill, -k <name>       Fetch and print content of a specific skill directly by name
  --system, -s <text>      Optional system prompt or instructions
  --skills-dir, -d <path>  Path to skills directory (default: agent ./.agents/other_skills and global ~/.agents/other_skills)
  --threshold, -t <num>    Probability threshold (default: 0.05)
  --max-skills, -m <num>   Maximum skills to return (default: 3)
  --json                   Output results as JSON
  --help, -h               Show this help message
`);
}

/**
 * CLI Handler
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 && process.stdin.isTTY) {
    printHelp();
    process.exit(0);
  }

  // Delegate to setup command if requested
  if (args[0] === "setup") {
    const { runSetupCli } = await import("./scripts/setup-agent");
    runSetupCli(args.slice(1));
    return;
  }

  // Delegate to migrate command if requested
  if (
    args[0] === "migrate" ||
    args[0] === "migrate-skill" ||
    args[0] === "migrate-skills"
  ) {
    const { runMigrateCli } = await import("./scripts/migrate-skills");
    await runMigrateCli(args.slice(1));
    return;
  }

  let prompt = "";
  let directSkillName: string | undefined;
  let systemPrompt: string | undefined;
  let customSkillsDir: string | undefined;
  let threshold = 0.05;
  let maxSkills = 3;
  let jsonOutput = false;
  let showContent = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      printHelp();
      return;
    } else if (arg === "--prompt" || arg === "-p") {
      prompt = args[++i] || "";
    } else if (arg === "--content" || arg === "-c") {
      showContent = true;
    } else if (arg === "--skill" || arg === "-k") {
      directSkillName = args[++i];
    } else if (arg === "--system" || arg === "-s") {
      systemPrompt = args[++i];
    } else if (arg === "--skills-dir" || arg === "-d") {
      customSkillsDir = args[++i];
    } else if (arg === "--threshold" || arg === "-t") {
      threshold = parseFloat(args[++i] ?? "") || 0.05;
    } else if (arg === "--max-skills" || arg === "-m") {
      maxSkills = parseInt(args[++i] ?? "", 10) || 3;
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (!arg.startsWith("-") && !prompt) {
      prompt = arg;
    }
  }

  // Handle direct skill lookup
  if (directSkillName) {
    const searchDirs = resolveSkillsSearchPaths({ skillsDir: customSkillsDir });
    const allSkills = loadSkillsFromDir(searchDirs);
    const found = allSkills.find(
      (s) => s.name.toLowerCase() === directSkillName!.toLowerCase(),
    );
    if (!found) {
      console.error(
        `Skill "${directSkillName}" not found in search paths: ${searchDirs.join(", ")}`,
      );
      process.exit(1);
    }
    const content =
      found.path && fs.existsSync(found.path)
        ? fs.readFileSync(found.path, "utf-8")
        : found.description;
    if (jsonOutput) {
      console.log(JSON.stringify({ skill: found, content }, null, 2));
    } else {
      console.log(
        `\n### Skill: ${found.name}\n*Path: ${found.path || "embedded"}*\n\n${content}`,
      );
    }
    return;
  }

  // Handle stdin if no prompt provided via args
  if (!prompt && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    const input = Buffer.concat(chunks).toString("utf-8").trim();
    if (input) {
      try {
        const parsed = JSON.parse(input);
        prompt = parsed.userPrompt || parsed.prompt || parsed.task || input;
        if (parsed.systemPrompt) systemPrompt = parsed.systemPrompt;
        if (parsed.content || parsed.showContent) showContent = true;
      } catch {
        prompt = input;
      }
    }
  }

  if (!prompt) {
    console.error(
      "Error: No prompt provided. Provide a prompt as argument or via stdin.",
    );
    process.exit(1);
  }

  try {
    const result = await selectSkills({
      userPrompt: prompt,
      systemPrompt,
      skillsDir: customSkillsDir,
      options: { threshold, maxSkills, includeContent: showContent },
    });

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else if (showContent) {
      console.log(
        "\n" +
          formatSkillContent(result.selectedSkills, { userPrompt: prompt }),
      );
    } else {
      console.log("\n🎯 OtherSkill Selection Result");
      console.log(`Prompt: "${prompt}"`);
      console.log(`Primary Choice: ${result.primarySkill || "none"}`);
      console.log(
        `Confidence: ${result.answers?.selected_skill?.confidence ?? "N/A"}\n`,
      );

      if (result.selectedSkills.length === 0) {
        console.log("No specialized skills matched the threshold.");
      } else {
        console.log("Selected Skills:");
        for (const s of result.selectedSkills) {
          console.log(
            `  • ${s.name.padEnd(30)} Prob: ${(s.probability * 100).toFixed(1)}% | Conf: ${(s.confidence * 100).toFixed(1)}%`,
          );
          if (s.description) {
            console.log(`    ${s.description}`);
          }
        }
      }

      if (result.usage) {
        console.log("\n📊 Token Usage Breakdown:");
        console.log(`  • Total Used Tokens:    ${result.usage.total_tokens}`);
        console.log(
          `  • Input Prompt Tokens:  ${result.usage.user_prompt_tokens}`,
        );
        console.log(
          `  • System Prompt Tokens: ${result.usage.system_prompt_tokens}`,
        );
        console.log(
          `  • API Input Tokens:     ${result.usage.input_tokens} (including skills criteria)`,
        );
        console.log(`  • Output Tokens:        ${result.usage.output_tokens}`);
        if (result.usage.cost !== undefined) {
          console.log(
            `  • Estimated Cost:       $${result.usage.cost.toFixed(6)}`,
          );
        }
      }
    }
  } catch (error: any) {
    console.error(`Error selecting skills: ${error.message}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
