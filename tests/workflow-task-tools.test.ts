import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import workflowTaskTools from "../.pi/extensions/workflow-task-tools/index.js";

describe("workflow-task-tools extension", () => {
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
    it("registers report_task_result tool", () => {
      workflowTaskTools(mockPi);

      expect(mockPi.registerTool).toHaveBeenCalled();
      expect(registeredTool).toBeDefined();
    });

    it("report_task_result tool has correct metadata", () => {
      workflowTaskTools(mockPi);

      expect(registeredTool.name).toBe("report_task_result");
      expect(registeredTool.label).toBe("Report Task Result");
      expect(registeredTool.description).toContain("developer/verifier");
    });

    it("report_task_result tool has parameters schema", () => {
      workflowTaskTools(mockPi);

      expect(registeredTool.parameters).toBeDefined();
      expect(typeof registeredTool.parameters).toBe("object");
    });
  });

  describe("report_task_result tool execute - developer status", () => {
    it("returns success for status=done with summary", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "tool-call-123",
        { status: "done", summary: "Implemented feature" },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain("Task completed");
      expect(result.content[0].text).toContain("Implemented feature");
    });

    it("handles done with filesChanged", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "tool-call-123",
        {
          status: "done",
          summary: "Created config module",
          filesChanged: ["src/config.ts", "src/config.test.ts"],
        },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain("src/config.ts");
      expect(result.content[0].text).toContain("src/config.test.ts");
    });

    it("handles done with empty filesChanged", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "tool-call-123",
        {
          status: "done",
          summary: "Refactored code",
          filesChanged: [],
        },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain("Files: none");
    });

    it("handles done without filesChanged", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "tool-call-123",
        {
          status: "done",
          summary: "Updated documentation",
        },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain("Files: none");
    });

    it("handles done with notes", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "tool-call-123",
        {
          status: "done",
          summary: "Added tests",
          notes: "Used vitest framework",
        },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      // Notes are included in details but not in the summary message
      expect(result.content[0].text).toContain("Task completed");
      expect(result.details.params.notes).toBe("Used vitest framework");
    });

    it("handles done with all fields", async () => {
      workflowTaskTools(mockPi);

      const params = {
        status: "done" as const,
        summary: "Complete implementation",
        filesChanged: ["src/index.ts", "src/utils.ts"],
        notes: "Ready for review",
      };

      const result = await registeredTool.execute(
        "tool-call-123",
        params,
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain("Complete implementation");
      expect(result.content[0].text).toContain("src/index.ts");
      expect(result.details.params).toEqual(params);
    });
  });

  describe("report_task_result tool execute - verifier status=pass", () => {
    it("returns success for status=pass", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "tool-call-123",
        { status: "pass", issues: [] },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toBe("Verification passed. No issues found.");
    });

    it("handles pass with empty issues", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "tool-call-123",
        { status: "pass", issues: [] },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain("No issues found");
    });

    it("ignores issues array when status is pass", async () => {
      workflowTaskTools(mockPi);

      // If someone mistakenly provides issues with pass status
      const result = await registeredTool.execute(
        "tool-call-123",
        { status: "pass", issues: ["should be ignored"] },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      // The message still says passed
      expect(result.content[0].text).toBe("Verification passed. No issues found.");
    });
  });

  describe("report_task_result tool execute - verifier status=fail", () => {
    it("returns failure message with issues", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "tool-call-123",
        {
          status: "fail",
          issues: ["File not found", "Tests failing"],
        },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain("Verification failed");
      expect(result.content[0].text).toContain("- File not found");
      expect(result.content[0].text).toContain("- Tests failing");
    });

    it("handles single issue", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "tool-call-123",
        {
          status: "fail",
          issues: ["Missing export statement"],
        },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain("- Missing export statement");
    });

    it("handles empty issues array", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "tool-call-123",
        {
          status: "fail",
          issues: [],
        },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain("Verification failed");
      expect(result.content[0].text).not.toContain("- ");
    });

    it("handles multiple issues with formatting", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "tool-call-123",
        {
          status: "fail",
          issues: ["Issue 1", "Issue 2", "Issue 3"],
        },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      const text = result.content[0].text;
      expect(text).toContain("- Issue 1");
      expect(text).toContain("- Issue 2");
      expect(text).toContain("- Issue 3");
    });
  });

  describe("report_task_result tool execute - edge cases", () => {
    it("handles undefined optional fields", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "tool-call-123",
        { status: "done" },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain("Summary: N/A");
      expect(result.content[0].text).toContain("Files: none");
    });

    it("handles null-like values", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "tool-call-123",
        { status: "done", summary: "", filesChanged: null as any },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      // Empty string summary
      expect(result.content[0].text).toContain("Summary: ");
    });

    it("handles special characters in summary", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "tool-call-123",
        {
          status: "done",
          summary: 'Created file with\nnewlines and "quotes"',
        },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain("newlines");
      expect(result.content[0].text).toContain("quotes");
    });

    it("handles special characters in issues", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "tool-call-123",
        {
          status: "fail",
          issues: ['Error: "Module not found"', "Line 42: Unexpected token"],
        },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain('"Module not found"');
      expect(result.content[0].text).toContain("Unexpected token");
    });

    it("handles long file paths", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "tool-call-123",
        {
          status: "done",
          summary: "Refactored",
          filesChanged: [
            "src/very/long/path/to/some/deeply/nested/module/file.ts",
            "tests/very/long/path/to/some/deeply/nested/module/file.test.ts",
          ],
        },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain("src/very/long");
    });
  });

  describe("tool behavior", () => {
    it("does not call sendMessage", async () => {
      workflowTaskTools(mockPi);

      await registeredTool.execute(
        "tool-call-123",
        { status: "done", summary: "Test" },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("does not call appendEntry", async () => {
      workflowTaskTools(mockPi);

      await registeredTool.execute(
        "tool-call-123",
        { status: "done", summary: "Test" },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(mockPi.appendEntry).not.toHaveBeenCalled();
    });

    it("returns consistent response structure", async () => {
      workflowTaskTools(mockPi);

      const doneResult = await registeredTool.execute(
        "id1",
        { status: "done", summary: "Test" },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      const passResult = await registeredTool.execute(
        "id2",
        { status: "pass", issues: [] },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      const failResult = await registeredTool.execute(
        "id3",
        { status: "fail", issues: ["Bug"] },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      // All should have content and details
      expect(doneResult).toHaveProperty("content");
      expect(doneResult).toHaveProperty("details");
      expect(passResult).toHaveProperty("content");
      expect(passResult).toHaveProperty("details");
      expect(failResult).toHaveProperty("content");
      expect(failResult).toHaveProperty("details");
    });

    it("includes params in details", async () => {
      workflowTaskTools(mockPi);

      const params = { status: "done", summary: "Test", filesChanged: ["a.ts"] };

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

  describe("tool parameter schema", () => {
    it("status accepts done, pass, or fail", () => {
      workflowTaskTools(mockPi);

      // Schema uses Type.Union with literals
      expect(registeredTool.parameters).toBeDefined();

      // The schema structure is TypeBox
      const schema = registeredTool.parameters;
      expect(schema).toHaveProperty("type");
    });

    it("summary is optional", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "id",
        { status: "done" },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      // Should not throw, summary is optional
      expect(result.content[0].text).toContain("N/A");
    });

    it("filesChanged is optional", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "id",
        { status: "done", summary: "Test" },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      // Should not throw
      expect(result).toBeDefined();
    });

    it("notes is optional", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "id",
        { status: "done", summary: "Test" },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      // Should not throw
      expect(result.details.params.notes).toBeUndefined();
    });

    it("issues is optional", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "id",
        { status: "pass" },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      // Should not throw
      expect(result).toBeDefined();
    });
  });

  describe("usage scenarios", () => {
    it("developer completes task", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "dev-123",
        {
          status: "done",
          summary: "Implemented user authentication",
          filesChanged: ["src/auth.ts", "src/middleware.ts"],
          notes: "Uses JWT for tokens",
        },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain("Implemented user authentication");
      expect(result.content[0].text).toContain("src/auth.ts");
    });

    it("verifier passes task", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "verifier-123",
        {
          status: "pass",
          issues: [],
        },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toBe("Verification passed. No issues found.");
    });

    it("verifier fails task with multiple issues", async () => {
      workflowTaskTools(mockPi);

      const result = await registeredTool.execute(
        "verifier-123",
        {
          status: "fail",
          issues: [
            "Missing error handling in auth.ts",
            "No tests for edge cases",
            "TypeScript errors in middleware.ts",
          ],
        },
        vi.fn(),
        {} as any,
        new AbortController().signal,
      );

      expect(result.content[0].text).toContain("Verification failed");
      expect(result.content[0].text).toContain("Missing error handling");
      expect(result.content[0].text).toContain("No tests for edge cases");
    });
  });
});
