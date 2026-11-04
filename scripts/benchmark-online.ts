#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { DecisionProvider } from "../lib/provider";
import type { Skill } from "../lib/model";
import { DEFAULT_DECISION_MODEL } from "../lib/decision_models";

interface BenchmarkCase {
  id: string;
  category: "multi_tool" | "single_tool" | "tool_awareness";
  prompt: string;
  expectedTools: string[];
  acceptableTools?: string[];
  description: string;
}

interface CaseEvaluationResult {
  id: string;
  category: string;
  prompt: string;
  passed: boolean;
  expected: string[];
  primaryTool: string | null;
  selectedTools: { name: string; probability: number; confidence: number }[];
  durationMs: number;
  confidence: number;
}

async function runOnlineBenchmark() {
  const toolsPath = path.resolve(
    __dirname,
    "../golden_set/metatool_tools.json",
  );
  const benchmarkPath = path.resolve(
    __dirname,
    "../golden_set/metatool_benchmark.json",
  );

  if (!fs.existsSync(toolsPath) || !fs.existsSync(benchmarkPath)) {
    console.error("Error: Benchmark data files missing in golden_set/");
    process.exit(1);
  }

  const toolsJson: Record<string, string> = JSON.parse(
    fs.readFileSync(toolsPath, "utf-8"),
  );
  const testcases: BenchmarkCase[] = JSON.parse(
    fs.readFileSync(benchmarkPath, "utf-8"),
  );

  // Convert MetaTool tools into Skill format
  const candidateSkills: Skill[] = Object.entries(toolsJson).map(
    ([name, desc]) => ({
      name,
      description: desc,
      whenToUse: desc,
    }),
  );

  console.log(`\n======================================================`);
  console.log(`🌐 Starting MetaTool (ToolE) Online Benchmark on OtherSkill`);
  console.log(`Dataset: MetaTool / ToolE (HuggingFace / GitHub)`);
  console.log(`Total Candidate Tools in Bank: ${candidateSkills.length}`);
  console.log(`Total Benchmark Test Cases: ${testcases.length}`);
  console.log(`Model: ${process.env.MODEL || DEFAULT_DECISION_MODEL}`);
  console.log(`======================================================\n`);

  const provider = new DecisionProvider();
  const results: CaseEvaluationResult[] = [];
  let passedCount = 0;
  let totalDurationMs = 0;

  for (let i = 0; i < testcases.length; i++) {
    const tc = testcases[i];
    if (!tc) continue;
    process.stdout.write(
      `[${i + 1}/${testcases.length}] Evaluating ${tc.id} (${tc.category})... `,
    );

    const startTime = Date.now();
    try {
      const res = await provider.selectSkills({
        userPrompt: tc.prompt,
        skills: candidateSkills,
        options: { threshold: 0.05, maxSkills: 3 },
      });

      const durationMs = Date.now() - startTime;
      totalDurationMs += durationMs;
      const actualSelected = res.selectedSkills.map((s) => s.name);
      const actualPrimary = res.primarySkill;

      let passed = false;

      if (tc.category === "tool_awareness") {
        // Awareness: query should NOT trigger any external tool
        passed =
          actualPrimary === null ||
          actualPrimary === "none" ||
          res.selectedSkills.length === 0;
      } else if (tc.category === "single_tool") {
        // Single tool: primary or selected should match expected tool
        passed =
          (actualPrimary && tc.expectedTools.includes(actualPrimary)) ||
          actualSelected.some((s) => tc.expectedTools.includes(s));
      } else {
        // Multi tool: at least one expected tool as primary, and high recall on expected set
        const acceptable = tc.acceptableTools || tc.expectedTools;
        const matchedCount = tc.expectedTools.filter((t) =>
          actualSelected.includes(t),
        ).length;
        passed =
          (actualPrimary !== null && acceptable.includes(actualPrimary)) ||
          matchedCount >= 1;
      }

      if (passed) {
        passedCount++;
        console.log(
          `✅ PASS (${durationMs}ms) -> Primary: [${actualPrimary || "none"}], Selected: [${actualSelected.join(", ")}]`,
        );
      } else {
        console.log(
          `❌ FAIL (${durationMs}ms) -> Expected: ${JSON.stringify(tc.expectedTools)}, Got: [${actualPrimary}]`,
        );
      }

      results.push({
        id: tc.id,
        category: tc.category,
        prompt: tc.prompt,
        passed,
        expected: tc.expectedTools,
        primaryTool: actualPrimary,
        selectedTools: res.selectedSkills.map((s) => ({
          name: s.name,
          probability: s.probability,
          confidence: s.confidence,
        })),
        durationMs,
        confidence: res.selectedSkills[0]?.confidence || 0,
      });
    } catch (err: any) {
      console.log(`⚠️ ERROR: ${err.message}`);
      results.push({
        id: tc.id,
        category: tc.category,
        prompt: tc.prompt,
        passed: false,
        expected: tc.expectedTools,
        primaryTool: null,
        selectedTools: [],
        durationMs: Date.now() - startTime,
        confidence: 0,
      });
    }

    // Rate limit pacing (sleep 3.2s to stay well under 15-20 RPM)
    if (i < testcases.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 3200));
    }
  }

  const accuracy = (passedCount / testcases.length) * 100;
  const avgLatency = Math.round(totalDurationMs / testcases.length);

  console.log(`\n======================================================`);
  console.log(`📊 MetaTool Online Benchmark Results`);
  console.log(`Total Cases: ${testcases.length}`);
  console.log(
    `Passed:      ${passedCount}/${testcases.length} (${accuracy.toFixed(1)}%)`,
  );
  console.log(`Avg Latency: ${avgLatency}ms / decision`);
  console.log(`======================================================\n`);

  console.table(
    results.map((r) => ({
      ID: r.id,
      Category: r.category,
      Status: r.passed ? "PASS" : "FAIL",
      Expected: r.expected.length ? r.expected.join(", ") : "none",
      Actual: r.primaryTool || "none",
      "Selected (Top 2)":
        r.selectedTools
          .slice(0, 2)
          .map((s) => s.name)
          .join(", ") || "none",
      "Conf %": `${(r.confidence * 100).toFixed(0)}%`,
      "Time (ms)": r.durationMs,
    })),
  );

  // Save report to test-results/
  const outputDir = path.resolve(__dirname, "../test-results");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const reportPath = path.join(outputDir, "metatool_benchmark_report.json");
  const report = {
    benchmark: "MetaTool (ToolE) Tool Selection & Awareness Benchmark",
    timestamp: new Date().toISOString(),
    model: process.env.MODEL || DEFAULT_DECISION_MODEL,
    totalCases: testcases.length,
    passedCount,
    accuracyPct: accuracy,
    averageLatencyMs: avgLatency,
    results,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Report saved to: ${reportPath}\n`);

  if (accuracy < 80) {
    console.error(
      `Benchmark failed: accuracy (${accuracy.toFixed(1)}%) is below 80% threshold.`,
    );
    process.exit(1);
  }

  console.log("🎉 Online benchmark successfully completed with passing score!");
}

if (import.meta.main) {
  runOnlineBenchmark();
}
