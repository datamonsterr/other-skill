/**
 * Decision model policy shared by the CLI router and the library provider.
 *
 * OpenRouter's /api/alpha/decisions endpoint only serves decision-output models,
 * and no free one can answer choice questions any more (respan/span-01-lite:free
 * is a behavior scorer). The default is therefore a cheap paid decision model,
 * which OtherSkill only calls after an explicit opt-in (allowPaidModels: true,
 * --allow-paid-models or OTHERSKILL_ALLOW_PAID_MODELS=1).
 */
export const DEFAULT_DECISION_MODEL = "perplexity/pplx-decider-flash-v1.2";
/** Suggested fallbacks: cheap decision models with large enough context for skill stages. */
export const SUGGESTED_FALLBACK_MODELS = [
  "respan/span-02",
  "~typesafe/jev-latest",
] as const;
export const MAX_FALLBACK_MODELS = 4;
export const PAID_MODEL_OPT_IN = "paid_model_requires_opt_in";

const MODEL_ID = /^~?[a-z0-9_.-]+\/[a-z0-9_.-]+(:free)?$/i;

/** One OpenRouter model id: provider/model, optional ~ alias prefix, optional exact :free suffix. */
export function isDecisionModelId(model?: string): boolean {
  return typeof model === "string" && MODEL_ID.test(model);
}

/** Free models carry the exact :free suffix; anything else is billed. */
export function isFreeModel(model?: string): boolean {
  if (!model || typeof model !== "string") return false;
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+:free$/.test(model.trim().toLowerCase());
}

/** Validate model id syntax only; paid access is checked when a request is sent. */
export function decisionModel(model: string): string {
  if (!isDecisionModelId(model))
    throw new Error(
      "model must be one OpenRouter decision model id (provider/model or provider/model:free)",
    );
  return model;
}

/** True when OTHERSKILL_ALLOW_PAID_MODELS opts in to paid decision models. */
export function envAllowsPaidModels(): boolean {
  return /^(1|true|yes)$/i.test(process.env.OTHERSKILL_ALLOW_PAID_MODELS ?? "");
}

/** Primary model followed by unique fallbacks, in call order. */
export function modelChain(model: string, fallbacks: string[] = []): string[] {
  return [...new Set([model, ...fallbacks])];
}

/** Paid models in `models` that the opt-in does not cover. */
export function blockedPaidModels(
  models: string[],
  allowPaid: boolean,
): string[] {
  return allowPaid ? [] : models.filter((model) => !isFreeModel(model));
}
