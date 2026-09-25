import { describe, it, expect } from "vitest";
import { buildExecutionPlan } from "./planner";
import { ExecutionEngineError, ExecutionErrorCode } from "./errors";

function node(id: string, type: string, data: Record<string, unknown> = {}) {
  return { id, type, name: id, position: { x: 0, y: 0 }, data };
}
function edge(id: string, source: string, target: string, sourceHandle?: string, targetHandle?: string) {
  return { id, source, target, sourceHandle, targetHandle };
}
function baseDoc(nodes: unknown[], edges: unknown[]) {
  return { schemaVersion: 1, nodes, edges, settings: { executionMode: "default" } };
}

describe("buildExecutionPlan", () => {
  it("builds a plan for a simple linear workflow", () => {
    const raw = baseDoc(
      [node("t", "manualTrigger"), node("s", "set")],
      [edge("e1", "t", "s")]
    );
    const plan = buildExecutionPlan("wf1", raw);
    expect(plan.manualTriggerNodeId).toBe("t");
    expect(plan.topologicalOrder).toEqual(["t", "s"]);
    expect(plan.nodes).toHaveLength(2);
    expect(plan.edges).toHaveLength(1);
  });

  it("builds a plan for a workflow with a branch (IF)", () => {
    const raw = baseDoc(
      [node("t", "manualTrigger"), node("i", "if"), node("a", "set"), node("b", "set")],
      [edge("e1", "t", "i"), edge("e2", "i", "a", "true"), edge("e3", "i", "b", "false")]
    );
    const plan = buildExecutionPlan("wf1", raw);
    expect(plan.topologicalOrder).toContain("a");
    expect(plan.topologicalOrder).toContain("b");
    expect(plan.topologicalOrder.indexOf("i")).toBeLessThan(plan.topologicalOrder.indexOf("a"));
  });

  it("rejects an invalid WorkflowDocument (schema validation)", () => {
    const raw = baseDoc([node("t", "notARealType")], []);
    expect(() => buildExecutionPlan("wf1", raw)).toThrow(ExecutionEngineError);
    try {
      buildExecutionPlan("wf1", raw);
    } catch (err) {
      expect((err as ExecutionEngineError).code).toBe(ExecutionErrorCode.WORKFLOW_INVALID);
    }
  });

  it("rejects a workflow with no manual trigger", () => {
    const raw = baseDoc([node("s", "set")], []);
    expect(() => buildExecutionPlan("wf1", raw)).toThrow(ExecutionEngineError);
    try {
      buildExecutionPlan("wf1", raw);
    } catch (err) {
      expect((err as ExecutionEngineError).code).toBe(
        ExecutionErrorCode.WORKFLOW_REQUIRES_SINGLE_MANUAL_TRIGGER
      );
    }
  });

  it("rejects a workflow with more than one manual trigger", () => {
    const raw = baseDoc(
      [node("t1", "manualTrigger"), node("t2", "manualTrigger")],
      []
    );
    expect(() => buildExecutionPlan("wf1", raw)).toThrow(
      ExecutionErrorCode.WORKFLOW_REQUIRES_SINGLE_MANUAL_TRIGGER
    );
  });

  it("rejects a cyclic workflow with WORKFLOW_CONTAINS_CYCLE", () => {
    const raw = baseDoc(
      [node("t", "manualTrigger"), node("a", "set"), node("b", "set"), node("c", "set")],
      [edge("e1", "t", "a"), edge("e2", "a", "b"), edge("e3", "b", "c"), edge("e4", "c", "a")]
    );
    try {
      buildExecutionPlan("wf1", raw);
      throw new Error("expected buildExecutionPlan to throw");
    } catch (err) {
      expect((err as ExecutionEngineError).code).toBe(ExecutionErrorCode.WORKFLOW_CONTAINS_CYCLE);
    }
  });
});
