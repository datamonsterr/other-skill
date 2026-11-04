# Project skills

This repository routes to six reviewed online skills through `otherskill.config.json`.
The full skill trees, references, scripts, license files and `.otherskill.json`
provenance live in `.otherskill/bank/`. The bank is outside native skill discovery;
there are no category links or imported skills in `.claude/skills` or `.agents/skills`.

## Selection and attribution

Reviewed on 2026-10-22. Each source is a real skill with YAML `name` and
`description`, substantial instructions and supporting material. Licenses are
included beside each imported `SKILL.md`; upstream content is preserved verbatim.

| Skill                        | Category     | Source                                                                                                                                           | License    | Why it fits                                                                                                                               |
| ---------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `crafting-effective-readmes` | `docs`       | [softaworks/agent-toolkit](https://github.com/softaworks/agent-toolkit/tree/main/skills/crafting-effective-readmes)                              | MIT        | Audience-specific README templates, installation/usage sections, review checklists and prose guidance.                                    |
| `bun-cli`                    | `backend`    | [dmythro/agent-skills](https://github.com/dmythro/agent-skills/tree/main/skills/bun-cli)                                                         | MIT        | Bun package management, `bun test`, bundling and standalone CLI executables, with version checks and references.                          |
| `bun-api`                    | `backend`    | [dmythro/agent-skills](https://github.com/dmythro/agent-skills/tree/main/skills/bun-api)                                                         | MIT        | Bun runtime APIs for CLI implementation: arguments, file I/O, subprocesses, environment and a CLI script template. Complements `bun-cli`. |
| `openrouter`                 | `backend`    | [nateslabach/skills](https://github.com/nateslabach/skills/tree/main/skills/openrouter)                                                          | MIT        | API authentication, model discovery, provider routing, structured outputs and diagnostic metadata; includes live catalog helpers.         |
| `skill-creator`              | `management` | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/skill-creator)                                                         | Apache-2.0 | Authoring skills, improving descriptions for routing, constructing eval prompts and measuring selection behavior.                         |
| `hook-development`           | `management` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/plugin-dev/skills/hook-development) | Apache-2.0 | Claude Code hook authoring, including `UserPromptSubmit`, payload handling, validation scripts and examples.                              |

Imported revisions and upstream commit dates:

| Repository                           | Revision                                   | Date       |
| ------------------------------------ | ------------------------------------------ | ---------- |
| `softaworks/agent-toolkit`           | `3027f20f3181758385a1bb8c022d4041dfb4de84` | 2026-03-05 |
| `dmythro/agent-skills`               | `18e3101b8e0cf16b1f793ebdc2522e8a8ac9a399` | 2026-10-10 |
| `nateslabach/skills`                 | `ce8b6e289f8f32b720058c6c69b03de99fe56f00` | 2026-09-29 |
| `anthropics/skills`                  | `dbd4588f9e1033efb41dad4bef2f7947c8993d44` | 2026-10-09 |
| `anthropics/claude-plugins-official` | `af59ee3a1051a29dda4a2e7a2af221aa457ae08b` | 2026-10-21 |

The README skill is older than the others but has focused, complete templates
that remain useful. The Bun skills cover versions newer than the Bun 1.3.14
used for this verification; follow their version checks before using newer APIs.
The repository's Bun-only runtime, `bun test`, free routing model and scope rules
take precedence over upstream examples using other package runners or paid models.
Importing a skill does not install its helper dependencies or execute its scripts.

Discovery used `bun otherskill.ts search` for README, Bun, OpenRouter and skill
authoring queries, plus skills.sh and direct repository inspection with `gh`.
Search returned sparse results, including zero for OpenRouter, so the sources above
were also checked directly. The Node-targeted `jwynia/agent-skills` `npx-cli` skill
was rejected because its Node/Vitest/publishing workflow conflicts with this repo.
OpenRouter's [official skills](https://openrouter.ai/skills/) include a directly
relevant Jev/Decisions skill, but its repository snapshot had no declared license;
it was not vendored. The installed skill authoring and hook skills cover the
skill-routing workflow without claiming dedicated Jev API coverage.

## Configuration and reinstall

The config uses a relative `bankPath` of `.otherskill/bank`, project scope,
Claude as the configured agent and `perplexity/pplx-decider-flash-v1.2`.
`docs` is added for README work; `backend` and `management` reuse starter IDs.
Explicit categories make these imports deterministic without classifier requests.
Neither config nor bank contains credentials. `OPENROUTER_API_KEY` stays in the
environment. No setup/apply command was run, so no native hook or launcher was
created by this change.

A normal clone includes the bank; no online installation is required. To refresh
the same sources, run this from the repository root with Bun and Git available:

```bash
repo_root="$(pwd)"
isolated_home="$(mktemp -d)"
trap 'rm -rf "$isolated_home"' EXIT

add_skill() {
  bun otherskill.ts add "$1" --path "$2" --ref main --category "$3" \
    --scope project --cwd "$repo_root" --home "$isolated_home"
}

add_skill github:softaworks/agent-toolkit skills/crafting-effective-readmes docs
add_skill github:dmythro/agent-skills skills/bun-cli backend
add_skill github:dmythro/agent-skills skills/bun-api backend
add_skill github:nateslabach/skills skills/openrouter backend
add_skill github:anthropics/skills skills/skill-creator management
add_skill github:anthropics/claude-plugins-official \
  plugins/plugin-dev/skills/hook-development management

bun otherskill.ts list --scope project --cwd "$repo_root" --home "$isolated_home"
```

`--ref main` follows upstream, so refreshes may differ from the revisions above.
Review the emitted revision, licenses and diff before committing a refresh. The
current importer supports branch/tag refs, not commit SHAs through `--ref`.
For the exact reviewed snapshot, restore the committed config and bank from this
repository's history instead of refreshing upstream. Each installed metadata file
records the source URL, revision, category and installation timestamp.

## Verification evidence

`bun otherskill.ts list --cwd <repo> --home <temporary-home>` reported:

```text
docs        crafting-effective-readmes
backend     bun-api
backend     bun-cli
backend     openrouter
management  hook-development
management  skill-creator
```

Six temporary Bun acceptance tests exercised the public `list` CLI. Each was
observed failing before its corresponding import and passing afterward:
- `project list exposes a README writing skill in docs`
- `project list exposes Bun CLI toolchain guidance in backend`
- `project list exposes Bun runtime APIs for CLI implementation`
- `project list exposes OpenRouter provider integration guidance`
- `project list exposes agent skill authoring and evaluation guidance`
- `project list exposes Claude Code UserPromptSubmit hook guidance`

Final temporary acceptance result: **6 pass, 0 fail**. Tests were kept outside the
repository to respect this worker's prohibition on editing `tests/**`.
`bun test tests/`: **137 pass, 0 fail**, 1,048 assertions across 26 files.

The following real OpenRouter probes used `find --json --agent claude --scope
project --cwd <repo> --home <temporary-home> --prompt <prompt>`:

| Prompt                                                                                                                                                                           | Expected skills              | Actual result                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------- |
| `rewrite the README with install guide`                                                                                                                                          | `crafting-effective-readmes` | `failed`, `selected: []`, `openrouter_http_401` |
| `Build a TypeScript CLI with Bun: parse command line arguments, read files with Bun.file, spawn subprocesses, test with bun test and bundle a standalone executable`             | `bun-cli`, `bun-api`         | `failed`, `selected: []`, `openrouter_http_401` |
| `Integrate the OpenRouter API into a TypeScript application: configure the provider, discover models, authenticate with OPENROUTER_API_KEY and validate structured JSON outputs` | `openrouter`                 | `failed`, `selected: []`, `openrouter_http_401` |

Each probe made one logical category request, returned no categories and exited
0 because `find` fails open for harness hooks. The probe assertions failed: a zero
exit status is not evidence of successful selection. **Live selection is unverified
until the environment credential is accepted and these probes are rerun.**

`doctor` reported six instances and `nativeBankExposure: checked_by_config`.
`.gitignore` does not exclude the config or any imported bank file. Before/after
fingerprints of real global OtherSkill storage/config and Claude settings matched;
`ls ~/.local/share/otherskill/bank` reported the directory absent both times.
Every modifying CLI command used `--scope project --cwd <repo> --home <temporary-home>`.

After refreshing the environment credential, rerun a probe without saving the key:

```bash
isolated_home="$(mktemp -d)"
trap 'rm -rf "$isolated_home"' EXIT
bun otherskill.ts find --json --agent claude --scope project \
  --cwd "$(pwd)" --home "$isolated_home" \
  --prompt 'rewrite the README with install guide'
```

Require `status: "ok"` and the expected skill name in `selected`; repeat with the
Bun and OpenRouter prompts above. Never print the environment key or put it in config.
