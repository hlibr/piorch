# Workflow Resume & Session Persistence Plan

This plan describes how to resume a workflow after a crash or restart, **without mid-run continuation**. The goal is to restart from the last persisted messages in each task’s session file.

## Goals

- Resume a workflow after restart from the **last saved session entries**.
- Restart any `in_progress` tasks at their **current stage**, using the same session file.
- Resume the **full workflow loop** (current wave + subsequent waves).
- Respect configured **parallelism** during resume.
- Provide explicit user controls (`/workflow resume`).
- Make UI/state clear about **resumed** vs **restarted** tasks.

## Non-Goals

- Mid-run continuation (token-level resumption).
- Tool-level checkpointing or partial tool replay.
- Reconnecting to a still-running RPC process without a broker/daemon.

---

## 1) Persist additional orchestration state

### Data to persist in `WorkflowState`

Add fields so the scheduler can be reconstructed:

- `runId` (already present)
- `waveIndex` (already present)
- `wave` (already present)
- `active` (already present)
- **New** `previousSummary?: string` (persist the last wave summary used for PM wave generation)
- **New** `waveSummaries?: string[]` (optional full history for debugging)
- **New** `resumeInfo`:
  - `wasRunning: boolean`
  - `lastShutdownAt: number`
  - `resumeAttempted: boolean`

### Per-task additions (`TaskState`)

- **New** `lastStartedAt?: number`
- **New** `resumeCount?: number`
- **New** `lastRunStageId?: string`

Purpose: show “resumed” in UI, track repeated resumes, and avoid infinite loops.

---

## 2) Orphan handling (no PID killing)

We do **not** attempt to kill or reconnect to orphaned subagent processes. We rely on `session_shutdown` for graceful cleanup in normal exits. After a crash, orphaned processes are possible but rare, and we accept that risk to avoid killing unrelated processes.

---

## 3) New resume flow

### New command

- `/workflow resume [--auto]`
  - Restores state from session entries.
  - Rebuilds the workflow loop **from the current wave index**.
  - Restarts any task with status `in_progress` at `task.stageId`.
  - Replays any tasks marked `stopped` only if the user explicitly chooses.

### Auto-resume option

- On `session_start`, if `resumeInfo.wasRunning === true`, prompt:
  - “Previous workflow was interrupted. Resume?”

If yes → call `/workflow resume`.
If no → mark workflow inactive and leave tasks stopped.

---

## 4) Scheduler reconstruction (full loop)

Rebuild a resume scheduler that mirrors `startWorkflow()`:

- Load `WorkflowConfig` by name.
- Continue at `currentState.waveIndex` using `currentState.wave` if present.
- Run the **current wave’s tasks** via `mapWithConcurrencyLimit` to respect `parallelism`.
- After the current wave finishes:
  - For **static waves**: continue with the next configured wave.
  - For **PM waves**: use the persisted `previousSummary` (or `waveSummaries`) as input to generate the next wave.
- Stop when max waves are reached or PM returns `done`.

### Optional

Add `/workflow resume-all` to restart **pending + in_progress** tasks.

---

## 5) Task restart behavior

When restarting an `in_progress` task:

- Use `processTask(..., startStageId=task.stageId)`.
- Before running, **set**:
  - `task.resumeCount += 1`
  - `task.lastNote = "resumed"`
  - `task.lastStartedAt = Date.now()`

This makes resumption explicit in UI and logs.

---

## 6) Session file usage

Each task already has `sessionFiles[stageId]`. Ensure:

- On resume, **reuse** the same session file.
- On new run after failure, **continue** appending to the same file (keeps full context).

If file is missing:

- Recreate it and warn the user that context was lost.

---

## 7) UI updates

### Widget status lines

- Display `resumed` or `restarted` in ticker/notes.
- Show `resumeCount` if > 1.

### Task list

- Add a visual indicator (e.g. `↻` or `R`) for resumed tasks.

---

## 8) PM context persistence

To avoid PM losing continuity across restarts:

- Add a **PM session file** (like task session files).
- Run PM via `RpcAgent` in RPC mode with `--session <pm-session-file>`.
- Use that session file for both wave generation and chat responses.

This keeps PM memory across restarts.

---

## 9) Shutdown & restart behavior

On `session_shutdown`:

- Abort runners.
- Mark `active = false`.
- Mark `in_progress` tasks as `stopped`.
- Set `resumeInfo.wasRunning = true` and `lastShutdownAt = Date.now()`.
- Persist `previousSummary`/`waveSummaries` if available.

On `session_start`:

- Restore state.
- If `resumeInfo.wasRunning === true`, prompt for resume.

---

## 10) Failure handling

- If a restarted task fails immediately, increment retries as usual.
- If a resumed task exceeds max retries, mark it failed and continue.

---

## 11) Validation & testing

- Simulate crash by `kill -9` pi during in-progress task.
- Restart, resume, verify:
  - Workflow state restored.
  - in_progress tasks restarted from saved session.
  - workflow continues into next wave when current finishes.

---

## Deliverables

- [ ] `WorkflowState` + `TaskState` schema updates
- [ ] Persist `previousSummary`/`waveSummaries`
- [ ] `/workflow resume` command
- [ ] Auto-resume prompt on `session_start`
- [ ] Resume scheduler (full loop, respects parallelism)
- [ ] PM session file support
- [ ] UI changes for resumed tasks
- [ ] Documentation update (README)
