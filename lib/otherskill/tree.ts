import fs from "node:fs";
import path from "node:path";
import { readSkill, discoverBank } from "./bank";
import type { Config } from "./config";

/** Where a group of skills comes from. */
export type SourceKind =
  | "plugin"
  | "synced"
  | "user"
  | "shared"
  | "codex"
  | "project"
  | "bank";

export interface TreeSkill {
  /** Frontmatter name, or directory name when frontmatter is unreadable. */
  name: string;
  /** Name as the harness exposes it, including any plugin namespace. */
  fullName: string;
  description: string;
  path: string;
  /** Symlink target when the skill directory is a link. */
  linkTarget?: string;
  /** Bank provenance (install source) for OtherSkill bank skills. */
  origin?: string;
}

export interface TreeSection {
  label: string;
  path?: string;
  details?: Record<string, string>;
  skills: TreeSkill[];
}

export interface TreeGroup {
  kind: SourceKind;
  label: string;
  sections: TreeSection[];
}

export interface SkillTree {
  total: number;
  groups: TreeGroup[];
  warnings: string[];
}

const LABELS: Record<SourceKind, string> = {
  plugin: "Plugins",
  synced: "Synced (claude.ai)",
  user: "User",
  shared: "Shared (.agents)",
  codex: "Codex",
  project: "Project",
  bank: "OtherSkill bank",
};
/** Namespace Claude Code shows for skills synced from claude.ai. */
const SYNCED_NAMESPACE = "anthropic-skills";

function readJson(file: string, warnings: string[]): unknown {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    warnings.push(`unreadable ${file}`);
    return undefined;
  }
}

function sameDir(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/** Skills directly under `dir` (each a folder holding SKILL.md), sorted by name. */
function scanSkills(
  dir: string,
  namespace?: string,
  skip: string[] = [],
): TreeSkill[] {
  if (!fs.existsSync(dir)) return [];
  const skills: TreeSkill[] = [];
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || skip.includes(entry.name)) continue;
    const folder = path.join(dir, entry.name);
    const file = path.join(folder, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    let meta = { name: entry.name, description: "" };
    try {
      meta = readSkill(folder);
    } catch {}
    const skill: TreeSkill = {
      name: meta.name,
      fullName: namespace ? `${namespace}:${meta.name}` : meta.name,
      description: meta.description,
      path: file,
    };
    if (entry.isSymbolicLink())
      skill.linkTarget = path.resolve(dir, fs.readlinkSync(folder));
    skills.push(skill);
  }
  return skills;
}

interface PluginInstall {
  scope?: string;
  installPath?: string;
  version?: string;
  projectPath?: string;
}

function pluginSections(config: Config, warnings: string[]): TreeSection[] {
  const file = path.join(config.home, ".claude/plugins/installed_plugins.json");
  const data = readJson(file, warnings) as
    | { plugins?: Record<string, PluginInstall[]> }
    | undefined;
  const sections: TreeSection[] = [];
  for (const [key, installs] of Object.entries(data?.plugins ?? {}).sort()) {
    if (!Array.isArray(installs)) continue;
    // User installs apply everywhere; project/local installs only in their project.
    const install = installs.find(
      (i) =>
        i?.installPath &&
        (i.scope === "user" ||
          (i.projectPath !== undefined && sameDir(i.projectPath, config.cwd))),
    );
    if (!install?.installPath) continue;
    const at = key.lastIndexOf("@");
    const marketplace = at > 0 ? key.slice(at + 1) : "";
    let plugin = at > 0 ? key.slice(0, at) : key;
    const manifest = readJson(
      path.join(install.installPath, ".claude-plugin/plugin.json"),
      warnings,
    ) as { name?: unknown; skills?: unknown } | undefined;
    if (typeof manifest?.name === "string" && manifest.name)
      plugin = manifest.name;
    const extra = manifest?.skills;
    const dirs = [
      "skills",
      ...(typeof extra === "string"
        ? [extra]
        : Array.isArray(extra)
          ? extra
          : []),
    ]
      .filter((d): d is string => typeof d === "string")
      .map((d) => path.resolve(install.installPath!, d));
    const seen = new Set<string>();
    const skills = [...new Set(dirs)]
      .flatMap((d) => scanSkills(d, plugin))
      .filter((s) => !seen.has(s.fullName) && !!seen.add(s.fullName));
    if (!skills.length) continue;
    sections.push({
      label: key,
      path: install.installPath,
      details: {
        plugin,
        marketplace,
        scope: install.scope ?? "unknown",
        ...(install.version ? { version: install.version } : {}),
      },
      skills,
    });
  }
  return sections;
}

