import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { discoverAgents, findAgentByName } from "./agents.js";
import { loadWorkflowConfig, type WorkflowConfig, type WorkflowStage, type WorkflowTask, type WorkflowWave } from "./config.js";
import { setPmWidgetStatus, setTaskListExpanded, updateStatus } from "./render.js";
import { RpcAgent, runAgent } from "./runner.js";
import { appendState, restoreState, type TaskState, type WorkflowState } from "./state.js";

interface WorkflowRunHandle {
  abortController: AbortController;
  promise: Promise<void>;
}

const PM_MESSAGE_TYPE = "workflow-pm";

interface TaskRunner {
  key: string;
  agent: RpcAgent;
  stageId: string;
}

let currentRun: WorkflowRunHandle | null = null;
let currentState: WorkflowState | undefined;
let pmBusy = false;
const taskRunners = new Map<string, TaskRunner>();

function setState(pi: ExtensionAPI, ctx: ExtensionContext, state: WorkflowState, persist = true) {
  const nextState = { ...state, updatedAt: Date.now() };
  currentState = nextState;
  if (persist) appendState(pi, nextState);
  updateStatus(ctx, nextState);
}

function getByPath(obj: any, path: string): any {
  const parts = path.split(".").filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const value = getByPath(data, path);
    if (value === undefined || value === null) return "";
    if (Array.isArray(value)) return value.join("\n");
    return String(value);
  });
}

function extractJson(text: string): any {
  const cleaned = text.replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ""));
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON object found");
  const jsonText = cleaned.slice(start, end + 1);
  return JSON.parse(jsonText);
}

