import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_DECISION_MODEL,
  loadConfig,
  type Config,
} from "../lib/otherskill/config";
import { createSkill, installLocal } from "../lib/otherskill/bank";
import {
  route,
  summary,
  Decisions,
  type DecisionRequest,
} from "../lib/otherskill/routing";

function fixture(run: (config: Config) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otherskill-route-"));
  const config = loadConfig({ home: root, cwd: root });
  config.allowPaidModels = true;
  const source = createSkill(
    path.join(root, "source"),
    "same",
    `Complete description ${"detail ".repeat(100)}`,
    "BODY NEVER INJECTED",
  );
  installLocal(config, source, ["frontend/ui-ux", "testing"]);
  return run(config).finally(() =>
    fs.rmSync(root, { recursive: true, force: true }),
  );
}
export function answer(
  request: DecisionRequest,
  weights?: Record<string, number>,
) {
  const criteria = request.questions.selection.criteria;
  const keys = Object.keys(criteria);
  const probabilities =
    weights ??
    Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 1 : 0]));
  const choice = Object.keys(probabilities).sort(
    (a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0),
  )[0];
  return new Response(
    JSON.stringify({
      answers: {
        selection: { type: "choice", choice, probabilities, confidence: 0.9 },
      },
    }),
    { status: 200 },
  );
}
test("two stages forward original full prompt and every complete description in 1+N genuinely concurrent calls, deduplicating logical copies", () =>
  fixture(async (config) => {
    const prompt = `Original full prompt ${"long context ".repeat(700)}`;
    const requests: DecisionRequest[] = [];
    let active = 0,
      peak = 0;
    const releases: Array<() => void> = [];
    const fetchFn = async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as DecisionRequest;
      requests.push(request);
      expect(request.state.user_prompt).toBe(prompt);
      if (request.state.stage === "categories")
        return answer(request, {
          c0: 0.5,
          c1: 0,
          c2: 0,
          c3: 0.5,
          c4: 0,
          none: 0,
        });
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
        if (releases.length === 2) for (const release of releases) release();
      });
      active--;
      return answer(request);
    };
    const result = await route(
      config,
      prompt,
      new Decisions(config, { apiKey: "test", fetchFn }),
    );
    expect(requests).toHaveLength(3);
    expect(peak).toBe(2);
    expect(result.logicalCalls).toBe(3);
    expect(result.status).toBe("ok");
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]?.categories).toEqual([
      "frontend/ui-ux",
      "testing",
    ]);
    for (const request of requests.slice(1))
      expect(JSON.stringify(request)).toContain("detail ".repeat(100));
    const text = summary(result);
    expect(text).toContain("Complete description");
    expect(text).toContain("frontend/ui-ux");
    expect(text).not.toContain("BODY NEVER INJECTED");
    expect(text).not.toContain(prompt);
  }));
test("stage one errors inject nothing; category errors give validated partial results without prompt or key diagnostics", () =>
  fixture(async (config) => {
    const denied = new Decisions(config, {
      apiKey: "secret-key",
      fetchFn: async () => new Response("prompt secret-key", { status: 401 }),
    });
    const failed = await route(config, "private prompt", denied);
    expect(failed.status).toBe("failed");
    expect(failed.selected).toEqual([]);
    expect(summary(failed)).toBe("");
    expect(JSON.stringify(failed)).not.toContain("secret-key");
    expect(JSON.stringify(failed)).not.toContain("private prompt");
    const partial = await route(
      config,
      "prompt",
      new Decisions(config, {
        apiKey: "test",
        fetchFn: async (_url, init) => {
          const request = JSON.parse(String(init?.body)) as DecisionRequest;
          if (request.state.stage === "categories")
            return answer(request, {
              c0: 0.5,
              c1: 0,
              c2: 0,
              c3: 0.5,
              c4: 0,
              none: 0,
            });
          if (request.state.category === "testing")
            return new Response("failure", { status: 400 });
          return answer(request);
        },
      }),
    );
    expect(partial.status).toBe("partial");
    expect(partial.selected).toHaveLength(1);
    expect(summary(partial)).toContain("partial");
  }));
