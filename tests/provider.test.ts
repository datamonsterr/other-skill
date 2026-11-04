import { describe, it, expect, mock } from "bun:test";
import { DecisionProvider } from "../lib/provider";
import type { Skill } from "../lib/model";

describe("DecisionProvider", () => {
  const dummySkills: Skill[] = [
    {
      name: "tdd",
      description: "Test-driven development",
      whenToUse: "Use when user wants to build features test-first",
    },
    {
      name: "git-commit",
      description: "Git commit tool",
      whenToUse: "Use when user wants to commit changes",
    },
  ];

  it("successfully calls decisions endpoint and parses selected skills", async () => {
    const mockFetch = mock(async () => {
      return new Response(
        JSON.stringify({
          model: "typesafe/jev-1.13-20260917",
          answers: {
            selected_skill: {
              type: "choice",
              choice: "tdd",
              probabilities: {
                tdd: 0.95,
                "git-commit": 0.01,
                none: 0,
              },
              confidence: 0.95,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const provider = new DecisionProvider({
      allowPaidModels: true,
      apiKey: "test-key",
      fetchFn: mockFetch as any,
    });

    const result = await provider.selectSkills({
      userPrompt: "I want to do red-green-refactor testing",
      skills: dummySkills,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.primarySkill).toBe("tdd");
    expect(result.selectedSkills).toHaveLength(1);
    expect(result.selectedSkills[0]?.name).toBe("tdd");
    expect(result.selectedSkills[0]?.probability).toBe(0.95);
    expect(result.selectedSkills[0]?.confidence).toBe(0.95);
  });

  it("retries 3 times with delay on 429 rate limit before succeeding", async () => {
    let callCount = 0;
    const mockFetch = mock(async () => {
      callCount++;
      if (callCount < 3) {
        return new Response(
          JSON.stringify({
            error: { message: "Rate limit exceeded", code: 429 },
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          model: "typesafe/jev-1.13-20260917",
          answers: {
            selected_skill: {
              type: "choice",
              choice: "git-commit",
              probabilities: {
                tdd: 0.02,
                "git-commit": 0.98,
                none: 0,
              },
              confidence: 0.98,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const provider = new DecisionProvider({
      allowPaidModels: true,
      apiKey: "test-key",
      fetchFn: mockFetch as any,
      retryDelayMs: 10, // Fast delay for tests
    });

    const result = await provider.selectSkills({
      userPrompt: "Commit code with conventional commits",
      skills: dummySkills,
    });

    expect(callCount).toBe(3);
    expect(result.primarySkill).toBe("git-commit");
  });

  it("throws error in sendDecisionRequest after exhausting all retries and safely falls back in selectSkills", async () => {
    const mockFetch = mock(async () => {
      return new Response(
        JSON.stringify({
          error: { message: "Service Unavailable", code: 503 },
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    });

    const provider = new DecisionProvider({
      allowPaidModels: true,
      apiKey: "test-key",
      fetchFn: mockFetch as any,
      retries: 3,
      retryDelayMs: 5,
    });

    await expect(
      provider.sendDecisionRequest({
        model: "inception/mercury-decide:free",
        state: {},
        questions: {},
      }),
    ).rejects.toThrow("HTTP 503");

    const fallbackRes = await provider.selectSkills({
      userPrompt: "Any prompt",
      skills: dummySkills,
    });
    expect(fallbackRes.source).toBe("unavailable");
  });

  it("supports multi-step and continuation prompts by evaluating multiple questions and aggregating skills", async () => {
    const mockFetch = mock(async (_url, opts: any) => {
      const body = JSON.parse(opts.body);
      expect(body.questions).toHaveProperty("primary_skill");
      expect(body.questions).toHaveProperty("secondary_skill");
      expect(body.questions).toHaveProperty("followup_skill");

      return new Response(
        JSON.stringify({
          model: "typesafe/jev-1.13-20260917",
          answers: {
            primary_skill: {
              type: "choice",
              choice: "tdd",
              probabilities: { tdd: 0.9, "git-commit": 0.1, none: 0 },
              confidence: 0.9,
            },
            secondary_skill: {
              type: "choice",
              choice: "git-commit",
              probabilities: { "git-commit": 0.85, tdd: 0.15, none: 0 },
              confidence: 0.85,
            },
            followup_skill: {
              type: "choice",
              choice: "none",
              probabilities: { none: 0.9, tdd: 0.05, "git-commit": 0.05 },
              confidence: 0.9,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const provider = new DecisionProvider({
      allowPaidModels: true,
      apiKey: "test-key",
      fetchFn: mockFetch as any,
    });

    const result = await provider.selectSkills({
      userPrompt:
        "Step 1: Write unit tests with TDD. Step 2: Commit changes using conventional commits.",
      skills: dummySkills,
      options: { multiStep: true },
    });

    expect(result.selectedSkills).toHaveLength(2);
    const names = result.selectedSkills.map((s) => s.name);
    expect(names).toContain("tdd");
    expect(names).toContain("git-commit");
  });
});