function normalizeGoal(goal?: string): string | undefined {
  if (!goal) return undefined;
  const trimmed = goal.trim();
  if (!trimmed) return undefined;
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

const MAX_TICKER_CHARS = 160;

function truncateTicker(text: string): string {
  if (text.length <= MAX_TICKER_CHARS) return text;
  const sliceLength = MAX_TICKER_CHARS - 1;
  return `…${text.slice(-sliceLength)}`;
}

function lastSentence(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match = normalized.match(/[^.!?]*[.!?](?=\s|$)/g);
  if (!match || match.length === 0) return normalized;
  return match[match.length - 1].trim();
}

function appendOutput(task: TaskState, chunk: string, mode: "delta" | "line") {
  const current = task.lastOutput ?? "";
  if (mode === "delta") {
    const next = lastSentence(`${current} ${chunk}`);
    task.lastOutput = truncateTicker(next);
    return;
  }
  task.lastOutput = truncateTicker(chunk.replace(/\s+/g, " ").trim());
}

function sendPmMessage(pi: ExtensionAPI, text: string) {
  pi.sendMessage({
    customType: PM_MESSAGE_TYPE,
    content: text,
    display: true,
  });
}

function sendAgentSummary(pi: ExtensionAPI, task: TaskState, stageId: string, summary: string) {
  const agent = task.lastAgent ?? "agent";
  const title = task.title;
  const message = `${agent} (${stageId}) finished ${task.id}: ${title}\n${summary}`;
  pi.sendMessage({
    customType: PM_MESSAGE_TYPE,
    content: message,
    display: true,
  });
}

function setPmStatus(ctx: ExtensionContext, text?: string) {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus("workflow-pm", text);
  setPmWidgetStatus(text ? text.replace(/^PM:\s*/i, "") : undefined);
}

function sendWorkflowNotice(pi: ExtensionAPI, text: string) {
  pi.sendMessage({
    customType: PM_MESSAGE_TYPE,
    content: text,
    display: true,
  });
}

function buildWaveSummary(state: WorkflowState): string {
  const lines = state.tasks.map((task) => {
    const status = task.status === "verified" ? "verified" : task.status === "failed" ? "failed" : task.status;
    return `${task.id}: ${task.title} (${status})`;
  });
  return lines.join("\n");
}

function summarizeWave(wave: WorkflowWave): string {
  const lines = wave.tasks.map((task) => `${task.id}: ${task.title}`);
  return [`PM generated wave: ${wave.goal}`, ...lines].join("\n");
}

function buildPmChatPrompt(state: WorkflowState, message: string): string {
  const summary = state.tasks.length > 0 ? buildWaveSummary(state) : "No tasks yet.";
  return [
    `Project goal: ${state.goal}`,
    `Current wave: ${state.waveIndex + 1}`,
    `Wave summary:\n${summary}`,
    "User message:",
    message,
    "Respond conversationally. Do NOT output JSON.",
  ].join("\n\n");
}

async function mapWithConcurrencyLimit<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

function buildTaskState(task: WorkflowTask): TaskState {
  return {
    ...task,
    status: "pending",
    retries: 0,
  };
}

function ensureSessionFile(state: WorkflowState, task: TaskState, stageId: string): string {
  const workflowDir = path.join(".pi", "workflows", "sessions", state.runId);
  fs.mkdirSync(workflowDir, { recursive: true });
  if (!task.sessionFiles) task.sessionFiles = {};
  if (!task.sessionFiles[stageId]) {
    task.sessionFiles[stageId] = path.join(workflowDir, `${task.id}-${stageId}.jsonl`);
  }
  return task.sessionFiles[stageId]!;
}

function getRunnerKey(taskId: string, stageId: string): string {
  return `${taskId}:${stageId}`;
}

function findTask(taskId: string): TaskState | undefined {
  return currentState?.tasks.find((task) => task.id === taskId);
}

function getTaskRunner(
  ctx: ExtensionContext,
  task: TaskState,
  stage: WorkflowStage,
  agentName: string,
  agents: ReturnType<typeof discoverAgents>["agents"],
): TaskRunner {
  if (!currentState) throw new Error("No workflow state");
  const key = getRunnerKey(task.id, stage.id);
  const existing = taskRunners.get(key);
  if (existing) return existing;

  const agent = findAgentByName(agents, agentName);
  if (!agent) throw new Error(`Agent not found: ${agentName}`);

  const sessionFile = ensureSessionFile(currentState, task, stage.id);
  const runner = new RpcAgent({
    cwd: ctx.cwd,
    sessionFile,
    systemPrompt: agent.systemPrompt,
    model: agent.model,
    tools: agent.tools,
  });

  const taskRunner: TaskRunner = { key, agent: runner, stageId: stage.id };
  taskRunners.set(key, taskRunner);
  return taskRunner;
}

function stopTask(task: TaskState) {
  if (!task.stageId) return;
  const key = getRunnerKey(task.id, task.stageId);
  const runner = taskRunners.get(key);
  runner?.agent.abort();
  task.status = "stopped";
  task.lastNote = "stopped";
}

async function messageTask(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: WorkflowConfig,
  task: TaskState,
  message: string,
  agents: ReturnType<typeof discoverAgents>["agents"],
) {
  if (!task.stageId) throw new Error("Task has no active stage");
  const stage = findStageById(config.taskFlow.stages, task.stageId);
  if (!stage) throw new Error(`Stage not found: ${task.stageId}`);

  const key = getRunnerKey(task.id, task.stageId);
  const runner = taskRunners.get(key);
  if (runner) {
    runner.agent.sendSteer(message);
    task.lastNote = "running";
    task.status = "in_progress";
    setState(pi, ctx, { ...currentState!, tasks: [...currentState!.tasks] });
    return;
  }

  if (!currentState?.wave) throw new Error("No active wave");
  task.resumeMessage = message;
  task.lastNote = "running";
  task.status = "in_progress";
  setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] });
  void processTask(pi, ctx, config, task, currentState.wave, agents, new AbortController().signal, task.stageId);
}

function findStageById(stages: WorkflowStage[], id: string): WorkflowStage | undefined {
  return stages.find((stage) => stage.id === id);
}

function getNextStageId(stages: WorkflowStage[], currentStageId: string): string | undefined {
  const index = stages.findIndex((stage) => stage.id === currentStageId);
  if (index === -1) return undefined;
  return stages[index + 1]?.id;
}