test("oversize context, unknown choices and invalid distributions fail safely, without truncation or invented selections", () =>
  fixture(async (config) => {
    let calls = 0;
    const provider = new Decisions(config, {
      apiKey: "test",
      fetchFn: async (_url, init) => {
        calls++;
        return answer(JSON.parse(String(init?.body)));
      },
    });
    const oversized = await route(
      { ...config, limits: { ...config.limits, maxRequestBytes: 256 } },
      "x".repeat(1000),
      provider,
    );
    expect(oversized.status).toBe("failed");
    expect(calls).toBe(0);
    for (const invalid of [
      { choice: "invented", probabilities: { invented: 1 }, confidence: 1 },
      { choice: "c0", probabilities: { c0: 5, none: 0 }, confidence: 1 },
      { choice: "c0", probabilities: { c0: 0.1, none: 0.1 }, confidence: 1 },
      { choice: "c0", probabilities: { c0: 1 }, confidence: -1 },
    ]) {
      const result = await route(
        config,
        "p",
        new Decisions(config, {
          apiKey: "test",
          fetchFn: async () =>
            Response.json({
              answers: { selection: { type: "choice", ...invalid } },
            }),
        }),
      );
      expect(result.status).toBe("failed");
      expect(result.selected).toEqual([]);
    }
  }));

test("all category candidates retain scoped identity, even when two distinct sources have the same name", () =>
  fixture(async (config) => {
    const second = createSkill(
      path.join(config.cwd, "second"),
      "same",
      `Second independent skill ${"complete ".repeat(90)}`,
      "Other body",
    );
    installLocal(config, second, ["testing"]);
    config.enabledCategories = ["testing"];
    const prompt = "full original prompt";
    let requests = 0;
    const result = await route(
      config,
      prompt,
      new Decisions(config, {
        apiKey: "test",
        fetchFn: async (_url, init) => {
          requests++;
          const request = JSON.parse(String(init.body)) as DecisionRequest;
          if (request.state.stage === "categories") {
            expect(request.state.categories).toHaveLength(1);
            return answer(request);
          }
          expect(request.state.skills).toHaveLength(2);
          expect(new Set(request.state.skills?.map((s) => s.id)).size).toBe(2);
          expect(request.state.skills?.map((s) => s.name)).toEqual([
            "same",
            "same",
          ]);
          expect(
            Object.values(request.questions.selection.criteria).join("\n"),
          ).toContain("complete ".repeat(90));
          expect(request.state.user_prompt).toBe(prompt);
          return answer(request, { s0: 0.5, s1: 0.5, none: 0 });
        },
      }),
    );
    expect(requests).toBe(2);
    expect(result.selected).toHaveLength(2);
    expect(new Set(result.selected.map((s) => s.logicalId)).size).toBe(2);
  }));

test("new Decisions provider bounds retries, refuses paid overrides, and never retries permanent HTTP failures", () =>
  fixture(async (config) => {
    config.limits.retries = 2;
    config.limits.retryDelayMs = 0;
    const request: DecisionRequest = {
      model: config.model,
      state: { user_prompt: "never log this", stage: "probe" },
      questions: {
        selection: {
          type: "choice",
          instructions: "choose",
          criteria: { s0: "selected", none: "none" },
        },
      },
    };
    let calls = 0;
    const provider = new Decisions(config, {
      apiKey: "key",
      fetchFn: async (_url, init) => {
        calls++;
        expect(JSON.parse(String(init.body)).model).toBe(
          DEFAULT_DECISION_MODEL,
        );
        return calls < 3
          ? new Response("private upstream text", { status: 429 })
          : answer(request);
      },
    });
    expect((await provider.decide(request)).choice).toBe("s0");
    expect(calls).toBe(3);
    await expect(
      provider.decide({ ...request, model: "paid/model" }),
    ).rejects.toThrow("model_override_rejected");
    expect(calls).toBe(3);
    let permanentCalls = 0;
    const denied = new Decisions(config, {
      apiKey: "key",
      fetchFn: async () => {
        permanentCalls++;
        return new Response("private upstream text", { status: 401 });
      },
    });
    await expect(denied.decide(request)).rejects.toThrow("openrouter_http_401");
    expect(permanentCalls).toBe(1);
  }));