function dirSection(dir: string, namespace?: string, skip?: string[]) {
  const skills = scanSkills(dir, namespace, skip);
  return skills.length ? [{ label: dir, path: dir, skills }] : [];
}

function syncedSections(home: string): TreeSection[] {
  const root = path.join(home, ".claude/skills/synced");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => !e.name.startsWith(".") && e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => dirSection(path.join(root, e.name), SYNCED_NAMESPACE));
}

function bankSections(config: Config, warnings: string[]): TreeSection[] {
  let skills: ReturnType<typeof discoverBank>;
  try {
    skills = discoverBank(config);
  } catch (error) {
    warnings.push(
      `bank: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
  const byCategory = new Map<string, TreeSkill[]>();
  for (const skill of skills) {
    const list = byCategory.get(skill.category) ?? [];
    list.push({
      name: skill.name,
      fullName: skill.name,
      description: skill.description,
      path: skill.path,
      origin: skill.source.source,
    });
    byCategory.set(skill.category, list);
  }
  return [...byCategory].map(([label, list]) => ({ label, skills: list }));
}

/** Collect every skill visible to the harnesses plus the OtherSkill bank, grouped by source. */
export function collectSkillTree(config: Config): SkillTree {
  const warnings: string[] = [];
  const { home, cwd } = config;
  const groups: TreeGroup[] = (
    [
      ["plugin", pluginSections(config, warnings)],
      ["synced", syncedSections(home)],
      [
        "user",
        dirSection(path.join(home, ".claude/skills"), undefined, ["synced"]),
      ],
      ["shared", dirSection(path.join(home, ".agents/skills"))],
      ["codex", dirSection(path.join(home, ".codex/skills"))],
      [
        "project",
        sameDir(cwd, home)
          ? []
          : [
              ...dirSection(path.join(cwd, ".claude/skills")),
              ...dirSection(path.join(cwd, ".agents/skills")),
            ],
      ],
      ["bank", bankSections(config, warnings)],
    ] as [SourceKind, TreeSection[]][]
  )
    .filter(([, sections]) => sections.length)
    .map(([kind, sections]) => ({ kind, label: LABELS[kind], sections }));
  const total = groups.reduce(
    (n, g) => n + g.sections.reduce((m, s) => m + s.skills.length, 0),
    0,
  );
  return { total, groups, warnings };
}

/** Render the tree with box-drawing connectors; paths under `home` print as `~`. */
export function renderSkillTree(tree: SkillTree, home: string): string {
  const tilde = (p: string) =>
    p === home ? "~" : p.replaceAll(home + path.sep, `~${path.sep}`);
  const lines = [`Skills (${tree.total})`];
  const branch = (last: boolean) => (last ? "└── " : "├── ");
  const pad = (last: boolean) => (last ? "    " : "│   ");
  tree.groups.forEach((group, gi) => {
    const lastGroup = gi === tree.groups.length - 1;
    const count = group.sections.reduce((n, s) => n + s.skills.length, 0);
    lines.push(`${branch(lastGroup)}${group.label} (${count})`);
    group.sections.forEach((section, si) => {
      const lastSection = si === group.sections.length - 1;
      const d = section.details;
      const meta =
        group.kind === "plugin" && d
          ? ` (${[d.scope, d.version].filter(Boolean).join(", ")})`
          : "";
      const where =
        section.path && section.path !== section.label
          ? `  ${tilde(section.path)}`
          : "";
      lines.push(
        `${pad(lastGroup)}${branch(lastSection)}${tilde(section.label)}${meta}${where}`,
      );
      section.skills.forEach((skill, ki) => {
        const extra = skill.linkTarget
          ? ` -> ${tilde(skill.linkTarget)}`
          : skill.origin
            ? `  (${tilde(skill.origin)})`
            : "";
        lines.push(
          `${pad(lastGroup)}${pad(lastSection)}${branch(ki === section.skills.length - 1)}${skill.fullName}${extra}`,
        );
      });
    });
  });
  for (const warning of tree.warnings) lines.push(`warning: ${tilde(warning)}`);
  return lines.join("\n");
}
