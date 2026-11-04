import {
  type Config,
  DEFAULT_DECISION_MODEL,
  paidModelsAllowed,
} from "./config";
import { isFreeModel } from "../decision_models";
import { isAgentTarget, type Agent, type SetupTarget } from "./setup";
export interface MenuResult {
  config: Config;
  agent?: Agent;
  agents: Agent[];
  targets: SetupTarget[];
  scope: "global" | "project";
  model: string;
  allowPaidModels?: boolean;
  enabledCategories: string[];
  key?: string;
  companion: boolean;
  apply: boolean;
}
export interface MenuOptions {
  fixedAgent?: Agent;
  fixedAgents?: Agent[];
  fixedScope?: "global" | "project";
  noCompanion?: boolean;
  configForScope?: (scope: "global" | "project") => Config;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  terminal?: boolean;
}
type Key =
  | "up"
  | "down"
  | "left"
  | "right"
  | "space"
  | "enter"
  | "backspace"
  | "escape"
  | "ctrl-c"
  | "ctrl-d"
  | string;
export interface CheckboxChoice {
  value: SetupTarget;
  label: string;
  description: string;
}
export const targetChoices: CheckboxChoice[] = [
  {
    value: "agents",
    label: ".agents",
    description:
      "shared canonical use-otherskill companion (required with a harness)",
  },
  { value: "claude", label: "Claude", description: "hook + linked companion" },
  { value: "codex", label: "Codex", description: "hook" },
  { value: "antigravity", label: "Antigravity", description: "hook" },
  { value: "opencode", label: "OpenCode", description: "hook" },
];
function parseKeys(text: string): { keys: Key[]; pending: string } {
  const keys: Key[] = [];
  let index = 0;
  for (; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\x1b") {
      if (index + 1 >= text.length) break;
      const next = text[index + 1];
      if (next === "[" || next === "O") {
        let end = index + 2;
        while (end < text.length && !/[A-Za-z~]/.test(text[end]!)) end++;
        if (end >= text.length) break;
        const final = text[end];
        if (final === "A") keys.push("up");
        else if (final === "B") keys.push("down");
        else if (final === "C") keys.push("right");
        else if (final === "D") keys.push("left");
        else keys.push("escape");
        index = end;
      } else keys.push("escape");
    } else if (char === "\r" || char === "\n") keys.push("enter");
    else if (char === " ") keys.push("space");
    else if (char === "\x7f" || char === "\b") keys.push("backspace");
    else if (char === "\x03") keys.push("ctrl-c");
    else if (char === "\x04") keys.push("ctrl-d");
    else keys.push(char);
  }
  return { keys, pending: text.slice(index) };
}
/**
 * Shared raw terminal reader. It avoids readline so checkbox navigation and
 * hidden line input can use the same buffered key stream.
 */
