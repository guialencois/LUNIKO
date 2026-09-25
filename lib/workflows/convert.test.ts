import { describe, it, expect } from "vitest";
import {
  documentToRfNodes,
  documentToRfEdges,
  buildWorkflowDocument,
} from "./convert";
import type { WorkflowNode, WorkflowEdge } from "./types";

describe("WorkflowDocument <-> React Flow conversion", () => {
  const nodes: WorkflowNode[] = [
    {
      id: "n1",
      type: "manualTrigger",
      name: "Start",
      position: { x: 0, y: 0 },
      data: {},
    },
    {
      id: "n2",
      type: "httpRequest",
      name: "Call API",
      position: { x: 220, y: 40 },
      data: { method: "POST", url: "https://example.com" },
    },
  ];

  const edges: WorkflowEdge[] = [
    { id: "e1", source: "n1", target: "n2", sourceHandle: "output", targetHandle: "input" },
  ];

  it("round-trips nodes without losing id/type/name/position/data", () => {
    const rfNodes = documentToRfNodes(nodes);
    const rfEdges = documentToRfEdges(edges);
    const rebuilt = buildWorkflowDocument(rfNodes, rfEdges);

    expect(rebuilt.nodes).toEqual(nodes);
    expect(rebuilt.edges).toEqual(edges);
  });

  it("never puts non-serializable values into the React Flow node data", () => {
    const rfNodes = documentToRfNodes(nodes);
    for (const node of rfNodes) {
      expect(() => JSON.stringify(node)).not.toThrow();
      expect(typeof node.data.nodeType).toBe("string");
      expect(typeof node.data.label).toBe("string");
    }
  });
});
