import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { DecisionProvider } from "../lib/provider";
import type { Skill } from "../lib/model";

describe("metatool online benchmark integration", () => {
  const toolsPath = path.resolve(
    __dirname,
    "../golden_set/metatool_tools.json",
  );
  const benchmarkPath = path.resolve(
    __dirname,
    "../golden_set/metatool_benchmark.json",
  );

  it("validates MetaTool benchmark schema and verifies all expected tools exist in tool bank", () => {
    expect(fs.existsSync(toolsPath)).toBe(true);
    expect(fs.existsSync(benchmarkPath)).toBe(true);

    const toolsJson: Record<string, string> = JSON.parse(
      fs.readFileSync(toolsPath, "utf-8"),
    );
    const testcases = JSON.parse(fs.readFileSync(benchmarkPath, "utf-8"));

    expect(Array.isArray(testcases)).toBe(true);
    expect(testcases.length).toBe(12);

    const toolNames = new Set(Object.keys(toolsJson));

    for (const tc of testcases) {
      expect(tc.id).toBeDefined();
      expect(tc.prompt).toBeDefined();
      expect(tc.category).toBeDefined();
      expect(Array.isArray(tc.expectedTools)).toBe(true);

      for (const toolName of tc.expectedTools) {
        expect(toolNames.has(toolName)).toBe(true);
      }
    }
  });

  it("evaluates a multi-tool query from MetaTool and correctly selects target tools with OtherSkill", async () => {
    const toolsJson: Record<string, string> = JSON.parse(
      fs.readFileSync(toolsPath, "utf-8"),
    );
    const candidateSkills: Skill[] = Object.entries(toolsJson).map(
      ([name, desc]) => ({
        name,
        description: desc,
        whenToUse: desc,
      }),
    );

    const mockFetch = (async () => {
      return new Response(
        JSON.stringify({
          model: "inception/mercury-decide:free",
          answers: {
            primary_skill: {
              type: "choice",
              choice: "FinanceTool",
              probabilities: { FinanceTool: 0.88, NewsTool: 0.72 },
              confidence: 0.95,
            },
          },
          usage: { input_tokens: 180, output_tokens: 50 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    const provider = new DecisionProvider({
      allowPaidModels: true,
      apiKey: "offline-test-key",
      fetchFn: mockFetch,
    });
    const result = await provider.selectSkills({
      userPrompt:
        "I want to know the latest news about Tesla and how it has impacted the stock market.",
      skills: candidateSkills,
    });

    expect(result.primarySkill).toBe("FinanceTool");
    const selectedNames = result.selectedSkills.map((s) => s.name);
    expect(selectedNames).toContain("FinanceTool");
    expect(selectedNames).toContain("NewsTool");
  });
});
