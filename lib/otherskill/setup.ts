import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  type Config,
  nativePaths,
  overlaps,
  projectConfigNames,
  projectRoot,
  realPath,
  auditNativeExposure,
  routingView,
  withRoutingOverrides,
} from "./config";
export const agents = ["claude", "codex", "antigravity", "opencode"] as const;
export type Agent = (typeof agents)[number];
export const setupTargets = ["agents", ...agents] as const;
export type SetupTarget = (typeof setupTargets)[number];
export function isAgentTarget(target: SetupTarget): target is Agent {
  return target !== "agents";
}
export function agentName(value: string): Agent {
  if (value === "agy") return "antigravity";
  if (agents.includes(value as Agent)) return value as Agent;
  throw new Error(
    "unsupported agent; choose claude, codex, antigravity, opencode",
  );
}
export function detectAgent(
  env: NodeJS.ProcessEnv = process.env,
): Agent | undefined {
  if (env.CLAUDE_CODE || env.CLAUDE_PLUGIN_ROOT) return "claude";
  if (env.CODEX_THREAD_ID || env.CODEX) return "codex";
  if (env.ANTIGRAVITY || env.GEMINI_CLI) return "antigravity";
  if (env.OPENCODE || env.OPENCODE_VERSION) return "opencode";
}
export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export function quote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("invalid command path");
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export function launcherPath(home: string): string {
  return path.join(home, ".local/share/otherskill/bin/otherskill");
}
/** Managed copy of the launcher in the conventional user bin directory on PATH. */
export function pathLauncherPath(home: string): string {
  return path.join(home, ".local/bin/otherskill");
}
const managedLauncherMarker = "# OtherSkill managed launcher";
function managedLauncher(file: string): boolean | undefined {
  const stat = lstat(file);
  if (!stat) return undefined;
  if (!stat.isFile()) return false;
  try {
    return fs.readFileSync(file, "utf8").includes(managedLauncherMarker);
  } catch {
    return false;
  }
}
export const portableLauncher =
  '"$HOME/.local/share/otherskill/bin/otherskill"';
export const portableMarker = "// otherskill:portable";
export const portableError =
  "portable hooks require project scope with otherskill.config.json or .otherskill/config.json at the project root";
export function portablePrefix(agent: Agent): string {
  return `${portableLauncher} 'find' '--agent' ${quote(agent)}`;
}
export function hookFile(
  agent: Agent,
  root: string,
  scope: "global" | "project",
): string {
  if (agent === "claude") return path.join(root, ".claude/settings.json");
  if (agent === "codex") return path.join(root, ".codex/hooks.json");
  if (agent === "antigravity")
    return path.join(
      root,
      scope === "global" ? ".gemini/config/hooks.json" : ".agents/hooks.json",
    );
  return path.join(
    root,
    scope === "global"
      ? ".config/opencode/plugins/otherskill.ts"
      : ".opencode/plugins/otherskill.ts",
  );
}
/** The single authoritative use-otherskill companion tree. */
export function canonicalCompanionDir(root: string): string {
  return path.join(root, ".agents/skills/use-otherskill");
}
/**
 * Native companion location for a harness. Claude reads .claude/skills while
 * Codex, Antigravity and OpenCode read the shared .agents/skills catalog.
 */
