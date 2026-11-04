import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../lib/otherskill/config";
import {
  TerminalSession,
  menu,
  targetChoices,
  type MenuResult,
} from "../lib/otherskill/menu";
import {
  applySetup,
  canonicalCompanionDir,
  companionDir,
  planMultiSetup,
  planSetup,
  type setupTargets,
} from "../lib/otherskill/setup";
import { checkAgentStatus } from "../scripts/setup-agent";

const repo = path.resolve(import.meta.dir, "..");
const companionSource = path.join(
  repo,
  "examples/polly/skills/use-otherskill/SKILL.md",
);
const companionContent = fs.readFileSync(companionSource, "utf8");

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => (text += chunk.toString()));
  return { input, output, transcript: () => text };
}

async function driveCheckbox(
  keys: string,
  initial: (typeof setupTargets)[number][] = ["agents"],
) {
  const { input, output, transcript } = streams();
  const session = new TerminalSession(input, output, true);
  const result = session.checkbox({
    title: "Install targets:",
    choices: targetChoices,
    initial,
  });
  input.write(keys);
  try {
    return { selected: await result, transcript: transcript() };
  } finally {
    session.close();
  }
}

async function driveMenu(
  keys: string,
  config: ReturnType<typeof loadConfig>,
): Promise<{ result: MenuResult; transcript: string }> {
  const { input, output, transcript } = streams();
  const result = menu(config, "setup", {
    input,
    output,
    terminal: true,
  });
  input.write(keys);
  try {
    return { result: await result, transcript: transcript() };
  } finally {
    input.end();
  }
}

function configFor(home: string, cwd: string) {
  fs.mkdirSync(cwd, { recursive: true });
  return loadConfig({ home, cwd });
}

describe("interactive target checkbox", () => {
  it("defaults to .agents and responds to real arrow, space and enter key bytes", async () => {
    // Down to Claude, toggle it; down to Codex, toggle it; confirm.
    const { selected, transcript } = await driveCheckbox("\x1b[B \x1b[B \r");
    expect(selected).toEqual(["agents", "claude", "codex"]);
    expect(transcript).toContain("[x] .agents");
    expect(transcript).toContain("[x] Claude");
    expect(transcript).toContain("[x] Codex");
    expect(transcript).toContain("[ ] Antigravity");
    expect(transcript).toContain("[ ] OpenCode");
  });

  it("supports SPACE deselect and refuses to confirm an empty target list", async () => {
    const { selected, transcript } = await driveCheckbox(" \r \r");
    expect(selected).toEqual(["agents"]);
    expect(transcript).toContain("Select at least one target.");
  });

  it("wraps with up/down and also accepts j/k navigation", async () => {
    const { selected } = await driveCheckbox(
      "\x1b[A " + "j" + "j" + " " + "\r",
    );
    expect(selected).toEqual(["agents", "claude", "opencode"]);
  });

  it("buffers split ESC and CSI arrow sequences across input chunks", async () => {
    const { input, output, transcript } = streams();
    const session = new TerminalSession(input, output, true);
    const result = session.checkbox({
      title: "Install targets:",
      choices: targetChoices,
      initial: ["agents"],
    });
    for (const chunk of ["\x1b", "[", "B", " "]) {
      input.write(chunk);
      await Bun.sleep(1);
    }
    input.write("\r");
    try {
      expect(await result).toEqual(["agents", "claude"]);
      expect(transcript()).toContain("[x] Claude");
    } finally {
      session.close();
    }
  });

  it("marks .agents required while a harness is selected and cannot deselect it", async () => {
    const { selected, transcript } = await driveCheckbox(
      "\x1b[B\x1b[B \x1b[A\x1b[A \r",
    );
    expect(selected).toEqual(["agents", "codex"]);
    expect(transcript).toContain(".agents (required)");
  });
});

