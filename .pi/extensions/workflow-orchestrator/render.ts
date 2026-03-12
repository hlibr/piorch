import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { WorkflowState } from "./state.js";

let pmWidgetStatus: string | undefined;

export function setPmWidgetStatus(text?: string) {
  pmWidgetStatus = text;
}

function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function truncateLine(text: string, max: number): string {
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

  ctx.ui.setWidget("workflow", (tui, theme) => {
    const maxWidth = Math.max(40, tui.width - 4);
    const maxLines = 6;
    const lines: string[] = [];

    lines.push(theme.fg("toolTitle", truncateLine(`Workflow: ${state.workflowName}`, maxWidth)));
    lines.push(theme.fg("accent", truncateLine(`PM: ${pmWidgetStatus ?? "idle"}`, maxWidth)));

    for (const task of sortedTasks) {
      if (lines.length + 1 > maxLines) break;
      const tag = task.status === "verified" ? "✓" : task.status === "failed" ? "✗" : task.status === "in_progress" ? "…" : "•";
      const stage = task.stageId ? ` (${task.stageId})` : "";
      const agent = task.lastAgent ? ` [${task.lastAgent}]` : "";
      const note = task.lastNote ? ` — ${task.lastNote}` : "";
      const title = shorten(task.title, 60);
      const mainLine = truncateLine(`${tag} ${task.id}: ${title}${stage}${agent}${note}`, maxWidth);
      lines.push(theme.fg("toolOutput", mainLine));

      if (task.status === "in_progress" && task.lastOutput && lines.length + 1 <= maxLines) {
        const tickerLine = truncateLine(`   ↳ ${task.lastOutput}`, maxWidth);
        lines.push(theme.fg("dim", tickerLine));
      }
    }

    if (lines.length < maxLines && sortedTasks.length > 0) {
      const shownTasks = Math.max(0, lines.length - 2);
      const remaining = Math.max(0, sortedTasks.length - shownTasks);
      if (remaining > 0) lines.push(theme.fg("muted", `… +${remaining} more`));
    }

    return new Text(lines.join("\n"), 0, 0);
  });
}