async function processTask(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: WorkflowConfig,
  task: TaskState,
  wave: WorkflowWave,
  agents: ReturnType<typeof discoverAgents>["agents"],
  signal: AbortSignal,
  startStageId?: string,
): Promise<void> {
  const stages = config.taskFlow.stages;
  let currentStageId = startStageId ?? stages[0]?.id;

  while (currentStageId) {
    if (signal.aborted) throw new Error("Workflow aborted");
    if (task.status === "stopped") return;

    const stage = findStageById(stages, currentStageId);
    if (!stage) throw new Error(`Stage not found: ${currentStageId}`);

    task.status = "in_progress";
    task.stageId = stage.id;
    task.lastAgent = stage.agent;
    task.lastNote = "running";
    setState(pi, ctx, { ...currentState!, tasks: [...currentState!.tasks] });

    const agentName = stage.agent;
    const templateData = {
      task: {
        ...task,
        dev: task.devOutput,
        verify: task.verifyOutput,
        issues: task.issues,
      },
      workflow: { goal: config.goal },
      wave: { goal: wave.goal, index: currentState?.waveIndex ?? 0 },
    };

    let taskPrompt = renderTemplate(stage.inputTemplate, templateData as Record<string, unknown>);
    if (task.resumeMessage) {
      taskPrompt = `${taskPrompt}\n\nAdditional instruction:\n${task.resumeMessage}`;
      task.resumeMessage = undefined;
    }

    let output: any;
    try {
      const runner = getTaskRunner(ctx, task, stage, agentName, agents);
      const outputText = await runner.agent.runPrompt(taskPrompt, {
        onUpdate: (update) => {
          if (!currentState) return;
          if (update.type === "text_delta") {
            appendOutput(task, update.delta, "delta");
            setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] }, false);
            return;
          }
          if (update.type === "tool_start") {
            appendOutput(task, `tool ${update.toolName}`, "line");
            setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] }, false);
          }
        },
      });

      if (task.status === "stopped") return;

      output = extractJson(outputText);
      if (typeof output?.status === "string") {
        task.lastNote = String(output.status);
      } else if (typeof output?.summary === "string") {
        task.lastNote = output.summary.slice(0, 80);
      } else {
        task.lastNote = "completed";
      }
      const tickerSource = typeof output?.summary === "string" ? output.summary : outputText.split("\n")[0] ?? "";
      task.lastOutput = truncateTicker(tickerSource.trim());
    } catch (error: any) {
      if (task.status === "stopped") return;
      const message = error?.message || "Agent output parse failed";
      task.lastNote = `error: ${message}`;
      task.lastOutput = truncateTicker(message);
      if (stage.id === "verify") {
        task.verifyOutput = { status: "fail", issues: [message] };
        task.issues = [message];
        task.retries += 1;
        if (task.retries > config.maxTaskRetries) {
          task.status = "failed";
          task.stageId = stage.id;
          setState(pi, ctx, { ...currentState!, tasks: [...currentState!.tasks] });
          return;
        }
        currentStageId = config.taskFlow.stages[0]?.id;
        setState(pi, ctx, { ...currentState!, tasks: [...currentState!.tasks] });
        continue;
      }

      task.issues = [message];
      task.retries += 1;
      if (task.retries > config.maxTaskRetries) {
        task.status = "failed";
        setState(pi, ctx, { ...currentState!, tasks: [...currentState!.tasks] });
        return;
      }
      setState(pi, ctx, { ...currentState!, tasks: [...currentState!.tasks] });
      continue;
    }

    if (stage.id === "develop") task.devOutput = output;
    if (stage.id === "verify") task.verifyOutput = output;

    if (stage.id === "develop") {
      const summary = typeof output?.summary === "string" ? output.summary : JSON.stringify(output);
      sendAgentSummary(pi, task, stage.id, summary);
    }

    if (stage.id === "verify") {
      const status = output?.status ? String(output.status) : "unknown";
      const issues = Array.isArray(output?.issues) ? output.issues.join("; ") : "";
      const summary = issues ? `${status}\nissues: ${issues}` : status;
      sendAgentSummary(pi, task, stage.id, summary);
    }

    let nextStageId: string | undefined;
    if (stage.transitions && stage.transitions.length > 0) {
      for (const transition of stage.transitions) {
        const fieldValue = getByPath(output, transition.when.field);
        if (String(fieldValue) === transition.when.equals) {
          nextStageId = transition.next;
          break;
        }
      }
    } else {
      nextStageId = getNextStageId(stages, stage.id);
    }

    if (!nextStageId || nextStageId === "complete") {
      task.status = "verified";
      task.stageId = stage.id;
      setState(pi, ctx, { ...currentState!, tasks: [...currentState!.tasks] });
      return;
    }

    if (nextStageId === stages[0]?.id && stage.id === "verify") {
      const issues = output?.issues;
      task.issues = Array.isArray(issues) ? issues.map(String) : ["Verification failed"];
      task.retries += 1;
      if (task.retries > config.maxTaskRetries) {
        task.status = "failed";
        task.stageId = stage.id;
        setState(pi, ctx, { ...currentState!, tasks: [...currentState!.tasks] });
        return;
      }
    }

    currentStageId = nextStageId;
    setState(pi, ctx, { ...currentState!, tasks: [...currentState!.tasks] });
  }
}

