import { create } from "zustand";
import type { WorkflowRFNode } from "@/lib/workflows/convert";
import type { Edge as RFEdge } from "@xyflow/react";

interface WorkflowEditorState {
  workflowId: string;
  name: string;
  status: "draft" | "active" | "inactive";
  nodes: WorkflowRFNode[];
  edges: RFEdge[];
  selectedNodeId: string | null;
  isDirty: boolean;
  isSaving: boolean;
  lastSavedAt: number | null;
  saveError: string | null;

  setNodes: (updater: WorkflowRFNode[] | ((prev: WorkflowRFNode[]) => WorkflowRFNode[])) => void;
  setEdges: (updater: RFEdge[] | ((prev: RFEdge[]) => RFEdge[])) => void;
  selectNode: (nodeId: string | null) => void;
  updateNodeConfig: (nodeId: string, config: Record<string, unknown>) => void;
  renameNode: (nodeId: string, name: string) => void;
  renameWorkflow: (name: string) => void;
  markSaving: () => void;
  markSaved: () => void;
  markSaveFailed: (message: string) => void;
  hydrate: (input: {
    workflowId: string;
    name: string;
    status: "draft" | "active" | "inactive";
    nodes: WorkflowRFNode[];
    edges: RFEdge[];
  }) => void;
}

export const useWorkflowEditorStore = create<WorkflowEditorState>((set) => ({
  workflowId: "",
  name: "",
  status: "draft",
  nodes: [],
  edges: [],
  selectedNodeId: null,
  isDirty: false,
  isSaving: false,
  lastSavedAt: null,
  saveError: null,

  setNodes: (updater) =>
    set((state) => ({
      nodes: typeof updater === "function" ? updater(state.nodes) : updater,
      isDirty: true,
    })),

  setEdges: (updater) =>
    set((state) => ({
      edges: typeof updater === "function" ? updater(state.edges) : updater,
      isDirty: true,
    })),

  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),

  updateNodeConfig: (nodeId, config) =>
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, config } } : node
      ),
      isDirty: true,
    })),

  renameNode: (nodeId, name) =>
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, label: name } } : node
      ),
      isDirty: true,
    })),

  renameWorkflow: (name) => set({ name, isDirty: true }),

  markSaving: () => set({ isSaving: true, saveError: null }),
  markSaved: () => set({ isSaving: false, isDirty: false, lastSavedAt: Date.now() }),
  markSaveFailed: (message) => set({ isSaving: false, saveError: message }),

  hydrate: ({ workflowId, name, status, nodes, edges }) =>
    set({
      workflowId,
      name,
      status,
      nodes,
      edges,
      selectedNodeId: null,
      isDirty: false,
      isSaving: false,
      saveError: null,
    }),
}));
