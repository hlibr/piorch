# Pi Workflow Orchestrator (PM → Dev → Verifier waves)

This document specifies how to implement a **pi extension** that orchestrates customizable multi-agent workflows (e.g., PM delegates tasks in waves → developers implement → verifiers review → loop until verified → PM starts next wave). The implementation should be fully driven by a JSON configuration file so flows are customizable without code changes.

> You are **not** building the workflow itself here; this is an implementation plan/spec for a separate AI to implement.

---

## 1. File Layout (new files)

Create the following files:

```
.pi/
  extensions/
    workflow-orchestrator/
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
```

> The extension is discovered by pi automatically because it sits under `.pi/extensions/`.

---

## 2. Agent Definitions (.pi/agents/*.md)

Use the same frontmatter format as the subagent example (see `examples/extensions/subagent/agents.ts`). Each file must include `name` and `description` in frontmatter, and the body becomes the system prompt for the agent.

**Example: `.pi/agents/pm.md`**

```markdown
---
name: pm
description: Product manager who plans and delegates tasks in waves.
model: anthropic/claude-sonnet-4-5
tools: read,grep,find,ls
---
You are a PM. Given the project goal and the last wave’s results, produce the next wave of tasks.
Return JSON only in this shape:
{
  "wave": {
    "goal": "...",
    "tasks": [
      {"id": "T1", "title": "...", "description": "...", "assignee": "developer"}
    ]
  },
  "done": false
}
If everything is complete, return {"done": true}.
```

**Example: `.pi/agents/developer.md`**

```markdown
---
name: developer
description: Implements assigned tasks.
model: anthropic/claude-sonnet-4-5
tools: read,edit,write,bash,grep,find,ls
---
You are a developer. Implement the task in the repo. When done, respond with JSON only:
{
  "status": "done",
  "summary": "...",
  "filesChanged": ["path", "path"],
  "notes": "..."
}
```

**Example: `.pi/agents/verifier.md`**

```markdown
---
name: verifier
description: Reviews developer work and validates requirements.
model: anthropic/claude-sonnet-4-5
tools: read,grep,find,ls,bash
---
You are a verifier. Review the task deliverables and repo state. Return JSON only:
{
  "status": "pass" | "fail",
  "issues": ["..."]
}
```

> These prompts are just defaults; users can edit them to fully customize behavior.

---

## 3. Workflow Configuration File

Create a JSON workflow file at `.pi/workflows/default.workflow.json`.
The extension must load it by name via `/workflow start default`.

### 3.1 Schema (TypeBox-compatible)

```json
{
  "name": "default",
  "goal": "High-level project goal or user request",
  "maxWaves": 10,
  "maxTaskRetries": 3,
  "parallelism": 2,
  "agents": {
    "pm": "pm",
    "developer": "developer",
    "verifier": "verifier"
  },
  "waveSource": {
    "type": "pm" | "static",
    "staticWaves": [
      {
        "goal": "...",
        "tasks": [
          {"id": "T1", "title": "...", "description": "...", "assignee": "developer"}
        ]
      }
    ]
  },
  "taskFlow": {
    "stages": [
      {
        "id": "develop",
        "agent": "developer",
        "inputTemplate": "Task: {{task.title}}\n{{task.description}}\nIssues: {{task.issues}}",
        "outputSchema": {
          "status": "done",
          "summary": "string",
          "filesChanged": "string[]",
          "notes": "string"
        }
      },
      {
        "id": "verify",
        "agent": "verifier",
        "inputTemplate": "Verify task {{task.title}}. Dev summary: {{task.dev.summary}}",
        "outputSchema": {
          "status": "pass|fail",
          "issues": "string[]"
        },
        "transitions": [
          {"when": {"field": "status", "equals": "fail"}, "next": "develop"},
          {"when": {"field": "status", "equals": "pass"}, "next": "complete"}
        ]
      }
    ]
  }
}
```

### 3.2 Customization Rules

- **Agents**: point to any `.pi/agents/*.md` name; changing prompts/custom tools changes flow behavior.
- **Wave source**:
  - `pm`: PM agent generates waves dynamically.
  - `static`: Use pre-defined `staticWaves` only.
- **Task flow**: add/remove stages or change transitions to customize the loop.
- **Transitions**: simple field matcher on JSON output.

---

## 4. Extension Behavior

### 4.1 Commands

Register a command `/workflow` with subcommands:

- `/workflow start <name>`: load `.pi/workflows/<name>.workflow.json`, initialize a run.
- `/workflow status`: show current wave/task progress.
- `/workflow stop`: cancel current run and clear status.

### 4.2 Optional Tool (LLM callable)

Register a tool `workflow_run` with parameters `{ name: string }` that calls `/workflow start <name>` via `pi.sendUserMessage("/workflow start ...", { deliverAs: "followUp" })`.

### 4.3 State Machine

Implement a simple orchestrator that executes:

1. **Start**
   - Load workflow config.
   - Initialize state: `runId`, `waveIndex`, `tasks`, `taskStatus`, `retries`.
   - Persist state via `pi.appendEntry("workflow-state", { ... })`.

