import fs from "node:fs";
import {
  type Skill,
  type SelectedSkill,
  type OtherSkillOptions,
  type SkillSelectionResult,
  type UsageMetrics,
  type DecisionRequest,
  type DecisionResponse,
  filterSelectedSkills,
} from "./model";
import { buildSkillState, buildSkillCriteria } from "./parse_skill";
import {
  DEFAULT_DECISION_MODEL,
  envAllowsPaidModels,
  isDecisionModelId,
  isFreeModel,
} from "./decision_models";
import {
  DEFAULT_SYSTEM_PROMPT,
  buildDecisionInstructions,
} from "./system_prompt";

export const DEFAULT_OPENROUTER_DECISIONS_URL =
  "https://openrouter.ai/api/alpha/decisions";
export {
  DEFAULT_DECISION_MODEL,
  isFreeModel,
} from "./decision_models";

function paidModelError(model: string): Error {
  return new Error(
    `Paid model "${model}" requires opt-in: pass allowPaidModels: true or set OTHERSKILL_ALLOW_PAID_MODELS=1.`,
  );
}

/** Throw unless `model` is a decision model id and, when paid, opted in. */
export function assertModelAllowed(model: string, allowPaid: boolean): string {
  if (!isDecisionModelId(model))
    throw new Error(`Invalid decision model id "${model}".`);
  if (!allowPaid && !isFreeModel(model)) throw paidModelError(model);
  return model;
}

/**
 * Resolve the active decision model.
 * Precedence:
 * 1. optionsModel (paid models need allowPaid, else error)
 * 2. OTHERSKILL_MODEL env var, then legacy SKILL_SELECTOR_MODEL (same rule)
 * 3. Legacy MODEL / JEV_MODEL, skipped when paid without opt-in
 * 4. DEFAULT_DECISION_MODEL (paid: requests fail until opted in)
 */
export function resolveActiveModel(
  optionsModel?: string,
  allowPaid = envAllowsPaidModels(),
): string {
  if (optionsModel) return assertModelAllowed(optionsModel, allowPaid);

  const envSelectorModel =
    process.env.OTHERSKILL_MODEL || process.env.SKILL_SELECTOR_MODEL;
  if (envSelectorModel) return assertModelAllowed(envSelectorModel, allowPaid);

  const legacyModel = process.env.MODEL || process.env.JEV_MODEL;
  if (
    legacyModel &&
    isDecisionModelId(legacyModel) &&
    (allowPaid || isFreeModel(legacyModel))
  )
    return legacyModel;

  return DEFAULT_DECISION_MODEL;
}

export interface DecisionProviderConfig {
  apiKey?: string;
  model?: string;
  /** Opt in to paid decision models (also OTHERSKILL_ALLOW_PAID_MODELS=1). */
  allowPaidModels?: boolean;
  endpoint?: string;
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  fetchFn?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

/**
 * Provider client for the decision model on OpenRouter
 */
export class DecisionProvider {
  private apiKey: string;
  private model: string;
  private allowPaid: boolean;
  private endpoint: string;
  private retries: number;
  private retryDelayMs: number;
  private timeoutMs: number;
  private fetchFn: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;

  constructor(config: DecisionProviderConfig = {}) {
    this.apiKey =
      config.apiKey ||
      process.env.OPENROUTER_API_KEY ||
      process.env.JEV_API_KEY ||
      "";
    this.allowPaid = config.allowPaidModels ?? envAllowsPaidModels();
    this.model = resolveActiveModel(config.model, this.allowPaid);
    this.endpoint = config.endpoint || DEFAULT_OPENROUTER_DECISIONS_URL;
    this.retries = Math.max(1, Math.min(3, Math.floor(config.retries ?? 3)));
    this.retryDelayMs =
      config.retryDelayMs !== undefined ? config.retryDelayMs : 500;
    this.timeoutMs = Math.max(1, Math.min(8000, config.timeoutMs ?? 8000));
    this.fetchFn = config.fetchFn || fetch;
  }

  /**
   * Send a decision request to the decision model with automatic retries and backoff
   */
  async sendDecisionRequest(
    request: DecisionRequest,
  ): Promise<DecisionResponse> {
    const modelToUse = request.model || this.model;
    assertModelAllowed(modelToUse, this.allowPaid);

    if (!this.apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY is not set. Please set the environment variable or pass apiKey in constructor.",
      );
    }