describe("interactive setup menu", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "otherskill-menu-test-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("confirms the default .agents target and companion without prompting separately", async () => {
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    const config = configFor(home, cwd);
    // Confirm targets, accept scope, blank key and model, allow paid, categories, apply.
    const { result, transcript } = await driveMenu("\r\r\r\ry\r\r\r", config);
    expect(transcript).toContain("Allow paid decision models?");
    expect(result.allowPaidModels).toBe(true);
    expect(result.targets).toEqual(["agents"]);
    expect(result.agents).toEqual([]);
    expect(result.agent).toBeUndefined();
    expect(result.companion).toBe(true);
    expect(transcript).not.toContain("Install native use-otherskill?");
    expect(transcript).toContain("[x] .agents");
  });

  it("prechecks saved harnesses on rerun and preserves the saved primary", async () => {
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    const config: ReturnType<typeof loadConfig> = {
      ...configFor(home, cwd),
      agent: "opencode",
      agents: ["opencode", "codex"],
    };
    // Accept all defaults (paid models stay off); saved targets must remain selected.
    const { result, transcript } = await driveMenu("\r\r\r\r\r\r\r", config);
    expect(result.allowPaidModels).toBeUndefined();
    expect(result.targets).toEqual(["agents", "codex", "opencode"]);
    expect(result.agents).toEqual(["opencode", "codex"]);
    expect(result.agent).toBe("opencode");
    expect(result.companion).toBe(true);
    expect(transcript).toContain("[x] Codex");
    expect(transcript).toContain("[x] OpenCode");
  });

  it("selects multiple harnesses and the shared canonical companion", async () => {
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    const config = configFor(home, cwd);
    // Claude and OpenCode while keeping the default .agents target.
    const { result } = await driveMenu(
      "\x1b[B " + "\x1b[B\x1b[B\x1b[B " + "\r\r\r\r\r\r\r",
      config,
    );
    expect(result.targets).toEqual(["agents", "claude", "opencode"]);
    expect(result.agents).toEqual(["claude", "opencode"]);
    expect(result.agent).toBe("claude");
    expect(result.companion).toBe(true);
  });
});

describe("setup migrates shipped companion versions safely", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(
      path.join(os.tmpdir(), "otherskill-companion-migration-"),
    );
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("replaces the formatted shipped companion in the canonical directory", () => {
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    const config = configFor(home, cwd);
    const canonical = path.join(canonicalCompanionDir(home), "SKILL.md");
    const formatted = companionContent.replace(/^---\n/, "---\n\n");
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, formatted);

    applySetup(planSetup(config, "codex"));

    expect(fs.readFileSync(canonical, "utf8")).toBe(companionContent);
  });

  it("replaces a formatted shipped Claude copy but refuses an edited companion", () => {
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    const config = configFor(home, cwd);
    const claude = path.join(companionDir("claude", home), "SKILL.md");
    const formatted = companionContent.replace(/^---\n/, "---\n\n");
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, formatted);

    applySetup(planSetup(config, "claude"));

    expect(fs.readFileSync(claude, "utf8")).toBe(companionContent);
    fs.writeFileSync(claude, `${companionContent}\nMy notes`);
    expect(() => planSetup(config, "claude")).toThrow(
      "refusing to replace modified or extended native companion",
    );
  });
});

