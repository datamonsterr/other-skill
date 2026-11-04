#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { selectSkills } from "../index";
import { DEFAULT_DECISION_MODEL } from "../lib/decision_models";

interface GoldenTestCase {
  id: string;
  prompt: string;
  expectedSkills: string[];
  category: string;
}

interface EvaluationResult {
  id: string;
  category: string;
  passed: boolean;
  expected: string[];
  actualPrimary: string | null;
  actualSelected: string[];
  confidence: number;
  durationMs: number;
}

async function runGoldenEvaluation() {
  const testsetPath = path.resolve(__dirname, "../golden_set/testset.json");
  if (!fs.existsSync(testsetPath)) {
    console.error(`Error: Golden testset not found at ${testsetPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(testsetPath, "utf-8");
  const testcases: GoldenTestCase[] = JSON.parse(raw);

  console.log(`\n======================================================`);
  console.log(`🚀 Starting OtherSkill Golden Evaluation`);
  console.log(`Total Cases: ${testcases.length}`);
  console.log(`Model: ${process.env.MODEL || DEFAULT_DECISION_MODEL}`);
  console.log(`======================================================\n`);

  const results: EvaluationResult[] = [];
  let passedCount = 0;

  for (let i = 0; i < testcases.length; i++) {
    const tc = testcases[i];
    if (!tc) continue;
    process.stdout.write(
      `[${i + 1}/${testcases.length}] Evaluating ${tc.id} (${tc.category})... `,
    );

    const startTime = Date.now();
    try {
      const res = await selectSkills({
        userPrompt: tc.prompt,
        options: { threshold: 0.05, maxSkills: 3 },
      });

      const durationMs = Date.now() - startTime;
      const actualSelected = res.selectedSkills.map((s) => s.name);
      const actualPrimary = res.primarySkill;

      // Check if primary skill or any selected skill matches expected
      const passed =
        (actualPrimary && tc.expectedSkills.includes(actualPrimary)) ||
        actualSelected.some((s) => tc.expectedSkills.includes(s));

      if (passed) {
        passedCount++;
        console.log(`✅ PASS (${durationMs}ms) -> [${actualPrimary}]`);
      } else {
        console.log(
          `❌ FAIL (${durationMs}ms) -> Expected: ${JSON.stringify(tc.expectedSkills)}, Got: [${actualPrimary}]`,
        );
      }

      results.push({
        id: tc.id,
        category: tc.category,
        passed,
        expected: tc.expectedSkills,
        actualPrimary,
        actualSelected,
        confidence: res.selectedSkills[0]?.confidence || 0,
        durationMs,
      });
    } catch (err: any) {
      console.log(`⚠️ ERROR: ${err.message}`);
      results.push({
        id: tc.id,
        category: tc.category,
        passed: false,
        expected: tc.expectedSkills,
        actualPrimary: null,
        actualSelected: [],
        confidence: 0,
        durationMs: Date.now() - startTime,
      });
    }

    // Rate limit pacing (15-20 RPM -> sleep ~3s between queries if more items remain)
    if (i < testcases.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 3200));
    }
  }

  const accuracy = (passedCount / testcases.length) * 100;
  console.log(`\n======================================================`);
  console.log(`📊 Golden Set Evaluation Summary`);
  console.log(
    `Passed: ${passedCount}/${testcases.length} (${accuracy.toFixed(1)}%)`,
  );
  console.log(`======================================================\n`);

  console.table(
    results.map((r) => ({
      ID: r.id,
      Category: r.category,
      Status: r.passed ? "PASS" : "FAIL",
      Expected: r.expected.join(", "),
      Actual: r.actualPrimary || "none",
      "Conf %": `${(r.confidence * 100).toFixed(0)}%`,
      "Time (ms)": r.durationMs,
    })),
  );

  if (accuracy < 80) {
    console.error(
      `Evaluation failed: accuracy (${accuracy.toFixed(1)}%) is below 80% threshold.`,
    );
    process.exit(1);
  }

  console.log("🎉 Evaluation successfully completed!");
}

if (import.meta.main) {
  runGoldenEvaluation();
}
