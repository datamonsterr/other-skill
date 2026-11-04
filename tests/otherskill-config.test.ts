import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../lib/otherskill/config";

test("config supports nested stable category IDs and rejects traversal, duplicate IDs, paid models and native overlap", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otherskill-config-"));
  const configPath = path.join(root, "otherskill.config.json");
  const write = (extra: object) =>
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        categories: [
          { id: "frontend/ui-ux", description: "Design interfaces" },
        ],
        ...extra,
      }),
    );
  try {
    write({});
    expect(
      loadConfig({ configPath, home: root, cwd: root }).categories[0]?.id,
    ).toBe("frontend/ui-ux");
    for (const bankPath of [
      ".agents/skills/bank",
      ".claude/skills",
      ".",
      ".config/opencode/skills/bank",
    ]) {
      write({ bankPath });
      expect(() => loadConfig({ configPath, home: root, cwd: root })).toThrow(
        "bank",
      );
    }
    for (const model of [
      "not-a-model",
      ["inception/mercury-decide:free", "paid/model"],
      "x/y:free,paid/model",
      "x/y:nitro",
    ]) {
      write({ model });
      expect(() => loadConfig({ configPath, home: root, cwd: root })).toThrow();
    }
    // Paid ids load; the opt-in is enforced when a request is sent.
    write({ model: "paid/model", allowPaidModels: true });
    expect(loadConfig({ configPath, home: root, cwd: root }).model).toBe(
      "paid/model",
    );
    for (const fallbackModels of [
      ["a/b", "a/b"],
      ["a/b", "c/d", "e/f", "g/h", "i/j"],
      ["bad"],
    ]) {
      write({ fallbackModels });
      expect(() => loadConfig({ configPath, home: root, cwd: root })).toThrow();
    }
    write({ categories: [{ id: "../escape", description: "bad" }] });
    expect(() => loadConfig({ configPath, home: root, cwd: root })).toThrow();
    write({
      categories: [
        { id: "a", description: "a" },
        { id: "a", description: "duplicate" },
      ],
    });
    expect(() => loadConfig({ configPath, home: root, cwd: root })).toThrow();
    write({ bankPath: path.join(root, "alias/bank") });
    fs.mkdirSync(path.join(root, ".agents/skills"), { recursive: true });
    fs.symlinkSync(path.join(root, ".agents/skills"), path.join(root, "alias"));
    expect(() => loadConfig({ configPath, home: root, cwd: root })).toThrow(
      "bank",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit, nearest-project and global configuration precedence and global scope reads are deterministic", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otherskill-precedence-"));
  try {
    const home = path.join(root, "home"),
      cwd = path.join(root, "project/subdir");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(path.join(home, ".config/otherskill"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".config/otherskill/otherskill.config.json"),
      JSON.stringify({ model: "global/model:free" }),
    );
    fs.writeFileSync(
      path.join(root, "project/otherskill.config.json"),
      JSON.stringify({ model: "project/model:free" }),
    );
    const explicit = path.join(root, "explicit.json");
    fs.writeFileSync(
      explicit,
      JSON.stringify({ model: "explicit/model:free" }),
    );
    expect(loadConfig({ home, cwd }).model).toBe("project/model:free");
    expect(loadConfig({ home, cwd, scope: "global" }).model).toBe(
      "global/model:free",
    );
    expect(loadConfig({ home, cwd, configPath: explicit }).model).toBe(
      "explicit/model:free",
    );
    expect(loadConfig({ home, cwd: path.join(root, "elsewhere") }).model).toBe(
      "global/model:free",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bank path traversal and dangling aliases into native discovery are rejected before setup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otherskill-dangling-"));
  try {
    const file = path.join(root, "otherskill.config.json");
    fs.writeFileSync(file, JSON.stringify({ bankPath: "../escape" }));
    expect(() =>
      loadConfig({ home: root, cwd: root, configPath: file }),
    ).toThrow();
    fs.symlinkSync(path.join(root, ".agents/skills"), path.join(root, "alias"));
    fs.writeFileSync(
      file,
      JSON.stringify({ bankPath: path.join(root, "alias/bank") }),
    );
    expect(() =>
      loadConfig({ home: root, cwd: root, configPath: file }),
    ).toThrow("bank");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
