#!/usr/bin/env bun
/** Public catalog verification; live requests only with a credential, and paid models only after OTHERSKILL_ALLOW_PAID_MODELS=1. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../lib/otherskill/config";
import {
  DEFAULT_DECISION_MODEL,
  envAllowsPaidModels,
  isFreeModel,
} from "../lib/decision_models";
import { readKey } from "../lib/otherskill/credentials";
import { Decisions, route, diagnostic } from "../lib/otherskill/routing";
import { createSkill, installLocal } from "../lib/otherskill/bank";
const MODEL = process.env.OTHERSKILL_MODEL || DEFAULT_DECISION_MODEL;
const evidence: Record<string, unknown> = {
  checkedAt: new Date().toISOString(),
  model: MODEL,
  endpoint: "https://openrouter.ai/api/alpha/decisions",
};
try {
  const response = await fetch(
    "https://openrouter.ai/api/v1/models?output_modalities=decisions",
    { signal: AbortSignal.timeout(20000) },
  );
  if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
  const catalog = (await response.json()) as {
    data: Array<{
      id: string;
      context_length: number;
      pricing: { prompt: string; completion: string };
      architecture: unknown;
    }>;
  };
  const model = catalog.data.find((m) => m.id === MODEL);
  if (!model) throw new Error("decision model absent from public catalog");
  const free =
    Number(model.pricing.prompt) === 0 &&
    Number(model.pricing.completion) === 0;
  if (!free && (isFreeModel(MODEL) || !envAllowsPaidModels()))
    throw new Error("paid model without opt-in; refusing probe");
  evidence.catalog = {
    status: "passed",
    id: model.id,
    context_length: model.context_length,
    pricing: model.pricing,
    architecture: model.architecture,
  };
} catch {
  evidence.catalog = {
    status: "unavailable",
    reason:
      "model missing from the public decision catalog, or paid without OTHERSKILL_ALLOW_PAID_MODELS=1",
  };
}
let key: string | undefined;
try {
  key = readKey(process.env.OTHERSKILL_HOME ?? os.homedir());
} catch {
  evidence.credential = "private credential unavailable";
}
if (!key || /your_openrouter|your-key|placeholder/i.test(key)) {
  evidence.tinyDecision = {
    status: "unavailable",
    reason: "no configured OpenRouter credential",
  };
  evidence.twoStage = {
    status: "unavailable",
    reason: "no configured OpenRouter credential",
  };
} else if ((evidence.catalog as { status?: string })?.status !== "passed") {
  evidence.tinyDecision = {
    status: "unavailable",
    reason: "catalog or paid opt-in unverified",
  };
  evidence.twoStage = {
    status: "unavailable",
    reason: "catalog or paid opt-in unverified",
  };
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otherskill-live-"));
  try {
    const config = loadConfig({ home: root, cwd: root });
    config.model = MODEL;
    config.allowPaidModels = envAllowsPaidModels();
    config.categories = [
      { id: "frontend/ui-ux", description: "Design accessible web interfaces" },
      { id: "testing", description: "Write and run automated tests" },
    ];
    config.limits.retries = 0;
    const provider = new Decisions(config, { apiKey: key });
    try {
      const tiny = await provider.decide({
        model: config.model,
        state: {
          user_prompt: "A web interface needs accessible buttons.",
          stage: "tiny-smoke",
        },
        questions: {
          selection: {
            type: "choice",
            instructions: "Choose the relevant topic",
            criteria: { design: "Interface design", none: "No topic" },
          },
        },
      });
      evidence.tinyDecision = { status: "passed", choice: tiny.choice };
    } catch (error) {
      evidence.tinyDecision = {
        status: "unavailable",
        reason: diagnostic(error),
      };
    }
    const source = createSkill(
      path.join(root, "smoke-skill"),
      "accessible-ui-tests",
      "Design accessible interfaces and automated tests.",
      "Synthetic live smoke skill.",
    );
    installLocal(
      config,
      source,
      config.categories.map((c) => c.id),
    );
    const result = await route(
      config,
      "Design an accessible web interface and write automated tests for its controls.",
      provider,
    );
    evidence.twoStage = {
      status: result.status,
      logicalCalls: result.logicalCalls,
      categories: result.categories,
      selectedNames: result.selected.map((s) => s.name),
      diagnostics: result.diagnostics,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
console.log(JSON.stringify(evidence, null, 2));
