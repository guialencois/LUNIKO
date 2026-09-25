"use client";

import { useCallback, useEffect, useRef } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { useWorkflowEditorStore } from "./workflow-editor-store";
import { WorkflowHeader } from "./workflow-header";
import { NodeLibrary } from "./node-library";
import { WorkflowCanvas, assertKnownNodeType } from "./workflow-canvas";
import { NodePropertiesPanel } from "./node-properties-panel";
import { ExecutionResultPanel } from "./execution-result-panel";
import { getNodeDefinition } from "@/lib/workflows/registry";
import { buildWorkflowDocument, documentToRfEdges, documentToRfNodes } from "@/lib/workflows/convert";
import type { WorkflowDocument } from "@/lib/workflows/types";

interface WorkflowEditorProps {
  workflowId: string;
  initialName: string;
  initialStatus: "draft" | "active" | "inactive";
  initialDocument: WorkflowDocument;
}

export function WorkflowEditor({
  workflowId,
  initialName,
  initialStatus,
  initialDocument,
}: WorkflowEditorProps) {
  const hydrate = useWorkflowEditorStore((s) => s.hydrate);
  const nodes = useWorkflowEditorStore((s) => s.nodes);
  const isDirty = useWorkflowEditorStore((s) => s.isDirty);
  const setNodes = useWorkflowEditorStore((s) => s.setNodes);
  const selectNode = useWorkflowEditorStore((s) => s.selectNode);
  const selectedNodeId = useWorkflowEditorStore((s) => s.selectedNodeId);
  const markSaving = useWorkflowEditorStore((s) => s.markSaving);
  const markSaved = useWorkflowEditorStore((s) => s.markSaved);
  const markSaveFailed = useWorkflowEditorStore((s) => s.markSaveFailed);

  const hydratedRef = useRef(false);

  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    hydrate({
      workflowId,
      name: initialName,
      status: initialStatus,
      nodes: documentToRfNodes(initialDocument.nodes),
      edges: documentToRfEdges(initialDocument.edges),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Protects against accidental data loss on tab close — does not block
  // in-app navigation (item 26 do prompt mestre: não travar o App Router).
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  const handleSave = useCallback(async () => {
    const { nodes: currentNodes, edges: currentEdges, name: currentName } =
      useWorkflowEditorStore.getState();
    const document = buildWorkflowDocument(currentNodes, currentEdges);

    markSaving();
    try {
      const response = await fetch(`/api/workflows/${workflowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: currentName, document }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        markSaveFailed(body?.error?.message ?? "Unable to save workflow. Please try again.");
        return;
      }

      markSaved();
    } catch {
      markSaveFailed("Unable to save workflow. Please try again.");
    }
  }, [workflowId, markSaving, markSaved, markSaveFailed]);

  const handleAddNode = useCallback(
    (nodeType: string) => {
      assertKnownNodeType(nodeType);
      const definition = getNodeDefinition(nodeType)!;
      const id = `node_${crypto.randomUUID()}`;

      setNodes((prev) => [
        ...prev,
        {
          id,
          type: "workflowNode",
          position: { x: 120 + prev.length * 40, y: 120 + prev.length * 30 },
          data: {
            nodeType,
            label: definition.displayName,
            config: definition.defaultData,
          },
        },
      ]);
    },
    [setNodes]
  );

  // Ctrl/Cmd+S (save), Ctrl/Cmd+D (duplicate selected), Escape (deselect).
  // Delete/Backspace is handled by React Flow itself (deleteKeyCode).
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isTyping =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSave();
        return;
      }

      if (isTyping) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        const state = useWorkflowEditorStore.getState();
        const node = state.nodes.find((n) => n.id === state.selectedNodeId);
        if (!node) return;
        const newId = `node_${crypto.randomUUID()}`;
        setNodes((prev) => [
          ...prev,
          {
            ...node,
            id: newId,
            position: { x: node.position.x + 32, y: node.position.y + 32 },
            selected: false,
          },
        ]);
        return;
      }

      if (e.key === "Escape") {
        selectNode(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSave, setNodes, selectNode]);

  return (
    <div className="flex h-screen flex-col">
      <WorkflowHeader workflowId={workflowId} onSave={handleSave} />
      <div className="flex flex-1 overflow-hidden">
        <NodeLibrary onAddNode={handleAddNode} />
        <div className="relative flex-1">
          {nodes.length === 0 && <WorkflowEmptyState onAddNode={handleAddNode} />}
          <ReactFlowProvider>
            <WorkflowCanvas />
          </ReactFlowProvider>
        </div>
        {selectedNodeId && <NodePropertiesPanel />}
      </div>
      <ExecutionResultPanel />
    </div>
  );
}

function WorkflowEmptyState({ onAddNode }: { onAddNode: (type: string) => void }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div className="pointer-events-auto max-w-sm rounded-lg border border-border bg-background p-6 text-center shadow-sm">
        <p className="text-sm font-medium">Comece com um trigger</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Todo workflow começa com um nó de trigger. Adicione um para começar.
        </p>
        <button
          type="button"
          onClick={() => onAddNode("manualTrigger")}
          className="mt-3 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Add Manual Trigger
        </button>
      </div>
    </div>
  );
}