test("candidate and result limits produce explicit failures instead of silently omitting candidates or selections", () =>
  fixture(async (config) => {
    config.categories = [{ id: "testing", description: "tests" }];
    config.limits.maxCandidates = 1;
    const second = createSkill(
      path.join(config.cwd, "second"),
      "other",
      "Second candidate",
      "body",
    );
    installLocal(config, second, ["testing"]);
    let calls = 0;
    const result = await route(
      config,
      "prompt",
      new Decisions(config, {
        apiKey: "test",
        fetchFn: async (_url, init) => {
          calls++;
          return answer(JSON.parse(String(init.body)));
        },
      }),
    );
    expect(calls).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.diagnostics).toContain(
      "context_limit_exceeded_raise_limits_or_reorganize_category",
    );
    config.limits.maxCandidates = 5;
    config.limits.maxSkills = 1;
    const overflow = await route(
      config,
      "prompt",
      new Decisions(config, {
        apiKey: "test",
        fetchFn: async (_url, init) => {
          const request = JSON.parse(String(init.body)) as DecisionRequest;
          return answer(
            request,
            request.state.stage === "skills"
              ? { s0: 0.6, s1: 0.4, none: 0 }
              : undefined,
          );
        },
      }),
    );
    expect(overflow.status).toBe("ok");
    expect(overflow.selected).toHaveLength(1);
    expect(overflow.selected[0]!.probability).toBe(0.6);
    expect(overflow.diagnostics).toContain(
      "skill_selection_truncated_to_maxSkills",
    );
  }));

test("configured worker concurrency is bounded across more selected categories than workers", () =>
  fixture(async (config) => {
    const { discoverBank } = await import("../lib/otherskill/bank");
    const first = discoverBank(config)[0]!;
    installLocal(
      config,
      path.dirname(first.path),
      config.categories.map((c) => c.id),
    );
    config.limits.concurrency = 2;
    let active = 0,
      peak = 0,
      calls = 0;
    const result = await route(
      config,
      "prompt",
      new Decisions(config, {
        apiKey: "test",
        fetchFn: async (_url, init) => {
          calls++;
          const request = JSON.parse(String(init.body)) as DecisionRequest;
          if (request.state.stage === "categories")
            return answer(request, {
              c0: 0.2,
              c1: 0.2,
              c2: 0.2,
              c3: 0.2,
              c4: 0.2,
              none: 0,
            });
          active++;
          peak = Math.max(peak, active);
          await Bun.sleep(10);
          active--;
          return answer(request);
        },
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.logicalCalls).toBe(6);
    expect(calls).toBe(6);
    expect(peak).toBe(2);
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]?.categories).toHaveLength(5);
  }));

test("request deadline covers a stalled response body as well as HTTP headers", () =>
  fixture(async (config) => {
    config.limits.timeoutMs = 10;
    config.limits.retries = 0;
    const provider = new Decisions(config, {
      apiKey: "test",
      fetchFn: async () =>
        new Response(new ReadableStream({ start() {} }), { status: 200 }),
    });
    const request: DecisionRequest = {
      model: config.model,
      state: { user_prompt: "private prompt", stage: "probe" },
      questions: {
        selection: {
          type: "choice",
          instructions: "choose",
          criteria: { s0: "match", none: "none" },
        },
      },
    };
    await expect(
      Promise.race([
        provider.decide(request),
        Bun.sleep(100).then(() => {
          throw new Error("deadline_not_enforced");
        }),
      ]),
    ).rejects.toThrow("openrouter_network_or_timeout");
  }));

