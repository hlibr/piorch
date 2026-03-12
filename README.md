# Pi Workflow Orchestrator

Customizable PM → Dev → Verifier workflow for **pi** using an extension and subagents. Tasks run in waves, verifiers loop failures back to developers, and the PM can generate the next wave. The workflow is fully configurable via JSON and agent prompt files.

## Features

- PM‑driven or static task waves
- Dev/Verifier loop with retries
- Live per‑task ticker status (compact two-line per active task)
- PM chat in the main pi conversation
- Per‑agent model selection
- Persistent workflow state in the session

## Repository Layout

```text
.pi/
  extensions/workflow-orchestrator/
    index.ts
    agents.ts
    runner.ts
    config.ts
    state.ts
    render.ts
  workflows/
    default.workflow.json
  agents/
    pm.md
    developer.md
    verifier.md
IMPLEMENTATION.md
```

## Installation

Clone this repo and run pi from the repo root:

```bash
cd /path/to/piorch
pi
```

The extension is auto‑discovered from `.pi/extensions/workflow-orchestrator`.

## Quick Start

```text
/workflow start default "Build a Telegram bot that replies pong to /ping"
```

You’ll see:

- A widget above the editor with live per‑task status and a PM line
- Active tasks show an indented ticker line with recent tool/text updates
- PM responses in the main chat (summarized wave output, not raw JSON)

Stop with:

```text
/workflow stop
```

## PM Chat Mode

When a workflow is active, normal chat input is routed to the PM (commands still work).
PM replies are shown in the main chat as:

```text
PM: <message>
```

## Configuration

### Workflow config

Edit `.pi/workflows/default.workflow.json` to customize:

- agent names
- stages and transitions
- wave source (PM or static)
- retries and parallelism
- allowedExtensions (whitelist extensions for subagents)

### Agents

Edit `.pi/agents/*.md` for prompts and per‑agent models:

```yaml
model: openrouter/hunter-alpha
```

## Models (OpenRouter + Local LLM)

Create `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "REPLACE_WITH_OPENROUTER_KEY",
      "api": "openai-completions",
      "models": [{ "id": "openrouter/hunter-alpha", "name": "OpenRouter Hunter Alpha" }]
    },
    "local-llm": {
      "baseUrl": "http://127.0.0.1:1234/v1",
      "apiKey": "local",
      "api": "openai-completions",
      "models": [{ "id": "local-model", "name": "Local LLM" }]
    }
  }
}
```

Then set models in `.pi/agents/*.md`:

```yaml
# pm.md
model: openrouter/hunter-alpha

# developer.md / verifier.md
model: local-model
```

Run `/reload` after changes.

## Commands

- `/workflow start <name> [goal]`
- `/workflow status`
- `/workflow stop`
- `/workflow stop-task <id>`
- `/workflow message <id> <message>`
- `/workflow expand`
- `/workflow collapse`
- `/workflow help`

## Notes

- PM wave output is summarized in chat (task titles + wave goal), not raw JSON.
- The workflow widget includes a `PM: idle/responding...` status line.
- Subagents run with `--no-extensions --no-skills --no-prompt-templates` to avoid tool noise.
- Live ticker is UI‑only (not persisted).
- Tasks can be stopped and messaged via `/workflow stop-task` and `/workflow message` (sessions are persisted per task stage).
- Use `/workflow expand` to show more tasks in the widget, `/workflow collapse` to revert.

## TODO

- Better UI (colors)
- Fix user messages not appearing in chat
- Expand tasks
- Add integration tests for RPC runner and end-to-end flows
- Persist PM memory across messages (session-based PM context)
- Implement workflow reload/resume after restart (/reload or pi exit)

## License

MIT
