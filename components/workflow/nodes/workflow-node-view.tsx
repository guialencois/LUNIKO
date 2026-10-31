"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { AlertCircle, Plus } from "lucide-react";
import { getNodeDefinition } from "@/lib/workflows/registry";
import { getNodeIcon } from "./node-icon-map";
import { cn } from "@/lib/utils";
import type { WorkflowRFNode } from "@/lib/workflows/convert";
import { useExecutionStore } from "../editor/execution-store";
import { useCanvasActions } from "../editor/canvas-actions-context";

/**
 * Deliberately a single component for every node type (item 56 do prompt
 * mestre: NodeDefinition describes data, this component describes
 * appearance). Adding a new node type never requires touching this file.
 */
function WorkflowNodeViewImpl({ id, data, selected }: NodeProps<WorkflowRFNode>) {
  const definition = getNodeDefinition(data.nodeType);
  const Icon = getNodeIcon(definition?.icon ?? "Globe");
  const outputs = definition?.outputs ?? [];
  const inputs = definition?.inputs ?? [];

  // The only per-node execution info the API currently exposes is which
  // single node failed (error.nodeId) — see execution-store.ts. There's no
  // list of which nodes succeeded/were skipped, so this can only highlight
  // a failure, not a full per-node status. WorkflowDocument itself is never
  // touched by this — it's read-only from a separate, non-persisted store.
  const executionStatus = useExecutionStore((s) => s.status);
  const executionErrorNodeId = useExecutionStore((s) => s.error?.nodeId);
  const failedHere = executionStatus === "error" && executionErrorNodeId === id;

  // Null outside WorkflowCanvas (e.g. a node rendered in isolation in a
  // test) — the "+" affordance below simply doesn't render in that case.
  const canvasActions = useCanvasActions();

  return (
    <div
      className={cn(
        "group relative min-w-[220px] rounded-lg border bg-background shadow-sm transition-colors",
        failedHere
          ? "border-destructive ring-2 ring-destructive/30"
          : selected
            ? "border-primary ring-2 ring-primary/30"
            : "border-border",
        data.disabled && "opacity-50"
      )}
    >
      {inputs.map((input, index) => (
        <Handle
          key={input.id}
          id={input.id}
          type="target"
          position={Position.Left}
          style={{ top: 24 + index * 16 }}
          className="!h-2.5 !w-2.5 !border-2 !border-background !bg-muted-foreground"
        />
      ))}

      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div
          className="flex h-6 w-6 items-center justify-center rounded-md"
          style={{ backgroundColor: `${definition?.color ?? "#64748b"}1a` }}
        >
          <Icon className="h-3.5 w-3.5" style={{ color: definition?.color ?? "#64748b" }} />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium leading-tight">{data.label}</span>
          <span className="truncate text-[11px] leading-tight text-muted-foreground">
            {definition?.displayName ?? data.nodeType}
          </span>
        </div>
        {failedHere && <AlertCircle className="ml-auto h-4 w-4 shrink-0 text-destructive" />}
      </div>

      <div className="px-3 py-2 text-xs text-muted-foreground">
        <NodeSummary nodeType={data.nodeType} config={data.config} />
      </div>

      {outputs.map((output, index) => {
        const top = 24 + index * 16;
        return (
          <div key={output.id}>
            <Handle
              id={output.id}
              type="source"
              position={Position.Right}
              style={{ top }}
              className="!h-2.5 !w-2.5 !border-2 !border-background !bg-primary"
            />
            {/* "Fácil conexão": hover an idle output to add+wire the next
             *  node in one step, instead of adding from the sidebar and
             *  then dragging a separate edge. Visible on node hover so the
             *  canvas doesn't look cluttered with a "+" per output at rest. */}
            {canvasActions && (
              <button
                type="button"
                title="Adicionar node conectado"
                style={{ top, right: -26 }}
                className="absolute z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border border-dashed border-primary/50 bg-background text-primary opacity-0 transition-opacity hover:border-solid hover:bg-primary hover:text-primary-foreground group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  canvasActions.onRequestAddFromOutput(id, output.id, {
                    x: e.clientX,
                    y: e.clientY,
                  });
                }}
              >
                <Plus className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** One-line summary of the config, so the node isn't just a bare label. */
function NodeSummary({
  nodeType,
  config,
}: {
  nodeType: string;
  config: Record<string, unknown>;
}) {
  switch (nodeType) {
    case "httpRequest":
      return (
        <span className="font-mono">
          {String(config.method ?? "GET")} {String(config.url ?? "") || "(sem URL)"}
        </span>
      );
    case "webhookTrigger":
      if (config.provider === "whatsapp") return <span>WhatsApp</span>;
      if (config.provider === "instagram") return <span>Instagram (sem executor ainda)</span>;
      return <span className="font-mono">{String(config.method ?? "POST")}</span>;
    case "googleCalendar":
      return <span>{String(config.summary ?? "") || "(sem título)"}</span>;
    case "googleSheets":
      return <span className="font-mono">{String(config.spreadsheetId ?? "") || "(sem planilha)"}</span>;
    case "aiAgent":
      return <span>{String(config.systemPrompt ?? "").slice(0, 40) || "(sem prompt)"}</span>;
    case "scheduleTrigger":
      return <span>a cada {String(config.interval ?? 60)}s</span>;
    case "delay":
      return <span>{String(config.duration ?? 1)} {String(config.unit ?? "seconds")}</span>;
    case "code":
      return <span>{String(config.code ?? "").length} caracteres</span>;
    default:
      return <span>Configurado</span>;
  }
}

export const WorkflowNodeView = memo(WorkflowNodeViewImpl);
