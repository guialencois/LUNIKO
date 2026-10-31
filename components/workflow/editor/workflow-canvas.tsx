"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  useReactFlow,
  EdgeLabelRenderer,
  getBezierPath,
  BaseEdge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type OnConnectStartParams,
  type EdgeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Plus } from "lucide-react";
import { useWorkflowEditorStore } from "./workflow-editor-store";
import { WorkflowNodeView } from "../nodes/workflow-node-view";
import { NodePicker } from "./node-picker";
import { CanvasActionsProvider } from "./canvas-actions-context";
import { isRegisteredNodeType, getNodeDefinition } from "@/lib/workflows/registry";
import type { WorkflowRFNode } from "@/lib/workflows/convert";

const nodeTypes = { workflowNode: WorkflowNodeView };

// --- Edge "+" (insert a node between two already-connected nodes) --------
//
// edgeTypes, like nodeTypes, is a stable object defined once outside the
// component (@xyflow/react re-mounts the edge whenever the reference
// changes). It can't take extra props the normal way either, so
// ConnectableEdge reaches WorkflowCanvas's latest callback through this
// context instead of a prop — same pattern as CanvasActionsProvider for
// nodes, just scoped to edges.

const SplitEdgeContext = createContext<
  ((edgeId: string, screenPosition: { x: number; y: number }) => void) | null
>(null);

function ConnectableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
}: EdgeProps) {
  const onRequestSplitEdge = useContext(SplitEdgeContext);
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <button
          type="button"
          title="Inserir node aqui"
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "all",
          }}
          className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-primary/50 bg-background text-primary opacity-0 transition-opacity hover:border-solid hover:bg-primary hover:text-primary-foreground [.react-flow__edge:hover_&]:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onRequestSplitEdge?.(id, { x: e.clientX, y: e.clientY });
          }}
        >
          <Plus className="h-3 w-3" />
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes = { workflowEdge: ConnectableEdge };

/**
 * Origin of a pending "add node and connect" flow: dragged out of a handle
 * and dropped on empty canvas, clicked via the "+" on an idle output handle
 * (components/workflow/nodes/workflow-node-view.tsx), or clicked via the
 * "+" on the middle of an existing edge (ConnectableEdge above, which
 * splits that edge around the new node).
 */
export type PendingConnection =
  | { kind: "drag"; nodeId: string; handleId: string | null; handleType: "source" | "target" }
  | { kind: "output-button"; nodeId: string; handleId: string }
  | {
      kind: "edge-split";
      edgeId: string;
      source: string;
      sourceHandle: string | null;
      target: string;
      targetHandle: string | null;
    };

