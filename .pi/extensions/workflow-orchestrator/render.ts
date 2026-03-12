import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { WorkflowState } from "./state.js";

export function updateStatus(ctx: ExtensionContext, state?: WorkflowState): void {
  if (!ctx.hasUI) return;

  if (!state) {
    ctx.ui.setStatus("workflow", undefined);
    ctx.ui.setWidget("workflow", undefined);
    return;
  }

  const total = state.tasks.length;
  const verified = state.tasks.filter((task) => task.status === "verified").length;
  const failed = state.tasks.filter((task) => task.status === "failed").length;
  const inProgress = state.tasks.filter((task) => task.status === "in_progress").length;

  const status = `Wave ${state.waveIndex + 1}: ${verified}/${total} verified${failed ? `, ${failed} failed` : ""}`;
  ctx.ui.setStatus("workflow", status);

  const lines = state.tasks.map((task) => {
    const tag = task.status === "verified" ? "✓" : task.status === "failed" ? "✗" : task.status === "in_progress" ? "…" : "•";
    const stage = task.stageId ? ` (${task.stageId})` : "";
    return `${tag} ${task.id}: ${task.title}${stage}`;
  });

  ctx.ui.setWidget("workflow", [`Workflow: ${state.workflowName}`, ...lines]);
}
