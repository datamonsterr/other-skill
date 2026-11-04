/**
 * Representation of a skill loaded from a skill bank
 */
export interface Skill {
  name: string;
  description: string;
  whenToUse: string;
  path?: string;
}

/**
 * State object sent to the decision model
 */
export interface DecisionState {
  user_prompt: string;
  system_prompt?: string;
  skills: Array<{
    name: string;
    description: string;
    when_to_use: string;
  }>;
  context?: Record<string, any>;
}

/**
 * Choice question schema
 */
export interface DecisionChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

/**
 * Decisions request payload for OpenRouter alpha decisions API
 */
export interface DecisionRequest {
  model: string;
  state: DecisionState | Record<string, any> | string;
  questions: Record<string, DecisionChoiceQuestion>;
}

/**
 * Answer for a Choice question from the decision model
 */
export interface DecisionChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

/**
 * Full response from the OpenRouter decisions API
 */
export interface DecisionResponse {
  model: string;
  answers: Record<string, DecisionChoiceAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cost?: number;
  };
  id?: string;
  provider?: string;
}

/**
 * A selected skill with calibrated confidence and probability
 */
export interface SelectedSkill {
  name: string;
  confidence: number;
  probability: number;
  description?: string;
  whenToUse?: string;
  path?: string;
  content?: string;
}

/**
 * Token usage breakdown
 */
export interface UsageMetrics {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  user_prompt_tokens: number;
  system_prompt_tokens: number;
  cost?: number;
}

/**
 * High-level result of skill selection
 */
export interface SkillSelectionResult {
  selectedSkills: SelectedSkill[];
  primarySkill: string | null;
  answers: Record<string, DecisionChoiceAnswer>;
  usage?: UsageMetrics;
  raw?: DecisionResponse;
  source?: "model" | "local_fallback" | "unavailable" | string;
  metadata?: {
    source?: string;
    model?: string;
    error?: string;
    [key: string]: any;
  };
}

/**
 * Options for configuring skill selection
 */
export interface OtherSkillOptions {
  model?: string;
  /** Opt in to paid decision models (also OTHERSKILL_ALLOW_PAID_MODELS=1). */
  allowPaidModels?: boolean;
  apiKey?: string;
  threshold?: number;
  maxSkills?: number;
  skillsDir?: string | string[];
  systemPrompt?: string;
  includeNone?: boolean;
  retries?: number;
  retryDelayMs?: number;
  multiStep?: boolean | "auto";
  includeContent?: boolean;
  fetchFn?: typeof fetch;
  provider?: any;
}

/**
 * Filter and sort selected skills from a choice answer based on probability threshold
 */
export function filterSelectedSkills(params: {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  threshold?: number;
  maxSkills?: number;
  skillMap?: Map<string, Skill>;
}): SelectedSkill[] {
  const {
    choice,
    probabilities,
    confidence,
    threshold = 0.05,
    maxSkills = 3,
    skillMap,
  } = params;

  // Filter out 'none'
  const items: SelectedSkill[] = Object.entries(probabilities)
    .filter(([name, prob]) => name !== "none" && prob >= threshold)
    .map(([name, prob]) => {
      const skill = skillMap?.get(name);
      return {
        name,
        probability: Number(prob.toFixed(4)),
        confidence: Number(confidence.toFixed(4)),
        description: skill?.description,
        whenToUse: skill?.whenToUse,
        path: skill?.path,
      };
    })
    .sort((a, b) => b.probability - a.probability);

  // If the winning choice was not "none", ensure it is at the front even if probabilities were close
  if (choice && choice !== "none") {
    const winningIdx = items.findIndex((i) => i.name === choice);
    if (winningIdx > 0) {
      const [winningItem] = items.splice(winningIdx, 1);
      if (winningItem) items.unshift(winningItem);
    } else if (winningIdx === -1 && probabilities[choice] !== undefined) {
      const skill = skillMap?.get(choice);
      items.unshift({
        name: choice,
        probability: Number(probabilities[choice].toFixed(4)),
        confidence: Number(confidence.toFixed(4)),
        description: skill?.description,
        whenToUse: skill?.whenToUse,
        path: skill?.path,
      });
    }
  }

  return items.slice(0, maxSkills);
}

/**
 * Format selected skills into clean, concise summary suitable for hook injection.
 * Defaults to concise selected names, original accessible paths, and load instructions without repeating full prompt.
 */
export function formatSkillSummary(skills: SelectedSkill[]): string {
  if (skills.length === 0) {
    return "No specialized skills required for this request.";
  }

  const lines = [
    "🎯 **[OtherSkill]**",
    "The following specialized skill(s) have been selected for this task:",
    "",
  ];

  for (const skill of skills) {
    const conf = (skill.confidence * 100).toFixed(0);
    const prob = (skill.probability * 100).toFixed(0);
    lines.push(
      `• **${skill.name}** (Confidence: ${conf}%, Probability: ${prob}%)`,
    );
    if (skill.path) {
      lines.push(`  - Path: \`${skill.path}\``);
    }
    if (skill.whenToUse) {
      lines.push(`  - When to use: ${skill.whenToUse}`);
    } else if (skill.description) {
      lines.push(`  - Description: ${skill.description}`);
    }
  }

  lines.push("");
  lines.push(
    "*Load instructions:* To inspect and follow a selected skill, view its `SKILL.md` from the path above.",
  );

  return lines.join("\n");
}

/**
 * Format selected skills with full SKILL.md contents included.
 * Designed for hook injections when explicit content is requested (--content).
 * Does not silently truncate mandatory skill instructions.
 */
export function formatSkillContent(
  skills: SelectedSkill[],
  _options?: { userPrompt?: string },
): string {
  if (skills.length === 0) {
    return "No specialized skills required for this request.";
  }

  const lines: string[] = [
    "### Recommended Agent Skills",
    "🎯 **[OtherSkill]**",
    "The following specialized skills have been selected:",
    "",
  ];

  for (const skill of skills) {
    const prob = (skill.probability * 100).toFixed(1);
    const conf = (skill.confidence * 100).toFixed(0);
    lines.push(
      `• **${skill.name}** (Probability: ${prob}% | Confidence: ${conf}%)`,
    );
    if (skill.path) {
      lines.push(`  - Path: \`${skill.path}\``);
    }
    if (skill.description) {
      lines.push(`  - Description: ${skill.description}`);
    }
  }

  lines.push("", "---", "");

  for (const skill of skills) {
    lines.push(`## Skill: ${skill.name}`);
    if (skill.path) {
      lines.push(`*Location: \`${skill.path}\`*`, "");
    }

    let content = skill.content;
    if (!content && skill.path) {
      try {
        const fs = require("node:fs");
        if (fs.existsSync(skill.path)) {
          content = fs.readFileSync(skill.path, "utf-8");
        }
      } catch {
        // Fallback
      }
    }

    if (content) {
      lines.push(content.trim());
    } else {
      lines.push(`### Description`);
      lines.push(skill.description || skill.name);
      if (skill.whenToUse && skill.whenToUse !== skill.description) {
        lines.push("", `### When to Use`, skill.whenToUse);
      }
    }

    lines.push("", "---", "");
  }

  lines.push(
    "*Instruction:* Apply the above skill instructions directly to fulfill the user task.",
  );

  return lines.join("\n");
}