it("generated launcher disables Bun env-file loading and inspection flags an old managed launcher", async () => {
  const { inspectInstallation, launcherPath } = await import(
    "../lib/otherskill/setup"
  );
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "otherskill-env-launcher-"),
  );
  try {
    const config = configFor(
      path.join(root, "home"),
      path.join(root, "project"),
    );
    applySetup(planSetup(config, "codex"));
    const launcher = launcherPath(config.home);
    expect(fs.readFileSync(launcher, "utf8")).toContain(" --no-env-file ");

    fs.writeFileSync(
      launcher,
      `#!/bin/sh\n# OtherSkill managed launcher\nexec ${process.execPath} '${path.join(repo, "otherskill.ts")}' "$@"\n`,
    );
    const inspected = inspectInstallation(config, "codex");
    expect(inspected.configured).toBe(false);
    expect(inspected.diagnostics).toContain("launcher_loads_env_file");

    applySetup(planSetup(config, "codex"));
    expect(fs.readFileSync(launcher, "utf8")).toContain(" --no-env-file ");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("multi-target setup and shared companion links", () => {
  let root: string;
  let home: string;
  let cwd: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "otherskill-multi-setup-"));
    home = path.join(root, "home");
    cwd = path.join(root, "project");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("installs canonical .agents content, Claude symlink and multiple hooks idempotently", () => {
    const config = configFor(home, cwd);
    const unrelated = path.join(home, ".agents/skills/my-skill/SKILL.md");
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fs.writeFileSync(unrelated, "keep my native skill");
    const claudeSettings = path.join(home, ".claude/settings.json");
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.writeFileSync(
      claudeSettings,
      JSON.stringify({
        model: "keep",
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "original" }] },
          ],
        },
      }),
    );
    const plan = planMultiSetup(config, ["claude", "codex", "opencode"], {
      scope: "global",
    });
    expect(plan.targets).toEqual(["agents", "claude", "codex", "opencode"]);
    applySetup(plan);
    const canonical = path.join(canonicalCompanionDir(home), "SKILL.md");
    expect(fs.readFileSync(canonical, "utf8")).toBe(companionContent);
    const link = companionDir("claude", home);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(
      fs.realpathSync(canonicalCompanionDir(home)),
    );
    for (const hook of [
      path.join(home, ".claude/settings.json"),
      path.join(home, ".codex/hooks.json"),
      path.join(home, ".config/opencode/plugins/otherskill.ts"),
    ])
      expect(fs.existsSync(hook)).toBe(true);
    expect(fs.readFileSync(unrelated, "utf8")).toBe("keep my native skill");
    const settings = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
    expect(settings.model).toBe("keep");
    expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
    expect(JSON.stringify(settings)).toContain("original");

    // A rerun neither duplicates hooks nor replaces the symlink with a copy.
    const rerun = planMultiSetup(config, ["claude", "codex", "opencode"], {
      scope: "global",
    });
    applySetup(rerun);
    expect(
      JSON.parse(fs.readFileSync(claudeSettings, "utf8")).hooks
        .UserPromptSubmit,
    ).toHaveLength(2);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(
      fs.readdirSync(path.dirname(path.dirname(unrelated))).sort(),
    ).toEqual(["my-skill", "use-otherskill"]);
  });

  it("migrates an untouched legacy Claude companion copy to a symlink", () => {
    const legacy = companionDir("claude", home);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "SKILL.md"), companionContent);
    const config = configFor(home, cwd);
    applySetup(planSetup(config, "claude", { scope: "global" }));
    expect(fs.lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(legacy)).toBe(
      fs.realpathSync(canonicalCompanionDir(home)),
    );
  });

  it("refuses modified copies and symlink collisions without changing them", () => {
    const config = configFor(home, cwd);
    const legacy = companionDir("claude", home);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "SKILL.md"), "user modified companion");
    expect(() => planSetup(config, "claude", { scope: "global" })).toThrow(
      /modified or extended native companion/,
    );
    expect(fs.readFileSync(path.join(legacy, "SKILL.md"), "utf8")).toBe(
      "user modified companion",
    );

    const other = path.join(root, "other-companion");
    fs.mkdirSync(other);
    fs.rmSync(legacy, { recursive: true, force: true });
    fs.symlinkSync(other, legacy);
    expect(() => planSetup(config, "claude", { scope: "global" })).toThrow(
      "existing native companion symlink",
    );
    expect(fs.readlinkSync(legacy)).toBe(other);

    const canonical = canonicalCompanionDir(home);
    fs.rmSync(legacy, { force: true });
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.symlinkSync(other, canonical);
    expect(() => planSetup(config, "codex", { scope: "global" })).toThrow(
      "canonical companion symlink collision",
    );
    fs.rmSync(canonical, { force: true });
  });

  it("gives preservation guidance for a legacy companion with extra files", () => {
    const config = configFor(home, cwd);
    const legacy = companionDir("claude", home);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "SKILL.md"), companionContent);
    fs.writeFileSync(path.join(legacy, "notes.txt"), "keep my notes");
    expect(() => planSetup(config, "claude", { scope: "global" })).toThrow(
      /move it aside to preserve it/,
    );
    expect(fs.readFileSync(path.join(legacy, "notes.txt"), "utf8")).toBe(
      "keep my notes",
    );
    expect(fs.readFileSync(path.join(legacy, "SKILL.md"), "utf8")).toBe(
      companionContent,
    );
  });

  it("recognizes a valid Claude-only legacy companion without canonical .agents", () => {
    const legacy = companionDir("claude", home);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "SKILL.md"), companionContent);
    expect(fs.existsSync(canonicalCompanionDir(home))).toBe(false);
    const status = checkAgentStatus({
      homeDir: home,
      projectRoot: cwd,
      scope: "global",
    });
    expect(status.claude.skill).toBe(true);
    expect(status.codex.skill).toBe(false);
  });

  it("keeps --no-companion hooks-only and preserves pre-existing shared skills", () => {
    const config = configFor(home, cwd);
    const skill = path.join(home, ".agents/skills/existing/SKILL.md");
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, "existing");
    applySetup(
      planSetup(config, "claude", {
        scope: "global",
        companion: false,
      }),
    );
    expect(fs.existsSync(path.join(home, ".claude/settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude/skills"))).toBe(false);
    expect(fs.existsSync(canonicalCompanionDir(home))).toBe(false);
    expect(fs.readFileSync(skill, "utf8")).toBe("existing");
  });
});

