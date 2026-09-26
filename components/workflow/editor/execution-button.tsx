"use client";

import { Play, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkflowEditorStore } from "./workflow-editor-store";
import { useExecutionStore } from "./execution-store";

interface ExecutionButtonProps {
  workflowId: string;
}

/**
 * Reads isDirty from the editor store to warn the person — the API
 * executes whatever is persisted in the database, not the in-memory
 * canvas, and this button never triggers a save on their behalf (item 1:
 * "não salvar automaticamente alterações antes de executar").
 */
export function ExecutionButton({ workflowId }: ExecutionButtonProps) {
  const isDirty = useWorkflowEditorStore((s) => s.isDirty);
  const status = useExecutionStore((s) => s.status);
  const execute = useExecutionStore((s) => s.execute);

  // "queued" counts as in-flight too: on the asynchronous path the job is
  // already in the queue, so leaving the button enabled would let someone
  // stack up several runs of the same workflow while the first waits for a
  // worker. Today only the synchronous path is wired to this button, so
  // this changes nothing visible yet — it is here so the async mode can be
  // exposed without the button becoming wrong in the same commit.
  const isRunning = status === "running" || status === "queued";

  return (
    <div className="flex items-center gap-2">
      {isDirty && (
        <span className="text-xs text-muted-foreground" title="A execução usa a última versão salva, não as alterações atuais">
          Alterações não salvas não serão executadas
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isRunning}
        onClick={() => execute(workflowId)}
      >
        {isRunning ? (
          <>
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            Running...
          </>
        ) : (
          <>
            <Play className="mr-1.5 h-3.5 w-3.5" />
            Execute
          </>
        )}
      </Button>
    </div>
  );
}
