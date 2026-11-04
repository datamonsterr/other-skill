import { describe, it, expect, mock } from "bun:test";
import { selectSkills } from "../index";

describe("index programmatic API", () => {
  it("exports selectSkills function that returns matching skills and usage breakdown", async () => {
    expect(typeof selectSkills).toBe("function");

    const mockFetch = mock(async () => {
      return new Response(
        JSON.stringify({
          model: "inception/mercury-decide:free",
          answers: {
            primary_skill: {
              type: "choice",
              choice: "otherskill",
              probabilities: { otherskill: 0.95 },
              confidence: 0.95,
            },
          },
          usage: {
            input_tokens: 120,
            output_tokens: 30,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await selectSkills({
      userPrompt:
        "Dynamically select and route the right skill for an agent prompt to avoid context bloat",
      options: {
        apiKey: "offline-test-key",
        allowPaidModels: true,
        threshold: 0.05,
        fetchFn: mockFetch as any,
      },
    });

    expect(result.primarySkill).toBe("otherskill");
    expect(result.usage).toBeDefined();
    expect(result.usage?.total_tokens).toBeGreaterThan(0);
    expect(result.usage?.input_tokens).toBeGreaterThan(0);
    expect(result.usage?.user_prompt_tokens).toBeGreaterThan(0);
    expect(result.usage?.system_prompt_tokens).toBeGreaterThan(0);
  });
});