export function companionDir(agent: Agent, root: string): string {
  return agent === "claude"
    ? path.join(root, ".claude/skills/use-otherskill")
    : canonicalCompanionDir(root);
}
export function nativeCompanion(agent: Agent, root: string): string {
  return path.join(companionDir(agent, root), "SKILL.md");
}
function companionSource(): string {
  return fs.readFileSync(
    path.join(repoRoot, "examples/polly/skills/use-otherskill/SKILL.md"),
    "utf8",
  );
}
const shippedCompanionHashes = [
  "e7138a1cfe8a198d634138eddf94b23a10b4757aa204e2c7b08e3572f74aed0b",
  "0a29c6344027bc4205f1749dc10b45e7e6ef3534832e2305311eeb561729911c",
  // 1.4: documents `otherskill tree`.
  "5a7320ed66adfbcaf812232b8b8a40df5c8fe19fef9aca1606040c6e1156dc93",
  "2c0e1a88adedbf34e8de0570a245dec2b87522a13f88f35c71c6c981801752c8",
];
function isUnmodifiedCompanion(value: string, content: string): boolean {
  if (value === content) return true;
  const hash = createHash("sha256").update(value).digest("hex");
  return shippedCompanionHashes.includes(hash);
}
/** Valid shared companion, or a valid Claude-only legacy copy before migration. */
export function hasValidCompanion(agent: Agent, root: string): boolean {
  const native = nativeCompanion(agent, root);
  if (!fs.existsSync(native)) return false;
  if (fs.existsSync(path.join(canonicalCompanionDir(root), "SKILL.md")))
    return true;
  if (agent !== "claude") return false;
  try {
    return fs.readFileSync(native, "utf8") === companionSource();
  } catch {
    return false;
  }
}
function objectFile(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  try {
    return z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    throw new Error("refusing to overwrite malformed native configuration");
  }
}
function record(value: unknown): Record<string, unknown> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success)
    throw new Error("refusing malformed native hook configuration");
  return parsed.data;
}
function lstat(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function assertRealTarget(file: string): void {
  if (realPath(file) !== path.resolve(file))
    throw new Error("refusing installation through symlink paths");
}
function assertRealParent(file: string): void {
  const parent = path.dirname(file);
  if (realPath(parent) !== path.resolve(parent))
    throw new Error("refusing installation through symlink paths");
}
/**
 * True only for an untouched generated companion copy. Such a copy can be
 * migrated to a symlink; anything with extra or edited files is user content.
 */
function managedCompanionCopy(dir: string, content: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.length !== 1 || entries[0] !== "SKILL.md") return false;
  const skill = path.join(dir, "SKILL.md");
  const stat = lstat(skill);
  return (
    stat?.isFile() === true &&
    isUnmodifiedCompanion(fs.readFileSync(skill, "utf8"), content)
  );
}
function modifiedCompanionError(dir: string): Error {
  return new Error(
    "refusing to replace modified or extended native companion at " +
      dir +
      "; move it aside to preserve it (for example, " +
      dir +
      ".backup) and rerun setup",
  );
}
function validateCanonicalCompanion(dir: string, content: string): void {
  const stat = lstat(dir);
  if (!stat) return;
  if (stat.isSymbolicLink())
    throw new Error(
      "refusing managed canonical companion symlink collision; move or remove " +
        dir +
        " first",
    );
  if (!stat.isDirectory())
    throw new Error(
      "refusing unrelated canonical companion collision at " + dir,
    );
  const skill = path.join(dir, "SKILL.md");
  const skillStat = lstat(skill);
  if (skillStat) {
    if (
      !skillStat.isFile() ||
      !isUnmodifiedCompanion(fs.readFileSync(skill, "utf8"), content)
    )
      throw modifiedCompanionError(skill);
    // Preserve unrelated files inside an existing companion directory.
    return;
  }
  if (fs.readdirSync(dir).length > 0)
    throw new Error(
      "refusing unrelated native companion directory collision at " + dir,
    );
}
function validateCompanionLink(
  link: string,
  canonicalDir: string,
  content: string,
): void {
  const stat = lstat(link);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    const target = path.resolve(path.dirname(link), fs.readlinkSync(link));
    if (realPath(target) !== realPath(canonicalDir))
      throw new Error(
        "refusing to replace existing native companion symlink at " + link,
      );
    return;
  }
  if (!stat.isDirectory() || !managedCompanionCopy(link, content))
    throw modifiedCompanionError(link);
}
function ownsCommand(command: string, agent: Agent, launcher: string): boolean {
  return (
    command.startsWith(quote(launcher) + " 'find' '--agent' " + quote(agent)) ||
    command.startsWith(portablePrefix(agent))
  );
}
function legacyClaudeHook(command: string): string | undefined {
  // Recognize executable/script positions, not incidental text in unrelated commands.
  const words =
    command
      .match(/(?:[^\s'";&|]+|'[^']*'|"[^"]*")+/g)
      ?.map((word) => word.replace(/^['"]|['"]$/g, "")) ?? [];
  if (path.basename(words[0] ?? "") === "bun") {
    words.shift();
    if (words[0] === "run") words.shift();
    if (/(?:^|\/)hooks\/claude\.ts$/.test(words[0] ?? ""))
      return "hooks/claude.ts";
  }
  const executable = path.basename(words[0] ?? "");
  if (executable === "skill_selector" || executable === "jev-skill-selector")
    return executable;
}
export interface SetupFile {
  path: string;
  content?: string;
  mode?: number;
  symlink?: string;
}
export interface SetupPlan {
  agent?: Agent;
  agents: Agent[];
  targets: SetupTarget[];
  scope: "global" | "project";
  root: string;
  files: SetupFile[];
  command: string;
  commands: string[];
  companion: boolean;
  shared: boolean;
  removedLegacyHooks: string[];
}
export interface SetupOptions {
  scope?: "global" | "project";
  projectRoot?: string;
  repoDir?: string;
  companion?: boolean;
  shared?: boolean;
}
/** Self-contained OpenCode adapter: inlines the shared source, resolves the launcher from the user's home. */
function portablePlugin(
  repo: string,
  flags: string[],
  timeoutMs: number,
): string {
  const source = fs
    .readFileSync(path.join(repo, "plugins/otherskill-opencode.ts"), "utf8")
    .replace(/^export /gm, "");
  const args = JSON.stringify(["find", "--agent", "opencode", ...flags]);
  return `// OtherSkill managed adapter\n${portableMarker}\nimport {homedir} from "node:os";\n${source}\nexport const OtherSkill = async ({directory}:{directory:string}) => createOpenCodePlugin({command:[homedir()+"/.local/share/otherskill/bin/otherskill",...${args}],cwd:directory,timeoutMs:${timeoutMs}});\n`;
}
function planHook(
  config: Config,
  agent: Agent,
  scope: "global" | "project",
  root: string,
  repo: string,
  launcher: string,
  command: string,
  commandArgs: string[],
  flags: string[] | undefined,
  removedLegacyHooks: string[],
): SetupFile {
  const hook = hookFile(agent, root, scope);
  const batches =
    1 +
    Math.ceil(
      Math.min(
        config.limits.maxCategories,
        routingView(config).categories.length,
      ) / config.limits.concurrency,
    );
  const timeoutMs =
    batches *
      ((config.limits.retries + 1) * config.limits.timeoutMs +
        config.limits.retryDelayMs * (2 ** config.limits.retries - 1)) +
    5000;
  if (agent === "opencode") {
    const module = pathToFileURL(
      path.join(repo, "plugins/otherskill-opencode.ts"),
    ).href;
    const plugin = flags
      ? portablePlugin(repo, flags, timeoutMs)
      : `// OtherSkill managed adapter\nimport {createOpenCodePlugin} from ${JSON.stringify(module)};\nexport const OtherSkill = async ({directory}:{directory:string}) => createOpenCodePlugin({command:${JSON.stringify(commandArgs)},cwd:directory,timeoutMs:${timeoutMs}});\n`;
    if (
      fs.existsSync(hook) &&
      !fs.readFileSync(hook, "utf8").startsWith("// OtherSkill managed adapter")
    )
      throw new Error("refusing unrelated OpenCode adapter collision");
    // Validate existing config, even though the auto-discovery adapter does not need to edit it.
    for (const configPath of [
      path.join(
        root,
        scope === "global" ? ".config/opencode/opencode.json" : "opencode.json",
      ),
      path.join(root, ".opencode/opencode.json"),
    ]) {
      const existing = objectFile(configPath);
      const skills =
        existing.skills === undefined ? {} : record(existing.skills);
      if (
        Array.isArray(skills.paths) &&
        skills.paths.some(
          (p) =>
            typeof p === "string" &&
            overlaps(config.bankPath, path.resolve(root, p)),
        )
      )
        throw new Error(
          "bank is exposed by native OpenCode skills.paths; remove that exposure before setup",
        );
    }
    return { path: hook, content: plugin };
  }
  const data = objectFile(hook);
  const handler = {
    type: "command",
    command,
    timeout: Math.ceil(timeoutMs / 1000),
    ...(agent === "codex" ? { additionalContextLimit: 100000 } : {}),
  };
  if (agent === "antigravity") {
    const old = data.otherskill;
    if (old !== undefined) {
      const group = record(old);
      if (
        !Array.isArray(group.PreInvocation) ||
        group.PreInvocation.some(
          (h) =>
            !h ||
            typeof h !== "object" ||
            !ownsCommand(
              String((h as Record<string, unknown>).command),
              "antigravity",
              launcher,
            ),
        )
      )
        throw new Error("refusing unrelated Antigravity hook collision");
    }
    data.otherskill = { PreInvocation: [handler] };
  } else {
    const hooks = data.hooks === undefined ? {} : record(data.hooks);
    const groups = hooks.UserPromptSubmit ?? [];
    if (!Array.isArray(groups))
      throw new Error("refusing malformed UserPromptSubmit hooks");
    // Keep all unrelated groups/handlers, including unknown valid extension fields.
    const kept = groups
      .map((group) => {
        const entry = record(group);
        if (!Array.isArray(entry.hooks))
          throw new Error("refusing malformed native hook group");
        return {
          ...entry,
          hooks: entry.hooks.filter((h) => {
            const hook = record(h);
            if (typeof hook.command !== "string") return true;
            const legacy =
              agent === "claude" ? legacyClaudeHook(hook.command) : undefined;
            if (legacy) {
              removedLegacyHooks.push(legacy);
              return false;
            }
            return !ownsCommand(hook.command, agent, launcher);
          }),
        };
      })
      .filter((entry) => entry.hooks.length > 0);
    hooks.UserPromptSubmit = [...kept, { hooks: [handler] }];
    data.hooks = hooks;
  }
  return { path: hook, content: JSON.stringify(data, null, 2) + "\n" };
}
export function planMultiSetup(
  config: Config,
  selectedAgents: Agent[],
  options: SetupOptions = {},
): SetupPlan {
  config = withRoutingOverrides(config, config.hookParams ?? {});
  auditNativeExposure(config);
  const scope = options.scope ?? config.scope;
  const root =
    scope === "global"
      ? config.home
      : path.resolve(options.projectRoot ?? projectRoot(config));
  const repo = path.resolve(options.repoDir ?? repoRoot);
  const portable = config.portableHooks === true;
  const portableConfig = config.configPath
    ? path.relative(root, path.resolve(config.configPath))
    : "";
  if (
    portable &&
    (scope !== "project" ||
      !(projectConfigNames as readonly string[]).includes(portableConfig))
  )
    throw new Error(portableError);
  const launcher = launcherPath(config.home);
  const cli = path.join(repo, "otherskill.ts");
  if (!fs.existsSync(cli)) throw new Error("OtherSkill CLI source not found");
  const agentList = [...new Set(selectedAgents)];
  const shared = options.shared ?? true;
  const companion = options.companion ?? true;
  const files: SetupFile[] = [];
  const launcherContent = `#!/bin/sh\n${managedLauncherMarker}\nexec ${quote(process.execPath)} --no-env-file ${quote(cli)} "$@"\n`;
  if (managedLauncher(launcher) === false)
    throw new Error("refusing unrelated launcher collision");
  files.push({ path: launcher, content: launcherContent, mode: 0o755 });
  // Expose the CLI on PATH; leave any unrelated ~/.local/bin/otherskill alone.
  const pathLauncher = pathLauncherPath(config.home);
  if (
    managedLauncher(pathLauncher) !== false &&
    realPath(path.dirname(pathLauncher)) === path.dirname(pathLauncher)
  )
    files.push({ path: pathLauncher, content: launcherContent, mode: 0o755 });
  const commands: string[] = [];
  const removedLegacyHooks: string[] = [];
  for (const agent of agentList) {
    const flags: string[] = [];
    const commandArgs = [
      launcher,
      "find",
      "--agent",
      agent,
      "--home",
      config.home,
      ...(scope === "project" ||
      (config.configPath &&
        config.configPath !==
          path.join(config.home, ".config/otherskill/otherskill.config.json"))
        ? [
            "--config",
            config.configPath ?? path.join(root, "otherskill.config.json"),
          ]
        : []),
    ];
    for (const [field, flag] of [
      ["maxSkills", "--max-skills"],
      ["maxCategories", "--max-categories"],
      ["timeoutMs", "--timeout-ms"],
      ["categories", "--categories"],
      ["model", "--model"],
    ] as const) {
      const value = config.hookParams?.[field];
      if (value !== undefined)
        flags.push(
          flag,
          Array.isArray(value) ? value.join(",") : String(value),
        );
    }
    commandArgs.push(...flags);
    // Native payloads travel on stdin; no interpolation of prompt text into a shell command.
    const command = portable
      ? [
          portablePrefix(agent),
          ...(agent === "claude"
            ? [`'--config' "$CLAUDE_PROJECT_DIR/${portableConfig}"`]
            : []),
          ...flags.map(quote),
        ].join(" ")
      : commandArgs.map(quote).join(" ");
    commands.push(command);
    files.push(
      planHook(
        config,
        agent,
        scope,
        root,
        repo,
        launcher,
        command,
        commandArgs,
        portable ? flags : undefined,
        removedLegacyHooks,
      ),
    );
  }
  const installCompanion = companion && (shared || agentList.length > 0);
  const sharedTarget = companion && (shared || agentList.length > 0);
  if (installCompanion) {
    const source = path.join(
      repo,
      "examples/polly/skills/use-otherskill/SKILL.md",
    );
    const content = fs.readFileSync(source, "utf8");
    const canonicalDir = canonicalCompanionDir(root);
    validateCanonicalCompanion(canonicalDir, content);
    files.push({ path: path.join(canonicalDir, "SKILL.md"), content });
    if (agentList.includes("claude")) {
      // Claude only discovers .claude/skills, so link it to the shared copy.
      const link = companionDir("claude", root);
      validateCompanionLink(link, canonicalDir, content);
      files.push({
        path: link,
        content,
        symlink: path.relative(path.dirname(link), canonicalDir),
      });
    }
  }
  for (const file of files) {
    if (file.symlink) {
      assertRealParent(file.path);
      if (
        overlaps(
          config.bankPath,
          path.resolve(path.dirname(file.path), file.symlink),
        )
      )
        throw new Error("bank overlaps installation paths");
    } else {
      assertRealTarget(file.path);
    }
    if (overlaps(config.bankPath, file.path))
      throw new Error("bank overlaps installation paths");
  }
  for (const native of nativePaths(root))
    if (overlaps(config.bankPath, native))
      throw new Error("bank overlaps native discovery");
  return {
    agent: agentList[0],
    agents: agentList,
    targets: [...(sharedTarget ? (["agents"] as const) : []), ...agentList],
    scope,
    root,
    files,
    command: commands[0] ?? "",
    commands,
    companion: installCompanion,
    shared: sharedTarget,
    removedLegacyHooks,
  };
}
export function planSetup(
  config: Config,
  agent: Agent,
  options: SetupOptions = {},
): SetupPlan {
  return planMultiSetup(config, [agent], options);
}
function applySymlink(file: SetupFile): void {
  if (!file.symlink || file.content === undefined)
    throw new Error("invalid managed symlink plan");
  assertRealParent(file.path);
  const target = path.resolve(path.dirname(file.path), file.symlink);
  const existing = lstat(file.path);
  if (existing) {
    if (existing.isSymbolicLink()) {
      const current = path.resolve(
        path.dirname(file.path),
        fs.readlinkSync(file.path),
      );
      if (realPath(current) !== realPath(target))
        throw new Error(
          "refusing to replace existing native companion symlink at " +
            file.path,
        );
      return;
    }
    if (
      !existing.isDirectory() ||
      !managedCompanionCopy(file.path, file.content)
    )
      throw modifiedCompanionError(file.path);
    fs.rmSync(file.path, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(file.path), { recursive: true });
  fs.symlinkSync(file.symlink, file.path, "dir");
}
export function applySetup(plan: SetupPlan, dryRun = false): void {
  if (dryRun) return;
  for (const file of plan.files) {
    if (file.symlink) {
      applySymlink(file);
      continue;
    }
    if (file.content === undefined)
      throw new Error("invalid managed file plan");
    assertRealTarget(file.path);
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    if (
      !fs.existsSync(file.path) ||
      fs.readFileSync(file.path, "utf8") !== file.content
    )
      fs.writeFileSync(file.path, file.content, { mode: file.mode ?? 0o644 });
    if (file.mode) fs.chmodSync(file.path, file.mode);
  }
}
export function setup(
  config: Config,
  agent: Agent,
  options: SetupOptions & { dryRun?: boolean } = {},
): SetupPlan {
  const plan = planSetup(config, agent, options);
  applySetup(plan, options.dryRun);
  return plan;
}

export function inspectInstallation(
  config: Config,
  agent: Agent,
): {
  agent: Agent;
  hook: string;
  configured: boolean;
  companion: boolean;
  diagnostics: string[];
} {
  const root = config.scope === "global" ? config.home : projectRoot(config);
  const hook = hookFile(agent, root, config.scope);
  const launcher = launcherPath(config.home);
  const diagnostics: string[] = [];
  const content = fs.existsSync(hook) ? fs.readFileSync(hook, "utf8") : "";
  const expected =
    agent === "opencode"
      ? JSON.stringify([launcher, "find", "--agent", agent]).slice(0, -1)
      : [launcher, "find", "--agent", agent].map(quote).join(" ");
  let configured =
    content.includes(expected) ||
    (agent === "opencode"
      ? content.startsWith("// OtherSkill managed adapter") &&
        content.includes(portableMarker) &&
        content.includes('"--agent","opencode"')
      : content.includes(JSON.stringify(portablePrefix(agent)).slice(1, -1)));
  if (content.includes("otherskill") && !configured)
    diagnostics.push("hook_installation_path_or_agent_mismatch");
  if (
    content.includes("jev-skill-selector") ||
    content.includes("hooks/claude.ts") ||
    content.includes("hooks/codex.ts")
  )
    diagnostics.push("legacy_routing_hook_present");
  if (configured) {
    const launcherContent = fs.existsSync(launcher)
      ? fs.readFileSync(launcher, "utf8")
      : "";
    if (
      !launcherContent.includes("# OtherSkill managed launcher") ||
      !launcherContent.includes(quote(path.join(repoRoot, "otherskill.ts")))
    ) {
      configured = false;
      diagnostics.push("launcher_source_path_mismatch_or_missing");
    } else if (!launcherContent.includes("--no-env-file")) {
      configured = false;
      diagnostics.push("launcher_loads_env_file");
    }
  }
  return {
    agent,
    hook,
    configured,
    companion: fs.existsSync(nativeCompanion(agent, root)),
    diagnostics,
  };
}
