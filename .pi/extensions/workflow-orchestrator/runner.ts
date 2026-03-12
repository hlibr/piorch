import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";

export type AgentRunUpdate =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; toolName: string; args: any }
  | { type: "tool_update"; toolName: string; partialResult: any }
  | { type: "tool_end"; toolName: string; isError: boolean };

export interface AgentRunInput {
  name: string;
  task: string;
  cwd: string;
  systemPrompt: string;
  model?: string;
  tools?: string[];
  signal?: AbortSignal;
  onUpdate?: (update: AgentRunUpdate) => void;
}

export interface AgentRunResult {
  outputText: string;
  messages: Message[];
  stderr: string;
  exitCode: number;
}

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

export async function runAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates"];
  if (input.model) args.push("--model", input.model);
  if (input.tools && input.tools.length > 0) args.push("--tools", input.tools.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  if (input.systemPrompt.trim()) {
    const tmp = writePromptToTempFile(input.name, input.systemPrompt);
    tmpPromptDir = tmp.dir;
    tmpPromptPath = tmp.filePath;
    args.push("--append-system-prompt", tmpPromptPath);
  }

  args.push(input.task);

  const messages: Message[] = [];
  let stderr = "";

  const exitCode = await new Promise<number>((resolve) => {
    const proc = spawn("pi", args, {
      cwd: input.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        input.onUpdate?.({ type: "text_delta", delta: event.assistantMessageEvent.delta ?? "" });
      }

      if (event.type === "tool_execution_start") {
        input.onUpdate?.({ type: "tool_start", toolName: event.toolName, args: event.args });
      }

      if (event.type === "tool_execution_update") {
        input.onUpdate?.({ type: "tool_update", toolName: event.toolName, partialResult: event.partialResult });
      }

      if (event.type === "tool_execution_end") {
        input.onUpdate?.({ type: "tool_end", toolName: event.toolName, isError: event.isError });
      }

      if (event.type === "message_end" && event.message) {
        const msg = event.message as Message;
        messages.push(msg);
      }
      if (event.type === "tool_result_end" && event.message) {
        const msg = event.message as Message;
        messages.push(msg);
      }
    };

    proc.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (buffer.trim()) processLine(buffer);
      resolve(code ?? 0);
    });

    proc.on("error", () => resolve(1));

    if (input.signal) {
      const killProc = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (input.signal.aborted) killProc();
      else input.signal.addEventListener("abort", killProc, { once: true });
    }
  });

  const outputText = getFinalOutput(messages);

  if (tmpPromptPath)
    try {
      fs.unlinkSync(tmpPromptPath);
    } catch {
      /* ignore */
    }
  if (tmpPromptDir)
    try {
      fs.rmdirSync(tmpPromptDir);
    } catch {
      /* ignore */
    }

  return { outputText, messages, stderr, exitCode };
}