2. **Generate next wave**
   - If `waveSource.type === "pm"`: run PM agent (see runner below) with context (goal, previous wave summary).
   - Parse JSON for `{ done: true }` or `{ wave: { goal, tasks } }`.
   - If `done`, finish workflow.
   - If `static`, read from `staticWaves[waveIndex]`.

3. **Process tasks** (wave loop)
   - For each task, execute `taskFlow` stages in order.
   - Start at stage `stages[0]`.
   - If a stage has `transitions`, select `next` based on JSON output field match; if next is `complete`, mark task verified.
   - If verifier returns `fail`, inject issues back into task context and loop back to `develop`.
   - Enforce `maxTaskRetries`; on exceed, mark task failed and continue.
   - Run up to `parallelism` tasks concurrently (simple queue + worker pool).

4. **Wave completion**
   - When all tasks are verified (or failed after retries), create a summary and send to PM agent (optional if `waveSource.type === "pm"`).
   - If PM replies with `done: true`, stop. Otherwise, proceed to next wave.

### 4.4 Persistence & Resume

- On `session_start`, scan `ctx.sessionManager.getBranch()` for the latest `customType === "workflow-state"` entry and restore state if present.
- If state indicates an active run, show a status widget and allow `/workflow status` to inspect.
- All changes to task status must append a new `workflow-state` entry (append-only).

---

## 5. Subagent Runner (runner.ts)

Re-use the subagent pattern from `examples/extensions/subagent/index.ts`:

- Spawn `pi` with:
  - `--mode json -p --no-session`
  - `--model` from agent frontmatter, if provided
  - `--tools` from agent frontmatter, if provided
  - `--append-system-prompt` to inject agent system prompt (write to a temp file)
- Capture JSONL from stdout and collect `message_end` for assistant outputs.
- Return the **final assistant text** (last assistant message content) and **usage stats**.

Implement helper:

```ts
runAgent({ name, task, cwd, systemPrompt, model, tools }): Promise<{ outputText, messages }>
```

---

## 6. JSON Output Parsing

All agents must respond with **JSON only**. Implement a robust `extractJson()`:

- Strip code fences if present.
- Find first `{` and last `}` and parse substring.
- If parsing fails, treat as an error and surface to user; for verifier failures, count as `fail` with issue `"Invalid JSON output"`.

---

## 7. UI Rendering (render.ts)

Provide minimal UI feedback:

- `ctx.ui.setStatus("workflow", "Wave 2: 3/5 tasks verified")`
- `ctx.ui.setWidget("workflow", [...lines])` to show detailed per-task statuses.
- Optional: register `pi.registerMessageRenderer("workflow", ...)` and send `pi.sendMessage()` updates as custom messages.

Keep it simple and text-only.

---

## 8. Config Loader (config.ts)

- Load JSON with `fs.readFileSync`.
- Validate structure (TypeBox + `Value.Check` or manual checks).
- Normalize defaults (`parallelism = 1`, `maxWaves = 10`, `maxTaskRetries = 2`).

---

## 9. agents.ts

Copy the agent discovery logic from `examples/extensions/subagent/agents.ts`:

- Search in `~/.pi/agent/agents` (user) and `.pi/agents` (project) to load `.md` agent files.
- Parse frontmatter via `parseFrontmatter` from `@mariozechner/pi-coding-agent`.
- Each agent has: `{ name, description, tools?, model?, systemPrompt, source, filePath }`.

---

## 10. Error Handling Rules

- If agent is missing: fail the workflow run with a clear error message.
- If verifier returns `fail`, loop back to developer with `issues` injected into `inputTemplate`.
- If a task exceeds `maxTaskRetries`, mark task failed and continue.
- If PM returns invalid JSON, abort the workflow and show the error in status widget.

---

## 11. Example Input Templates

Use simple Mustache-style templating for input strings:

- Implement `renderTemplate(template, data)` with `{{path.to.value}}` lookup.
- Supported path sources:
  - `task` → current task object
  - `task.dev` → developer output
  - `task.verify` → verifier output
  - `workflow.goal`, `wave.goal`, `wave.index`

---

## 12. Done Criteria

The implementation is complete when:

- `/workflow start default` runs a full wave cycle using PM → Dev → Verifier loop.
- Verifier failures trigger developer retries with issues injected.
- When all tasks are verified, PM is invoked again and may return `done: true`.
- State persists across session restart via `workflow-state` entries.
- Workflow is configurable entirely via `.pi/workflows/*.workflow.json` and `.pi/agents/*.md`.

---

## 13. Notes for the Implementer

- Use the extension APIs from `docs/extensions.md`.
- For concurrency, implement a simple worker pool (no external deps).
- Always check `ctx.hasUI` before calling `ctx.ui` methods.
- Use `pi.exec` only if you need to run shell commands; otherwise rely on the subagent runner.

---

This spec is intentionally verbose to allow a smaller model to implement it reliably.
