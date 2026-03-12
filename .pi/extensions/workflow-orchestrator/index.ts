import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { discoverAgents, findAgentByName } from "./agents.js";
import { loadWorkflowConfig, type WorkflowConfig, type WorkflowStage, type WorkflowTask, type WorkflowWave } from "./config.js";
import { updateStatus } from "./render.js";
import { runAgent } from "./runner.js";
import { appendState, restoreState, type TaskState, type WorkflowState } from "./state.js";

interface WorkflowRunHandle {
  abortController: AbortController;
  promise: Promise<void>;
}

let currentRun: WorkflowRunHandle | null = null;
let currentState: WorkflowState | undefined;

function setState(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: WorkflowState) {
  const nextState = { ...state, updatedAt: Date.now() };
  currentState = nextState;
  appendState(pi, nextState);
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
  ctx: ExtensionCommandContext,
  config: WorkflowConfig,
  task: TaskState,
  wave: WorkflowWave,
  agents: ReturnType<typeof discoverAgents>["agents"],
  signal: AbortSignal,
): Promise<void> {
  const stages = config.taskFlow.stages;
  let currentStageId = stages[0]?.id;

  while (currentStageId) {
    if (signal.aborted) throw new Error("Workflow aborted");

    const stage = findStageById(stages, currentStageId);
    if (!stage) throw new Error(`Stage not found: ${currentStageId}`);

    task.status = "in_progress";
    task.stageId = stage.id;
    task.lastAgent = stage.agent;
    task.lastNote = `running ${stage.id}`;
    setState(pi, ctx, { ...currentState!, tasks: [...currentState!.tasks] });

    const agentName = stage.agent;
    const agent = findAgentByName(agents, agentName);
    if (!agent) throw new Error(`Agent not found: ${agentName}`);

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

    const taskPrompt = renderTemplate(stage.inputTemplate, templateData as Record<string, unknown>);

    let output: any;
    try {
      const result = await runAgent({
        name: agent.name,
        task: taskPrompt,
        cwd: ctx.cwd,
        systemPrompt: agent.systemPrompt,
        model: agent.model,
        tools: agent.tools,
        signal,
      });
      if (result.exitCode !== 0) throw new Error(result.stderr || "Agent failed");
      output = extractJson(result.outputText || "");
      if (typeof output?.status === "string") {
        task.lastNote = `status: ${output.status}`;
      } else if (typeof output?.summary === "string") {
        task.lastNote = output.summary.slice(0, 80);
      } else {
        task.lastNote = "completed";
      }
    } catch (error: any) {
      const message = error?.message || "Agent output parse failed";
      task.lastNote = `error: ${message}`;
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
  ctx: ExtensionCommandContext,
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

function buildWaveSummary(state: WorkflowState): string {
  const lines = state.tasks.map((task) => {
    const status = task.status === "verified" ? "verified" : task.status === "failed" ? "failed" : task.status;
    return `${task.id}: ${task.title} (${status})`;
  });
  return lines.join("\n");
}

async function generateWaveFromPm(
  config: WorkflowConfig,
  agents: ReturnType<typeof discoverAgents>["agents"],
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
  previousSummary: string,
): Promise<{ done: boolean; wave?: WorkflowWave }> {
  const pmAgent = findAgentByName(agents, config.agents.pm);
  if (!pmAgent) throw new Error(`PM agent not found: ${config.agents.pm}`);

  const prompt = [
    `Project goal: ${config.goal}`,
    previousSummary ? `Previous wave summary:\n${previousSummary}` : "No previous wave summary.",
    "Return the next wave JSON response.",
  ].join("\n\n");

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

  const output = extractJson(result.outputText || "");
  if (output.done === true) return { done: true };
  if (!output.wave) throw new Error("PM output missing wave");
  return { done: false, wave: output.wave as WorkflowWave };
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
          const pmResult = await generateWaveFromPm(effectiveConfig, agents, ctx, abortController.signal, previousSummary);
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
      if (ctx.hasUI) ctx.ui.notify("Workflow completed", "info");
    } catch (error: any) {
      const message = error?.message || "Workflow failed";
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
  if (currentState) {
    currentState.active = false;
    setState(pi, ctx, currentState);
  }
  if (ctx.hasUI) ctx.ui.notify("Workflow stopped", "info");
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    currentState = restoreState(ctx);
    if (currentState) updateStatus(ctx, currentState);
  });

  pi.registerCommand("workflow", {
    description: "Manage workflow orchestrator",
    handler: async (args, ctx) => {
      const tokens = (args || "").split(/\s+/).filter(Boolean);
      const command = tokens[0];
      const name = tokens[1];
      const goalText = normalizeGoal(tokens.slice(2).join(" "));

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

      ctx.ui?.notify("Usage: /workflow start|status|stop", "warning");
    },
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
}
