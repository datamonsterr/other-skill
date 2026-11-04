# OtherSkill

Coding agents load every installed skill into context on every prompt. OtherSkill keeps your skills in a private, categorized bank outside native discovery. On each prompt a hook asks one free OpenRouter model which categories and skills apply, and injects only those names, descriptions and provenance. Supports Claude Code, Codex, Antigravity and OpenCode 1.x.

## Prerequisites

- [Bun](https://bun.sh) >= 1.3 (never installed for you)
- `curl` and `tar` (installer), Git (only for online skill imports), a POSIX shell
- A free [OpenRouter](https://openrouter.ai/keys) API key in `OPENROUTER_API_KEY`
- Linux or macOS. Windows and OpenCode 2.x are unverified.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/datamonsterr/other-skill/master/install.sh | bash
```

Scripted, no menu:

```sh
curl -fsSL https://raw.githubusercontent.com/datamonsterr/other-skill/master/install.sh | bash -s -- \
  --non-interactive --agent claude --scope global --key-env OPENROUTER_API_KEY
```

From source:

```sh
git clone https://github.com/datamonsterr/other-skill && cd other-skill
bun install --frozen-lockfile
bun otherskill.ts setup
```

Setup creates the launcher `~/.local/share/otherskill/bin/otherskill` (used by hooks) and a copy at `~/.local/bin/otherskill`, so `otherskill` is on `PATH` when `~/.local/bin` is. Details, snapshots and flags: [docs/installation.md](docs/installation.md).

The bins `skill_selector` and `jev-skill-selector` are deprecated aliases kept for old installs; use `otherskill`. Env vars `OTHERSKILL_MODEL`, `OTHERSKILL_BANK_PATH`, `OTHERSKILL_GLOBAL_SKILLS_PATH` and `OTHERSKILL_AGENT_SKILLS_PATH` win over the legacy `SKILL_SELECTOR_*` names (and `JEV_MODEL`), which are still read as fallbacks. See [ADR 0008](docs/adr/0008-rename-to-otherskill.md).

## Quick start

```sh
otherskill setup --agent claude       # menu: scope, key, model, categories
otherskill doctor                     # checks config, hook, bank; no network
otherskill doctor --live              # one tiny free-model request
otherskill find --agent claude --prompt 'Design an accessible form' --json
```

Preview without writing: `otherskill setup --non-interactive --agent claude --dry-run --home "$(mktemp -d)"`.

### Setup targets

Plain `otherskill setup` opens a checkbox list of targets: `.agents` (the shared `use-otherskill` companion, selected by default) plus Claude, Codex, Antigravity and OpenCode hooks. Arrow keys or `j`/`k` move, SPACE toggles, ENTER confirms. Reruns precheck the saved harnesses.

Non-interactively, pass one harness with `--agent` or several with `--agents` (not both):

```sh
otherskill setup --non-interactive --agents claude,codex --scope global
```

Setup saves the primary `agent` and the full `agents` list; `config --apply` and `update` reapply hooks for every saved harness. `config set agent X` narrows the list to `[X]`. The companion lives once under `.agents/skills/use-otherskill`; Claude's `.claude/skills/use-otherskill` is a symlink to it.

## How it works

```text
prompt -> harness hook -> otherskill find
                            |-- stage 1: decision model picks categories
                            |-- stage 2: one request per category picks skills
                            v
          additionalContext: skill names + descriptions + provenance
```

1. The harness fires `UserPromptSubmit` (or its equivalent) and runs `otherskill find --agent <harness>`.
2. Stage 1 sends the prompt and all category descriptions; categories above the threshold win.
3. Stage 2 sends, per selected category, the prompt and every skill description, concurrently.
4. Selected skills are deduplicated and injected as context. The agent reads a skill body only if it decides to.
5. Any failure injects nothing and exits 0, so the hook never blocks your prompt.

More: [docs/architecture.md](docs/architecture.md).

## Configuration

Config is one JSON file. Precedence: `--config` / `OTHERSKILL_CONFIG` > nearest ancestor `otherskill.config.json` or `.otherskill/config.json` (project; the root file wins when a directory has both) > `~/.config/otherskill/otherskill.config.json` (global) > defaults. A project config also inherits the global config: routing (`find`, `select`, `list`, `doctor`, `classify`) sees the categories and banks of both as one pool, and writes go only to the project bank. Set `"inheritGlobal": false` to opt out.

```jsonc
{
  "bankPath": ".otherskill/bank", // relative to this file; global default ~/.local/share/otherskill/bank
  "model": "perplexity/pplx-decider-flash-v1.2", // default; any OpenRouter decision model id
  "fallbackModels": ["respan/span-02", "~typesafe/jev-latest"], // optional, tried in order (max 4)
  "allowPaidModels": true, // required for any model without :free; project configs inherit it from global
  "scope": "project", // global | project
  "agent": "claude",
  "categories": [
    // routing taxonomy; ids may nest, e.g. frontend/ui-ux
    { "id": "docs", "description": "README writing, installation guides" }
  ],
  "limits": {
    "maxCategories": 20,
    "maxSkills": 10,
    "timeoutMs": 10000,
    "concurrency": 4
  }
}
```

### Decision model

OtherSkill calls `https://openrouter.ai/api/alpha/decisions`, which only serves decision-output models (list them with `curl 'https://openrouter.ai/api/v1/models?output_modalities=decisions'`). Text models such as `google/gemma-4-26b-a4b-it:free` return HTTP 400 there. `inception/mercury-decide:free` is delisted, and the only free decision model left, `respan/span-01-lite:free`, is a behavior scorer that rejects choice questions.

So the default is `perplexity/pplx-decider-flash-v1.2`, a paid decision model at $0.01 per million prompt tokens (about $0.00001 per `find`). Paid models never run without an explicit opt-in: set `"allowPaidModels": true`, pass `--allow-paid-models` to `setup`/`config`, or set `OTHERSKILL_ALLOW_PAID_MODELS=1`. Without it, `find` injects nothing and reports `paid_model_requires_opt_in`; `doctor` shows the same in `modelAccess`.

`fallbackModels` lists models tried in order when a model fails (HTTP 404/400/429/5xx, timeout, invalid answer). Credential errors (401/402) do not fall back. Each model gets its own retries and deadline, so a long chain adds latency. Other cheap decision models at the time of writing: `respan/span-02` ($0.01/M), `baseten/joey-1` ($0.01/M, 16k context, too small for large categories), `~typesafe/jev-latest` ($0.042/M).

```bash
otherskill config set model perplexity/pplx-decider-flash-v1.2 --allow-paid-models --fallback-models respan/span-02,~typesafe/jev-latest
```

Starter file: [otherskill.config.example.json](otherskill.config.example.json). This repo's own project config is [otherskill.config.json](otherskill.config.json) ([docs/project-skills.md](docs/project-skills.md)).

The API key is never in config. `OPENROUTER_API_KEY` in the environment wins over the private file `<home>/.config/otherskill/credentials.json` (mode `0600`, written by `--key-env` or `--key-stdin`).

## Hook params

`find` accepts per-invocation overrides, never written to config:

| Flag                                   | Effect                      |
| -------------------------------------- | --------------------------- |
| `--max-skills N`, `--max-categories N` | cap selections              |
| `--timeout-ms N`                       | per-request deadline        |
| `--categories a,b`                     | restrict enabled categories |
| `--model provider/model`               | override model              |
| `--config FILE`, `--home DIR`          | config and home roots       |

Selections over `--max-skills` are now truncated to the top N by probability (previously an error).

`setup` / `config --apply` embed these flags in the hook command, installing one idempotent `UserPromptSubmit` entry and keeping all other hooks:

```sh
otherskill setup --non-interactive --agent claude --scope global --max-skills 5 --timeout-ms 8000
```

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "timeout": 54,
            "command": "'$HOME/.local/share/otherskill/bin/otherskill' 'find' '--agent' 'claude' '--home' '$HOME' '--max-skills' '5' '--timeout-ms' '8000'"
          }
        ]
      }
    ]
  }
}
```

(Real files contain absolute paths.) Setup also removes the legacy `hooks/claude.ts`, `skill_selector` and `jev-skill-selector` entries and reports it as `removedLegacyHooks`.

## Update

```sh
otherskill update --check     # compare installed commit with remote HEAD, no writes
otherskill update             # new snapshot of master, repoint launcher, reapply hooks
otherskill update --ref v1.2 --dry-run
```

In a git checkout it prints `git pull` instructions and exits 0.

## Managing skills

```sh
otherskill add github:anthropics/skills --path skills/frontend-design   # classify + copy into bank
otherskill add ./my-skill --category testing                            # explicit category
otherskill list                                                         # bank instances
otherskill search 'accessibility'                                       # GitHub search; needs gh auth or GH_TOKEN
otherskill config show                                                  # also: get/set model|categories|limits, --apply
```

`--scope project` writes into the project bank. Full command reference: `otherskill --help`.

## Development

```sh
bun install --frozen-lockfile    # also sets git hooks via `prepare`
```

| Script                     | Runs                                                           |
| -------------------------- | -------------------------------------------------------------- |
| `bun run test`             | unit tests (no network)                                        |
| `bun run test:integration` | real OpenRouter; skipped without key                           |
| `bun run test:e2e`         | 100-case golden set through `find --json`; skipped without key |
| `bun run test:all`         | everything under `tests/`                                      |
| `bun run check`            | Biome format check, lint, `tsc --noEmit`                       |
| `bun run format`           | Biome format write                                             |
| `bun run audit`            | `bun audit`                                                    |

Git hooks (`.githooks`): pre-commit = `check`; pre-push = `audit` + unit tests. E2E reports hit-rate and fails below `E2E_MIN_HIT` (default 0.6); `E2E_LIMIT=N` samples N cases. Set both only with `OPENROUTER_API_KEY` exported.

CI (`.github/workflows/ci.yml`): `check` job (format, lint, typecheck, audit, unit) on push and PR; `live` job (integration + e2e) on master pushes and manual dispatch, skipped for forks, using repository secret `OPENROUTER_API_KEY`. Terms: [CONTEXT.md](CONTEXT.md). Decisions: [docs/adr](docs/adr). Evidence: [docs/otherskill-evidence.md](docs/otherskill-evidence.md).

## Troubleshooting

- `openrouter_http_401` in `find --json`: key missing or rejected. Export `OPENROUTER_API_KEY`, rerun `doctor --live`. Hooks still exit 0.
- A stale `OPENROUTER_API_KEY` in the environment or Claude settings `env` overrides the saved key; check `doctor`'s `credentialSource`.
- Nothing injected: run `find --json` and read `status` and `diagnostics`; check `doctor` shows `configured: true` for your harness, then restart the harness.
- Duplicate routing: a legacy hook is still active. Rerun setup (Claude) or remove the old hook (other harnesses).
- `bun: command not found` in the hook: setup records absolute paths; rerun setup after moving Bun or the checkout.
- Codex ignores the hook: review and trust it through `/hooks`.
