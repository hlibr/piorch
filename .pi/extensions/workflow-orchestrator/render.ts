import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { WorkflowState } from "./state.js";

let pmWidgetStatus: string | undefined;
let taskListExpanded = false;

export function setPmWidgetStatus(text?: string) {
  pmWidgetStatus = text;
}

export function setTaskListExpanded(expanded: boolean) {
  taskListExpanded = expanded;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function formatAge(ms: number): string {
  const seconds = Math.max(1, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
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

  const order = { in_progress: 0, pending: 1, stopped: 2, verified: 3, failed: 4 } as const;
  const sortedTasks = [...state.tasks].sort((a, b) => {
    const aOrder = order[a.status] ?? 9;
    const bOrder = order[b.status] ?? 9;
    return aOrder - bOrder;
  });

  const theme = ctx.ui.theme;
  const maxWidth = 80;
  const maxTasks = taskListExpanded ? 10 : 4;
  const lines: string[] = [];

  lines.push(theme.fg("text", shorten(`Workflow: ${state.workflowName}`, maxWidth)));
  lines.push(theme.fg("accent", shorten(`PM: ${pmWidgetStatus ?? "idle"}`, maxWidth)));

  const visibleTasks = sortedTasks.slice(0, maxTasks);
  for (const task of visibleTasks) {
    const ageMs = task.lastActivityAt ? Date.now() - task.lastActivityAt : undefined;
    const isActive = typeof ageMs === "number" && ageMs < 4000;
    const spinner = isActive
      ? SPINNER_FRAMES[Math.floor(Date.now() / 120) % SPINNER_FRAMES.length]
      : "…";
    const tag =
      task.status === "verified"
        ? "✓"
        : task.status === "failed"
          ? "✗"
          : task.status === "stopped"
            ? "⏸"
            : task.status === "in_progress"
              ? spinner
              : "•";
    const stage = task.stageId ? ` (${task.stageId})` : "";
    const agent = task.lastAgent ? ` [${task.lastAgent}]` : "";
    const note = task.lastNote ? ` — ${task.lastNote}` : "";
    const ageText = ageMs ? ` · ${formatAge(ageMs)}` : "";
    const header = `${tag} ${task.id}${agent}${stage}`;
    const remainingWidth = Math.max(
      20,
      maxWidth - header.length - note.length - ageText.length - 2,
    );
    const title = shorten(task.title, remainingWidth);
    const statusColor =
      task.status === "verified"
        ? "success"
        : task.status === "failed"
          ? "error"
          : task.status === "in_progress"
            ? "warning"
            : task.status === "stopped"
              ? "muted"
              : "text";
    lines.push(theme.fg(statusColor, shorten(`${header}: ${title}${note}${ageText}`, maxWidth)));

    if (task.status === "in_progress" && task.lastOutput) {
      lines.push(theme.fg("dim", shorten(`↳ ${task.lastOutput}`, maxWidth)));
    }
  }

  const remaining = Math.max(0, sortedTasks.length - visibleTasks.length);
  if (remaining > 0) {
    const hint = taskListExpanded ? "" : " (use /workflow expand)";
    lines.push(theme.fg("muted", `… +${remaining} more${hint}`));
  }

  ctx.ui.setWidget("workflow", lines);
}
