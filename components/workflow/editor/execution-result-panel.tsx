"use client";

import { X, CheckCircle2, XCircle, Loader2, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useExecutionStore } from "./execution-store";

const STATUS_LABEL: Record<string, string> = {
  // "queued" only appears on the asynchronous path: the job is in the queue
  // and no worker has claimed it yet. Without an entry here the header
  // would fall through to `?? status` and render the raw word.
  queued: "Queued",
  running: "Running",
  success: "Success",
  error: "Error",
  cancelled: "Cancelled",
};

/**
 * Minimal result panel — status, executionId, error, final result. No
 * history, no per-node timeline beyond what the API response already
 * carries (today: at most the failing node's id in error.nodeId — see
 * README note in the final report about what isn't available yet).
 */
export function ExecutionResultPanel() {
  const isPanelOpen = useExecutionStore((s) => s.isPanelOpen);
  const status = useExecutionStore((s) => s.status);
  const executionId = useExecutionStore((s) => s.executionId);
  const result = useExecutionStore((s) => s.result);
  const error = useExecutionStore((s) => s.error);
  const closePanel = useExecutionStore((s) => s.closePanel);
  const reset = useExecutionStore((s) => s.reset);

  if (!isPanelOpen) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 w-96 rounded-lg border border-border bg-background shadow-lg">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <StatusIcon status={status} />
          {STATUS_LABEL[status] ?? status}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Fechar painel de execução"
          onClick={() => {
            closePanel();
            reset();
          }}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="max-h-80 overflow-y-auto p-4 text-sm">
        {executionId && (
          <p className="mb-2 text-xs text-muted-foreground">
            Execution ID: <span className="font-mono">{executionId}</span>
          </p>
        )}

        {status === "running" && (
          <p className="text-muted-foreground">Executando workflow...</p>
        )}

        {error && (
          <div className="rounded-md bg-destructive/10 p-3">
            <p className="font-medium text-destructive">{error.code}</p>
            <p className="mt-1 text-muted-foreground">{error.message}</p>
            {error.nodeId && (
              <p className="mt-1 text-xs text-muted-foreground">
                Node: <span className="font-mono">{error.nodeId}</span>
              </p>
            )}
          </div>
        )}

        {status === "success" && result && (
          <div>
            <p className="mb-1 font-medium">Resultado</p>
            <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">
              {JSON.stringify(result, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
    case "success":
      return <CheckCircle2 className="h-4 w-4 text-green-600" />;
    case "error":
      return <XCircle className="h-4 w-4 text-destructive" />;
    case "cancelled":
      return <Ban className="h-4 w-4 text-muted-foreground" />;
    default:
      return null;
  }
}
