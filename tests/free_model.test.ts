import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  DecisionProvider,
  isFreeModel,
  resolveActiveModel,
  DEFAULT_DECISION_MODEL,
} from "../lib/provider";
import type { Skill } from "../lib/model";

describe("Decision model opt-in enforcement", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.MODEL;
    delete process.env.JEV_MODEL;
    delete process.env.SKILL_SELECTOR_MODEL;
    delete process.env.OTHERSKILL_MODEL;
    delete process.env.OTHERSKILL_ALLOW_PAID_MODELS;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("identifies free models vs paid models correctly", () => {
    expect(isFreeModel("inception/mercury-decide:free")).toBe(true);
    expect(isFreeModel("meta-llama/llama-3-8b-instruct:free")).toBe(true);
    expect(isFreeModel("any-provider/any-model:FREE")).toBe(true);

    // Paid models must return false
    expect(isFreeModel("~typesafe/jev-latest")).toBe(false);
    expect(isFreeModel("typesafe/jev-1.13-20260917")).toBe(false);
    expect(isFreeModel("openai/gpt-4o")).toBe(false);
    expect(isFreeModel("anthropic/claude-3.5-sonnet")).toBe(false);
  });

  it("defaults to the cheap paid decision model perplexity/pplx-decider-flash-v1.2", () => {
    expect(resolveActiveModel()).toBe(DEFAULT_DECISION_MODEL);
    expect(resolveActiveModel()).toBe("perplexity/pplx-decider-flash-v1.2");
  });

  it("does not send the paid default without an opt-in", async () => {
    const mockFetch = mock(async () => new Response("{}", { status: 200 }));
    const provider = new DecisionProvider({
      apiKey: "test-key",
      fetchFn: mockFetch as any,
    });
    await expect(
      provider.sendDecisionRequest({ state: {}, questions: {} } as any),
    ).rejects.toThrow(/requires opt-in/);
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  it("accepts paid models with allowPaidModels or OTHERSKILL_ALLOW_PAID_MODELS", () => {
    expect(resolveActiveModel("~typesafe/jev-latest", true)).toBe(
      "~typesafe/jev-latest",
    );
    expect(
      new DecisionProvider({
        apiKey: "test-key",
        model: "respan/span-02",
        allowPaidModels: true,
      }),
    ).toBeDefined();
    process.env.OTHERSKILL_ALLOW_PAID_MODELS = "1";
    expect(resolveActiveModel("respan/span-02")).toBe("respan/span-02");
    process.env.MODEL = "~typesafe/jev-latest";
    expect(resolveActiveModel()).toBe("~typesafe/jev-latest");
  });

  it("rejects paid model overrides without opt-in before network call", async () => {
    const mockFetch = mock(async () => new Response("{}", { status: 200 }));

    // Explicit paid model option
    expect(() => {
      new DecisionProvider({
        apiKey: "test-key",
        model: "~typesafe/jev-latest",
        fetchFn: mockFetch as any,
      });
    }).toThrow(/requires opt-in/i);

    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  it("OTHERSKILL_MODEL wins over legacy SKILL_SELECTOR_MODEL, which still works alone", () => {
    process.env.OTHERSKILL_MODEL = "new/free-model:free";
    process.env.SKILL_SELECTOR_MODEL = "old/free-model:free";
    expect(resolveActiveModel()).toBe("new/free-model:free");

    delete process.env.OTHERSKILL_MODEL;
    expect(resolveActiveModel()).toBe("old/free-model:free");
  });

  it("prefers SKILL_SELECTOR_MODEL then compatible legacy free-only values", () => {
    process.env.SKILL_SELECTOR_MODEL = "custom/free-model:free";
    process.env.MODEL = "legacy/model:free";
    expect(resolveActiveModel()).toBe("custom/free-model:free");

    delete process.env.SKILL_SELECTOR_MODEL;
    expect(resolveActiveModel()).toBe("legacy/model:free");
  });

  it("does not silently use legacy MODEL or JEV_MODEL if configured to paid model", () => {
    process.env.MODEL = "~typesafe/jev-latest";
    process.env.JEV_MODEL = "openai/gpt-4o";

    // Should NOT use the paid legacy model without opt-in; falls back to the default
    expect(resolveActiveModel()).toBe(DEFAULT_DECISION_MODEL);
  });

  it("treats provider failure/timeout as local fallback or no selected skills with explicit source metadata", async () => {
    const dummySkills: Skill[] = [
      {
        name: "tdd",
        description: "TDD",
        whenToUse: "Use for test-first development",
      },
    ];

    const mockFailingFetch = mock(async () => {
      throw new Error("Connection timeout");
    });

    const provider = new DecisionProvider({
      apiKey: "test-key",
      model: "inception/mercury-decide:free",
      fetchFn: mockFailingFetch as any,
      retries: 1,
    });

    const result = await provider.selectSkills({
      userPrompt: "Run TDD tests",
      skills: dummySkills,
    });

    expect(result.source).toBe("unavailable");
    expect(result.metadata?.source).toBe("unavailable");
    expect(result.metadata?.error).toBe("decision_unavailable");
    expect(result.selectedSkills).toEqual([]);
  });
});