describe("headless CLI compatibility", () => {
  it("accepts --agents for multiple hooks and keeps --agent single-target", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "otherskill-agents-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    fs.mkdirSync(cwd, { recursive: true });
    const run = async (args: string[]) => {
      const child = Bun.spawn(
        [
          process.execPath,
          path.join(repo, "otherskill.ts"),
          ...args,
          "--home",
          home,
          "--cwd",
          cwd,
        ],
        {
          cwd,
          env: {
            ...process.env,
            OPENROUTER_API_KEY: "",
            OTHERSKILL_CONFIG: "",
            OTHERSKILL_HOME: home,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { out, err, code, json: () => JSON.parse(out) };
    };
    try {
      const multi = await run([
        "setup",
        "--non-interactive",
        "--agents",
        "claude,codex",
        "--scope",
        "global",
      ]);
      expect(multi.code).toBe(0);
      expect(multi.json().agents).toEqual(["claude", "codex"]);
      expect(multi.json().targets).toEqual(["agents", "claude", "codex"]);
      expect(fs.existsSync(path.join(home, ".claude/settings.json"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(home, ".codex/hooks.json"))).toBe(true);
      expect(fs.lstatSync(companionDir("claude", home)).isSymbolicLink()).toBe(
        true,
      );
      const single = await run([
        "setup",
        "--non-interactive",
        "--agent",
        "codex",
        "--scope",
        "project",
      ]);
      expect(single.code).toBe(0);
      expect(single.json().agents).toEqual(["codex"]);
      expect(fs.existsSync(path.join(cwd, ".codex/hooks.json"))).toBe(true);
      // A config edit plus --apply must use the newly selected agent.
      const configured = await run([
        "config",
        "set",
        "agent",
        "opencode",
        "--apply",
        "--scope",
        "global",
      ]);
      expect(configured.code).toBe(0);
      expect(configured.json().agent).toBe("opencode");
      expect(configured.json().agents).toEqual(["opencode"]);
      expect(
        fs.existsSync(
          path.join(home, ".config/opencode/plugins/otherskill.ts"),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});

describe("headless target precedence and persistence", () => {
  let root: string;
  let home: string;
  let cwd: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "otherskill-precedence-"));
    home = path.join(root, "home");
    cwd = path.join(root, "project");
    fs.mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function env(
    extra: Record<string, string> = {},
  ): Record<string, string | undefined> {
    const result: Record<string, string | undefined> = {
      ...process.env,
      OPENROUTER_API_KEY: "",
      OTHERSKILL_CONFIG: "",
      OTHERSKILL_HOME: home,
      ...extra,
    };
    for (const key of [
      "CLAUDE_CODE",
      "CLAUDE_PLUGIN_ROOT",
      "CODEX_THREAD_ID",
      "CODEX",
      "ANTIGRAVITY",
      "GEMINI_CLI",
      "OPENCODE",
      "OPENCODE_VERSION",
    ])
      delete result[key];
    return result;
  }

  async function run(args: string[], extra: Record<string, string> = {}) {
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(repo, "otherskill.ts"),
        ...args,
        "--home",
        home,
        "--cwd",
        cwd,
      ],
      {
        cwd,
        env: env(extra),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, err, code, json: () => JSON.parse(out) };
  }

  const savedConfig = () =>
    JSON.parse(
      fs.readFileSync(
        path.join(home, ".config/otherskill/otherskill.config.json"),
        "utf8",
      ),
    );

  it("persists --agents primary and reapply honors the full selected set", async () => {
    const setup = await run([
      "setup",
      "--non-interactive",
      "--agents",
      "codex,opencode",
      "--scope",
      "global",
    ]);
    expect(setup.code).toBe(0);
    expect(setup.json().agent).toBe("codex");
    expect(setup.json().agents).toEqual(["codex", "opencode"]);
    expect(setup.json().targets).toEqual(["agents", "codex", "opencode"]);
    expect(savedConfig().agent).toBe("codex");
    expect(savedConfig().agents).toEqual(["codex", "opencode"]);

    // A config edit without --apply still reports the saved primary.
    const noApply = await run([
      "config",
      "set",
      "model",
      "inception/mercury-decide:free",
      "--scope",
      "global",
    ]);
    expect(noApply.code).toBe(0);
    expect(noApply.json().agent).toBe("codex");
    expect(noApply.json().agents).toEqual(["codex", "opencode"]);

    // Reapply must install both saved targets, not just the primary.
    const reapplied = await run([
      "config",
      "set",
      "model",
      "inception/mercury-decide:free",
      "--apply",
      "--scope",
      "global",
    ]);
    expect(reapplied.code).toBe(0);
    expect(reapplied.json().agent).toBe("codex");
    expect(reapplied.json().agents).toEqual(["codex", "opencode"]);
    expect(reapplied.json().targets).toEqual(["agents", "codex", "opencode"]);
    expect(fs.existsSync(path.join(home, ".codex/hooks.json"))).toBe(true);
    expect(
      fs.existsSync(path.join(home, ".config/opencode/plugins/otherskill.ts")),
    ).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude/settings.json"))).toBe(false);
  }, 30000);

  it("explicit --agents outrank CLAUDE_CODE detection and later apply", async () => {
    const setup = await run(
      [
        "setup",
        "--non-interactive",
        "--agents",
        "codex,opencode",
        "--scope",
        "global",
      ],
      { CLAUDE_CODE: "1" },
    );
    expect(setup.code).toBe(0);
    expect(setup.json().agent).toBe("codex");
    expect(setup.json().agents).toEqual(["codex", "opencode"]);
    expect(savedConfig().agent).toBe("codex");
    expect(savedConfig().agents).toEqual(["codex", "opencode"]);
    expect(fs.existsSync(path.join(home, ".claude/settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codex/hooks.json"))).toBe(true);

    const doctor = await run(["doctor"], { CLAUDE_CODE: "1" });
    expect(doctor.code).toBe(0);
    const harnesses = doctor.json().harnesses as Array<{
      agent: string;
      configured: boolean;
    }>;
    expect(
      harnesses.find((entry) => entry.agent === "claude")?.configured,
    ).toBe(false);
    expect(harnesses.find((entry) => entry.agent === "codex")?.configured).toBe(
      true,
    );

    // Detection must not turn a later reapply into an unrequested Claude install.
    const reapplied = await run(
      [
        "config",
        "set",
        "model",
        "inception/mercury-decide:free",
        "--apply",
        "--scope",
        "global",
      ],
      { CLAUDE_CODE: "1" },
    );
    expect(reapplied.code).toBe(0);
    expect(reapplied.json().agents).toEqual(["codex", "opencode"]);
    expect(fs.existsSync(path.join(home, ".claude/settings.json"))).toBe(false);
  }, 30000);

  it("rejects combining --agent and --agents before any writes", async () => {
    const result = await run([
      "setup",
      "--non-interactive",
      "--agent",
      "codex",
      "--agents",
      "claude",
      "--scope",
      "global",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("either --agent or --agents");
    expect(
      fs.existsSync(
        path.join(home, ".config/otherskill/otherskill.config.json"),
      ),
    ).toBe(false);
    expect(fs.existsSync(path.join(home, ".codex/hooks.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude/settings.json"))).toBe(false);
  }, 30000);

  it("dedupes --agents and excludes .agents targets under --no-companion", async () => {
    const result = await run([
      "setup",
      "--non-interactive",
      "--agents",
      "codex,codex,opencode",
      "--no-companion",
      "--scope",
      "global",
    ]);
    expect(result.code).toBe(0);
    expect(result.json().agents).toEqual(["codex", "opencode"]);
    expect(result.json().targets).toEqual(["codex", "opencode"]);
    expect(savedConfig().agents).toEqual(["codex", "opencode"]);
    expect(fs.existsSync(canonicalCompanionDir(home))).toBe(false);
    expect(
      fs.existsSync(path.join(home, ".claude/skills/use-otherskill")),
    ).toBe(false);
  }, 30000);
});
