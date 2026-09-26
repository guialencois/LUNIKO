import type { ValidatedWorkflowDocument } from "@/lib/workflows/schema";
import { ExecutionEngineError, ExecutionErrorCode } from "./errors";

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
}

export interface Graph {
  nodeIds: string[];
  outgoing: Map<string, GraphEdge[]>;
  incoming: Map<string, GraphEdge[]>;
  /** Nodes with zero incoming edges. */
  entryNodes: string[];
}

/**
 * Builds the adjacency structure from an already-validated WorkflowDocument.
 * Assumes the document passed workflowDocumentSchema (no dangling edges, no
 * duplicate ids) — this is not a second validation pass.
 */
export function buildGraph(document: ValidatedWorkflowDocument): Graph {
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  const nodeIds = document.nodes.map((n) => n.id);

  for (const nodeId of nodeIds) {
    outgoing.set(nodeId, []);
    incoming.set(nodeId, []);
  }

  for (const edge of document.edges) {
    const graphEdge: GraphEdge = {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
    };
    outgoing.get(edge.source)!.push(graphEdge);
    incoming.get(edge.target)!.push(graphEdge);
  }

  const entryNodes = nodeIds.filter((id) => incoming.get(id)!.length === 0);

  return { nodeIds, outgoing, incoming, entryNodes };
}

/**
 * Throws WORKFLOW_CONTAINS_CYCLE if the graph has one. Standard DFS with a
 * "currently on stack" set to detect back-edges — no cycle resolution, per
 * item 31 (não tentar "resolver" ciclos automaticamente).
 */
export function assertNoCycles(graph: Graph): void {
  const visited = new Set<string>();
  const onStack = new Set<string>();

  function visit(nodeId: string) {
    if (onStack.has(nodeId)) {
      throw new ExecutionEngineError(
        ExecutionErrorCode.WORKFLOW_CONTAINS_CYCLE,
        `Workflow graph contains a cycle involving node "${nodeId}"`,
        { nodeId }
      );
    }
    if (visited.has(nodeId)) return;

    onStack.add(nodeId);
    for (const edge of graph.outgoing.get(nodeId) ?? []) {
      visit(edge.target);
    }
    onStack.delete(nodeId);
    visited.add(nodeId);
  }

  for (const nodeId of graph.nodeIds) {
    if (!visited.has(nodeId)) visit(nodeId);
  }
}

/**
 * Kahn's algorithm. Requires assertNoCycles() to have already passed —
 * this does not itself detect cycles (a cyclic graph would just leave nodes
 * out of the returned order, which the planner treats as a bug upstream,
 * not a valid state to reach silently).
 */
export function topologicalOrder(graph: Graph): string[] {
  const indegree = new Map<string, number>();
  for (const nodeId of graph.nodeIds) {
    indegree.set(nodeId, graph.incoming.get(nodeId)!.length);
  }

  const queue: string[] = graph.nodeIds.filter((id) => indegree.get(id) === 0);
  // Deterministic: process in the order nodes appear in the document
  // whenever multiple are ready at once (item 32 — determinismo).
  const order: string[] = [];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    order.push(nodeId);
    for (const edge of graph.outgoing.get(nodeId) ?? []) {
      const remaining = indegree.get(edge.target)! - 1;
      indegree.set(edge.target, remaining);
      if (remaining === 0) queue.push(edge.target);
    }
  }

  return order;
}
