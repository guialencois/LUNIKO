"use client";

import { useCallback } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useWorkflowEditorStore } from "./workflow-editor-store";
import { WorkflowNodeView } from "../nodes/workflow-node-view";
import { isRegisteredNodeType } from "@/lib/workflows/registry";

const nodeTypes = { workflowNode: WorkflowNodeView };

export function WorkflowCanvas() {
  const nodes = useWorkflowEditorStore((s) => s.nodes);
  const edges = useWorkflowEditorStore((s) => s.edges);
  const setNodes = useWorkflowEditorStore((s) => s.setNodes);
  const setEdges = useWorkflowEditorStore((s) => s.setEdges);
  const selectNode = useWorkflowEditorStore((s) => s.selectNode);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const removedIds = changes
        .filter((c) => c.type === "remove")
        .map((c) => (c as { id: string }).id);

      setNodes((prev) => applyNodeChanges(changes, prev));

      // Edges are not implicitly cleaned up by applyNodeChanges — do it
      // explicitly so a deleted node never leaves a dangling edge behind
      // (item 29 do prompt mestre).
      if (removedIds.length > 0) {
        setEdges((prevEdges) =>
          prevEdges.filter(
            (edge) => !removedIds.includes(edge.source) && !removedIds.includes(edge.target)
          )
        );
      }

      const selectionChange = changes.find((c) => c.type === "select" && c.selected);
      if (selectionChange && selectionChange.type === "select") {
        selectNode(selectionChange.id);
      }
      if (changes.some((c) => c.type === "remove")) {
        selectNode(null);
      }
    },
    [setNodes, setEdges, selectNode]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((prev) => applyEdgeChanges(changes, prev)),
    [setEdges]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      // Basic structural validation (item 14 do prompt mestre). Deeper
      // semantic validation (cycles, type compatibility) belongs to the
      // future Workflow Engine, not the editor.
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;

      setEdges((prev) =>
        addEdge(
          { ...connection, id: `edge_${crypto.randomUUID()}` },
          prev
        )
      );
    },
    [setEdges]
  );

  const isValidConnection = useCallback(
    (connection: Connection | { source: string | null; target: string | null }) => {
      if (!connection.source || !connection.target) return false;
      if (connection.source === connection.target) return false;
      const sourceExists = nodes.some((n) => n.id === connection.source);
      const targetExists = nodes.some((n) => n.id === connection.target);
      return sourceExists && targetExists;
    },
    [nodes]
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onPaneClick={() => selectNode(null)}
      deleteKeyCode={["Backspace", "Delete"]}
      fitView
      minZoom={0.2}
      maxZoom={2}
    >
      <Background />
      <Controls />
      <MiniMap pannable zoomable className="!bg-background" />
    </ReactFlow>
  );
}

/** Guards against a node type slipping in that the registry doesn't know
 *  about — used when adding a node from the library. */
export function assertKnownNodeType(type: string) {
  if (!isRegisteredNodeType(type)) {
    throw new Error(`Cannot add unknown node type: ${type}`);
  }
}
