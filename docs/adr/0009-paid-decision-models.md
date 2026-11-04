# 0009: Paid decision models behind an opt-in

Status: accepted (supersedes the free-only rule in 0001)

## Context

OtherSkill calls `https://openrouter.ai/api/alpha/decisions`, which only serves decision-output models. The only configured model, `inception/mercury-decide:free`, was delisted, so every `find` failed with `openrouter_http_404`. The live catalog on 2026-11-04 had one free decision model, `respan/span-01-lite:free`. It is a behavior scorer and returns HTTP 400 for choice questions. Text models such as `google/gemma-4-26b-a4b-it:free` also return 400 on this endpoint. Cheap paid decision models answer the routing request correctly.

## Decision

- Default model: `perplexity/pplx-decider-flash-v1.2` ($0.01/M prompt tokens, 262k context, pinned version rather than a `~latest` alias).
- `model` and `fallbackModels` accept any OpenRouter model id (`provider/model`, optional `~` alias prefix, optional `:free`). Up to four unique fallbacks.
- Any id without `:free` is paid. `Decisions.decide` refuses the whole chain with `paid_model_requires_opt_in`, before any HTTP call, unless `allowPaidModels: true` is set in the effective config or in the inherited global config, `--allow-paid-models` is passed, or `OTHERSKILL_ALLOW_PAID_MODELS=1` is set. The library `DecisionProvider` takes `allowPaidModels` or the same variable.
- The check runs at request time, not at config load, so a config that only relies on defaults still loads and `doctor` can report `modelAccess`.
- Fallback happens on HTTP 4xx except 401/402, 5xx, timeout and invalid answers. Each model has its own retries and deadline.

## Consequences

Routing works again after a one-time opt-in, at about $0.00001 per `find`. Spending money stays an explicit user choice. The model can be swapped by config when the catalog changes again; `fallbackModels` keeps routing up when one provider is delisted. A long chain multiplies worst-case hook latency.
