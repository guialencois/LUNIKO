import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { WorkflowDocument, WorkflowNode, WorkflowEdge } from "./types";
import { CURRENT_SCHEMA_VERSION } from "./types";

/**
 * React Flow's Node/Edge types carry UI-only fields (selected, dragging,
 * measured size, ...) that must never be persisted. This module is the only
 * place that crosses between the two shapes, so that boundary can't leak
 * elsewhere in the editor (item 8 do prompt mestre).
 */

export interface WorkflowNodeRFData {
  /** The registry node type, e.g. "httpRequest". Distinct from RFNode.type,
   *  which is always "workflowNode" so a single component renders all of
   *  them (see components/workflow/nodes/workflow-node-view.tsx). */
  nodeType: string;
  label: string;
  config: Record<string, unknown>;
  disabled?: boolean;
}

export type WorkflowRFNode = RFNode<WorkflowNodeRFData, "workflowNode">;

export function documentToRfNodes(nodes: WorkflowNode[]): WorkflowRFNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: "workflowNode",
    position: node.position,
    data: {
      nodeType: node.type,
      label: node.name,
      config: node.data,
      disabled: node.disabled,
    },
  }));
}

export function documentToRfEdges(edges: WorkflowEdge[]): RFEdge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? undefined,
    targetHandle: edge.targetHandle ?? undefined,
  }));
}

export function rfNodesToWorkflowNodes(nodes: WorkflowRFNode[]): WorkflowNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.data.nodeType,
    name: node.data.label,
    position: node.position,
    data: node.data.config,
    disabled: node.data.disabled,
  }));
}

export function rfEdgesToWorkflowEdges(edges: RFEdge[]): WorkflowEdge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
  }));
}

export function buildWorkflowDocument(
  nodes: WorkflowRFNode[],
  edges: RFEdge[]
): WorkflowDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    nodes: rfNodesToWorkflowNodes(nodes),
    edges: rfEdgesToWorkflowEdges(edges),
    settings: { executionMode: "default" },
  };
}