async function runWave(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: WorkflowConfig,
  wave: WorkflowWave,
  agents: ReturnType<typeof discoverAgents>["agents"],
  signal: AbortSignal,
): Promise<void> {
  const tasks = wave.tasks.map(buildTaskState);
  const newState: WorkflowState = {
    ...currentState!,
    wave,
    tasks,
    updatedAt: Date.now(),
  };
  setState(pi, ctx, newState);

  await mapWithConcurrencyLimit(tasks, config.parallelism ?? 1, async (task) =>
    processTask(pi, ctx, config, task, wave, agents, signal),
  );
}

async function runPmAgent(
  pi: ExtensionAPI,
  config: WorkflowConfig,
  agents: ReturnType<typeof discoverAgents>["agents"],
  ctx: ExtensionContext,
  signal: AbortSignal,
  prompt: string,
): Promise<string> {
  const pmAgent = findAgentByName(agents, config.agents.pm);
  if (!pmAgent) throw new Error(`PM agent not found: ${config.agents.pm}`);
  if (pmBusy) throw new Error("PM is already running");
  pmBusy = true;
  setPmStatus(ctx, "PM: responding...");
  try {
    const result = await runAgent({
      name: pmAgent.name,
      task: prompt,
      cwd: ctx.cwd,
      systemPrompt: pmAgent.systemPrompt,
      model: pmAgent.model,
      tools: pmAgent.tools,
      signal,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || "PM agent failed");
    return result.outputText || "";
  } finally {
    pmBusy = false;
    setPmStatus(ctx, undefined);
  }
}

async function generateWaveFromPm(
  pi: ExtensionAPI,
  config: WorkflowConfig,
  agents: ReturnType<typeof discoverAgents>["agents"],
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
  previousSummary: string,
): Promise<{ done: boolean; wave?: WorkflowWave }> {
  const prompt = [
    `Project goal: ${config.goal}`,
    previousSummary ? `Previous wave summary:\n${previousSummary}` : "No previous wave summary.",
    "Return the next wave JSON response.",
  ].join("\n\n");

  const outputText = await runPmAgent(pi, config, agents, ctx, signal, prompt);

  const output = extractJson(outputText || "");
  if (output.done === true) {
    sendPmMessage(pi, "PM reports: all work is complete.");
    return { done: true };
  }
  if (!output.wave) throw new Error("PM output missing wave");
  const wave = output.wave as WorkflowWave;
  sendPmMessage(pi, summarizeWave(wave));
  return { done: false, wave };
}

async function startWorkflow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  workflowName: string,
  goalOverride?: string,
): Promise<void> {
  if (currentRun) {
    if (ctx.hasUI) ctx.ui.notify("Workflow already running", "warning");
    return;
  }

  const { config } = loadWorkflowConfig(ctx.cwd, workflowName);
  const { agents } = discoverAgents(ctx.cwd);
  const effectiveConfig: WorkflowConfig = {
    ...config,
    goal: goalOverride ?? config.goal,
  };

  const abortController = new AbortController();
  const runPromise = (async () => {
    try {
      const initialState: WorkflowState = {
        runId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        workflowName: effectiveConfig.name,
        goal: effectiveConfig.goal,
        active: true,
        waveIndex: 0,
        tasks: [],
        updatedAt: Date.now(),
      };
      setState(pi, ctx, initialState);
      sendWorkflowNotice(pi, `Workflow started: ${effectiveConfig.goal}`);

      let previousSummary = "";

      for (let waveIndex = 0; waveIndex < (effectiveConfig.maxWaves ?? 10); waveIndex++) {
        if (abortController.signal.aborted) throw new Error("Workflow aborted");

        let wave: WorkflowWave | undefined;
        if (effectiveConfig.waveSource.type === "static") {
          wave = effectiveConfig.waveSource.staticWaves?.[waveIndex];
          if (!wave) {
            break;
          }
        } else {
          const pmResult = await generateWaveFromPm(pi, effectiveConfig, agents, ctx, abortController.signal, previousSummary);
          if (pmResult.done) {
            break;
          }
          wave = pmResult.wave;
        }

        if (!wave) break;

        const updatedState: WorkflowState = {
          ...currentState!,
          waveIndex,
          wave,
          tasks: [],
          updatedAt: Date.now(),
        };
        setState(pi, ctx, updatedState);

        await runWave(pi, ctx, effectiveConfig, wave, agents, abortController.signal);

        previousSummary = buildWaveSummary(currentState!);
      }

      const finalState: WorkflowState = {
        ...currentState!,
        active: false,
        updatedAt: Date.now(),
      };
      setState(pi, ctx, finalState);
      sendWorkflowNotice(pi, "Workflow completed.");
      if (ctx.hasUI) ctx.ui.notify("Workflow completed", "info");
    } catch (error: any) {
      const message = error?.message || "Workflow failed";
      sendWorkflowNotice(pi, `Workflow error: ${message}`);
      if (ctx.hasUI) ctx.ui.notify(message, "error");
      if (currentState) {
        setState(pi, ctx, { ...currentState, active: false, updatedAt: Date.now() });
      }
    } finally {
      currentRun = null;
    }
  })();

  currentRun = { abortController, promise: runPromise };
}

