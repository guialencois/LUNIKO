"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Bridges the "+" affordance rendered inside WorkflowNodeView (components/
 * workflow/nodes) back up to WorkflowCanvas (components/workflow/editor),
 * which owns the node picker and knows how to create nodes/edges. A plain
 * prop would have to thread through `nodeTypes`, which @xyflow/react does
 * not support — nodeTypes components only receive NodeProps. Context is the
 * sanctioned way to pass extra data to a custom node (see the xyflow docs).
 */
export interface CanvasActions {
  /** User clicked the "+" on an output handle that has no outgoing edge yet. */
  onRequestAddFromOutput: (
    nodeId: string,
    handleId: string,
    screenPosition: { x: number; y: number }
  ) => void;
}

const CanvasActionsContext = createContext<CanvasActions | null>(null);

export function CanvasActionsProvider({
  value,
  children,
}: {
  value: CanvasActions;
  children: ReactNode;
}) {
  return <CanvasActionsContext.Provider value={value}>{children}</CanvasActionsContext.Provider>;
}

/** Null outside a WorkflowCanvas (e.g. in isolated component tests) — callers
 *  must handle that rather than assuming the provider is always mounted. */
export function useCanvasActions(): CanvasActions | null {
  return useContext(CanvasActionsContext);
}
