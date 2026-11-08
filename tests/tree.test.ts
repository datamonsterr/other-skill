import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "../lib/otherskill/setup";
import { loadConfig } from "../lib/otherskill/config";
import { collectSkillTree, renderSkillTree } from "../lib/otherskill/tree";

let root: string, home: string, cwd: string;

function skill(dir: string, name: string, description = `${name} skill`) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody\n`,
  );
}

async function cli(args: string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      path.join(repoRoot, "otherskill.ts"),
      ...args,
      "--home",
      home,
      "--cwd",
      cwd,
    ],
    {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: home,
        OPENROUTER_API_KEY: "",
        OTHERSKILL_CONFIG: "",
        OTHERSKILL_HOME: home,
      },
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
}

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "otherskill-tree-")),
  );
  home = path.join(root, "home");
  cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });

  // Claude plugin from a marketplace, user scope.
  const install = path.join(
    home,
    ".claude/plugins/cache/caveman/caveman/2.7.0",
  );
  fs.mkdirSync(path.join(install, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(install, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "caveman", version: "2.7.0" }),
  );
  skill(path.join(install, "skills/caveman"), "caveman");
  skill(path.join(install, "skills/caveman-review"), "caveman-review");
  // Project-local plugin for another project must not appear.
  const other = path.join(home, ".claude/plugins/cache/hq/hq/0.2.0");
  skill(path.join(other, "skills/status"), "status");
  fs.writeFileSync(
    path.join(home, ".claude/plugins/installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "caveman@caveman": [
          { scope: "user", installPath: install, version: "2.7.0" },
        ],
        "hq@claude-hq": [
          {
            scope: "local",
            installPath: other,
            version: "0.2.0",
            projectPath: path.join(root, "elsewhere"),
          },
        ],
      },
    }),
  );

  // Native skills: user, shared, synced, project.
  skill(path.join(home, ".agents/skills/use-otherskill"), "use-otherskill");
  skill(path.join(home, ".claude/skills/tokenimum"), "tokenimum");
  fs.symlinkSync(
    path.join(home, ".agents/skills/use-otherskill"),
    path.join(home, ".claude/skills/use-otherskill"),
  );
  skill(path.join(home, ".claude/skills/synced/bucket-1/docx"), "docx");
  skill(path.join(cwd, ".claude/skills/release"), "release");
  skill(path.join(home, ".codex/skills/codex-only"), "codex-only");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("collectSkillTree groups native, plugin, synced and bank skills by source with full names", async () => {
  const local = path.join(root, "src/ui-kit");
  skill(local, "ui-kit", "Build UI kits");
  expect((await cli(["add", local, "--category", "frontend/ui-ux"])).code).toBe(
    0,
  );

  const tree = collectSkillTree(loadConfig({ home, cwd }));
  const byKind = Object.fromEntries(tree.groups.map((g) => [g.kind, g]));

  const plugin = byKind.plugin!;
  expect(plugin.sections).toHaveLength(1);
  expect(plugin.sections[0]!.label).toBe("caveman@caveman");
  expect(plugin.sections[0]!.details).toMatchObject({
    plugin: "caveman",
    marketplace: "caveman",
    scope: "user",
    version: "2.7.0",
  });
  expect(plugin.sections[0]!.skills.map((s) => s.fullName)).toEqual([
    "caveman:caveman",
    "caveman:caveman-review",
  ]);

  const user = byKind.user!;
  const userSkills = user.sections.flatMap((s) => s.skills);
  expect(userSkills.map((s) => s.fullName)).toEqual([
    "tokenimum",
    "use-otherskill",
  ]);
  expect(userSkills[1]!.linkTarget).toBe(
    path.join(home, ".agents/skills/use-otherskill"),
  );

  expect(byKind.synced!.sections[0]!.skills[0]!.fullName).toBe(
    "anthropic-skills:docx",
  );
  expect(byKind.shared!.sections[0]!.skills[0]!.fullName).toBe(
    "use-otherskill",
  );
  expect(byKind.codex!.sections[0]!.skills[0]!.fullName).toBe("codex-only");
  expect(byKind.project!.sections[0]!.skills[0]!.fullName).toBe("release");

  const bank = byKind.bank!;
  expect(bank.sections[0]!.label).toBe("frontend/ui-ux");
  expect(bank.sections[0]!.skills[0]).toMatchObject({
    name: "ui-kit",
    fullName: "ui-kit",
    origin: `file://${local}`,
  });

  // Plugin installed only for another project is excluded.
  expect(JSON.stringify(tree)).not.toContain("status");
  expect(tree.total).toBe(9);
});

test("renderSkillTree prints a box-drawing tree with home shortened to ~", () => {
  const text = renderSkillTree(
    collectSkillTree(loadConfig({ home, cwd })),
    home,
  );
  expect(text).toContain("Skills (8)");
  expect(text).toContain("├── Plugins");
  expect(text).toContain("caveman@caveman (user, 2.7.0)");
  expect(text).toMatch(/│ {7}├── caveman:caveman\n/);
  expect(text).toContain("caveman:caveman-review");
  expect(text).toContain("~/.claude/skills");
  expect(text).toContain("use-otherskill -> ~/.agents/skills/use-otherskill");
  expect(text).toContain("anthropic-skills:docx");
  expect(text).not.toContain(home);
  // Last top-level group uses the closing connector.
  expect(text.split("\n").filter((l) => l.startsWith("└── "))).toHaveLength(1);
});

test("otherskill tree prints text and --json output", async () => {
  const text = await cli(["tree"]);
  expect(text.code).toBe(0);
  expect(text.out).toContain("caveman:caveman-review");
  expect(text.out).toContain("Project");

  const json = await cli(["tree", "--json"]);
  expect(json.code).toBe(0);
  const parsed = JSON.parse(json.out);
  expect(parsed.total).toBe(8);
  expect(
    parsed.groups.flatMap(
      (g: { sections: { skills: { fullName: string }[] }[] }) =>
        g.sections.flatMap((s) => s.skills.map((k) => k.fullName)),
    ),
  ).toContain("caveman:caveman-review");

  const help = await cli(["tree", "--help"]);
  expect(help.out).toContain("Usage: otherskill tree");
});

test("tree tolerates missing sources and invalid frontmatter", () => {
  skill(path.join(home, ".claude/skills/ok"), "ok");
  fs.mkdirSync(path.join(home, ".claude/skills/broken"));
  fs.writeFileSync(path.join(home, ".claude/skills/broken/SKILL.md"), "no fm");
  fs.writeFileSync(
    path.join(home, ".claude/plugins/installed_plugins.json"),
    "{not json",
  );
  const tree = collectSkillTree(loadConfig({ home, cwd }));
  const user = tree.groups.find((g) => g.kind === "user")!;
  expect(user.sections[0]!.skills.map((s) => s.fullName)).toContain("broken");
  expect(tree.groups.find((g) => g.kind === "plugin")).toBeUndefined();
  expect(tree.warnings.join(" ")).toContain("installed_plugins.json");
});
