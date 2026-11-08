#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  loadConfig,
  defaultBankPath,
  freeModel,
  configData,
  configTarget,
  writeConfig,
  defaultProjectBankPath,
  writtenBankPath,
  withRoutingOverrides,
  type RoutingOverrides,
  auditNativeExposure,
} from "./lib/otherskill/config";
import {
  readKey,
  saveKey,
  credentialPath,
  keySource,
} from "./lib/otherskill/credentials";
import {
  createSkill,
  installLocal,
  discoverBank,
  withOnlineSkill,
  findOnline,
} from "./lib/otherskill/bank";
import {
  Decisions,
  classify,
  route,
  diagnostic,
} from "./lib/otherskill/routing";
import {
  agentName,
  detectAgent,
  planMultiSetup,
  inspectInstallation,
  applySetup,
  agents,
  type Agent,
} from "./lib/otherskill/setup";
import { hookInput, hookOutput } from "./lib/otherskill/hook";
import { menu } from "./lib/otherskill/menu";
import { update } from "./lib/otherskill/update";
import { collectSkillTree, renderSkillTree } from "./lib/otherskill/tree";

export const HELP = `OtherSkill — hidden skill sets and free OpenRouter routing
Usage: otherskill <command> [arguments] [options]
Canonical commands:
  setup                              Interactive target checkboxes, scope, key, free model and categories menu
  add <local-dir|github:owner/repo|https://skills.sh/owner/repo/skill>
                                     Classify automatically and copy full skill trees into every match
  find --agent <harness> --prompt <text>
                                     Two-stage selection; emit native hook context (stdin JSON supported)
  config [show|get <field>|set <field> <value>]
                                     Interactive edits or scripted settings, with --apply for hooks
  update [--check|--dry-run] [--ref branch-or-tag]
                                     Update installed snapshot (default master), then reapply hooks
Secondary commands:
  search <query>                     Online GitHub SKILL.md search (GH_TOKEN required by GitHub)
  create <dir> --name <slug> --description <text> --instructions-file <file>
                                     Generate SKILL.md and classify/copy into the bank
  classify <dir>                     Reclassify and copy a skill (explicit --category or model-driven)
  list                               Show scoped bank instances and membership
  tree [--json]                      Show every skill with its full name, grouped by source
  doctor [--live]                    Check config, native visibility, hook paths and optionally free API
Aliases: install = add; hook = find; select = find --json (routing result)
Options:
  --agent claude|codex|antigravity|opencode   Explicit single harness overrides detection
  --agents claude,codex,...          Install multiple harness hooks (not with --agent)
  --scope global|project             Hook/config scope (setup/config)
  --home <dir> --cwd <dir>            Isolated home/project roots
  --config <file>                    Explicit config override (otherwise nearest ancestor, then global)
                                     Project configs also inherit the global config's categories and bank (inheritGlobal: false opts out)
  --model <provider/model:free>       Configure one free model; paid models/fallback chains rejected
  --categories <id,id>               Enabled category IDs (setup/config/find)
  --max-skills N --max-categories N  Per-call routing limits; setup embeds them in hooks
  --timeout-ms N                    Per-request deadline; setup embeds it in hooks
  --category <id>                    Explicit classification, repeat for complete copies in every match
  --key-env <ENV_NAME> | --key-stdin  Save key privately (0600); never printed or put in config
  --non-interactive                  Use flags/defaults for setup/config instead of menus
  --dry-run                         Validate and preview setup/config writes without mutations
  --no-companion                    Install hooks without the shared .agents companion
  --ref <branch-or-tag> --path <dir> GitHub skill source selection (slash refs use --ref)
  --prompt <literal text> --json     Native find output, or JSON routing result for inspection
  --portable                        Write path-free project hooks ($HOME launcher; needs project scope and
                                     otherskill.config.json or .otherskill/config.json at the project
                                     root); persists portableHooks
  --apply                           Apply config settings to harness hooks
  --live                            Doctor: tiny free-model probe (no paid fallback)
  --check                           Update: compare installed commit with remote HEAD, no writes
  --help                            Show this help for any command
Keys: environment OPENROUTER_API_KEY overrides private ~/.config/otherskill/credentials.json.
Project configs never contain credentials. Explicit config > nearest project config > global > defaults.
A project config is otherskill.config.json or .otherskill/config.json (the root file wins when both exist).
`;
const COMMAND_HELP: Record<string, string> = {
  setup: `Usage: otherskill setup [--agent <harness> | --agents a,b] [--scope global|project] [options]
Install harness hooks, the launcher and the companion skill, and write config.
  --non-interactive            Use flags/defaults instead of the menu
  --dry-run                    Preview writes without changing anything
  --portable                   Path-free project hooks (needs project scope; bankPath must be project-relative)
  --no-companion               Skip the shared .agents companion
  --key-env <ENV> | --key-stdin  Save the OpenRouter key privately
  --model, --categories, --max-skills, --max-categories, --timeout-ms
                               Persist routing settings and embed them in the hook
  --home <dir> --cwd <dir> --config <file>
`,
  find: `Usage: otherskill find --agent <harness> [--prompt <text>] [options]
Select skills for a prompt and print native hook context (stdin hook JSON is read when no --prompt).
Hook params override config for this call only and are never written to config:
  --max-skills N        Keep at most N skills, highest probability first
  --max-categories N    Consider at most N categories in stage one
  --timeout-ms N        Per-request deadline in milliseconds
  --categories a,b      Restrict enabled categories
  --model <id:free>     Free model override
  --config <file>       Explicit config file
  --home <dir>          Home root (config and credentials)
  --agent claude|codex|antigravity|opencode   Output format for the harness
  --json                Print the routing result as JSON
Errors never block the prompt: the hook exits 0 with empty context.
`,
  add: `Usage: otherskill add <local-dir|github:owner/repo|https://skills.sh/owner/repo/skill> [options]
Classify a skill and copy its full tree into the bank of every matching category.
  --category <id>       Skip classification; repeat for several categories
  --ref <branch-or-tag> --path <dir>   GitHub source selection
  --scope global|project, --home, --cwd, --config
Alias: install.
`,
  list: `Usage: otherskill list [options]
Print bank skill instances and their category membership as JSON.
  --scope global|project, --home, --cwd, --config
`,
  tree: `Usage: otherskill tree [--json] [options]
Print every skill as a tree grouped by source: Claude plugins (plugin@marketplace),
claude.ai synced skills, user ~/.claude/skills, shared ~/.agents/skills, Codex,
project .claude/skills and .agents/skills, and the OtherSkill bank by category.
Names include the plugin namespace (for example caveman:caveman-review).
  --json                Print the tree as JSON
  --scope global|project, --home, --cwd, --config
`,
  config: `Usage: otherskill config [show|get <field>|set <field> <value>] [options]
Without an action, edit settings interactively. With an action, run scripted.
  --apply               Reapply harness hooks after the change
  --scope global|project, --dry-run, --home, --cwd, --config
  --model, --categories, --max-skills, --max-categories, --timeout-ms
Settable fields: key, model, bankPath, portableHooks, scope, agent, categories, taxonomy, limits.
`,
  update: `Usage: otherskill update [--check|--dry-run] [--ref <branch-or-tag>]
Install a new snapshot (default master), repoint the launcher and reapply hooks.
  --check               Compare the installed commit with remote HEAD; no writes
  --dry-run             Preview without writes
`,
  doctor: `Usage: otherskill doctor [--live]
Check config, bank, native skill visibility, hook paths and credentials.
  --live                Send one tiny free-model probe
  --home, --cwd, --config
`,
  search: `Usage: otherskill search <query>
Search GitHub for SKILL.md files (GH_TOKEN required by GitHub).
`,
  create: `Usage: otherskill create <dir> --name <slug> --description <text> --instructions-file <file>
Generate a SKILL.md, then classify and copy it into the bank.
  --category <id>       Skip classification; repeatable
`,
  classify: `Usage: otherskill classify <dir> [--category <id>]
Reclassify a skill directory and copy it into the bank.
  --category <id>       Explicit categories; repeatable
`,
};
for (const [alias, name] of [
  ["install", "add"],
  ["hook", "find"],
  ["select", "find"],
] as const)
  COMMAND_HELP[alias] = COMMAND_HELP[name]!;
