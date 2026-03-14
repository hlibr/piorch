import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = process.env.PI_TEST_MODEL;

if (!model) {
  console.error(
    "PI_TEST_MODEL is required to run this harness (e.g. anthropic/claude-sonnet-4-5).",
  );
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "piorch-pm-memory-"));
const sessionFile = path.join(tmpDir, "pm-memory.jsonl");

const args = [
  "--mode",
  "rpc",
  "--session",
  sessionFile,
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--model",
  model,
];

const proc = spawn("pi", args, { stdio: ["pipe", "pipe", "pipe"] });

let buffer = "";
let currentResolve;
let currentReject;
let lastAssistantText = "";

function send(payload) {
  proc.stdin.write(`${JSON.stringify(payload)}\n`);
}

function runPrompt(message) {
  if (currentResolve) throw new Error("Prompt already running");
  return new Promise((resolve, reject) => {
    currentResolve = resolve;
    currentReject = reject;
    lastAssistantText = "";
    send({ type: "prompt", message });
  });
}

proc.stdout.on("data", (data) => {
  buffer += data.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "message_end" && event.message?.role === "assistant") {
      for (const part of event.message.content || []) {
        if (typeof part === "string") lastAssistantText = part;
        else if (part.type === "text") lastAssistantText = part.text;
      }
    }

    if (event.type === "agent_end") {
      if (currentResolve) {
        currentResolve(lastAssistantText);
        currentResolve = undefined;
        currentReject = undefined;
      }
    }
  }
});

proc.stderr.on("data", (data) => {
  process.stderr.write(data.toString());
});

proc.on("close", (code) => {
  if (currentReject) {
    currentReject(new Error(`pi exited with code ${code ?? "unknown"}`));
  }
});

try {
  console.log("Prompt 1: store memory");
  await runPrompt("Remember this code word: KIWI. Reply with 'OK'.");

  console.log("Prompt 2: recall memory");
  const response = await runPrompt(
    "What code word did I ask you to remember? Reply with just the word.",
  );

  if (!response.toLowerCase().includes("kiwi")) {
    console.error("Memory check failed. Response:", response);
    process.exit(1);
  }

  if (!fs.existsSync(sessionFile)) {
    console.error("Session file was not created:", sessionFile);
    process.exit(1);
  }

  const sessionContents = fs.readFileSync(sessionFile, "utf-8");
  if (!sessionContents.toLowerCase().includes("kiwi")) {
    console.error("Session file does not contain expected content.");
    process.exit(1);
  }

  console.log("PM memory harness succeeded.");
  proc.kill("SIGTERM");
} catch (error) {
  console.error("PM memory harness failed:", error);
  proc.kill("SIGTERM");
  process.exit(1);
}
