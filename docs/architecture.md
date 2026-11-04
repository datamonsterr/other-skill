# Architecture

## Routing

Two stages, both plain HTTP calls to one free OpenRouter model (never harness subagents):
1. **Categories.** The full prompt plus every enabled category description goes in one request. The model returns validated probabilities; categories above `categoryThreshold` (up to `maxCategories`) win.
2. **Skills.** For each selected non-empty category one concurrent request carries the same full prompt and **all candidates with complete descriptions**. Skills above `skillThreshold` (up to `maxSkills`) win.

Logical calls = `1 + N`; bounded retries add HTTP attempts. Injection deduplicates logical copies, keeps category provenance and keeps distinct same-name sources. Only names, full descriptions and provenance are injected, never skill bodies.

Responses are validated: choices, finite probabilities, normalization, winner. Inputs are never silently truncated. Context, candidate or selection overflow returns a safe diagnostic. The configured model is one OpenRouter decision model id, optionally followed by up to four `fallbackModels` tried in order when a model fails (credential errors do not fall back). Paid models, meaning any id without `:free`, are refused before any HTTP call unless `allowPaidModels` (own or inherited global config), `--allow-paid-models` or `OTHERSKILL_ALLOW_PAID_MODELS=1` opts in. A `--model` override must equal the configured model for each request.

## Failure behavior

Stage-one failure injects nothing. Category failures can return successful categories with `status: "partial"`. Hook failures exit 0 with protocol-correct empty context, so a broken router never blocks the harness. Diagnostics never include prompts, keys or upstream bodies. A zero exit is therefore not proof of selection: check `status` in `find --json`.

## Output per harness

Claude/Codex `hookSpecificOutput.additionalContext`; Antigravity `injectSteps` (named `PreInvocation` group, skips repeats, reads the original request from the transcript when needed); OpenCode `experimental.chat.messages.transform` appending a synthetic text part, cached per user message, prompt passed as a subprocess argument array. Global hooks honor the event workspace's config; project hooks pin the project config.

## Bank layout

```text
~/.local/share/otherskill/bank/
  frontend/ui-ux/design--<source-hash>/
    SKILL.md  scripts/  references/  assets/  .otherskill.json
  testing/design--<source-hash>/
    ...
```

Every category meeting the classifier threshold gets a **complete copy** (scripts, references, assets, modes, licenses). `.otherskill.json` records source URL/path, requested ref, resolved revision, category and logical identity. Distinct sources with the same name stay distinct. Re-adding stages the full tree before replacing owned destinations. Reclassification adds memberships and never silently deletes copies. Symlinks and special files are rejected; `.git` is excluded.

## Config

Precedence: `--config` / `OTHERSKILL_CONFIG` > nearest ancestor `otherskill.config.json` > `~/.config/otherskill/otherskill.config.json` > defaults. The chosen file is complete (schema defaults fill gaps); global and project files are not merged. Relative `bankPath` resolves beside the file; `~/` uses the selected home. Invalid config is an error. Category IDs nest arbitrarily; traversal, duplicates, unknown enabled IDs and aliases into native skill paths are rejected.

Default limits: concurrency 4, retries 1, retryDelayMs 250, timeoutMs 10000, maxRequestBytes 60000, maxCandidates 200, thresholds 0.05, maxCategories 20, maxSkills 10. See [otherskill.config.example.json](../otherskill.config.example.json).

`doctor` checks paths, native exposure, hook files and companion presence without a provider call; `doctor --live` makes one tiny free-model request. Configured paths do not prove the running harness loaded the hook.

## Skill authoring and discovery

```sh
otherskill add ./my-skill
otherskill add github:anthropics/skills --path skills/frontend-design
otherskill add owner/repository --ref release/v1 --path skills/design
otherskill add https://skills.sh/owner/repository/skill-name
otherskill add ./my-skill --category frontend/ui-ux --category testing   # skip classifier
otherskill create ./my-skill --name my-skill --description 'When this applies' \
  --instructions-file ./instructions.md --category management
otherskill search 'accessibility'                                         # needs gh auth or GH_TOKEN
```

Automatic classification sends the skill name and description plus the taxonomy to the decision model; `none` means no import. Review imported code and licenses before running it. GitHub tree URLs work; refs containing slashes need `--ref`.

## References

[OpenRouter Decisions](https://openrouter.ai/blog/tutorials/jev-vs-llm-when-to-use-each/), [decision model catalog](https://openrouter.ai/api/v1/models?output_modalities=decisions), [Claude hooks](https://code.claude.com/docs/en/hooks), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Antigravity hooks](https://antigravity.google/docs/hooks), [OpenCode plugins](https://opencode.ai/docs/plugins/). Measured evidence: [otherskill-evidence.md](otherskill-evidence.md).