export function WorkflowCanvas() {
  const nodes = useWorkflowEditorStore((s) => s.nodes);
  const edges = useWorkflowEditorStore((s) => s.edges);
  const setNodes = useWorkflowEditorStore((s) => s.setNodes);
  const setEdges = useWorkflowEditorStore((s) => s.setEdges);
  const selectNode = useWorkflowEditorStore((s) => s.selectNode);

  const { screenToFlowPosition } = useReactFlow();

  // Tracks the handle a drag started from, and whether that drag landed on
  // a real handle (onConnect fires) rather than empty canvas, between
  // onConnectStart and onConnectEnd.
  const dragStartRef = useRef<OnConnectStartParams | null>(null);
  const dragCompletedRef = useRef(false);

  const [picker, setPicker] = useState<{
    screenPosition: { x: number; y: number };
    flowPosition: { x: number; y: number };
    pending: PendingConnection;
  } | null>(null);

  const onNodesChange = useCallback(
    // NodeChange sem parâmetro é NodeChange<Node>, e aí applyNodeChanges
    // infere NodeType = NodeBase e devolve NodeBase[], que o setNodes do store
    // (WorkflowRFNode[]) recusa. Dizer o tipo do nó aqui é o que faz a
    // inferência chegar em WorkflowRFNode — e é também o que a prop
    // onNodesChange do <ReactFlow> espera, já que nodes={nodes} é
    // WorkflowRFNode[].
    (changes: NodeChange<WorkflowRFNode>[]) => {
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

      dragCompletedRef.current = true;
      setEdges((prev) =>
        addEdge({ ...connection, type: "workflowEdge", id: `edge_${crypto.randomUUID()}` }, prev)
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

  const onConnectStart = useCallback((_: unknown, params: OnConnectStartParams) => {
    dragStartRef.current = params;
    dragCompletedRef.current = false;
  }, []);

  // "Fácil conexão": dropping a dragged connection on empty canvas (instead
  // of on another node's handle) opens the node picker right there, and
  // picking a node both creates it and wires the edge — the same outcome as
  // adding from the sidebar and then dragging an edge, in one gesture.
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      const start = dragStartRef.current;
      dragStartRef.current = null;
      if (!start || dragCompletedRef.current) return;
      if (!start.nodeId || !start.handleType) return;

      const target = event.target as HTMLElement | null;
      const droppedOnPane = !!target?.closest(".react-flow__pane");
      if (!droppedOnPane) return;

      // tsconfig has noUncheckedIndexedAccess on, so TouchList's index
      // signature returns `Touch | undefined` here — a touch end with no
      // changedTouches entry is not expected, but still has to typecheck.
      let clientX: number;
      let clientY: number;
      if ("changedTouches" in event) {
        const touch = event.changedTouches[0];
        if (!touch) return;
        clientX = touch.clientX;
        clientY = touch.clientY;
      } else {
        clientX = event.clientX;
        clientY = event.clientY;
      }
      const screenPosition = { x: clientX, y: clientY };

      setPicker({
        screenPosition,
        flowPosition: screenToFlowPosition(screenPosition),
        pending: {
          kind: "drag",
          nodeId: start.nodeId,
          handleId: start.handleId,
          handleType: start.handleType,
        },
      });
    },
    [screenToFlowPosition]
  );

  const onRequestAddFromOutput = useCallback(
    (nodeId: string, handleId: string, screenPosition: { x: number; y: number }) => {
      setPicker({
        screenPosition,
        flowPosition: screenToFlowPosition(screenPosition),
        pending: { kind: "output-button", nodeId, handleId },
      });
    },
    [screenToFlowPosition]
  );

  const onRequestSplitEdge = useCallback(
    (edgeId: string, screenPosition: { x: number; y: number }) => {
      const edge = edges.find((e) => e.id === edgeId);
      if (!edge) return;
      setPicker({
        screenPosition,
        flowPosition: screenToFlowPosition(screenPosition),
        pending: {
          kind: "edge-split",
          edgeId,
          source: edge.source,
          sourceHandle: edge.sourceHandle ?? null,
          target: edge.target,
          targetHandle: edge.targetHandle ?? null,
        },
      });
    },
    [edges, screenToFlowPosition]
  );

  const handlePickNode = useCallback(
    (nodeType: string) => {
      if (!picker) return;
      const result = buildPickResult(picker.pending, nodeType, picker.flowPosition);

      setNodes((prev) => [...prev, result.newNode]);
      setEdges((prev) => {
        const base = result.removeEdgeId
          ? prev.filter((e) => e.id !== result.removeEdgeId)
          : prev;
        return result.newEdges.reduce(
          (acc, conn) =>
            addEdge({ ...conn, type: "workflowEdge", id: `edge_${crypto.randomUUID()}` }, acc),
          base
        );
      });
      setPicker(null);
    },
    [picker, setNodes, setEdges]
  );

  return (
    <CanvasActionsProvider value={{ onRequestAddFromOutput }}>
      <SplitEdgeContext.Provider value={onRequestSplitEdge}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          onPaneClick={() => selectNode(null)}
          edgesFocusable
          defaultEdgeOptions={{ type: "workflowEdge" }}
          deleteKeyCode={["Backspace", "Delete"]}
          fitView
          minZoom={0.2}
          maxZoom={2}
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable className="!bg-background" />
        </ReactFlow>
      </SplitEdgeContext.Provider>
      {picker && (
        <NodePicker
          screenPosition={picker.screenPosition}
          onSelect={handlePickNode}
          onClose={() => setPicker(null)}
        />
      )}
    </CanvasActionsProvider>
  );
}

/** Guards against a node type slipping in that the registry doesn't know
 *  about — used when adding a node from the library. */
export function assertKnownNodeType(type: string) {
  if (!isRegisteredNodeType(type)) {
    throw new Error(`Cannot add unknown node type: ${type}`);
  }
}

type SimpleConnection = { source: string; sourceHandle?: string; target: string; targetHandle?: string };

export interface PickResult {
  newNode: WorkflowRFNode;
  newEdges: SimpleConnection[];
  /** Set only for an edge-split pick — the original edge that gets
   *  replaced by the two new ones around the inserted node. */
  removeEdgeId?: string;
}

/**
 * Pure core of "pick a node type and have it created + wired up", factored
 * out of handlePickNode so it's testable without mounting <WorkflowCanvas>
 * (this project's test setup doesn't stub ResizeObserver/@xyflow/react's
 * jsdom needs yet — see workflow-editor.add-node.test.tsx). Everything
 * React-y (state, crypto.randomUUID for ids) stays in the component;
 * this function only decides WHAT node and edges to produce for a given
 * PendingConnection.
 */
export function buildPickResult(
  pending: PendingConnection,
  nodeType: string,
  flowPosition: { x: number; y: number }
): PickResult {
  assertKnownNodeType(nodeType);
  const definition = getNodeDefinition(nodeType)!;
  const newNodeId = `node_${crypto.randomUUID()}`;
  const firstInputId = definition.inputs[0]?.id;
  const firstOutputId = definition.outputs[0]?.id;

  const newNode: WorkflowRFNode = {
    id: newNodeId,
    type: "workflowNode",
    position: flowPosition,
    data: {
      nodeType,
      label: definition.displayName,
      config: definition.defaultData,
    },
  };

  const newEdges: SimpleConnection[] = [];

  if (pending.kind === "drag") {
    if (pending.handleType === "source") {
      if (firstInputId) {
        newEdges.push({
          source: pending.nodeId,
          sourceHandle: pending.handleId ?? undefined,
          target: newNodeId,
          targetHandle: firstInputId,
        });
      }
    } else if (firstOutputId) {
      newEdges.push({
        source: newNodeId,
        sourceHandle: firstOutputId,
        target: pending.nodeId,
        targetHandle: pending.handleId ?? undefined,
      });
    }
  } else if (pending.kind === "output-button") {
    if (firstInputId) {
      newEdges.push({
        source: pending.nodeId,
        sourceHandle: pending.handleId,
        target: newNodeId,
        targetHandle: firstInputId,
      });
    }
  } else if (pending.kind === "edge-split") {
    if (firstInputId) {
      newEdges.push({
        source: pending.source,
        sourceHandle: pending.sourceHandle ?? undefined,
        target: newNodeId,
        targetHandle: firstInputId,
      });
    }
    if (firstOutputId) {
      newEdges.push({
        source: newNodeId,
        sourceHandle: firstOutputId,
        target: pending.target,
        targetHandle: pending.targetHandle ?? undefined,
      });
    }
  }

  return {
    newNode,
    newEdges,
    removeEdgeId: pending.kind === "edge-split" ? pending.edgeId : undefined,
  };
}
