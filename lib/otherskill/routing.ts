import { z } from "zod";
import {
  type Config,
  decisionModel,
  paidModelsAllowed,
  routingView,
} from "./config";
import {
  PAID_MODEL_OPT_IN,
  blockedPaidModels,
  envAllowsPaidModels,
  modelChain,
} from "../decision_models";
import { discoverBank, type BankSkill, readSkill } from "./bank";
export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export interface DecisionRequest {
  model: string;
  state: {
    user_prompt: string;
    stage: string;
    category?: string;
    categories?: Array<{ id: string; description: string }>;
    skills?: Array<{ id: string; name: string; description: string }>;
  };
  questions: {
    selection: {
      type: "choice";
      instructions: string;
      criteria: Record<string, string>;
    };
  };
}
export class RoutingError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
const answerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number().finite().min(0).max(1)),
  confidence: z.number().finite().min(0).max(1),
});
export interface Choice {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
/** Failures that the next model in the fallback chain may succeed on. */
function fallbackEligible(code: string): boolean {
  if (code === "openrouter_http_401" || code === "openrouter_http_402")
    return false;
  return (
    code.startsWith("openrouter_http_") ||
    code.startsWith("invalid_decision_") ||
    code === "openrouter_network_or_timeout" ||
    code === "openrouter_unavailable" ||
    code === "inconsistent_decision_choice"
  );
}
export class Decisions {
  private readonly apiKey: string;
  private readonly fetchFn: (
    url: string,
    init: RequestInit,
  ) => Promise<Response>;
  constructor(
    private readonly config: Config,
    options: {
      apiKey?: string;
      fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
    } = {},
  ) {
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
    this.fetchFn = options.fetchFn ?? fetch;
    decisionModel(config.model);
    for (const model of config.fallbackModels ?? []) decisionModel(model);
  }
  /** Ask the configured model, then each fallback model, until one answers. */
  async decide(
    request: DecisionRequest,
    limits = this.config.limits,
  ): Promise<Choice> {
    decisionModel(request.model);
    if (request.model !== this.config.model)
      throw new RoutingError("model_override_rejected");
    const chain = modelChain(this.config.model, this.config.fallbackModels);
    const allowPaid = paidModelsAllowed(this.config) || envAllowsPaidModels();
    if (!this.apiKey)
      throw new RoutingError("openrouter_credential_unavailable");
    if (blockedPaidModels(chain, allowPaid).length)
      throw new RoutingError(PAID_MODEL_OPT_IN);
    let lastError: unknown;
    for (const model of chain) {
      try {
        return await this.decideWith({ ...request, model }, limits);
      } catch (error) {
        if (!(error instanceof RoutingError) || !fallbackEligible(error.code))
          throw error;
        lastError = error;
      }
    }
    throw lastError;
  }
  private async decideWith(
    request: DecisionRequest,
    limits: Config["limits"],
  ): Promise<Choice> {
    const body = JSON.stringify(request);
    const criteria = Object.keys(request.questions.selection.criteria);
    if (
      criteria.length - 1 > limits.maxCandidates ||
      Buffer.byteLength(body) > limits.maxRequestBytes
    )
      throw new RoutingError(
        "context_limit_exceeded_raise_limits_or_reorganize_category",
      );
    if (!this.apiKey)
      throw new RoutingError("openrouter_credential_unavailable");
    for (let attempt = 0; attempt <= limits.retries; attempt++) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let completed: { ok: boolean; status: number; data?: unknown };
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new RoutingError("openrouter_network_or_timeout"));
            controller.abort();
          }, limits.timeoutMs);
        });
        const operation = (async () => {
          const response = await this.fetchFn(DECISIONS_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
              "X-Title": "OtherSkill",
            },
            body,
            signal: controller.signal,
          });
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            return { ok: false, status: response.status };
          }
          let data: unknown;
          try {
            data = await response.json();
          } catch {
            throw new RoutingError(
              controller.signal.aborted
                ? "openrouter_network_or_timeout"
                : "invalid_decision_json",
            );
          }
          return { ok: true, status: response.status, data };
        })();
        completed = await Promise.race([operation, deadline]);
      } catch (error) {
        if (
          error instanceof RoutingError &&
          error.code === "invalid_decision_json"
        )
          throw error;
        if (attempt < limits.retries) {
          await Bun.sleep(limits.retryDelayMs * 2 ** attempt);
          continue;
        }
        throw new RoutingError("openrouter_network_or_timeout");
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (!completed.ok) {
        if (
          (completed.status === 429 || completed.status >= 500) &&
          attempt < limits.retries
        ) {
          await Bun.sleep(limits.retryDelayMs * 2 ** attempt);
          continue;
        }
        throw new RoutingError(`openrouter_http_${completed.status}`);
      }
      const parsed = completed.data;
      const result = z
        .object({ answers: z.object({ selection: answerSchema }).strict() })
        .safeParse(parsed);
      if (!result.success) throw new RoutingError("invalid_decision_response");
      const answer = result.data.answers.selection;
      const keys = Object.keys(answer.probabilities);
      if (
        !criteria.includes(answer.choice) ||
        keys.length !== criteria.length ||
        keys.some((k) => !criteria.includes(k))
      )
        throw new RoutingError("invalid_decision_choices");
      const sum = Object.values(answer.probabilities).reduce(
        (a, b) => a + b,
        0,
      );
      if (Math.abs(sum - 1) > 0.02)
        throw new RoutingError("invalid_decision_distribution");
      const winner = answer.probabilities[answer.choice] ?? -1;
      if (Object.values(answer.probabilities).some((p) => p > winner + 0.0001))
        throw new RoutingError("inconsistent_decision_choice");
      return answer;
    }
    throw new RoutingError("openrouter_unavailable");
  }
}
function selectedKeys(answer: Choice, threshold: number): string[] {
  if (answer.choice === "none") return [];
  return Object.entries(answer.probabilities)
    .filter(([key, p]) => key !== "none" && p >= threshold)
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key);
}
export async function classify(
  config: Config,
  sourceDir: string,
  provider = new Decisions(config),
): Promise<string[]> {
  const skill = readSkill(sourceDir);
  const known = routingView(config).categories;
  const criteria = Object.fromEntries(
    known.map((c, i) => [`c${i}`, c.description]),
  );
  criteria.none = "No category matches this skill.";
  const response = await provider.decide(
    {
      model: config.model,
      state: {
        user_prompt: JSON.stringify(skill),
        stage: "classify",
        categories: known,
      },
      questions: {
        selection: {
          type: "choice",
          instructions:
            "Classify this skill against the complete configured taxonomy. Assign probability to every applicable category.",
          criteria,
        },
      },
    },
    config.limits,
  );
  const keys = selectedKeys(response, config.limits.categoryThreshold);
  if (!keys.length)
    throw new RoutingError("no_matching_categories_use_explicit_category");
  if (keys.length > config.limits.maxCategories)
    throw new RoutingError("category_selection_limit_exceeded");
  return keys.map((key) => known[Number(key.slice(1))]!.id);
}
export interface Selected extends BankSkill {
  categories: string[];
  instances: string[];
  paths: string[];
  probability: number;
  confidence: number;
}
export interface RouteResult {
  status: "ok" | "partial" | "failed";
  selected: Selected[];
  categories: string[];
  logicalCalls: number;
  diagnostics: string[];
}
export function diagnostic(error: unknown): string {
  return error instanceof RoutingError
    ? error.code
    : "invalid_configuration_or_bank";
}
export async function route(
  config: Config,
  prompt: string,
  provider = new Decisions(config),
): Promise<RouteResult> {
  const result: RouteResult = {
    status: "ok",
    selected: [],
    categories: [],
    logicalCalls: 0,
    diagnostics: [],
  };
  try {
    if (!prompt.trim()) throw new RoutingError("missing_prompt");
    const bank = discoverBank(config);
    const view = routingView(config);
    const categories = view.categories.filter(
      (c) => !view.enabledCategories || view.enabledCategories.includes(c.id),
    );
    if (!categories.length) return result;
    const criteria = Object.fromEntries(
      categories.map((category, index) => [`c${index}`, category.description]),
    );
    criteria.none = "No specialized category needed.";
    result.logicalCalls++;
    const answer = await provider.decide(
      {
        model: config.model,
        state: { user_prompt: prompt, stage: "categories", categories },
        questions: {
          selection: {
            type: "choice",
            instructions:
              "Select relevant categories for the original full user request, assigning probability to every applicable category.",
            criteria,
          },
        },
      },
      config.limits,
    );
    const keys = selectedKeys(answer, config.limits.categoryThreshold);
    if (keys.length > config.limits.maxCategories)
      throw new RoutingError("category_selection_limit_exceeded");
    result.categories = keys.map((key) => categories[Number(key.slice(1))]!.id);
    const groups = result.categories.map((category) => ({
      category,
      skills: bank.filter((s) => s.category === category),
    }));
    const nonempty = groups.filter((group) => group.skills.length);
    for (const group of groups.filter((group) => !group.skills.length))
      result.diagnostics.push(`empty_category:${group.category}`);
    // Preflight all category contexts before issuing any stage-two calls.
    const requests = nonempty.map(({ category, skills }) => {
      const criteria = Object.fromEntries(
        skills.map((skill, index) => [`s${index}`, skill.description]),
      );
      criteria.none = "No skill is useful for this request.";
      const request: DecisionRequest = {
        model: config.model,
        state: {
          user_prompt: prompt,
          stage: "skills",
          category,
          skills: skills.map((s) => ({
            id: s.instanceId,
            name: s.name,
            description: s.description,
          })),
        },
        questions: {
          selection: {
            type: "choice",
            instructions:
              "Select useful skills for the original full user request using all complete descriptions.",
            criteria,
          },
        },
      };
      if (
        skills.length > config.limits.maxCandidates ||
        Buffer.byteLength(JSON.stringify(request)) >
          config.limits.maxRequestBytes
      )
        throw new RoutingError(
          "context_limit_exceeded_raise_limits_or_reorganize_category",
        );
      return { category, skills, request };
    });
    result.logicalCalls += requests.length;
    const responses: Array<{
      category: string;
      selected: Selected[];
      error?: string;
    }> = new Array(requests.length);
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(config.limits.concurrency, requests.length) },
        async () => {
          for (;;) {
            const index = next++;
            const group = requests[index];
            if (!group) break;
            try {
              const answer = await provider.decide(
                group.request,
                config.limits,
              );
              const selected = selectedKeys(
                answer,
                config.limits.skillThreshold,
              ).map((key) => {
                const skill = group.skills[Number(key.slice(1))]!;
                return {
                  ...skill,
                  categories: [group.category],
                  instances: [skill.instanceId],
                  paths: [skill.path],
                  probability: answer.probabilities[key]!,
                  confidence: answer.confidence,
                };
              });
              responses[index] = { category: group.category, selected };
            } catch (error) {
              responses[index] = {
                category: group.category,
                selected: [],
                error: diagnostic(error),
              };
            }
          }
        },
      ),
    );
    const collected = new Map<string, Selected>();
    for (const response of responses) {
      if (response.error) {
        result.diagnostics.push(`${response.category}:${response.error}`);
        continue;
      }
      for (const skill of response.selected) {
        const old = collected.get(skill.logicalId);
        if (old) {
          old.categories.push(...skill.categories);
          old.instances.push(...skill.instances);
          old.paths.push(...skill.paths);
          old.probability = Math.max(old.probability, skill.probability);
        } else collected.set(skill.logicalId, skill);
      }
    }
    const errors = responses.filter((r) => r.error).length;
    result.status =
      errors === 0 ? "ok" : errors === responses.length ? "failed" : "partial";
    result.selected = [...collected.values()].sort(
      (a, b) => b.probability - a.probability,
    );
    if (result.selected.length > config.limits.maxSkills) {
      result.selected = result.selected.slice(0, config.limits.maxSkills);
      result.diagnostics.push("skill_selection_truncated_to_maxSkills");
    }
    return result;
  } catch (error) {
    return {
      ...result,
      status: "failed",
      selected: [],
      diagnostics: [...result.diagnostics, diagnostic(error)],
    };
  }
}
export function summary(result: RouteResult): string {
  if (!result.selected.length) return "";
  const lines = [
    `OtherSkill selected skills (${result.status}). Read a selected SKILL.md only when needed.`,
  ];
  for (const skill of result.selected)
    lines.push(
      `- ${skill.name}: ${skill.description}\n  Categories: ${skill.categories.join(", ")}; Source: ${skill.source.source}\n  SKILL.md: ${skill.path}`,
    );
  return lines.join("\n");
}
