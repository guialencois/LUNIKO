"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useWorkflowEditorStore } from "./workflow-editor-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ExecutionButton } from "./execution-button";

interface WorkflowHeaderProps {
  workflowId: string;
  onSave: () => void;
}

export function WorkflowHeader({ workflowId, onSave }: WorkflowHeaderProps) {
  const name = useWorkflowEditorStore((s) => s.name);
  const status = useWorkflowEditorStore((s) => s.status);
  const isDirty = useWorkflowEditorStore((s) => s.isDirty);
  const isSaving = useWorkflowEditorStore((s) => s.isSaving);
  const saveError = useWorkflowEditorStore((s) => s.saveError);
  const renameWorkflow = useWorkflowEditorStore((s) => s.renameWorkflow);

  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
      <div className="flex items-center gap-3">
        <Link
          href="/dashboard/workflows"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Workflows
        </Link>
        <div className="h-5 w-px bg-border" />
        <Input
          value={name}
          onChange={(e) => renameWorkflow(e.target.value)}
          className="h-8 w-56 border-none px-1 text-sm font-medium shadow-none focus-visible:ring-1"
          aria-label="Workflow name"
        />
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium capitalize text-muted-foreground">
          {status}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">
          {saveError ? (
            <span className="text-destructive">{saveError}</span>
          ) : isSaving ? (
            "Saving..."
          ) : isDirty ? (
            "Unsaved changes"
          ) : (
            "Saved"
          )}
        </span>
        <Button type="button" onClick={onSave} disabled={isSaving || !isDirty} size="sm">
          Save
        </Button>
        <div className="h-5 w-px bg-border" />
        <ExecutionButton workflowId={workflowId} />
      </div>
    </div>
  );
}