test("validated none is a successful no-match and makes no category requests", () =>
  fixture(async (config) => {
    let calls = 0;
    const result = await route(
      config,
      "No specialized skill needed",
      new Decisions(config, {
        apiKey: "test",
        fetchFn: async (_url, init) => {
          calls++;
          const request = JSON.parse(String(init.body)) as DecisionRequest;
          const probabilities = Object.fromEntries(
            Object.keys(request.questions.selection.criteria).map((key) => [
              key,
              key === "none" ? 1 : 0,
            ]),
          );
          return answer(request, probabilities);
        },
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.selected).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(calls).toBe(1);
    expect(result.logicalCalls).toBe(1);
    expect(summary(result)).toBe("");
  }));

const probe = (config: Config): DecisionRequest => ({
  model: config.model,
  state: { user_prompt: "probe", stage: "probe" },
  questions: {
    selection: {
      type: "choice",
      instructions: "choose",
      criteria: { s0: "selected", none: "none" },
    },
  },
});

test("paid decision models need an explicit opt-in before any HTTP call", () =>
  fixture(async (config) => {
    const previous = process.env.OTHERSKILL_ALLOW_PAID_MODELS;
    delete process.env.OTHERSKILL_ALLOW_PAID_MODELS;
    try {
      let calls = 0;
      const fetchFn = async (_url: string, init: RequestInit) => {
        calls++;
        return answer(JSON.parse(String(init.body)));
      };
      config.allowPaidModels = undefined;
      const gated = new Decisions(config, { apiKey: "key", fetchFn });
      await expect(gated.decide(probe(config))).rejects.toThrow(
        "paid_model_requires_opt_in",
      );
      // A paid fallback behind a free primary is gated too.
      const free = {
        ...config,
        model: "vendor/model:free",
        fallbackModels: ["vendor/paid"],
      };
      await expect(
        new Decisions(free, { apiKey: "key", fetchFn }).decide(probe(free)),
      ).rejects.toThrow("paid_model_requires_opt_in");
      expect(calls).toBe(0);
      const freeOnly = { ...free, fallbackModels: [] };
      await new Decisions(freeOnly, { apiKey: "key", fetchFn }).decide(
        probe(freeOnly),
      );
      expect(calls).toBe(1);
      process.env.OTHERSKILL_ALLOW_PAID_MODELS = "1";
      expect((await gated.decide(probe(config))).choice).toBe("s0");
      expect(calls).toBe(2);
    } finally {
      if (previous === undefined)
        delete process.env.OTHERSKILL_ALLOW_PAID_MODELS;
      else process.env.OTHERSKILL_ALLOW_PAID_MODELS = previous;
    }
  }));

test("fallback models answer when the configured model is delisted, but not on credential errors", () =>
  fixture(async (config) => {
    config.limits.retries = 0;
    config.fallbackModels = ["vendor/second", "vendor/third"];
    const seen: string[] = [];
    const provider = new Decisions(config, {
      apiKey: "key",
      fetchFn: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        seen.push(body.model);
        if (body.model === DEFAULT_DECISION_MODEL)
          return new Response("gone", { status: 404 });
        if (body.model === "vendor/second")
          return new Response("bad", { status: 400 });
        return answer(body);
      },
    });
    expect((await provider.decide(probe(config))).choice).toBe("s0");
    expect(seen).toEqual([
      DEFAULT_DECISION_MODEL,
      "vendor/second",
      "vendor/third",
    ]);
    seen.length = 0;
    const denied = new Decisions(config, {
      apiKey: "key",
      fetchFn: async (_url, init) => {
        seen.push(JSON.parse(String(init.body)).model);
        return new Response("denied", { status: 401 });
      },
    });
    await expect(denied.decide(probe(config))).rejects.toThrow(
      "openrouter_http_401",
    );
    expect(seen).toEqual([DEFAULT_DECISION_MODEL]);
    const exhausted = new Decisions(config, {
      apiKey: "key",
      fetchFn: async () => new Response("gone", { status: 404 }),
    });
    await expect(exhausted.decide(probe(config))).rejects.toThrow(
      "openrouter_http_404",
    );
  }));
