import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { WorkflowState } from "./state.js";

let pmWidgetStatus: string | undefined;

export function setPmWidgetStatus(text?: string) {
  pmWidgetStatus = text;
}

function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

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

  const status = `Wave ${state.waveIndex + 1}: ${verified}/${total} verified${failed ? `, ${failed} failed` : ""}`;
  ctx.ui.setStatus("workflow", status);

  const order = { in_progress: 0, pending: 1, verified: 2, failed: 3 } as const;
  const sortedTasks = [...state.tasks].sort((a, b) => {
    const aOrder = order[a.status] ?? 9;
    const bOrder = order[b.status] ?? 9;
    return aOrder - bOrder;
  });

  const theme = ctx.ui.theme;
  const maxWidth = 80;
  const maxTasks = 4;
  const lines: string[] = [];

  lines.push(theme.fg("toolTitle", shorten(`Workflow: ${state.workflowName}`, maxWidth)));
  lines.push(theme.fg("accent", shorten(`PM: ${pmWidgetStatus ?? "idle"}`, maxWidth)));

  const visibleTasks = sortedTasks.slice(0, maxTasks);
  for (const task of visibleTasks) {
    const tag = task.status === "verified" ? "✓" : task.status === "failed" ? "✗" : task.status === "in_progress" ? "…" : "•";
    const stage = task.stageId ? ` (${task.stageId})` : "";
    const agent = task.lastAgent ? ` [${task.lastAgent}]` : "";
    const note = task.lastNote ? ` — ${task.lastNote}` : "";
    const header = `${tag} ${task.id}${agent}${stage}`;
    const remainingWidth = Math.max(20, maxWidth - header.length - note.length - 2);
    const title = shorten(task.title, remainingWidth);
    lines.push(theme.fg("toolOutput", shorten(`${header}: ${title}${note}`, maxWidth)));

    if (task.status === "in_progress" && task.lastOutput) {
      lines.push(theme.fg("dim", shorten(`↳ ${task.lastOutput}`, maxWidth)));
    }
  }

  const remaining = Math.max(0, sortedTasks.length - visibleTasks.length);
  if (remaining > 0) lines.push(theme.fg("muted", `… +${remaining} more`));

  ctx.ui.setWidget("workflow", lines);
}
