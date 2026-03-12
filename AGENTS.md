# Project Guide (Pi Workflow Orchestrator)

## Purpose

This repo contains a **pi extension** that orchestrates PM → Dev → Verifier workflows with waves of tasks, live UI status, and subagent runs. The extension lives under `.pi/extensions/workflow-orchestrator/`.

## How to run

From repo root:

```bash
pi
```

Then:

```
/workflow start default "Your goal"
```

Reload extensions:

```
/reload
```

## Key files

- `.pi/extensions/workflow-orchestrator/index.ts` – orchestration logic, commands, PM chat
- `.pi/extensions/workflow-orchestrator/runner.ts` – subagent execution (JSON + RPC)
- `.pi/extensions/workflow-orchestrator/render.ts` – UI widget rendering
- `.pi/extensions/workflow-orchestrator/state.ts` – workflow/task state
- `.pi/extensions/workflow-orchestrator/config.ts` – workflow schema
- `.pi/workflows/default.workflow.json` – default workflow config
- `.pi/agents/*.md` – agent prompts + per-agent models

## Common behaviors

- Subagents run in **RPC mode** with per-task session files at:
  `.pi/workflows/sessions/<runId>/<taskId>-<stage>.jsonl`
- `/workflow stop-task <id>` aborts a task but keeps session context.
- `/workflow message <id> <text>` sends a steer message to the running task, or resumes a stopped task.
- While workflow is active, normal chat is routed to PM (commands still work).

## UI notes

- Widget shows only a limited number of tasks.
- Use `/workflow expand` or `/workflow collapse` to change visibility.

## Extension reload caveat

If a workflow is running and you `/reload`, the running workflow keeps using the old runtime.
To apply changes safely:

```
/workflow stop
/reload
/workflow start ...
```

## Allowed extensions for subagents

Use `allowedExtensions` in workflow JSON to whitelist extensions for subagents:

```json
"allowedExtensions": ["/absolute/path/to/ext.ts"]
```