function stopWorkflow(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  if (!currentRun) {
    if (ctx.hasUI) ctx.ui.notify("No active workflow", "warning");
    return;
  }
  currentRun.abortController.abort();
  currentRun = null;
  for (const runner of taskRunners.values()) runner.agent.abort();
  if (currentState) {
    currentState.active = false;
    setState(pi, ctx, currentState);
  }
  sendWorkflowNotice(pi, "Workflow stopped.");
  if (ctx.hasUI) ctx.ui.notify("Workflow stopped", "info");
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    currentState = restoreState(ctx);
    if (currentState) updateStatus(ctx, currentState);
    setPmStatus(ctx, undefined);
    taskRunners.clear();
  });

  pi.on("input", async (event, ctx) => {
    if (!currentState?.active) return { action: "continue" };
    if (event.source === "extension") return { action: "continue" };
    if (event.text.trim().startsWith("/")) return { action: "continue" };
    if (pmBusy) {
      if (ctx.hasUI) ctx.ui.notify("PM is busy. Try again shortly.", "warning");
      return { action: "handled" };
    }

    try {
      const { config } = loadWorkflowConfig(ctx.cwd, currentState.workflowName);
      const { agents } = discoverAgents(ctx.cwd);
      const effectiveConfig: WorkflowConfig = { ...config, goal: currentState.goal };
      const prompt = buildPmChatPrompt(currentState, event.text);
      const outputText = await runPmAgent(pi, effectiveConfig, agents, ctx, new AbortController().signal, prompt);
      sendPmMessage(pi, outputText);
      return { action: "handled" };
    } catch (error: any) {
      if (ctx.hasUI) ctx.ui.notify(error?.message || "PM chat failed", "error");
      return { action: "handled" };
    }
  });

  pi.registerCommand("workflow", {
    description: "Manage workflow orchestrator",
    handler: async (args, ctx) => {
      const tokens = (args || "").split(/\s+/).filter(Boolean);
      const command = tokens[0];
      const name = tokens[1];
      const goalText = normalizeGoal(tokens.slice(2).join(" "));

      if (!command || command === "help") {
        sendWorkflowNotice(
          pi,
          [
            "Workflow commands:",
            "  /workflow start <name> [goal]",
            "  /workflow status",
            "  /workflow stop",
            "  /workflow stop-task <id>",
            "  /workflow message <id> <message>",
            "  /workflow expand",
            "  /workflow collapse",
            "Example:",
            "  /workflow start default \"Build a Telegram bot\"",
          ].join("\n"),
        );
        return;
      }

      if (command === "start") {
        if (!name) {
          ctx.ui?.notify("Usage: /workflow start <name> [goal]", "warning");
          return;
        }
        void startWorkflow(pi, ctx, name, goalText);
        return;
      }

      if (command === "status") {
        if (!currentState) {
          ctx.ui?.notify("No workflow state", "info");
          return;
        }
        updateStatus(ctx, currentState);
        return;
      }

      if (command === "stop") {
        stopWorkflow(pi, ctx);
        return;
      }

      if (command === "stop-task") {
        if (!currentState) {
          ctx.ui?.notify("No workflow state", "info");
          return;
        }
        if (!name) {
          ctx.ui?.notify("Usage: /workflow stop-task <id>", "warning");
          return;
        }
        const task = findTask(name);
        if (!task) {
          ctx.ui?.notify(`Task not found: ${name}`, "warning");
          return;
        }
        stopTask(task);
        setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] });
        return;
      }

      if (command === "message") {
        if (!currentState) {
          ctx.ui?.notify("No workflow state", "info");
          return;
        }
        if (!name) {
          ctx.ui?.notify("Usage: /workflow message <id> <message>", "warning");
          return;
        }
        const message = tokens.slice(2).join(" ");
        if (!message) {
          ctx.ui?.notify("Usage: /workflow message <id> <message>", "warning");
          return;
        }
        const task = findTask(name);
        if (!task) {
          ctx.ui?.notify(`Task not found: ${name}`, "warning");
          return;
        }
        const { config } = loadWorkflowConfig(ctx.cwd, currentState.workflowName);
        const { agents } = discoverAgents(ctx.cwd);
        void messageTask(pi, ctx, config, task, message, agents);
        return;
      }

      if (command === "expand") {
        setTaskListExpanded(true);
        if (currentState) updateStatus(ctx, currentState);
        return;
      }

      if (command === "collapse") {
        setTaskListExpanded(false);
        if (currentState) updateStatus(ctx, currentState);
        return;
      }

      ctx.ui?.notify("Usage: /workflow start|status|stop|stop-task|message|expand|collapse", "warning");
    },
  });

  pi.registerMessageRenderer(PM_MESSAGE_TYPE, (message, _options, theme) => {
    const text = theme.fg("toolTitle", theme.bold("PM")) + theme.fg("muted", ": ") + message.content;
    return new Text(text, 0, 0);
  });

  pi.registerTool({
    name: "workflow_run",
    label: "Workflow Run",
    description: "Start a workflow by name (optional goal override).",
    parameters: Type.Object({
      name: Type.String({ description: "Workflow name" }),
      goal: Type.Optional(Type.String({ description: "Optional goal override" })),
    }),
    async execute(_toolCallId, params) {
      const goal = normalizeGoal(params.goal);
      const command = goal ? `/workflow start ${params.name} "${goal}"` : `/workflow start ${params.name}`;
      pi.sendUserMessage(command, { deliverAs: "followUp" });
      return { content: [{ type: "text", text: `Queued workflow start: ${params.name}` }] };
    },
  });

  pi.registerTool({
    name: "workflow_stop_task",
    label: "Workflow Stop Task",
    description: "Stop a task by id without discarding progress.",
    parameters: Type.Object({
      id: Type.String({ description: "Task id" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!currentState) return { content: [{ type: "text", text: "No workflow state." }] };
      const task = findTask(params.id);
      if (!task) return { content: [{ type: "text", text: `Task not found: ${params.id}` }] };
      stopTask(task);
      setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] });
      return { content: [{ type: "text", text: `Stopped task ${params.id}` }] };
    },
  });

  pi.registerTool({
    name: "workflow_message_task",
    label: "Workflow Message Task",
    description: "Send a message to a running task or resume a stopped task.",
    parameters: Type.Object({
      id: Type.String({ description: "Task id" }),
      message: Type.String({ description: "Message to send" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!currentState) return { content: [{ type: "text", text: "No workflow state." }] };
      const task = findTask(params.id);
      if (!task) return { content: [{ type: "text", text: `Task not found: ${params.id}` }] };
      const { config } = loadWorkflowConfig(ctx.cwd, currentState.workflowName);
      const { agents } = discoverAgents(ctx.cwd);
      await messageTask(pi, ctx, config, task, params.message, agents);
      return { content: [{ type: "text", text: `Sent message to task ${params.id}` }] };
    },
  });
}
