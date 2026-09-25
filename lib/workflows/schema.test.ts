import { describe, it, expect } from "vitest";
import { workflowDocumentSchema, parseWorkflowDocument } from "./schema";
import { createEmptyWorkflowDocument } from "./types";

describe("workflowDocumentSchema", () => {
  it("accepts an empty workflow document", () => {
    const result = workflowDocumentSchema.safeParse(createEmptyWorkflowDocument());
    expect(result.success).toBe(true);
  });

  it("accepts a valid document with connected nodes", () => {
    const doc = {
      schemaVersion: 1,
      nodes: [
        { id: "n1", type: "manualTrigger", name: "Start", position: { x: 0, y: 0 }, data: {} },
        {
          id: "n2",
          type: "httpRequest",
          name: "Call API",
          position: { x: 200, y: 0 },
          data: { method: "GET", url: "https://example.com" },
        },
      ],
      edges: [{ id: "e1", source: "n1", target: "n2" }],
      settings: { executionMode: "default" },
    };
    const result = workflowDocumentSchema.safeParse(doc);
    expect(result.success).toBe(true);
  });

  it("rejects a duplicate node id", () => {
    const doc = {
      schemaVersion: 1,
      nodes: [
        { id: "n1", type: "manualTrigger", name: "A", position: { x: 0, y: 0 }, data: {} },
        { id: "n1", type: "manualTrigger", name: "B", position: { x: 10, y: 10 }, data: {} },
      ],
      edges: [],
      settings: { executionMode: "default" },
    };
    const result = workflowDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("Duplicate node id"))).toBe(true);
    }
  });

  it("rejects a duplicate edge id", () => {
    const doc = {
      schemaVersion: 1,
      nodes: [
        { id: "n1", type: "manualTrigger", name: "A", position: { x: 0, y: 0 }, data: {} },
        { id: "n2", type: "manualTrigger", name: "B", position: { x: 10, y: 10 }, data: {} },
        { id: "n3", type: "manualTrigger", name: "C", position: { x: 20, y: 20 }, data: {} },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e1", source: "n2", target: "n3" },
      ],
      settings: { executionMode: "default" },
    };
    const result = workflowDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("Duplicate edge id"))).toBe(true);
    }
  });

  it("rejects an unknown node type", () => {
    const doc = {
      schemaVersion: 1,
      nodes: [
        { id: "n1", type: "totallyMadeUpNodeType", name: "A", position: { x: 0, y: 0 }, data: {} },
      ],
      edges: [],
      settings: { executionMode: "default" },
    };
    const result = workflowDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("Unknown node type"))).toBe(true);
    }
  });

  it("rejects invalid config for a known node type", () => {
    const doc = {
      schemaVersion: 1,
      nodes: [
        {
          id: "n1",
          type: "httpRequest",
          name: "Call API",
          position: { x: 0, y: 0 },
          // "method" must be one of the enum values
          data: { method: "NOT_A_REAL_METHOD" },
        },
      ],
      edges: [],
      settings: { executionMode: "default" },
    };
    const result = workflowDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("Invalid config"))).toBe(true);
    }
  });

  it("rejects an edge whose source node does not exist", () => {
    const doc = {
      schemaVersion: 1,
      nodes: [{ id: "n1", type: "manualTrigger", name: "A", position: { x: 0, y: 0 }, data: {} }],
      edges: [{ id: "e1", source: "does-not-exist", target: "n1" }],
      settings: { executionMode: "default" },
    };
    const result = workflowDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message.includes("unknown source node"))
      ).toBe(true);
    }
  });

  it("rejects an edge whose target node does not exist", () => {
    const doc = {
      schemaVersion: 1,
      nodes: [{ id: "n1", type: "manualTrigger", name: "A", position: { x: 0, y: 0 }, data: {} }],
      edges: [{ id: "e1", source: "n1", target: "does-not-exist" }],
      settings: { executionMode: "default" },
    };
    const result = workflowDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message.includes("unknown target node"))
      ).toBe(true);
    }
  });

  it("rejects a missing schemaVersion", () => {
    const doc = { nodes: [], edges: [], settings: { executionMode: "default" } };
    const result = workflowDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it("parseWorkflowDocument is a safe (non-throwing) wrapper", () => {
    const result = parseWorkflowDocument({ garbage: true });
    expect(result.success).toBe(false);
  });

  it("accepts a valid sourceHandle/targetHandle pair that exist on the nodes", () => {
    const doc = {
      schemaVersion: 1,
      nodes: [
        { id: "n1", type: "if", name: "Check", position: { x: 0, y: 0 }, data: {} },
        { id: "n2", type: "httpRequest", name: "Call", position: { x: 200, y: 0 }, data: {} },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2", sourceHandle: "true", targetHandle: "input" },
      ],
      settings: { executionMode: "default" },
    };
    const result = workflowDocumentSchema.safeParse(doc);
    expect(result.success).toBe(true);
  });

  it("rejects a sourceHandle that the source node's type doesn't have", () => {
    const doc = {
      schemaVersion: 1,
      nodes: [
        { id: "n1", type: "if", name: "Check", position: { x: 0, y: 0 }, data: {} },
        { id: "n2", type: "httpRequest", name: "Call", position: { x: 200, y: 0 }, data: {} },
      ],
      // "if" only has "true"/"false" outputs, not "output"
      edges: [{ id: "e1", source: "n1", target: "n2", sourceHandle: "output" }],
      settings: { executionMode: "default" },
    };
    const result = workflowDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("no output handle"))).toBe(true);
    }
  });

  it("rejects a targetHandle that the target node's type doesn't have", () => {
    const doc = {
      schemaVersion: 1,
      nodes: [
        { id: "n1", type: "manualTrigger", name: "Start", position: { x: 0, y: 0 }, data: {} },
        { id: "n2", type: "merge", name: "Merge", position: { x: 200, y: 0 }, data: {} },
      ],
      // "merge" only has "input1"/"input2" inputs, not "input"
      edges: [{ id: "e1", source: "n1", target: "n2", targetHandle: "input" }],
      settings: { executionMode: "default" },
    };
    const result = workflowDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("no input handle"))).toBe(true);
    }
  });

  it("does not require a handle to be specified at all", () => {
    const doc = {
      schemaVersion: 1,
      nodes: [
        { id: "n1", type: "manualTrigger", name: "Start", position: { x: 0, y: 0 }, data: {} },
        { id: "n2", type: "httpRequest", name: "Call", position: { x: 200, y: 0 }, data: {} },
      ],
      edges: [{ id: "e1", source: "n1", target: "n2" }],
      settings: { executionMode: "default" },
    };
    const result = workflowDocumentSchema.safeParse(doc);
    expect(result.success).toBe(true);
  });

  it("survives a JSON.stringify/parse round-trip without losing data", () => {
    const doc = {
      schemaVersion: 1,
      nodes: [
        {
          id: "n1",
          type: "if",
          name: "Check",
          position: { x: 5, y: 5 },
          data: { conditions: [{ field: "status", operator: "equals", value: "ok" }] },
        },
      ],
      edges: [],
      settings: { executionMode: "default" },
    };
    const roundTripped = JSON.parse(JSON.stringify(doc));
    expect(roundTripped).toEqual(doc);
    expect(workflowDocumentSchema.safeParse(roundTripped).success).toBe(true);
  });
});