const options = {
  agent: { type: "string" },
  agents: { type: "string" },
  scope: { type: "string" },
  home: { type: "string" },
  cwd: { type: "string" },
  config: { type: "string" },
  model: { type: "string" },
  categories: { type: "string" },
  "max-skills": { type: "string" },
  "max-categories": { type: "string" },
  "timeout-ms": { type: "string" },
  category: { type: "string", multiple: true },
  "key-env": { type: "string" },
  "key-stdin": { type: "boolean" },
  "non-interactive": { type: "boolean" },
  "dry-run": { type: "boolean" },
  "no-companion": { type: "boolean" },
  ref: { type: "string" },
  path: { type: "string" },
  prompt: { type: "string" },
  json: { type: "boolean" },
  portable: { type: "boolean" },
  apply: { type: "boolean" },
  live: { type: "boolean" },
  check: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  name: { type: "string" },
  description: { type: "string" },
  "instructions-file": { type: "string" },
} as const;
async function stdin(): Promise<string> {
  return await Bun.stdin.text();
}
function scopeValue(
  value: string | undefined,
  fallback: "global" | "project",
): "global" | "project" {
  if (value === undefined) return fallback;
  if (value === "global" || value === "project") return value;
  throw new Error("scope must be global or project");
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  let agent: Agent | undefined;
  let commandHint = argv[0];
  try {
    commandHint = parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: false,
    }).positionals[0];
  } catch {}
  const routingCommand = ["find", "hook", "select"].includes(commandHint ?? "");
  // Establish an explicit output protocol even when parsing/configuration fails later.
  const index = argv.indexOf("--agent");
  const inlineAgent = argv.find((arg) => arg.startsWith("--agent="))?.slice(8);
  try {
    agent = inlineAgent
      ? agentName(inlineAgent)
      : index >= 0
        ? agentName(argv[index + 1] ?? "")
        : detectAgent();
  } catch {}
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: true,
    });
    const command = positionals[0] ?? "help";
    if (values.help || command === "help") {
      const topic = values.help ? positionals[0] : positionals[1];
      console.log(
        (topic && Object.hasOwn(COMMAND_HELP, topic)
          ? COMMAND_HELP[topic]
          : undefined) || HELP,
      );
      return 0;
    }
    const roots = {
      home: values.home,
      cwd: values.cwd,
      configPath: values.config,
    };
    if (values.agent) agent = agentName(values.agent);
    let config = loadConfig({
      ...roots,
      ...((command === "config" || command === "setup") && values.scope
        ? { scope: scopeValue(values.scope, "global") }
        : {}),
    });
    if (values.model) config = { ...config, model: freeModel(values.model) };
    const dryRun = values["dry-run"] ?? false;
    const overrides: RoutingOverrides = {
      ...(values.model !== undefined ? { model: values.model } : {}),
      ...(values.categories !== undefined
        ? {
            categories: values.categories.trim()
              ? values.categories.split(",").map((s) => s.trim())
              : [],
          }
        : {}),
    };
    for (const [flag, field] of [
      ["max-skills", "maxSkills"],
      ["max-categories", "maxCategories"],
      ["timeout-ms", "timeoutMs"],
    ] as const) {
      const value = values[flag];
      if (value !== undefined) {
        if (!/^\d+$/.test(value))
          throw new Error(`${flag} must be a positive integer`);
        overrides[field] = Number(value);
      }
    }
    if (command === "setup" || command === "config") {
      const action = positionals[1];
      const scripted =
        values["non-interactive"] || (command === "config" && !!action);
      const explicitAgent = values.agent ? agentName(values.agent) : undefined;
      const explicitAgents =
        values.agents === undefined
          ? undefined
          : [
              ...new Set(
                values.agents
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean)
                  .map(agentName),
              ),
            ];
      if (explicitAgent && explicitAgents)
        throw new Error("choose either --agent or --agents, not both");
      if (values.agents !== undefined && !explicitAgents?.length)
        throw new Error("--agents requires one or more harness names");
      let key: string | undefined;
      if (values["key-env"]) {
        key = process.env[values["key-env"]];
        if (!key)
          throw new Error(
            "requested credential environment variable is unavailable",
          );
      }
      if (values["key-stdin"]) {
        if (key) throw new Error("choose one credential input");
        key = (await stdin()).trim();
      }
      let scope = scopeValue(values.scope, config.scope);
      let companion = !values["no-companion"];
      let shared = true;
      let selectedAgents: Agent[] = [];
      let agentWasSelected = false;
      let apply = command === "setup" || !!values.apply;
      let data = configData(config);
      if (!scripted) {
        const answers = await menu({ ...config, scope }, command, {
          fixedAgent: explicitAgent,
          fixedAgents: explicitAgents,
          fixedScope: values.scope ? scope : undefined,
          noCompanion: values["no-companion"],
          configForScope: (targetScope) =>
            loadConfig({ ...roots, scope: targetScope }),
        });
        if (!answers.apply) {
          console.log("Cancelled; no changes.");
          return 0;
        }
        config = answers.config;
        data = configData(config);
        selectedAgents = [...new Set(answers.agents)];
        agent = answers.agent ?? selectedAgents[0];
        agentWasSelected = true;
        scope = answers.scope;
        shared = answers.targets.includes("agents");
        companion = answers.companion;
        key = answers.key ?? key;
        apply = true;
        data = {
          ...data,
          model: answers.model,
          enabledCategories: answers.enabledCategories,
        };
      }
      if (values.model) data.model = values.model;
      if (values.categories !== undefined)
        data.enabledCategories = values.categories.trim()
          ? values.categories.split(",").map((s) => s.trim())
          : [];
      data.scope = scope;
      if (values.portable) data.portableHooks = true;
      if (Object.keys(overrides).length)
        data.hookParams = { ...config.hookParams, ...overrides };
      const file =
        values.config || process.env.OTHERSKILL_CONFIG
          ? configTarget({ ...roots, scope })
          : values.scope || !scripted
            ? configTarget({ ...roots, scope })
            : (config.configPath ?? configTarget({ ...roots, scope }));
      if (command === "config" && action === "show") {
        console.log(
          JSON.stringify(
            {
              configPath: config.configPath ?? "(defaults)",
              ...configData(config),
              key: readKey(config.home) ? "configured" : "unavailable",
            },
            null,
            2,
          ),
        );
        return 0;
      }
      if (command === "config" && action === "get") {
        const field = positionals[2];
        if (!field) throw new Error("config get requires a field");
        const value =
          field === "key"
            ? readKey(config.home)
              ? "configured"
              : "unavailable"
            : field === "categories"
              ? (config.enabledCategories ?? config.categories.map((c) => c.id))
              : field === "taxonomy"
                ? config.categories
                : configData(config)[field];
        if (value === undefined) throw new Error("unknown config field");
        console.log(JSON.stringify(value, null, 2));
        return 0;
      }
      if (command === "config" && action === "set") {
        const field = positionals[2],
          value = positionals[3];
        if (field === "key") {
          if (!key)
            throw new Error("config set key requires --key-env or --key-stdin");
        } else {
          if (!field || value === undefined)
            throw new Error("config set requires field and value");
          if (field === "model" || field === "bankPath") data[field] = value;
          else if (field === "portableHooks") {
            if (value !== "true" && value !== "false")
              throw new Error("portableHooks must be true or false");
            data.portableHooks = value === "true";
          } else if (field === "scope") {
            scope = scopeValue(value, scope);
            data.scope = scope;
          } else if (field === "agent") {
            agent = agentName(value);
          } else if (field === "categories")
            data.enabledCategories = value.trim()
              ? value.split(",").map((s) => s.trim())
              : [];
          else if (field === "taxonomy" || field === "limits")
            data[field === "taxonomy" ? "categories" : "limits"] =
              JSON.parse(value);
          else throw new Error("unknown editable config field");
        }
      } else if (command === "config" && action)
        throw new Error("unknown config action");
      if (scripted) {
        const editedAgent =
          command === "config" &&
          action === "set" &&
          positionals[2] === "agent";
        if (explicitAgents) {
          selectedAgents = explicitAgents;
          agentWasSelected = true;
        } else if (explicitAgent) {
          selectedAgents = [explicitAgent];
          agentWasSelected = true;
        } else if (editedAgent && agent) {
          selectedAgents = [agent];
          agentWasSelected = true;
        } else {
          selectedAgents = [
            ...new Set([
              ...(config.agents ?? []),
              ...(config.agent ? [config.agent] : []),
            ]),
          ];
        }
        if (agentWasSelected) agent = selectedAgents[0];
        else
          agent =
            config.agent && selectedAgents.includes(config.agent)
              ? config.agent
              : selectedAgents[0];
        shared = selectedAgents.length > 0;
        if (apply && selectedAgents.length === 0)
          throw new Error(
            "setup/apply requires --agent, --agents or a saved harness selection",
          );
      }
      // Explicit targets/menu answers define the persisted primary and full set.
      if (agentWasSelected) {
        if (selectedAgents.length > 0) {
          agent =
            agent && selectedAgents.includes(agent) ? agent : selectedAgents[0];
          data.agent = agent;
          data.agents = selectedAgents;
        } else {
          agent = undefined;
          delete data.agent;
          delete data.agents;
        }
      }
      const target =
        command === "config" &&
        action === "set" &&
        positionals[2] === "scope" &&
        !values.config &&
        !process.env.OTHERSKILL_CONFIG
          ? configTarget({ ...roots, scope })
          : file;
      if (data.bankPath === config.bankPath)
        data.bankPath =
          scope === "project" &&
          !fs.existsSync(target) &&
          config.bankPath === defaultBankPath(config.home)
            ? defaultProjectBankPath(target)
            : writtenBankPath(target, config.bankPath, config.home);
      const portableTouched =
        values.portable ||
        (command === "config" &&
          action === "set" &&
          (positionals[2] === "portableHooks" ||
            positionals[2] === "bankPath"));
      if (
        portableTouched &&
        data.portableHooks === true &&
        typeof data.bankPath === "string" &&
        (path.isAbsolute(data.bankPath) || data.bankPath.startsWith("~"))
      )
        throw new Error("portable hooks require a project-relative bankPath");
      config = writeConfig(target, data, roots, true);
      const plan = apply
        ? planMultiSetup(config, selectedAgents, {
            scope,
            companion,
            shared,
          })
        : undefined;
      // Validate all writes, including credentials, before applying any mutations.
      if (key) saveKey(config.home, key, true);
      writeConfig(target, data, roots, dryRun);
      if (key) saveKey(config.home, key, dryRun);
      if (plan) applySetup(plan, dryRun);
      console.log(
        JSON.stringify(
          {
            dryRun,
            configPath: target,
            agent,
            agents: selectedAgents,
            targets: plan?.targets ?? [
              ...(companion && shared ? (["agents"] as const) : []),
              ...selectedAgents,
            ],
            scope,
            credential: key
              ? `saved privately${dryRun ? " (dry-run)" : ""}`
              : readKey(config.home)
                ? "configured"
                : "unavailable",
            files: plan?.files.map((f) => f.path) ?? [],
            removedLegacyHooks: plan?.removedLegacyHooks ?? [],
          },
          null,
          2,
        ),
      );
      return 0;
    }
    if (command === "update") {
      console.log(
        JSON.stringify(
          await update(config, {
            check: values.check,
            dryRun,
            ref: values.ref,
          }),
          null,
          2,
        ),
      );
      return 0;
    }
    const provider = () =>
      new Decisions(config, { apiKey: readKey(config.home) });
    if (command === "find" || command === "hook" || command === "select") {
      if (!agent && command !== "select")
        throw new Error(
          "find requires --agent or a detected supported harness",
        );
      agent ??= "codex";
      const input = hookInput(
        values.prompt !== undefined ? "" : await stdin(),
        agent,
        values.prompt,
      );
      if (input.cwd && !values.cwd)
        config = loadConfig({ ...roots, cwd: input.cwd });
      config = withRoutingOverrides(config, overrides);
      const result = input.skip
        ? {
            status: "ok" as const,
            selected: [],
            categories: [],
            logicalCalls: 0,
            diagnostics: [],
          }
        : await route(config, input.prompt, provider());
      for (const detail of result.diagnostics)
        console.error(`[otherskill] ${detail}`);
      console.log(
        JSON.stringify(
          values.json || command === "select"
            ? result
            : hookOutput(agent, result),
          null,
          2,
        ),
      );
      return 0;
    }
    if (
      command === "add" ||
      command === "install" ||
      command === "classify" ||
      command === "create"
    ) {
      if (dryRun)
        throw new Error(
          "dry-run is supported for setup/config; add/classify/create require real isolated destinations",
        );
      const source = positionals[1];
      if (!source)
        throw new Error("command requires a source/destination directory");
      const install = async (
        dir: string,
        origin?: Parameters<typeof installLocal>[3],
      ) => {
        const categories =
          values.category ?? (await classify(config, dir, provider()));
        const installed = installLocal(config, dir, categories, origin);
        console.log(JSON.stringify(installed, null, 2));
      };
      if (command === "create") {
        const instructions = values["instructions-file"];
        if (!instructions)
          throw new Error("create requires --instructions-file");
        const dir = createSkill(
          path.resolve(config.cwd, source),
          values.name ?? "",
          values.description ?? "",
          fs.readFileSync(path.resolve(config.cwd, instructions), "utf8"),
        );
        await install(dir);
      } else if (
        /^(https:\/\/|github:)/.test(source) ||
        (!fs.existsSync(path.resolve(config.cwd, source)) &&
          /^[\w.-]+\/[\w.-]+$/.test(source))
      )
        await withOnlineSkill(
          /^(https:\/\/|github:)/.test(source) ? source : `github:${source}`,
          { ref: values.ref, subpath: values.path },
          install,
        );
      else {
        const dir = path.resolve(config.cwd, source);
        if (!fs.existsSync(dir)) throw new Error(`source not found: ${dir}`);
        await install(dir);
      }
      return 0;
    }
    if (command === "list") {
      console.log(JSON.stringify(discoverBank(config), null, 2));
      return 0;
    }
    if (command === "tree") {
      const tree = collectSkillTree(config);
      console.log(
        values.json
          ? JSON.stringify(tree, null, 2)
          : renderSkillTree(tree, config.home),
      );
      return 0;
    }
    if (command === "search") {
      console.log(
        JSON.stringify(
          await findOnline(positionals.slice(1).join(" ")),
          null,
          2,
        ),
      );
      return 0;
    }
    if (command === "doctor") {
      auditNativeExposure(config);
      const skills = discoverBank(config);
      const scope = config.scope,
        _root = scope === "global" ? config.home : config.cwd;
      const findings = agents.map((agent) =>
        inspectInstallation(config, agent),
      );
      let live: unknown = "not_requested";
      if (values.live) {
        try {
          await provider().decide({
            model: config.model,
            state: { user_prompt: "health check", stage: "doctor" },
            questions: {
              selection: {
                type: "choice",
                instructions: "Choose healthy",
                criteria: { healthy: "Healthy", none: "Unavailable" },
              },
            },
          });
          live = "passed";
        } catch (error) {
          live = diagnostic(error);
        }
      }
      console.log(
        JSON.stringify(
          {
            configPath: config.configPath ?? "(defaults)",
            bank: config.bankPath,
            inheritedConfigPath: config.inherited?.configPath ?? null,
            inheritedBank: config.inherited?.bankPath ?? null,
            instances: skills.length,
            model: config.model,
            credential: readKey(config.home) ? "configured" : "unavailable",
            credentialSource: keySource(config.home),
            credentialFile: credentialPath(config.home),
            nativeBankExposure: "checked_by_config",
            harnesses: findings,
            live,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    throw new Error("unknown command; run otherskill --help");
  } catch (error) {
    // Product diagnostics use fixed messages or internal validation messages only, never provider bodies.
    console.error(
      "[otherskill] " +
        (routingCommand
          ? diagnostic(error)
          : error instanceof Error && "code" in error
            ? String((error as { code: unknown }).code).startsWith(
                "ERR_PARSE_ARGS_",
              )
              ? error.message
              : "filesystem_or_process_operation_failed"
            : error instanceof Error && !(error instanceof SyntaxError)
              ? error.message
              : "invalid input/configuration"),
    );
    if (routingCommand) {
      console.log(
        JSON.stringify(
          argv.includes("--json") || commandHint === "select"
            ? {
                status: "failed",
                selected: [],
                categories: [],
                logicalCalls: 0,
                diagnostics: [diagnostic(error)],
              }
            : hookOutput(agent ?? "codex"),
        ),
      );
      return 0;
    }
    return 1;
  }
}
if (import.meta.main) process.exitCode = await main();
