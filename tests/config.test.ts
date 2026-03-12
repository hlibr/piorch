import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadWorkflowConfig } from "../.pi/extensions/workflow-orchestrator/config.js";

function setupTempConfig(content: string): { cwd: string; name: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-test-"));
  const workflowDir = path.join(dir, ".pi", "workflows");
  fs.mkdirSync(workflowDir, { recursive: true });
  const name = "temp";
  fs.writeFileSync(path.join(workflowDir, `${name}.workflow.json`), content, "utf-8");
  return { cwd: dir, name };
}

describe("loadWorkflowConfig", () => {
  it("throws on invalid JSON", () => {
    const { cwd, name } = setupTempConfig("{ invalid json }");
    expect(() => loadWorkflowConfig(cwd, name)).toThrow();
  });

  it("throws on schema mismatch", () => {
    const { cwd, name } = setupTempConfig(JSON.stringify({ name: "x" }));
    expect(() => loadWorkflowConfig(cwd, name)).toThrow();
  });

  it("loads valid config", () => {
    const config = {
      name: "temp",
      goal: "test",
      parallelism: 1,
      agents: { pm: "pm", developer: "dev", verifier: "ver" },
      waveSource: { type: "static", staticWaves: [{ goal: "g", tasks: [] }] },
      taskFlow: { stages: [{ id: "develop", agent: "dev", inputTemplate: "x", outputSchema: {} }] },
    };
    const { cwd, name } = setupTempConfig(JSON.stringify(config));
    const loaded = loadWorkflowConfig(cwd, name);
    expect(loaded.config.name).toBe("temp");
    expect(loaded.config.parallelism).toBe(1);
  });
});
