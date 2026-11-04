import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import {
  DEFAULT_DECISION_MODEL,
  MAX_FALLBACK_MODELS,
  decisionModel,
  isDecisionModelId,
} from "../decision_models";

/** Default bank location as written in config (home-relative). */
export const DEFAULT_BANK_PATH = "~/.local/share/otherskill/bank";
/** Default bank location resolved against `home`. */
export const defaultBankPath = (home: string) =>
  path.join(home, DEFAULT_BANK_PATH.slice(2));
export {
  DEFAULT_DECISION_MODEL,
  decisionModel,
} from "../decision_models";
export const starterCategories = [
  {
    id: "frontend/ui-ux",
    description:
      "Interface design, accessibility, frontend components, visual usability",
  },
  {
    id: "frontend/storytelling",
    description:
      "Narrative, copywriting, presentations and visual storytelling",
  },
  {
    id: "backend",
    description:
      "Server APIs, databases, architecture and backend implementation",
  },
  {
    id: "testing",
    description: "Testing, test-driven development, debugging and verification",
  },
  {
    id: "management",
    description:
      "Find, create, install and maintain agent skills and project workflows",
  },
];
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/);
const agentId = z.enum(["claude", "codex", "antigravity", "opencode"]);
const hookParams = z
  .object({
    maxSkills: z.number().int().min(1).max(1000).optional(),
    maxCategories: z.number().int().min(1).max(254).optional(),
    timeoutMs: z.number().int().min(10).max(60000).optional(),
    categories: z.array(id).optional(),
    model: z.string().refine(isDecisionModelId).optional(),
  })
  .strict();
const modelId = z.string().refine(isDecisionModelId, "invalid model id");
const schema = z
  .object({
    bankPath: z
      .string()
      .min(1)
      .refine(
        (value) =>
          !value.split(/[\\/]/).includes("..") && !value.includes("\0"),
        "bank path traversal is forbidden",
      )
      .default(DEFAULT_BANK_PATH),
    model: modelId.default(DEFAULT_DECISION_MODEL),
    fallbackModels: z
      .array(modelId)
      .max(MAX_FALLBACK_MODELS)
      .refine(
        (value) => new Set(value).size === value.length,
        "fallbackModels must be unique",
      )
      .optional(),
    allowPaidModels: z.boolean().optional(),
    scope: z.enum(["global", "project"]).default("global"),
    agent: agentId.optional(),
    agents: z
      .array(agentId)
      .refine(
        (value) => new Set(value).size === value.length,
        "agents must be unique",
      )
      .optional(),
    hookParams: hookParams.optional(),
    portableHooks: z.boolean().optional(),
    inheritGlobal: z.boolean().optional(),
    enabledCategories: z.array(id).optional(),
    categories: z
      .array(z.object({ id, description: z.string().min(1) }).strict())
      .min(1)
      .default(starterCategories),
    limits: z
      .object({
        concurrency: z.number().int().min(1).max(32).default(4),
        retries: z.number().int().min(0).max(5).default(1),
        retryDelayMs: z.number().int().min(0).max(10000).default(250),
        timeoutMs: z.number().int().min(10).max(60000).default(10000),
        maxRequestBytes: z.number().int().min(256).max(1000000).default(60000),
        maxCandidates: z.number().int().min(1).max(254).default(200),
        categoryThreshold: z.number().min(0).max(1).default(0.05),
        skillThreshold: z.number().min(0).max(1).default(0.05),
        maxCategories: z.number().int().min(1).max(254).default(20),
        maxSkills: z.number().int().min(1).max(1000).default(10),
      })
      .strict()
      .prefault({}),
  })
  .strict();
type Parsed = z.infer<typeof schema>;
export interface Category {
  id: string;
  description: string;
}
export interface Inherited {
  configPath: string;
  bankPath: string;
  categories: Category[];
  enabledCategories?: string[];
  allowPaidModels?: boolean;
}
export type Config = Parsed & {
  configPath?: string;
  home: string;
  cwd: string;
  inherited?: Inherited;
  categoriesFinal?: boolean;
};
export interface ConfigOptions {
  configPath?: string;
  home?: string;
  cwd?: string;
  scope?: "global" | "project";
}