export class TerminalSession {
  private input: NodeJS.ReadableStream;
  private output: NodeJS.WritableStream;
  private terminal: boolean;
  private queue: Key[] = [];
  private pending = "";
  private waiter?: {
    resolve: (key: Key) => void;
    reject: (error: Error) => void;
  };
  private listening = false;
  private ended = false;
  private raw = false;
  private closed = false;
  private readonly onData = (chunk: Buffer | string): void => {
    const parsed = parseKeys(
      this.pending +
        (typeof chunk === "string" ? chunk : chunk.toString("utf8")),
    );
    this.pending = parsed.pending;
    for (const key of parsed.keys) this.queue.push(key);
    this.flush();
  };
  private readonly onEnd = (): void => {
    this.ended = true;
    this.waiter?.reject(new Error("terminal input closed"));
    this.waiter = undefined;
  };
  private readonly onError = (error: Error): void => {
    this.waiter?.reject(error);
    this.waiter = undefined;
  };
  constructor(
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
    terminal: boolean,
  ) {
    this.input = input;
    this.output = output;
    this.terminal = terminal;
  }
  private write(text: string): void {
    this.output.write(text);
  }
  private flush(): void {
    if (!this.waiter || this.queue.length === 0) return;
    const resolve = this.waiter.resolve;
    this.waiter = undefined;
    resolve(this.queue.shift()!);
  }
  private enableRaw(): void {
    if (!this.listening) {
      this.listening = true;
      this.input.on("data", this.onData);
      this.input.on("end", this.onEnd);
      this.input.on("error", this.onError);
      (this.input as NodeJS.ReadStream & { resume?: () => void }).resume?.();
    }
    if (this.raw || !this.terminal) return;
    const stream = this.input as NodeJS.ReadStream & {
      setRawMode?: (mode: boolean) => void;
    };
    if (typeof stream.setRawMode === "function") {
      stream.setRawMode(true);
      this.raw = true;
    }
  }
  private async nextKey(): Promise<Key> {
    this.enableRaw();
    if (this.queue.length > 0) return this.queue.shift()!;
    if (this.ended) throw new Error("terminal input closed");
    return new Promise<Key>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
  async ask(prompt: string, secret = false): Promise<string> {
    this.enableRaw();
    this.write(prompt);
    let value = "";
    for (;;) {
      const key = await this.nextKey();
      if (key === "ctrl-c") {
        this.write("\n");
        throw new Error("interactive setup cancelled");
      }
      if (key === "enter" || key === "ctrl-d") {
        this.write("\n");
        return value;
      }
      if (key === "backspace") {
        if (value) {
          value = value.slice(0, -1);
          if (!secret) this.write("\b \b");
        }
        continue;
      }
      if (key === "space") {
        value += " ";
        if (!secret) this.write(" ");
        continue;
      }
      if (key.length === 1 && key >= " ") {
        value += key;
        if (!secret) this.write(key);
      }
    }
  }
  async checkbox(options: {
    title: string;
    choices: CheckboxChoice[];
    initial: SetupTarget[];
    hint?: string;
    agentsRequired?: boolean;
  }): Promise<SetupTarget[]> {
    this.enableRaw();
    const selected = new Set<SetupTarget>(options.initial);
    let cursor = 0;
    let printed = 0;
    const hint = options.hint ?? "↑/↓ move, SPACE toggle, ENTER confirm";
    const render = (): void => {
      const agentsRequired =
        (options.agentsRequired ?? true) &&
        [...selected].some((value) => value !== "agents");
      const rows = [
        options.title,
        ...options.choices.map((choice, index) => {
          const pointer = index === cursor ? ">" : " ";
          const box = selected.has(choice.value) ? "[x]" : "[ ]";
          const label =
            choice.value === "agents" && agentsRequired
              ? choice.label + " (required)"
              : choice.label;
          return `  ${pointer} ${box} ${label} - ${choice.description}`;
        }),
        `  ${selected.size === 0 ? "Select at least one target." : hint}`,
      ];
      if (!printed) this.write("\x1b[?25l");
      else this.write(`\x1b[${printed}A`);
      for (const row of rows) this.write(`\x1b[2K${row}\n`);
      printed = rows.length;
    };
    render();
    for (;;) {
      const key = await this.nextKey();
      if (key === "ctrl-c") {
        this.close();
        throw new Error("interactive setup cancelled");
      }
      if (key === "enter" || key === "ctrl-d") {
        if (selected.size === 0) {
          render();
          continue;
        }
        this.write("\x1b[?25h");
        return options.choices
          .map((choice) => choice.value)
          .filter((value) => selected.has(value));
      }
      if (key === "up" || key === "k")
        cursor = (cursor - 1 + options.choices.length) % options.choices.length;
      else if (key === "down" || key === "j")
        cursor = (cursor + 1) % options.choices.length;
      else if (key === "space") {
        const value = options.choices[cursor]!.value;
        if (
          value === "agents" &&
          (options.agentsRequired ?? true) &&
          selected.size > 1
        )
          continue;
        if (selected.has(value)) selected.delete(value);
        else {
          selected.add(value);
          if (value !== "agents" && (options.agentsRequired ?? true))
            selected.add("agents");
        }
      } else continue;
      render();
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.listening) {
      this.input.removeListener("data", this.onData);
      this.input.removeListener("end", this.onEnd);
      this.input.removeListener("error", this.onError);
      this.listening = false;
      (this.input as NodeJS.ReadStream & { pause?: () => void }).pause?.();
    }
    if (this.waiter) {
      this.waiter.reject(new Error("terminal input closed"));
      this.waiter = undefined;
    }
    if (this.raw) {
      const stream = this.input as NodeJS.ReadStream & {
        setRawMode?: (mode: boolean) => void;
      };
      if (typeof stream.setRawMode === "function") stream.setRawMode(false);
      this.raw = false;
    }
    if (this.terminal) this.write("\x1b[?25h");
  }
}
export function uniqueTargets(values: SetupTarget[]): SetupTarget[] {
  return [...new Set(values)];
}
export async function menu(
  config: Config,
  kind: "setup" | "config",
  options: MenuOptions = {},
): Promise<MenuResult> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const terminal =
    options.terminal ??
    (input === process.stdin && Boolean(process.stdin.isTTY));
  if (!terminal)
    throw new Error(
      "interactive menu requires a terminal; use --non-interactive and flags",
    );
  const session = new TerminalSession(input, output, terminal);
  try {
    output.write(`OtherSkill ${kind} menu\n`);
    const fixed =
      options.fixedAgents ?? (options.fixedAgent ? [options.fixedAgent] : []);
    const saved = config.agents?.length
      ? config.agents
      : config.agent
        ? [config.agent]
        : [];
    // Explicit flags start clean; untouched reruns retain the saved harness set.
    const initial = uniqueTargets([
      "agents",
      ...(fixed.length ? [] : saved),
      ...fixed,
    ]);
    const chosen = await session.checkbox({
      title: "Install targets (shared .agents companion and harness hooks):",
      choices: targetChoices,
      initial,
      agentsRequired: !options.noCompanion,
    });
    let targets = uniqueTargets([...chosen, ...fixed]);
    let agents = targets.filter(isAgentTarget);
    // Keep the saved primary when an untouched rerun retains it.
    if (!fixed.length && config.agent && agents.includes(config.agent))
      agents = [config.agent, ...agents.filter((a) => a !== config.agent)];
    // The canonical companion is required by every harness that links to it.
    if (agents.length > 0) targets = uniqueTargets(["agents", ...targets]);
    const scopeChoice = (
      await session.ask(`Hook scope: 1 global, 2 project [${config.scope}]: `)
    ).trim();
    const scope =
      options.fixedScope ??
      (scopeChoice === "2" || scopeChoice === "project"
        ? "project"
        : scopeChoice === "1" || scopeChoice === "global"
          ? "global"
          : scopeChoice === ""
            ? config.scope
            : undefined);
    if (!scope) throw new Error("invalid scope");
    config = options.configForScope?.(scope) ?? config;
    const key = (
      await session.ask(
        "OpenRouter API key (hidden, blank keeps existing): ",
        true,
      )
    ).trim();
    const model =
      (
        await session.ask(
          `Decision model [${config.model || DEFAULT_DECISION_MODEL}]: `,
        )
      ).trim() || config.model;
    let allowPaidModels = config.allowPaidModels;
    if (!isFreeModel(model) && !paidModelsAllowed(config))
      allowPaidModels =
        (
          await session.ask(
            `${model} is a paid decision model (billed per token by OpenRouter). Allow paid decision models? [y/N]: `,
          )
        )
          .trim()
          .toLowerCase() === "y" || undefined;
    output.write(
      "Categories:\n" +
        config.categories
          .map((c, i) => `  ${i + 1}. ${c.id}: ${c.description}`)
          .join("\n") +
        "\n",
    );
    const categoryInput = (
      await session.ask(
        `Enabled categories: comma-separated numbers or IDs [${(config.enabledCategories ?? config.categories.map((c) => c.id)).join(",")}]: `,
      )
    ).trim();
    const enabledCategories = categoryInput
      ? categoryInput.split(",").map((s) => {
          const value = s.trim();
          return /^\d+$/.test(value)
            ? (config.categories[Number(value) - 1]?.id ?? value)
            : value;
        })
      : (config.enabledCategories ?? config.categories.map((c) => c.id));
    const companion = !options.noCompanion && targets.length > 0;
    const apply =
      (
        await session.ask(
          kind === "setup"
            ? "Apply setup? [Y/n]: "
            : "Save and apply settings/hooks? [Y/n]: ",
        )
      )
        .trim()
        .toLowerCase() !== "n";
    return {
      config,
      agent: agents[0],
      agents,
      targets,
      scope,
      key: key || undefined,
      model,
      allowPaidModels,
      enabledCategories,
      companion,
      apply,
    };
  } finally {
    session.close();
  }
}
