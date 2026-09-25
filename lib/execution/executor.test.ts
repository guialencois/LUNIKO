import { describe, it, expect, vi } from "vitest";
import "./executors"; // populate the executor registry
import { runExecutionPlan } from "./executor";
import { buildExecutionPlan } from "./planner";
import { noopLogger } from "./test-utils";

function node(id: string, type: string, data: Record<string, unknown> = {}) {
  return { id, type, name: id, position: { x: 0, y: 0 }, data };
}
function edge(id: string, source: string, target: string, sourceHandle?: string, targetHandle?: string) {
  return { id, source, target, sourceHandle, targetHandle };
}
function baseDoc(nodes: unknown[], edges: unknown[]) {
  return { schemaVersion: 1, nodes, edges, settings: { executionMode: "default" } };
}

const baseOptions = {
  executionId: "exec-1",
  workflowId: "wf-1",
  workspaceId: "ws-1",
  logger: noopLogger,
};

describe("runExecutionPlan — linear workflows", () => {
  it("Manual -> Set -> Transform produces the expected output unchanged", async () => {
    const raw = baseDoc(
      [node("t", "manualTrigger"), node("s", "set", { values: {} }), node("tr", "transform")],
      [edge("e1", "t", "s"), edge("e2", "s", "tr")]
    );
    const plan = buildExecutionPlan("wf-1", raw);
    const outcome = await runExecutionPlan(plan, {
      ...baseOptions,
      initialInput: { items: [{ json: { name: "Jackson" } }] },
    });

    expect(outcome.status).toBe("success");
    expect(outcome.finalOutput?.items).toEqual([{ json: { name: "Jackson" } }]);
    expect(outcome.nodeResults.size).toBe(3);
  });
});

describe("runExecutionPlan — branching (IF)", () => {
  it("only executes the true branch when the condition matches, and never touches the false branch", async () => {
    const raw = baseDoc(
      [
        node("t", "manualTrigger"),
        node("i", "if", { conditions: [{ field: "go", operator: "equals", value: true }] }),
        node("a", "set", { values: { path: "A" } }),
        node("b", "set", { values: { path: "B" } }),
      ],
      [
        edge("e1", "t", "i"),
        edge("e2", "i", "a", "true"),
        edge("e3", "i", "b", "false"),
      ]
    );
    const plan = buildExecutionPlan("wf-1", raw);
    const outcome = await runExecutionPlan(plan, {
      ...baseOptions,
      initialInput: { items: [{ json: { go: true } }] },
    });

    expect(outcome.status).toBe("success");
    expect(outcome.nodeResults.has("a")).toBe(true);
    expect(outcome.nodeResults.has("b")).toBe(false); // never executed
    expect(outcome.finalOutput?.items).toEqual([{ json: { go: true, path: "A" } }]);
  });

  it("executes the false branch instead when the condition doesn't match", async () => {
    const raw = baseDoc(
      [
        node("t", "manualTrigger"),
        node("i", "if", { conditions: [{ field: "go", operator: "equals", value: true }] }),
        node("a", "set", { values: { path: "A" } }),
        node("b", "set", { values: { path: "B" } }),
      ],
      [edge("e1", "t", "i"), edge("e2", "i", "a", "true"), edge("e3", "i", "b", "false")]
    );
    const plan = buildExecutionPlan("wf-1", raw);
    const outcome = await runExecutionPlan(plan, {
      ...baseOptions,
      initialInput: { items: [{ json: { go: false } }] },
    });

    expect(outcome.nodeResults.has("b")).toBe(true);
    expect(outcome.nodeResults.has("a")).toBe(false);
  });
});

describe("runExecutionPlan — branching (Switch)", () => {
  it("only executes the matched case", async () => {
    const raw = baseDoc(
      [
        node("t", "manualTrigger"),
        node("sw", "switch", {
          rules: [{ outputKey: "case1", field: "status", operator: "equals", value: "done" }],
        }),
        node("c1", "set", { values: { handled: "case1" } }),
        node("c2", "set", { values: { handled: "case2" } }),
      ],
      [edge("e1", "t", "sw"), edge("e2", "sw", "c1", "case1"), edge("e3", "sw", "c2", "case2")]
    );
    const plan = buildExecutionPlan("wf-1", raw);
    const outcome = await runExecutionPlan(plan, {
      ...baseOptions,
      initialInput: { items: [{ json: { status: "done" } }] },
    });

    expect(outcome.nodeResults.has("c1")).toBe(true);
    expect(outcome.nodeResults.has("c2")).toBe(false);
  });
});

