---

name: otherskill
description: Fast, calibrated multi-skill router using cheap OpenRouter decision models (default perplexity/pplx-decider-flash-v1.2, paid, opt-in). Dynamically filters and injects only relevant skills from your skills bank per prompt to eliminate context bloat. Use on every prompt or before agent task execution.
---

# OtherSkill

High-speed, calibrated multi-skill router powered by an OpenRouter decision model (default `perplexity/pplx-decider-flash-v1.2`, $0.01/M tokens). Paid models run only after an explicit opt-in (`allowPaidModels: true` or `OTHERSKILL_ALLOW_PAID_MODELS=1`).

Instead of polluting the agent's context window by loading 70+ skills on startup, `otherskill` evaluates the user prompt against your centralized skill bank (`.agents/other_skills`) and injects only concise skill references and load instructions for that specific task.

## Quick Start

### 1. Run OtherSkill and Get Full Skill Content (When Cannot Use Hooks)

If your agent harness cannot use lifecycle hooks, invoke `otherskill` CLI (globally available via `bun link` or via `./run.sh`) to select skills:

```bash
# If linked globally via 'bun link' (recommended):
otherskill "Refactor the payment gateway with TDD and make a git commit" --content

# Or using the skill runner script:
./run.sh "Refactor the payment gateway with TDD and make a git commit" --content

# Or directly with bun:
bun run index.ts "Refactor the payment gateway with TDD and make a git commit" --content
```

Directly inspect a skill by name:
```bash
otherskill --skill tdd
```

### 2. Fast Skill Selection Overview

To inspect routing probabilities without full file dumps:

```bash
otherskill "Refactor the payment gateway with TDD and make a git commit"
```

Output:
```text
🎯 Skill Selection Result
Prompt: "Refactor the payment gateway with TDD and make a git commit"
Primary Choice: tdd
Confidence: 0.88

Selected Skills:
  • tdd                            Prob: 65.0% | Conf: 88.0%
  • git-commit                     Prob: 32.0% | Conf: 88.0%

📊 Token Usage Breakdown:
  • Total Used Tokens:    3977
  • Input Prompt Tokens:  14
  • System Prompt Tokens: 37
  • API Input Tokens:     3209
  • Output Tokens:        768
```

### 3. Programmatic TypeScript API:

```typescript
import { selectSkills, formatSkillSummary, formatSkillContent } from "./index";

const result = await selectSkills({
  userPrompt: "Diagnose database connection leaks and write regression tests",
  options: { maxSkills: 3, threshold: 0.05 },
});

console.log(result.selectedSkills);
// => [ { name: "diagnosing-bugs", probability: 0.61, path: "..." }, { name: "tdd", probability: 0.38, path: "..." } ]

// Format concise instructions for prompt injection
const injection = formatSkillSummary(result.selectedSkills);
```

---

## Workflows

### 1. Pre-Prompt Hook Workflow (Priority 1: Automatic Routing)

The tool acts as a gatekeeper before your agent starts planning:
1. User submits a prompt (in Claude Code, Codex, Antigravity, or OpenCode).
2. The hook intercepts the prompt via stdin or lifecycle event.
3. Decision model evaluates candidate skills against the prompt (~400–700ms).
4. Hook outputs concise references with original accessible paths and load instructions directly into the agent's context for that turn.

### 2. Standalone Skill Workflow (Priority 2: Fallback When Cannot Use Hooks)

When the agent harness does not support lifecycle hooks:
1. `otherskill` is installed into the harness's skill folder (`~/.agents/skills/otherskill`).
2. The agent calls:

   ```bash
   otherskill "<task description>" --content
   ```
3. Full instructions of only the necessary skills are returned directly for execution.

### 3. Safe Migration Workflow

Relocate optional skills out of native auto-load directories into the isolated skills bank:
```bash
# Preview actions without modifying disk
otherskill migrate --dry-run

# Run migration
otherskill migrate
```

---

## Skills Directory Precedence

Skills are automatically discovered and merged with strict project-first precedence:
1. **Agent Skills (Project-Level)**: Nearest workspace ancestor `./.agents/other_skills` (or `OTHERSKILL_AGENT_SKILLS_PATH`; legacy `SKILL_SELECTOR_AGENT_SKILLS_PATH` still read)
2. **Global Skills (User-Level)**: `~/.agents/other_skills/` (or `OTHERSKILL_GLOBAL_SKILLS_PATH`; legacy `SKILL_SELECTOR_GLOBAL_SKILLS_PATH` still read)
3. **Precedence**: Project-level skills override global skills with the same name even if `SKILLS_BANK_PATH` is configured.
4. **Legacy Fallback**: Legacy `./.agents/jev_skills` and `~/.agents/jev_skills` are supported for migration compatibility with deprecation notice.

---

## Environment Configuration

Configure via environment variables or a `.env` file:

```env
# Required: OpenRouter API Key
OPENROUTER_API_KEY=sk-or-v1-your-key-here

# Decision model (defaults to perplexity/pplx-decider-flash-v1.2; paid models need the opt-in below)
OTHERSKILL_MODEL=perplexity/pplx-decider-flash-v1.2
OTHERSKILL_ALLOW_PAID_MODELS=1

# Optional: Global skills bank directory (defaults to ~/.agents/other_skills/)
OTHERSKILL_GLOBAL_SKILLS_PATH=~/.agents/other_skills

# Optional: Project/agent skills directory (defaults to ./.agents/other_skills)
OTHERSKILL_AGENT_SKILLS_PATH=./.agents/other_skills
```

The `OTHERSKILL_*` names win. Legacy `SKILL_SELECTOR_*` names (and `JEV_MODEL` for the model) are read only when the new name is unset.

---

## Bundled Hooks & Tools

- **Codex Hook**: [`hooks/codex.ts`](hooks/codex.ts) - Injects `UserPromptSubmitCommandOutputWire` with concise skill references.
- **Claude Code Hook**: [`hooks/claude.ts`](hooks/claude.ts) - Intercepts `UserPromptSubmit` in Claude settings and injects concise skill references.
- **OpenCode Plugin**: [`plugins/opencode.ts`](plugins/opencode.ts) - Intercepts `messages.transform` and provides `select_skill` tool with turn deduplication.
- **Antigravity Hook**: [`hooks/antigravity.ts`](hooks/antigravity.ts) - Pre-invocation ephemeral message with concise skill references.
- **Safe Migration Tool**: [`scripts/migrate-skills.ts`](scripts/migrate-skills.ts) & [`skills/migrate-skill/SKILL.md`](skills/migrate-skill/SKILL.md).
