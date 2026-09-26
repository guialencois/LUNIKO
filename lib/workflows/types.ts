/**
 * The WorkflowDocument is the persisted, serializable shape of a workflow.
 * It must never contain React elements, functions, class instances, or any
 * other non-JSON-serializable value — this is exactly what a future
 * Workflow Engine (Fase 3+) will read, and it must be able to do so without
 * importing anything from React or the editor.
 */

export interface WorkflowPosition {
  x: number;
  y: number;
}

export interface WorkflowNode {
  id: string;
  /** Matches a NodeDefinition["type"] in the registry, e.g. "httpRequest". */
  type: string;
  name: string;
  position: WorkflowPosition;
  /** Node-specific config. Validated against the NodeDefinition's configSchema. */
  data: Record<string, unknown>;
  disabled?: boolean;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface WorkflowSettings {
  executionMode: "default";
}

export interface WorkflowDocument {
  schemaVersion: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  settings: WorkflowSettings;
}

export const CURRENT_SCHEMA_VERSION = 1;

export function createEmptyWorkflowDocument(): WorkflowDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    nodes: [],
    edges: [],
    settings: { executionMode: "default" },
  };
}

export type WorkflowStatus = "draft" | "active" | "inactive";

export type NodeCategory =
  | "trigger"
  | "action"
  | "logic"
  | "data"
  | "utilities"
  | "code";

export interface NodePortDefinition {
  id: string;
  label: string;
}