export interface RoutingOverrides {
  model?: string;
  categories?: string[];
  maxSkills?: number;
  maxCategories?: number;
  timeoutMs?: number;
}
/** Validate ephemeral overrides without writing the underlying configuration. */
export function withRoutingOverrides(
  config: Config,
  overrides: RoutingOverrides,
): Config {
  const { model, categories, ...limits } = overrides;
  const known = routingView(config).categories;
  const parsed = schema.parse({
    ...configData(config),
    ...(model !== undefined ? { model } : {}),
    ...(categories !== undefined ? { enabledCategories: categories } : {}),
    limits: { ...config.limits, ...limits },
  });
  decisionModel(parsed.model);
  if (
    parsed.enabledCategories &&
    (new Set(parsed.enabledCategories).size !==
      parsed.enabledCategories.length ||
      parsed.enabledCategories.some((id) => !known.some((c) => c.id === id)))
  )
    throw new Error(
      "enabledCategories must reference unique configured category IDs",
    );
  return {
    ...config,
    ...parsed,
    bankPath: config.bankPath,
    categoriesFinal: config.categoriesFinal || categories !== undefined,
  };
}

// Resolve even nonexistent suffixes through real existing ancestors, detecting symlink aliases.
export function realPath(p: string): string {
  function resolve(input: string, depth: number): string {
    if (depth > 128) throw new Error("path alias resolution limit exceeded");
    const absolute = path.resolve(input);
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink())
        return resolve(
          path.resolve(path.dirname(absolute), fs.readlinkSync(absolute)),
          depth + 1,
        );
      return fs.realpathSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(resolve(parent, depth + 1), path.basename(absolute));
  }
  return resolve(p, 0);
}
export function overlaps(a: string, b: string): boolean {
  const left = realPath(a),
    right = realPath(b);
  return (
    left === right ||
    left.startsWith(right + path.sep) ||
    right.startsWith(left + path.sep)
  );
}
export function nativePaths(root: string): string[] {
  return [
    ".claude/skills",
    ".agents/skills",
    ".codex/skills",
    ".config/opencode/skills",
    ".opencode/skills",
    ".gemini/config/skills",
    ".gemini/skills",
  ].map((p) => path.join(root, p));
}
export function assertHiddenBank(
  bank: string,
  home: string,
  cwd: string,
): void {
  const roots = new Set([home]);
  let cursor = cwd;
  for (;;) {
    roots.add(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  // Also reject arbitrary native path components, even outside home/project roots.
  const canonical = realPath(bank).split(path.sep).join("/");
  if (
    /(^|\/)\.(?:agents|claude|codex|opencode)\/skills(?:\/|$)|(^|\/)\.gemini\/(?:config\/)?skills(?:\/|$)|(^|\/)\.config\/opencode\/skills(?:\/|$)/.test(
      canonical,
    ) ||
    [...roots].some((root) =>
      nativePaths(root).some((native) => overlaps(bank, native)),
    )
  ) {
    throw new Error(
      "bank must be separate from every native skills directory (including ancestors and aliases)",
    );
  }
}
/** Project config locations inside one directory, in precedence order. */
export const projectConfigNames = [
  "otherskill.config.json",
  ".otherskill/config.json",
] as const;
export function projectConfigFile(dir: string): string | undefined {
  return projectConfigNames
    .map((name) => path.join(dir, name))
    .find((file) => fs.existsSync(file));
}
/** Directory that owns a project config (parent of .otherskill/ for the nested form); cwd otherwise. */
export function projectRoot(config: Config): string {
  const file = config.configPath && path.resolve(config.configPath);
  if (file && file !== globalConfigFile(config.home))
    for (const name of projectConfigNames)
      if (file.endsWith(path.sep + name))
        return file.slice(0, -(name.length + 1));
  return config.cwd;
}
export function loadConfig(options: ConfigOptions = {}): Config {
  const home = path.resolve(
    options.home ?? process.env.OTHERSKILL_HOME ?? os.homedir(),
  );
  const cwd = path.resolve(options.cwd ?? process.cwd());
  let configPath =
    options.configPath || process.env.OTHERSKILL_CONFIG || undefined;
  if (configPath) configPath = path.resolve(cwd, configPath);
  else {
    let cursor = cwd;
    for (; options.scope !== "global"; ) {
      const candidate = projectConfigFile(cursor);
      if (candidate) {
        configPath = candidate;
        break;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    const global = globalConfigFile(home);
    if (!configPath && fs.existsSync(global)) configPath = global;
  }
  const parsed = readConfigFile(configPath, home, cwd);
  return inherit(
    { ...parsed, home, cwd, configPath },
    configPath,
    options.scope,
  );
}
function globalConfigFile(home: string): string {
  return path.join(home, ".config/otherskill/otherskill.config.json");
}
/** Attach the global config's categories and bank when a project config is in effect. */
function inherit(config: Config, file?: string, scope?: string): Config {
  const global = globalConfigFile(config.home);
  if (
    scope === "global" ||
    config.inheritGlobal === false ||
    !file ||
    !fs.existsSync(global) ||
    realPath(file) === realPath(global)
  )
    return config;
  const g = readConfigFile(global, config.home, config.cwd);
  return {
    ...config,
    inherited: {
      configPath: global,
      bankPath: g.bankPath,
      categories: g.categories,
      enabledCategories: g.enabledCategories,
      allowPaidModels: g.allowPaidModels,
    },
  };
}
function readConfigFile(
  configPath: string | undefined,
  home: string,
  cwd: string,
): Parsed {
  let raw: unknown = {};
  if (configPath) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      throw new Error("cannot read valid otherskill.config.json");
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      "invalid OtherSkill config: " +
        parsed.error.issues
          .map((x) => `${x.path.join(".")}: ${x.message}`)
          .join("; "),
    );
  const config = parsed.data;
  if (
    config.enabledCategories &&
    (new Set(config.enabledCategories).size !==
      config.enabledCategories.length ||
      config.enabledCategories.some(
        (id) => !config.categories.some((c) => c.id === id),
      ))
  )
    throw new Error(
      "enabledCategories must reference unique configured category IDs",
    );
  decisionModel(config.model);
  if (
    new Set(config.categories.map((c) => c.id)).size !==
    config.categories.length
  )
    throw new Error("duplicate category IDs");
  if (config.categories.length > config.limits.maxCandidates)
    throw new Error(
      "too many categories; raise maxCandidates within API bounds",
    );
  const bankPath =
    config.bankPath === "~"
      ? home
      : config.bankPath.startsWith("~/")
        ? path.join(home, config.bankPath.slice(2))
        : path.resolve(
            configPath ? path.dirname(configPath) : cwd,
            config.bankPath,
          );
  assertHiddenBank(bankPath, home, cwd);
  return { ...config, bankPath };
}

/** bankPath as written in `file` while it still resolves to `resolved`, so relative and ~ paths survive rewrites. */
export function writtenBankPath(
  file: string,
  resolved: string,
  home: string,
): string {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8")).bankPath;
    if (typeof raw !== "string") return resolved;
    const target =
      raw === "~"
        ? home
        : raw.startsWith("~/")
          ? path.join(home, raw.slice(2))
          : path.resolve(path.dirname(file), raw);
    return target === resolved ? raw : resolved;
  } catch {
    return resolved;
  }
}
/** Project bank default written into a new project config: relative to the config file. */
export function defaultProjectBankPath(file: string): string {
  return path.basename(path.dirname(file)) === ".otherskill"
    ? "bank"
    : ".otherskill/bank";
}
export function configData(config: Config): Record<string, unknown> {
  const { home, cwd, configPath, inherited, categoriesFinal, ...data } = config;
  return data;
}
export interface RoutingView {
  categories: Category[];
  enabledCategories?: string[];
  banks: string[];
}
/** Categories, enabled set and banks routing sees: project plus inherited global as one pool. */
/** Paid opt-in from this config or, for a project config, the inherited global config. */
export function paidModelsAllowed(config: Config): boolean {
  return (
    config.allowPaidModels === true ||
    config.inherited?.allowPaidModels === true
  );
}
export function routingView(config: Config): RoutingView {
  const g = config.inherited;
  if (!g)
    return {
      categories: config.categories,
      enabledCategories: config.enabledCategories,
      banks: [config.bankPath],
    };
  const categories = [...config.categories];
  for (const c of g.categories)
    if (!categories.some((x) => x.id === c.id)) categories.push(c);
  if (categories.length > config.limits.maxCandidates)
    throw new Error(
      "too many categories; raise maxCandidates within API bounds",
    );
  let enabledCategories: string[] | undefined;
  if (config.categoriesFinal) enabledCategories = config.enabledCategories;
  else if (config.enabledCategories || g.enabledCategories) {
    const ids = new Set([
      ...(config.enabledCategories ?? config.categories.map((c) => c.id)),
      ...(g.enabledCategories ?? g.categories.map((c) => c.id)),
    ]);
    enabledCategories = categories.map((c) => c.id).filter((id) => ids.has(id));
  }
  const banks = [config.bankPath];
  if (realPath(g.bankPath) !== realPath(config.bankPath))
    banks.push(g.bankPath);
  return { categories, enabledCategories, banks };
}
export function configTarget(
  options: ConfigOptions & { scope?: "global" | "project" } = {},
): string {
  const home = path.resolve(
    options.home ?? process.env.OTHERSKILL_HOME ?? os.homedir(),
  );
  const cwd = path.resolve(options.cwd ?? process.cwd());
  return path.resolve(
    cwd,
    options.configPath ||
      process.env.OTHERSKILL_CONFIG ||
      (options.scope === "project"
        ? (projectConfigFile(cwd) ?? path.join(cwd, "otherskill.config.json"))
        : path.join(home, ".config/otherskill/otherskill.config.json")),
  );
}
export function writeConfig(
  file: string,
  data: Record<string, unknown>,
  options: ConfigOptions = {},
  dryRun = false,
): Config {
  if (fs.existsSync(file)) {
    try {
      const existing = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!existing || Array.isArray(existing) || typeof existing !== "object")
        throw new Error();
    } catch {
      throw new Error("refusing to overwrite malformed config");
    }
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error("invalid OtherSkill configuration");
  decisionModel(parsed.data.model);
  if (
    new Set(parsed.data.categories.map((c) => c.id)).size !==
    parsed.data.categories.length
  )
    throw new Error("duplicate category IDs");
  if (
    parsed.data.enabledCategories?.some(
      (id) => !parsed.data.categories.some((c) => c.id === id),
    )
  )
    throw new Error("unknown enabled category");
  const home = path.resolve(
    options.home ?? process.env.OTHERSKILL_HOME ?? os.homedir(),
  );
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const bank = parsed.data.bankPath.startsWith("~/")
    ? path.join(home, parsed.data.bankPath.slice(2))
    : path.resolve(path.dirname(file), parsed.data.bankPath);
  assertHiddenBank(bank, home, cwd);
  if (realPath(file) !== path.resolve(file))
    throw new Error("refusing config write through symlink");
  if (
    parsed.data.enabledCategories &&
    new Set(parsed.data.enabledCategories).size !==
      parsed.data.enabledCategories.length
  )
    throw new Error("duplicate enabled category IDs");
  if (parsed.data.categories.length > parsed.data.limits.maxCandidates)
    throw new Error("too many categories");
  if (!dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(parsed.data, null, 2)}\n`);
  }
  return inherit(
    { ...parsed.data, bankPath: bank, home, cwd, configPath: file },
    file,
  );
}

/** Refuse pre-existing native links/config paths that would reveal the hidden bank. */
export function auditNativeExposure(config: Config): void {
  const roots = new Set([config.home]);
  let cursor = config.cwd;
  for (;;) {
    roots.add(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  let visited = 0;
  function walk(dir: string): void {
    if (!fs.existsSync(dir)) return;
    if (++visited > 20000)
      throw new Error("native skill visibility audit limit exceeded");
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink()) {
      if (overlaps(config.bankPath, dir))
        throw new Error("bank exposed through native skill symlink");
      return;
    }
    if (stat.isDirectory())
      for (const entry of fs.readdirSync(dir)) walk(path.join(dir, entry));
  }
  for (const root of roots) {
    for (const native of nativePaths(root)) walk(native);
    const opencode = [
      path.join(root, ".config/opencode/opencode.json"),
      path.join(root, "opencode.json"),
      path.join(root, ".opencode/opencode.json"),
    ];
    for (const file of opencode) {
      if (!fs.existsSync(file)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        throw new Error("cannot audit malformed OpenCode configuration");
      }
      const document = z
        .object({
          skills: z
            .object({ paths: z.array(z.string()).optional() })
            .passthrough()
            .optional(),
        })
        .passthrough()
        .safeParse(parsed);
      if (!document.success)
        throw new Error("cannot audit malformed OpenCode skills configuration");
      for (const p of document.data.skills?.paths ?? []) {
        const target = p.startsWith("~/")
          ? path.join(config.home, p.slice(2))
          : path.resolve(root, p);
        if (overlaps(config.bankPath, target))
          throw new Error("bank exposed through OpenCode skills.paths");
      }
    }
    const file = path.join(root, ".gemini/config/skills.json");
    if (fs.existsSync(file)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        throw new Error(
          "cannot audit malformed Antigravity skills configuration",
        );
      }
      const document = z
        .object({
          entries: z
            .array(z.object({ path: z.string() }).passthrough())
            .optional(),
        })
        .passthrough()
        .safeParse(parsed);
      if (!document.success)
        throw new Error(
          "cannot audit malformed Antigravity skills configuration",
        );
      for (const entry of document.data.entries ?? []) {
        const target = entry.path.startsWith("~/")
          ? path.join(config.home, entry.path.slice(2))
          : path.resolve(root, entry.path);
        if (overlaps(config.bankPath, target))
          throw new Error("bank exposed through Antigravity skills entries");
      }
    }
  }
}
