#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { selectSkills } from "../index";
import { DEFAULT_DECISION_MODEL } from "../lib/decision_models";

interface ComplexTestCase {
  id: string;
  title: string;
  type: "multi-step" | "continuation";
  prompt: string;
  requiredSkills: string[];
  acceptableSkills: string[];
  category: string;
  minSkillsExpected: number;
}

interface ComplexEvalResult {
  id: string;
  type: string;
  passed: boolean;
  required: string[];
  selected: string[];
  matchedCount: number;
  durationMs: number;
}

async function runComplexEvaluation() {
  const testsetPath = path.resolve(
    __dirname,
    "../golden_set/complex_testset.json",
  );
  if (!fs.existsSync(testsetPath)) {
    console.error(`Error: Complex testset not found at ${testsetPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(testsetPath, "utf-8");
  const testcases: ComplexTestCase[] = JSON.parse(raw);

  console.log(`\n======================================================`);
  console.log(`🚀 Starting OtherSkill Complex & Multi-Step Evaluation`);
  console.log(`Total Cases: ${testcases.length}`);
  console.log(`Model: ${process.env.MODEL || DEFAULT_DECISION_MODEL}`);
  console.log(`======================================================\n`);

  const results: ComplexEvalResult[] = [];
  let passedCount = 0;

  for (let i = 0; i < testcases.length; i++) {
    const tc = testcases[i];
    if (!tc) continue;
    process.stdout.write(
      `[${i + 1}/${testcases.length}] Evaluating ${tc.id} [${tc.type}]... `,
    );

    const startTime = Date.now();
    try {
      const res = await selectSkills({
        userPrompt: tc.prompt,
        options: { threshold: 0.03, maxSkills: 4, multiStep: true },
      });

      const durationMs = Date.now() - startTime;
      const actualSelected = res.selectedSkills.map((s) => s.name);
      const _allValidExpected = new Set([
        ...tc.requiredSkills,
        ...tc.acceptableSkills,
      ]);

      // Count how many required skills or their acceptable alternatives were matched
      const matchedSkills = tc.requiredSkills.filter(
        (req) =>
          actualSelected.includes(req) ||
          tc.acceptableSkills.some((acc) => actualSelected.includes(acc)),
      );

      // Pass if at least minSkillsExpected matched from the expected list and multiple skills were selected
      const passed =
        actualSelected.length >= tc.minSkillsExpected &&
        matchedSkills.length >= tc.minSkillsExpected;

      if (passed) {
        passedCount++;
        console.log(
          `✅ PASS (${durationMs}ms) -> [${actualSelected.join(", ")}]`,
        );
      } else {
        console.log(
          `❌ FAIL (${durationMs}ms) -> Required: ${JSON.stringify(tc.requiredSkills)}, Selected: [${actualSelected.join(", ")}]`,
        );
      }

      results.push({
        id: tc.id,
        type: tc.type,
        passed,
        required: tc.requiredSkills,
        selected: actualSelected,
        matchedCount: matchedSkills.length,
        durationMs,
      });
    } catch (err: any) {
      console.log(`⚠️ ERROR: ${err.message}`);
      results.push({
        id: tc.id,
        type: tc.type,
        passed: false,
        required: tc.requiredSkills,
        selected: [],
        matchedCount: 0,
        durationMs: Date.now() - startTime,
      });
    }

    // Pacing delay (15-20 RPM limit)
    if (i < testcases.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 3200));
    }
  }

  const accuracy = (passedCount / testcases.length) * 100;
  console.log(`\n======================================================`);
  console.log(`📊 Complex Multi-Step Evaluation Summary`);
  console.log(
    `Passed: ${passedCount}/${testcases.length} (${accuracy.toFixed(1)}%)`,
  );
  console.log(`======================================================\n`);

  console.table(
    results.map((r) => ({
      ID: r.id,
      Type: r.type,
      Status: r.passed ? "PASS" : "FAIL",
      "Required Skills": r.required.join(", "),
      "Selected Skills": r.selected.join(", "),
      Matched: r.matchedCount,
      "Time (ms)": r.durationMs,
    })),
  );

  if (accuracy < 80) {
    console.error(
      `Complex evaluation failed: accuracy (${accuracy.toFixed(1)}%) is below 80% threshold.`,
    );
    process.exit(1);
  }

  console.log("🎉 Complex evaluation successfully completed!");
}

if (import.meta.main) {
  runComplexEvaluation();
}
