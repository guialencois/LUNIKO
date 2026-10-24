import { workflowDocumentSchema, type ValidatedWorkflowDocument } from "@/lib/workflows/schema";
import { buildGraph, assertNoCycles, topologicalOrder } from "./graph";
import { ExecutionEngineError, ExecutionErrorCode } from "./errors";
import {
  EXECUTION_LIMITS,
  type ExecutionPlan,
  type PlannedNode,
  type PlannedEdge,
  type PlanTrigger,
} from "./types";

/**
 * WorkflowDocument -> ExecutionPlan (item 10/11). This is the only place
 * that turns "what the editor saved" into "something the engine can walk".
 * Re-validates with workflowDocumentSchema even though the document came
 * from the database — never trust a stored value to still be valid after a
 * schema change (same defensive stance as the editor page, see
 * app/dashboard/workflows/[workflowId]/page.tsx).
 */
export function buildExecutionPlan(
  workflowId: string,
  rawDocument: unknown,
  trigger: PlanTrigger = { type: "manual" }
): ExecutionPlan {
  const parsed = workflowDocumentSchema.safeParse(rawDocument);
  if (!parsed.success) {
    throw new ExecutionEngineError(
      ExecutionErrorCode.WORKFLOW_INVALID,
      `Workflow document failed validation: ${parsed.error.issues[0]?.message ?? "unknown error"}`
    );
  }
  const document: ValidatedWorkflowDocument = parsed.data;

  if (document.nodes.length > EXECUTION_LIMITS.MAX_NODES_PER_EXECUTION) {
    throw new ExecutionEngineError(
      ExecutionErrorCode.LIMIT_EXCEEDED,
      `Workflow has ${document.nodes.length} nodes, exceeding the limit of ${EXECUTION_LIMITS.MAX_NODES_PER_EXECUTION}`
    );
  }

  const graph = buildGraph(document);
  assertNoCycles(graph); // throws WORKFLOW_CONTAINS_CYCLE

  const order = topologicalOrder(graph);
  if (order.length !== document.nodes.length) {
    // Should be unreachable once assertNoCycles passed, but never silently
    // proceed with a partial plan if it somehow happens.
    throw new ExecutionEngineError(
      ExecutionErrorCode.WORKFLOW_INVALID,
      "Topological order does not cover all nodes — the graph is malformed"
    );
  }

  const triggerNodeId = resolveTriggerNodeId(document, trigger);

  const nodes: PlannedNode[] = document.nodes.map((n) => ({
    nodeId: n.id,
    nodeType: n.type,
    config: n.data,
  }));

  const edges: PlannedEdge[] = document.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? null,
    targetHandle: e.targetHandle ?? null,
  }));

  return {
    workflowId,
    nodes,
    edges,
    entryNodes: graph.entryNodes,
    topologicalOrder: order,
    triggerNodeId,
  };
}

/**
 * Manual: exactly one manualTrigger, exactly as before Fase 5A.
 * Webhook (Fase 5A): the specific node the endpoint points at, which must
 * still exist in THIS document and still be a webhookTrigger. Any other
 * trigger in the document (a manualTrigger kept for testing, a second
 * webhook) is fine — it has no incoming edge, so the engine never reaches it.
 */
function resolveTriggerNodeId(document: ValidatedWorkflowDocument, trigger: PlanTrigger): string {
  if (trigger.type === "webhook") {
    const node = document.nodes.find((n) => n.id === trigger.nodeId);
    if (!node || node.type !== "webhookTrigger") {
      throw new ExecutionEngineError(
        ExecutionErrorCode.WORKFLOW_TRIGGER_NOT_FOUND,
        `Workflow has no Webhook Trigger node "${trigger.nodeId}"`
      );
    }
    return node.id;
  }

  const manualTriggers = document.nodes.filter((n) => n.type === "manualTrigger");
  // `length !== 1` não estreita `manualTriggers[0]` (noUncheckedIndexedAccess).
  // Ligar o elemento e testá-lo no mesmo `if` diz a mesma coisa de um jeito
  // que o compilador acompanha; o segundo termo é redundante por construção.
  const manualTrigger = manualTriggers[0];
  if (manualTriggers.length !== 1 || !manualTrigger) {
    throw new ExecutionEngineError(
      ExecutionErrorCode.WORKFLOW_REQUIRES_SINGLE_MANUAL_TRIGGER,
      manualTriggers.length === 0
        ? "Workflow has no Manual Trigger node — manual execution needs exactly one"
        : `Workflow has ${manualTriggers.length} Manual Trigger nodes — manual execution needs exactly one`
    );
  }
  return manualTrigger.id;
}
