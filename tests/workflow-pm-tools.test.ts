import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import workflowPmTools from "../.pi/extensions/workflow-pm-tools/index.js";

describe("workflow-pm-tools extension", () => {
  let mockPi: ExtensionAPI;
  let registeredTool: any;

  beforeEach(() => {
    registeredTool = null;

    mockPi = {
      registerTool: vi.fn((toolDef) => {
        registeredTool = toolDef;
      }),
      sendMessage: vi.fn(),
      appendEntry: vi.fn(),
    } as unknown as ExtensionAPI;
  });

  describe("extension initialization", () => {
    it("registers generate_wave tool", () => {
      workflowPmTools(mockPi);

      expect(mockPi.registerTool).toHaveBeenCalled();
      expect(registeredTool).toBeDefined();
    });

    it("generate_wave tool has correct metadata", () => {
      workflowPmTools(mockPi);

      expect(registeredTool.name).toBe("generate_wave");
      expect(registeredTool.label).toBe("Generate Wave");
      expect(registeredTool.description).toContain("PM agent");
    });

    it("generate_wave tool has parameters schema", () => {
      workflowPmTools(mockPi);

      expect(registeredTool.parameters).toBeDefined();
      // Schema is a TypeBox object
      expect(typeof registeredTool.parameters).toBe("object");
    });
  });

  describe("generate_wave tool execute", () => {
    it("returns success for done=true", async () => {
      workflowPmTools(mockPi);

      const result = await registeredTool.execute(
        "tool-call-123",
        { done: true },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toBe("Project completion reported.");
      expect(result.details).toEqual({ params: { done: true } });
    });

    it("returns error for done=false without wave", async () => {
      workflowPmTools(mockPi);

      const result = await registeredTool.execute(
        "tool-call-123",
        { done: false },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toBe("Error: wave is required when done=false");
      expect(result.details).toEqual({ params: { done: false } });
    });

    it("returns success for done=false with wave", async () => {
      workflowPmTools(mockPi);

      const wave = {
        goal: "Implement features",
        tasks: [
          {
            id: "T1",
            title: "Create module",
            description: "Create the main module",
            assignee: "developer",
          },
          {
            id: "T2",
            title: "Write tests",
            description: "Write unit tests",
            assignee: "developer",
          },
        ],
      };

      const result = await registeredTool.execute(
        "tool-call-123",
        { done: false, wave },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain('Wave generated: "Implement features"');
      expect(result.content[0].text).toContain("(2 tasks)");
      expect(result.details.params.wave).toEqual(wave);
    });

    it("handles empty tasks array", async () => {
      workflowPmTools(mockPi);

      const wave = {
        goal: "Empty wave",
        tasks: [],
      };

      const result = await registeredTool.execute(
        "tool-call-123",
        { done: false, wave },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain('Wave generated: "Empty wave"');
      expect(result.content[0].text).toContain("(0 tasks)");
    });

    it("handles wave with requirements", async () => {
      workflowPmTools(mockPi);

      const wave = {
        goal: "Feature with requirements",
        tasks: [
          {
            id: "T1",
            title: "Implement auth",
            description: "Add authentication",
            requirements: "Must use JWT tokens",
            assignee: "developer",
          },
        ],
      };

      const result = await registeredTool.execute(
        "tool-call-123",
        { done: false, wave },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain("(1 tasks)");
      expect(result.details.params.wave).toEqual(wave);
    });

    it("handles task without assignee", async () => {
      workflowPmTools(mockPi);

      const wave = {
        goal: "Default assignee",
        tasks: [
          {
            id: "T1",
            title: "Task without assignee",
            description: "Should default to developer",
          },
        ],
      };

      const result = await registeredTool.execute(
        "tool-call-123",
        { done: false, wave },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain("(1 tasks)");
    });

    it("handles multiple tasks", async () => {
      workflowPmTools(mockPi);

      const wave = {
        goal: "Big wave",
        tasks: Array(5)
          .fill(null)
          .map((_, i) => ({
            id: `T${i + 1}`,
            title: `Task ${i + 1}`,
            description: `Description ${i + 1}`,
            assignee: "developer",
          })),
      };

      const result = await registeredTool.execute(
        "tool-call-123",
        { done: false, wave },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain("(5 tasks)");
    });

    it("includes params in details", async () => {
      workflowPmTools(mockPi);

      const params = {
        done: false,
        wave: {
          goal: "Test",
          tasks: [{ id: "T1", title: "T", description: "D" }],
        },
      };

      const result = await registeredTool.execute(
        "tool-call-123",
        params,
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.details.params).toEqual(params);
    });
  });

  describe("tool parameter validation (schema)", () => {
    it("done parameter is boolean", () => {
      workflowPmTools(mockPi);

      // The schema is TypeBox, we verify the structure exists
      expect(registeredTool.parameters).toBeDefined();

      // TypeBox schemas have $schema and type properties
      const schema = registeredTool.parameters;
      expect(schema).toHaveProperty("type");
    });

    it("wave parameter is optional", () => {
      workflowPmTools(mockPi);

      // When done=true, wave is not required
      // This is tested by the execute function accepting {done: true}
      expect(() => {
        registeredTool.execute(
          "id",
          { done: true },
          vi.fn(),
          {} as any,
          new AbortController().signal,
        );
      }).not.toThrow();
    });

    it("wave is required when done=false", async () => {
      workflowPmTools(mockPi);

      // When done=false, wave should be provided
      // The execute function returns an error message if missing
      const result = await registeredTool.execute(
        "id",
        { done: false },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result).toMatchObject({
        content: [{ text: expect.stringContaining("wave is required") }],
      });
    });
  });

  describe("tool behavior", () => {
    it("does not call sendMessage", async () => {
      workflowPmTools(mockPi);

      await registeredTool.execute(
        "tool-call-123",
        { done: true },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("does not call appendEntry", async () => {
      workflowPmTools(mockPi);

      await registeredTool.execute(
        "tool-call-123",
        { done: true },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(mockPi.appendEntry).not.toHaveBeenCalled();
    });

    it("returns consistent response structure", async () => {
      workflowPmTools(mockPi);

      const doneResult = await registeredTool.execute(
        "id1",
        { done: true },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      const waveResult = await registeredTool.execute(
        "id2",
        { done: false, wave: { goal: "G", tasks: [] } },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      const errorResult = await registeredTool.execute(
        "id3",
        { done: false },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      // All should have content and details
      expect(doneResult).toHaveProperty("content");
      expect(doneResult).toHaveProperty("details");
      expect(waveResult).toHaveProperty("content");
      expect(waveResult).toHaveProperty("details");
      expect(errorResult).toHaveProperty("content");
      expect(errorResult).toHaveProperty("details");
    });
  });
});
