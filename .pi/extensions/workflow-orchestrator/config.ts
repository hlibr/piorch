import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const TransitionSchema = Type.Object({
  when: Type.Object({
    field: Type.String(),
    equals: Type.String(),
  }),
  next: Type.String(),
});

const StageSchema = Type.Object({
  id: Type.String(),
  agent: Type.String(),
  inputTemplate: Type.String(),
  outputSchema: Type.Record(Type.String(), Type.String()),
  transitions: Type.Optional(Type.Array(TransitionSchema)),
});

const TaskSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  description: Type.String(),
  assignee: Type.Optional(Type.String()),
});

const WaveSchema = Type.Object({
  goal: Type.String(),
  tasks: Type.Array(TaskSchema),
});

const WaveSourceSchema = Type.Object({
  type: Type.Union([Type.Literal("pm"), Type.Literal("static")]),
  staticWaves: Type.Optional(Type.Array(WaveSchema)),
});

const WorkflowSchema = Type.Object({
  name: Type.String(),
  goal: Type.String(),
  maxWaves: Type.Optional(Type.Number()),
  maxTaskRetries: Type.Optional(Type.Number()),
  parallelism: Type.Optional(Type.Number()),
  allowedExtensions: Type.Optional(Type.Array(Type.String())),
  agents: Type.Object({
    pm: Type.String(),
    developer: Type.String(),
    verifier: Type.String(),
  }),
  waveSource: WaveSourceSchema,
  taskFlow: Type.Object({
    stages: Type.Array(StageSchema),
  }),
});

export type WorkflowConfig = Static<typeof WorkflowSchema>;
export type WorkflowStage = Static<typeof StageSchema>;
export type WorkflowTask = Static<typeof TaskSchema>;
export type WorkflowWave = Static<typeof WaveSchema>;

export interface LoadedWorkflow {
  config: WorkflowConfig;
  path: string;
}

export function loadWorkflowConfig(cwd: string, name: string): LoadedWorkflow {
  const workflowPath = path.join(cwd, ".pi", "workflows", `${name}.workflow.json`);
  if (!fs.existsSync(workflowPath)) {
    throw new Error(`Workflow not found: ${workflowPath}`);
  }

  const raw = fs.readFileSync(workflowPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (_error) {
    throw new Error(`Invalid JSON in workflow file: ${workflowPath}`);
  }

  if (!Value.Check(WorkflowSchema, parsed)) {
    const errors = [...Value.Errors(WorkflowSchema, parsed)].map((err) => `${err.path} ${err.message}`);
    throw new Error(`Workflow schema validation failed:\n${errors.join("\n")}`);
  }

  const config = parsed as WorkflowConfig;
  config.maxWaves = config.maxWaves ?? 10;
  config.maxTaskRetries = config.maxTaskRetries ?? 2;
  config.parallelism = config.parallelism ?? 1;

  return { config, path: workflowPath };
}