    let lastError: Error | null = null;
    const maxAttempts = this.retries;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(
              new Error(`Decision request timed out after ${this.timeoutMs}ms`),
            );
          }, this.timeoutMs);
        });
        let response: Response;
        let data: any;
        try {
          const operation = (async () => {
            const reply = await this.fetchFn(this.endpoint, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/datamonsterr/other-skill",
                "X-Title": "OtherSkill",
              },
              body: JSON.stringify({ ...request, model: modelToUse }),
              signal: controller.signal,
            });
            // The deadline covers both headers and body, even for injected clients.
            const body = await reply.text();
            let parsed: any;
            try {
              parsed = JSON.parse(body);
            } catch {
              parsed = { error: { message: body } };
            }
            return { reply, parsed };
          })();
          const completed = await Promise.race([operation, deadline]);
          response = completed.reply;
          data = completed.parsed;
        } finally {
          clearTimeout(timer!);
        }
        if (response.ok) return data as DecisionResponse;

        const isRateLimit = response.status === 429;
        const isServerError = response.status >= 500 && response.status <= 599;

        const errorText = "provider unavailable";

        const error = new Error(
          `Decision API failed with HTTP ${response.status}: ${errorText}`,
        );
        lastError = error;

        // Retry on 429 rate limit or 5xx server error if attempts remain
        if ((isRateLimit || isServerError) && attempt < maxAttempts - 1) {
          const backoff = this.retryDelayMs * 2 ** attempt;
          await new Promise((res) => setTimeout(res, backoff));
          continue;
        }

        throw error;
      } catch (err: any) {
        lastError = err;
        if (attempt < maxAttempts - 1) {
          const backoff = this.retryDelayMs * 2 ** attempt;
          await new Promise((res) => setTimeout(res, backoff));
          continue;
        }
        throw lastError;
      }
    }

    throw (
      lastError || new Error("Failed to send decision request after retries")
    );
  }

  /**
   * Select relevant skills from a skill bank for a given user prompt
   */
  async selectSkills(params: {
    userPrompt: string;
    skills: Skill[];
    systemPrompt?: string;
    context?: Record<string, any>;
    options?: OtherSkillOptions;
  }): Promise<SkillSelectionResult> {
    const { userPrompt, skills, systemPrompt, context, options = {} } = params;

    const threshold = options.threshold ?? 0.05;
    const maxSkills = options.maxSkills ?? 3;
    const includeNone = options.includeNone ?? true;
    const activeModel = resolveActiveModel(
      options.model || this.model,
      options.allowPaidModels ?? this.allowPaid,
    );

    // Build state and criteria (compact: true omits redundant skill array from state, saving ~11,000 input tokens)
    const state = buildSkillState(
      skills,
      userPrompt,
      systemPrompt || DEFAULT_SYSTEM_PROMPT,
      context,
      { compact: true },
    );
    const criteria = buildSkillCriteria(skills, includeNone, 140);

    // Determine if multi-step questions should be used
    const isMultiStep =
      options.multiStep === true ||
      (options.multiStep !== false &&
        /(?:step\s*\d|phase\s*\d|continuing|continue|first.*(?:next|then)|after that|subsequent)/i.test(
          userPrompt,
        ));

    const questions: Record<string, any> = isMultiStep
      ? {
          primary_skill: {
            type: "choice",
            instructions: buildDecisionInstructions("primary"),
            criteria,
          },
          secondary_skill: {
            type: "choice",
            instructions: buildDecisionInstructions("secondary"),
            criteria,
          },
          followup_skill: {
            type: "choice",
            instructions: buildDecisionInstructions("followup"),
            criteria,
          },
        }
      : {
          selected_skill: {
            type: "choice",
            instructions: buildDecisionInstructions("single"),
            criteria,
          },
        };

    const request: DecisionRequest = {
      model: activeModel,
      state,
      questions,
    };

    let response: DecisionResponse;
    try {
      response = await this.sendDecisionRequest(request);
    } catch (_err: any) {
      // Treat provider failure/timeout as local fallback or no selected skills, explicit source metadata
      const activeSystemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
      const estimateTokens = (text: string) =>
        Math.max(1, Math.ceil(text.trim().length / 3.8));

      return {
        selectedSkills: [],
        primarySkill: null,
        answers: {},
        source: "unavailable",
        metadata: {
          source: "unavailable",
          model: activeModel,
          error: "decision_unavailable",
        },
        usage: {
          total_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          user_prompt_tokens: estimateTokens(userPrompt),
          system_prompt_tokens: estimateTokens(activeSystemPrompt),
        },
      };
    }

    const skillMap = new Map(skills.map((s) => [s.name, s]));
    const collectedMap = new Map<string, SelectedSkill>();

    // Process all choice answers returned from the decision model
    for (const [, choiceAnswer] of Object.entries(response.answers || {})) {
      if (choiceAnswer.type !== "choice") continue;

      const skillsFromAns = filterSelectedSkills({
        choice: choiceAnswer.choice,
        probabilities: choiceAnswer.probabilities || {},
        confidence: choiceAnswer.confidence || 0,
        threshold,
        maxSkills,
        skillMap,
      });

      for (const item of skillsFromAns) {
        const existing = collectedMap.get(item.name);
        if (!existing || item.probability > existing.probability) {
          collectedMap.set(item.name, item);
        }
      }
    }

    const selectedSkills = Array.from(collectedMap.values())
      .sort((a, b) => b.probability - a.probability)
      .slice(0, maxSkills);

    if (options?.includeContent) {
      for (const skill of selectedSkills) {
        if (skill.path && fs.existsSync(skill.path)) {
          try {
            skill.content = fs.readFileSync(skill.path, "utf-8");
          } catch {
            // Keep content undefined
          }
        }
      }
    }

    // Primary skill is choice from primary_skill, or selected_skill, or top selected skill
    const primaryChoice =
      (response.answers?.primary_skill?.choice !== "none"
        ? response.answers?.primary_skill?.choice
        : null) ||
      (response.answers?.selected_skill?.choice !== "none"
        ? response.answers?.selected_skill?.choice
        : null) ||
      selectedSkills[0]?.name ||
      null;

    const primarySkill =
      primaryChoice && primaryChoice !== "none" ? primaryChoice : null;

    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const totalTokens = inputTokens + outputTokens;
    const activeSystemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;

    const estimateTokens = (text: string) =>
      Math.max(1, Math.ceil(text.trim().length / 3.8));
    const userPromptTokens = estimateTokens(userPrompt);
    const systemPromptTokens = estimateTokens(activeSystemPrompt);

    const usage: UsageMetrics = {
      total_tokens: totalTokens,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      user_prompt_tokens: userPromptTokens,
      system_prompt_tokens: systemPromptTokens,
      cost: response.usage?.cost,
    };

    return {
      selectedSkills,
      primarySkill,
      answers: response.answers,
      usage,
      raw: response,
      source: "model",
      metadata: {
        source: "model",
        model: activeModel,
      },
    };
  }
}
