import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot, agents } from "../lib/otherskill/setup";
import { loadConfig } from "../lib/otherskill/config";
import { saveKey } from "../lib/otherskill/credentials";
import { setup } from "../lib/otherskill/setup";

async function cli(
  root: string,
  args: string[],
  input?: string,
  preload?: string,
) {
  const home = path.join(root, "home"),
    cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const child = Bun.spawn(
    [
      process.execPath,
      ...(preload ? ["--preload", preload] : []),
      path.join(repoRoot, "otherskill.ts"),
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
        MODEL: "",
        OTHERSKILL_CONFIG: "",
        OTHERSKILL_HOME: home,
        TEST_ONLY_KEY: "fake-key-never-echo",
      },
      stdin: input === undefined ? "ignore" : new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(out + err).not.toContain("fake-key-never-echo");
  return { out, err, code, json: () => JSON.parse(out) };
}
test("canonical CLI setup/add/find/config and exposed secondary aliases run in isolated roots, preserving config and complete copies", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otherskill-cli-"));
  try {
    const home = path.join(root, "home"),
      project = path.join(root, "project");
    const preload = path.join(root, "fetch.ts");
    fs.writeFileSync(
      preload,
      `globalThis.fetch=async(_url,init)=>{const body=JSON.parse(init.body);const keys=Object.keys(body.questions.selection.criteria);const probabilities=Object.fromEntries(keys.map(k=>[k,0]));probabilities[keys[0]]=1;if(body.state.stage==='classify'){probabilities.c0=0.5;probabilities.c3=0.5;}return Response.json({answers:{selection:{type:'choice',choice:keys[0],probabilities,confidence:0.9}}});};`,
    );
    expect((await cli(root, ["--help"])).out).toContain("search <query>");
    const dry = await cli(root, [
      "setup",
      "--agent",
      "claude",
      "--scope",
      "global",
      "--key-env",
      "TEST_ONLY_KEY",
      "--non-interactive",
      "--dry-run",
    ]);
    expect(dry.code).toBe(0);
    expect(fs.existsSync(home)).toBe(false);
    for (const agent of agents) {
      const args = [
        "setup",
        "--agent",
        agent,
        "--scope",
        "global",
        "--key-env",
        "TEST_ONLY_KEY",
        "--non-interactive",
      ];
      expect((await cli(root, args)).code).toBe(0);
      expect((await cli(root, args)).code).toBe(0);
    }
    const privateKey = path.join(home, ".config/otherskill/credentials.json");
    expect(fs.statSync(privateKey).mode & 0o777).toBe(0o600);
    const configFile = path.join(
      home,
      ".config/otherskill/otherskill.config.json",
    );
    expect(fs.readFileSync(configFile, "utf8")).not.toContain("fake-key");
    expect((await cli(root, ["config", "show"])).json().key).toBe("configured");
    expect(
      (await cli(root, ["config", "set", "model", "not-a-model"])).code,
    ).toBe(1);
    expect(
      (await cli(root, ["config", "set", "allowPaidModels", "maybe"])).code,
    ).toBe(1);
    expect(
      (await cli(root, ["config", "set", "allowPaidModels", "true"])).code,
    ).toBe(0);
    expect((await cli(root, ["config", "get", "allowPaidModels"])).json()).toBe(
      true,
    );
    expect(
      (
        await cli(root, [
          "config",
          "set",
          "fallbackModels",
          "respan/span-02,~typesafe/jev-latest",
        ])
      ).code,
    ).toBe(0);
    expect(
      (await cli(root, ["config", "get", "fallbackModels"])).json(),
    ).toEqual(["respan/span-02", "~typesafe/jev-latest"]);
    expect(
      (
        await cli(root, [
          "config",
          "set",
          "categories",
          "testing,frontend/ui-ux",
        ])
      ).code,
    ).toBe(0);
    expect((await cli(root, ["config", "get", "categories"])).json()).toEqual([
      "testing",
      "frontend/ui-ux",
    ]);
    expect(
      (
        await cli(root, [
          "setup",
          "--agent",
          "codex",
          "--scope",
          "project",
          "--non-interactive",
          "--categories",
          "frontend/ui-ux,testing",
        ])
      ).code,
    ).toBe(0);
    expect(fs.existsSync(path.join(project, ".codex/hooks.json"))).toBe(true);
    expect(
      fs.existsSync(
        path.join(project, ".agents/skills/use-otherskill/SKILL.md"),
      ),
    ).toBe(true);
    const instructions = path.join(root, "instructions.txt");
    fs.writeFileSync(instructions, "FULL BODY SHOULD NOT BE INJECTED");
    const source = path.join(root, "source");
    expect(
      (
        await cli(
          root,
          [
            "create",
            source,
            "--name",
            "design",
            "--description",
            "Design interfaces fully",
            "--instructions-file",
            instructions,
          ],
          undefined,
          preload,
        )
      ).code,
    ).toBe(0);
    fs.mkdirSync(path.join(source, "assets"));
    fs.writeFileSync(path.join(source, "assets/test.txt"), "complete asset");
    expect((await cli(root, ["add", source], undefined, preload)).code).toBe(0);
    expect(
      (await cli(root, ["install", source, "--category", "testing"])).code,
    ).toBe(0);
    expect(
      (
        await cli(root, [
          "classify",
          source,
          "--category",
          "frontend/ui-ux",
          "--category",
          "testing",
        ])
      ).code,
    ).toBe(0);
    const list = (await cli(root, ["list"])).json();
    expect(list).toHaveLength(2);
    for (const skill of list)
      expect(
        fs.readFileSync(
          path.join(path.dirname(skill.path), "assets/test.txt"),
          "utf8",
        ),
      ).toBe("complete asset");
    for (const agent of agents) {
      const routed = await cli(
        root,
        [
          "find",
          "--agent",
          agent,
          "--prompt",
          "literal $(touch should-not-exist); `echo nope`",
        ],
        undefined,
        preload,
      );
      expect(routed.code).toBe(0);
      expect(routed.out).toContain("Design interfaces fully");
      expect(routed.out).not.toContain("FULL BODY SHOULD NOT BE INJECTED");
    }
    for (const alias of ["find", "hook", "select"]) {
      const output = await cli(
        root,
        [alias, "--agent", "codex"],
        JSON.stringify({ prompt: "Design interfaces" }),
        preload,
      );
      expect(output.code).toBe(0);
      expect(output.out).toContain("Design interfaces fully");
    }
    const doctor = (
      await cli(root, ["doctor", "--live"], undefined, preload)
    ).json();
    expect(doctor.live).toBe("passed");
    expect(fs.existsSync(path.join(project, "should-not-exist"))).toBe(false);
    const launcher = path.join(home, ".local/share/otherskill/bin/otherskill");
    const child = Bun.spawn(
      [
        launcher,
        "find",
        "--agent",
        "codex",
        "--home",
        path.join(root, "empty-home"),
        "--cwd",
        project,
        "--config",
        path.join(project, "otherskill.config.json"),
        "--prompt",
        "Do a task",
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, OPENROUTER_API_KEY: "", OTHERSKILL_CONFIG: "" },
      },
    );
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output).hookSpecificOutput.additionalContext).toBe("");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("setup preserves unrelated native skills/settings/hooks and refuses malformed configuration before writes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otherskill-preserve-"));
  try {
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, ".claude/skills/existing"), {
      recursive: true,
    });

    fs.writeFileSync(
      path.join(home, ".claude/skills/existing/SKILL.md"),
      "existing native skill",
    );
    const file = path.join(home, ".claude/settings.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        model: "keep",
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "echo custom" }] },
          ],
        },
      }),
    );
    const args = ["setup", "--agent", "claude", "--non-interactive"];
    expect((await cli(root, args)).code).toBe(0);
    expect((await cli(root, args)).code).toBe(0);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(data.model).toBe("keep");
    expect(data.hooks.Stop).toHaveLength(1);
    expect(data.hooks.UserPromptSubmit).toHaveLength(2);
    expect(
      fs.readFileSync(
        path.join(home, ".claude/skills/existing/SKILL.md"),
        "utf8",
      ),
    ).toBe("existing native skill");
    fs.writeFileSync(file, "{malformed");
    const before = fs.readFileSync(
      path.join(home, ".config/otherskill/otherskill.config.json"),
      "utf8",
    );
    const result = await cli(root, [
      ...args,
      "--model",
      "other/free-model:free",
    ]);
    expect(result.code).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe("{malformed");
    expect(
      fs.readFileSync(
        path.join(home, ".config/otherskill/otherskill.config.json"),
        "utf8",
      ),
    ).toBe(before);
    for (const agent of agents) {
      const failure = await cli(root, [
        "find",
        "--agent",
        agent,
        "--config",
        file,
        "--prompt",
        "PRIVATE PROMPT",
      ]);
      expect(failure.code).toBe(0);
      expect(failure.out + failure.err).not.toContain("PRIVATE PROMPT");
      const data = failure.json();
      if (agent === "antigravity") expect(data.injectSteps).toEqual([]);
      else if (agent === "opencode") expect(data.context).toBe("");
      else expect(data.hookSpecificOutput.additionalContext).toBe("");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("explicit global setup loads global settings and failed routing preserves protocols across argument forms", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otherskill-cli-flags-"));
  try {
    expect(
      (
        await cli(root, [
          "config",
          "set",
          "model",
          "global/model:free",
          "--scope",
          "global",
        ])
      ).code,
    ).toBe(0);
    expect(
      (
        await cli(root, [
          "config",
          "set",
          "model",
          "project/model:free",
          "--scope",
          "project",
        ])
      ).code,
    ).toBe(0);
    expect(
      (
        await cli(root, [
          "setup",
          "--non-interactive",
          "--agent",
          "codex",
          "--scope",
          "global",
          "--no-companion",
        ])
      ).code,
    ).toBe(0);
    expect(
      (await cli(root, ["config", "get", "model", "--scope", "global"])).json(),
    ).toBe("global/model:free");
    expect((await cli(root, ["config", "get", "model"])).json()).toBe(
      "project/model:free",
    );
    for (const args of [
      ["find", "--agent=antigravity", "--unknown-option"],
      ["--agent", "antigravity", "find", "--unknown-option"],
    ]) {
      const result = await cli(root, args);
      expect(result.code).toBe(0);
      expect(result.json()).toEqual({ injectSteps: [] });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("generated launcher ignores project .env but doctor reports explicit and saved credential sources", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "otherskill-launcher-env-"),
  );
  try {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, ".env"),
      "OPENROUTER_API_KEY=bogus-from-env-file\n",
    );
    const config = loadConfig({ home, cwd: project });
    setup(config, "codex");
    saveKey(home, "saved-test-key");
    const launcher = path.join(home, ".local/share/otherskill/bin/otherskill");
    const runDoctor = async (env: NodeJS.ProcessEnv) => {
      const child = Bun.spawn(
        [launcher, "doctor", "--home", home, "--cwd", project],
        {
          cwd: project,
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(err).toBe("");
      return JSON.parse(out) as { credentialSource?: string };
    };
    const withoutExport: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete withoutExport.OPENROUTER_API_KEY;
    expect((await runDoctor(withoutExport)).credentialSource).toBe(
      "credentials_file",
    );
    expect(
      (
        await runDoctor({
          ...withoutExport,
          OPENROUTER_API_KEY: "explicit-test-key",
        })
      ).credentialSource,
    ).toBe("env");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