describe("runExecutionPlan — merge with a skipped branch", () => {
  it("merge runs with only the taken branch's items when the other was skipped", async () => {
    const raw = baseDoc(
      [
        node("t", "manualTrigger"),
        node("i", "if", { conditions: [{ field: "go", operator: "equals", value: true }] }),
        node("a", "set", { values: { path: "A" } }),
        node("b", "set", { values: { path: "B" } }),
        node("m", "merge", { mode: "append" }),
      ],
      [
        edge("e1", "t", "i"),
        edge("e2", "i", "a", "true"),
        edge("e3", "i", "b", "false"),
        edge("e4", "a", "m", undefined, "input1"),
        edge("e5", "b", "m", undefined, "input2"),
      ]
    );
    const plan = buildExecutionPlan("wf-1", raw);
    const outcome = await runExecutionPlan(plan, {
      ...baseOptions,
      initialInput: { items: [{ json: { go: true } }] },
    });

    expect(outcome.status).toBe("success");
    expect(outcome.nodeResults.has("m")).toBe(true);
    expect(outcome.nodeResults.get("m")?.output?.items).toEqual([{ json: { go: true, path: "A" } }]);
    expect(outcome.nodeResults.has("b")).toBe(false);
  });
});

describe("runExecutionPlan — errors", () => {
  it("fails the whole execution when a node returns NOT_IMPLEMENTED, and never runs downstream nodes", async () => {
    const raw = baseDoc(
      [node("t", "manualTrigger"), node("h", "httpRequest"), node("after", "set")],
      [edge("e1", "t", "h"), edge("e2", "h", "after")]
    );
    const plan = buildExecutionPlan("wf-1", raw);
    const outcome = await runExecutionPlan(plan, { ...baseOptions, initialInput: { items: [{ json: {} }] } });

    expect(outcome.status).toBe("error");
    expect(outcome.error?.code).toBe("NOT_IMPLEMENTED");
    expect(outcome.nodeResults.has("after")).toBe(false); // fail-fast
  });

  it("reports LIMIT_EXCEEDED when a node's output exceeds MAX_ITEMS_PER_NODE", async () => {
    const raw = baseDoc(
      [node("t", "manualTrigger"), node("s", "set", { values: {} })],
      [edge("e1", "t", "s")]
    );
    const plan = buildExecutionPlan("wf-1", raw);
    const tooManyItems = Array.from({ length: 1001 }, () => ({ json: {} }));
    const outcome = await runExecutionPlan(plan, {
      ...baseOptions,
      initialInput: { items: tooManyItems },
    });

    expect(outcome.status).toBe("error");
    expect(outcome.error?.code).toBe("LIMIT_EXCEEDED");
  });
});

describe("runExecutionPlan — cancellation", () => {
  it("returns status cancelled when the signal is already aborted", async () => {
    const raw = baseDoc(
      [node("t", "manualTrigger"), node("s", "set")],
      [edge("e1", "t", "s")]
    );
    const plan = buildExecutionPlan("wf-1", raw);
    const controller = new AbortController();
    controller.abort();

    const outcome = await runExecutionPlan(plan, {
      ...baseOptions,
      initialInput: { items: [{ json: {} }] },
      signal: controller.signal,
    });

    expect(outcome.status).toBe("cancelled");
    expect(outcome.nodeResults.size).toBe(0);
  });
});

describe("runExecutionPlan — timeout", () => {
  it("returns status error with EXECUTION_TIMEOUT when the time limit is exceeded", async () => {
    const raw = baseDoc(
      [node("t", "manualTrigger"), node("s", "set")],
      [edge("e1", "t", "s")]
    );
    const plan = buildExecutionPlan("wf-1", raw);

    const realNow = Date.now();
    const spy = vi.spyOn(Date, "now");
    spy.mockReturnValueOnce(realNow); // startedAt
    spy.mockReturnValue(realNow + 40_000); // every check after that looks 40s later

    const outcome = await runExecutionPlan(plan, {
      ...baseOptions,
      initialInput: { items: [{ json: {} }] },
    });

    spy.mockRestore();
    expect(outcome.status).toBe("error");
    expect(outcome.error?.code).toBe("EXECUTION_TIMEOUT");
  });
});
