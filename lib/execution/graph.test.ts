import { describe, it, expect } from "vitest";
import { buildGraph, assertNoCycles, topologicalOrder } from "./graph";
import type { ValidatedWorkflowDocument } from "@/lib/workflows/schema";

function doc(
  nodeIds: string[],
  edges: { source: string; target: string }[]
): ValidatedWorkflowDocument {
  return {
    schemaVersion: 1,
    nodes: nodeIds.map((id) => ({
      id,
      type: "manualTrigger",
      name: id,
      position: { x: 0, y: 0 },
      data: {},
    })),
    edges: edges.map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target })),
    settings: { executionMode: "default" },
  } as ValidatedWorkflowDocument;
}

describe("buildGraph", () => {
  it("computes entry nodes as those with zero incoming edges", () => {
    const graph = buildGraph(
      doc(["A", "B", "C"], [
        { source: "A", target: "B" },
        { source: "B", target: "C" },
      ])
    );
    expect(graph.entryNodes).toEqual(["A"]);
  });

  it("computes adjacency (outgoing/incoming) correctly", () => {
    const graph = buildGraph(
      doc(["A", "B", "C"], [
        { source: "A", target: "B" },
        { source: "A", target: "C" },
      ])
    );
    expect(graph.outgoing.get("A")!.map((e) => e.target).sort()).toEqual(["B", "C"]);
    expect(graph.incoming.get("B")!.map((e) => e.source)).toEqual(["A"]);
    expect(graph.incoming.get("C")!.map((e) => e.source)).toEqual(["A"]);
  });

  it("a node with no edges at all is its own entry node", () => {
    const graph = buildGraph(doc(["Orphan"], []));
    expect(graph.entryNodes).toEqual(["Orphan"]);
  });
});

describe("assertNoCycles", () => {
  it("does not throw for a DAG", () => {
    const graph = buildGraph(
      doc(["A", "B", "C"], [
        { source: "A", target: "B" },
        { source: "B", target: "C" },
      ])
    );
    expect(() => assertNoCycles(graph)).not.toThrow();
  });

  it("throws WORKFLOW_CONTAINS_CYCLE for A -> B -> C -> A", () => {
    const graph = buildGraph(
      doc(["A", "B", "C"], [
        { source: "A", target: "B" },
        { source: "B", target: "C" },
        { source: "C", target: "A" },
      ])
    );
    expect(() => assertNoCycles(graph)).toThrow(/cycle/i);
  });

  it("throws for a self-loop (A -> A)", () => {
    const graph = buildGraph(doc(["A"], [{ source: "A", target: "A" }]));
    expect(() => assertNoCycles(graph)).toThrow(/cycle/i);
  });

  it("does not throw for disconnected branches, even if one alone is fine", () => {
    const graph = buildGraph(
      doc(["A", "B", "C", "D"], [
        { source: "A", target: "B" },
        { source: "C", target: "D" },
      ])
    );
    expect(() => assertNoCycles(graph)).not.toThrow();
  });
});

describe("topologicalOrder", () => {
  it("orders a linear chain correctly", () => {
    const graph = buildGraph(
      doc(["A", "B", "C"], [
        { source: "A", target: "B" },
        { source: "B", target: "C" },
      ])
    );
    expect(topologicalOrder(graph)).toEqual(["A", "B", "C"]);
  });

  it("keeps every predecessor before its successors in a branching graph", () => {
    const graph = buildGraph(
      doc(["A", "B", "C", "D"], [
        { source: "A", target: "B" },
        { source: "A", target: "C" },
        { source: "B", target: "D" },
        { source: "C", target: "D" },
      ])
    );
    const order = topologicalOrder(graph);
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("B"));
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("C"));
    expect(order.indexOf("B")).toBeLessThan(order.indexOf("D"));
    expect(order.indexOf("C")).toBeLessThan(order.indexOf("D"));
  });

  it("covers every node exactly once for a DAG", () => {
    const graph = buildGraph(
      doc(["A", "B", "C"], [
        { source: "A", target: "B" },
        { source: "A", target: "C" },
      ])
    );
    const order = topologicalOrder(graph);
    expect(order.sort()).toEqual(["A", "B", "C"]);
  });
});
