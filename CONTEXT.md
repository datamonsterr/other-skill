# Context

Glossary of project terms.
- **OtherSkill**: this project, formerly "Jev Skill Selector" (`skill_selector`, `jev-skill-selector`), and its canonical CLI (`otherskill.ts`). Routes prompts to skills held in a bank. The old bin names `skill_selector` and `jev-skill-selector` stay as deprecated aliases; legacy `index.ts` is a predecessor entry. See ADR 0008.
- **Bank**: private directory of categorized skill copies (`bankPath`), outside native skill discovery. Never linked into `.claude/skills` or `.agents/skills`.
- **Category**: stable, possibly nested ID (`frontend/ui-ux`) with a description. Stage one of routing chooses categories. A skill can hold a complete copy in several categories.
- **Skill set**: the skills in one category, or the enabled categories together; the candidates stage two chooses from.
- **Harness**: the coding agent host: Claude Code, Codex, Antigravity, OpenCode 1.x.
- **Adapter**: harness-specific integration that calls `find --agent <harness>`: a hook entry (Claude, Codex, Antigravity) or a plugin file (OpenCode).
- **Companion**: optional native `use-otherskill` skill installed by setup that teaches the agent to use the CLI. Disable with `--no-companion`.
- **Launcher**: managed script `~/.local/share/otherskill/bin/otherskill` that runs Bun on a snapshot by absolute path. Hooks call it. Setup also writes a managed copy to `~/.local/bin/otherskill` for `PATH`.
- **Snapshot**: immutable source copy under `~/.local/share/otherskill/installs/release.*` made by the installer or `update`. Launchers and adapters point at one.
- **Scope**: `global` (user home config and hooks) or `project` (nearest `otherskill.config.json`, project hook files and bank).
- **Hook params**: `find` flags (`--max-skills`, `--max-categories`, `--timeout-ms`, `--categories`, `--model`, `--config`, `--home`) that override config for one call and can be embedded in the hook command by setup.
- **Portable hooks**: project hooks (`portableHooks: true`, `--portable`) that call `$HOME/.local/share/otherskill/bin/otherskill` and hold no absolute home or project path, so a cloned repo works on another machine. Claude uses `$CLAUDE_PROJECT_DIR` for `--config`; others rely on `find` resolving config from the payload cwd.
- **Golden dataset**: `golden_set/e2e_golden.json`, 100 prompt cases with expected skills, run through the full CLI by the e2e suite against the fixture bank `tests/fixtures/e2e-bank/`.
- **Inherited global config**: when a project config is in effect (including an explicit `--config` pointing at one), the global config's categories and bank are merged into routing as one equal pool; the project wins on category id collisions and is the only write target. Disable with `inheritGlobal: false` or `--scope global`.
- **Decision model**: OpenRouter model with decision output, the only kind `/api/alpha/decisions` accepts. `model` in config; default `perplexity/pplx-decider-flash-v1.2`. See ADR 0009.
- **Fallback models**: `fallbackModels`, up to four decision models tried in order when the model fails. Not used for credential errors.
- **Paid opt-in**: `allowPaidModels: true` (own or inherited global config), `--allow-paid-models` or `OTHERSKILL_ALLOW_PAID_MODELS=1`. Required before any model without `:free` is called; otherwise routing reports `paid_model_requires_opt_in`.
