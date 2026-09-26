"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { getNodeDefinition } from "@/lib/workflows/registry";
import { useWorkflowEditorStore } from "./workflow-editor-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function NodePropertiesPanel() {
  const selectedNodeId = useWorkflowEditorStore((s) => s.selectedNodeId);
  const nodes = useWorkflowEditorStore((s) => s.nodes);
  const selectNode = useWorkflowEditorStore((s) => s.selectNode);
  const renameNode = useWorkflowEditorStore((s) => s.renameNode);
  const updateNodeConfig = useWorkflowEditorStore((s) => s.updateNodeConfig);

  const node = nodes.find((n) => n.id === selectedNodeId);

  if (!node) return null;

  const definition = getNodeDefinition(node.data.nodeType);

  return (
    <div className="flex h-full w-80 flex-col border-l border-border">
      <div className="flex items-center justify-between border-b border-border p-3">
        <div>
          <div className="text-sm font-medium">{definition?.displayName ?? node.data.nodeType}</div>
          <div className="text-[11px] text-muted-foreground">{definition?.description}</div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Fechar painel"
          onClick={() => selectNode(null)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="mb-4 flex flex-col gap-1.5">
          <Label htmlFor="node-name">Name</Label>
          <Input
            id="node-name"
            value={node.data.label}
            onChange={(e) => renameNode(node.id, e.target.value)}
          />
        </div>

        <ConfigForm
          key={node.id}
          nodeType={node.data.nodeType}
          config={node.data.config}
          onChange={(config) => updateNodeConfig(node.id, config)}
        />
      </div>
    </div>
  );
}

interface ConfigFormProps {
  nodeType: string;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}

/** Props for the tailored forms below, which don't need to know their own node type. */
interface NodeConfigFormProps {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}

/**
 * Tailored inputs for the node types whose config benefits from one
 * (item 17: "se um nó possuir configuração complexa, pode ter UI
 * específica"). Every other type falls back to a JSON editor validated
 * against its own configSchema before being applied — never applied blind.
 */
function ConfigForm({ nodeType, config, onChange }: ConfigFormProps) {
  switch (nodeType) {
    case "httpRequest":
      return <HttpRequestForm config={config} onChange={onChange} />;
    case "webhookTrigger":
      return <WebhookTriggerForm config={config} onChange={onChange} />;
    case "scheduleTrigger":
      return <ScheduleTriggerForm config={config} onChange={onChange} />;
    case "delay":
      return <DelayForm config={config} onChange={onChange} />;
    case "code":
      return <CodeForm config={config} onChange={onChange} />;
    default:
      return <RawJsonForm nodeType={nodeType} config={config} onChange={onChange} />;
  }
}

function HttpRequestForm({ config, onChange }: NodeConfigFormProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="http-method">Method</Label>
        <select
          id="http-method"
          className="h-10 rounded-md border border-border bg-background px-3 text-sm"
          value={String(config.method ?? "GET")}
          onChange={(e) => onChange({ ...config, method: e.target.value })}
        >
          {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="http-url">URL</Label>
        <Input
          id="http-url"
          placeholder="https://example.com"
          value={String(config.url ?? "")}
          onChange={(e) => onChange({ ...config, url: e.target.value })}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        Headers e query params: disponíveis via edição avançada na Fase 3, junto com a execução real.
      </p>
    </div>
  );
}

function WebhookTriggerForm({ config, onChange }: NodeConfigFormProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="webhook-method">Method</Label>
        <select
          id="webhook-method"
          className="h-10 rounded-md border border-border bg-background px-3 text-sm"
          value={String(config.method ?? "POST")}
          onChange={(e) => onChange({ ...config, method: e.target.value })}
        >
          {["GET", "POST", "PUT"].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="webhook-path">Path</Label>
        <Input
          id="webhook-path"
          placeholder="my-webhook"
          value={String(config.path ?? "")}
          onChange={(e) => onChange({ ...config, path: e.target.value })}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        O endpoint real será criado na Fase 5. Aqui você só define a forma esperada.
      </p>
    </div>
  );
}

function ScheduleTriggerForm({ config, onChange }: NodeConfigFormProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="schedule-interval">Interval (seconds)</Label>
        <Input
          id="schedule-interval"
          type="number"
          min={1}
          value={String(config.interval ?? 60)}
          onChange={(e) => onChange({ ...config, interval: Number(e.target.value) || 1 })}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        O scheduler real será implementado na Fase 5.
      </p>
    </div>
  );
}

function DelayForm({ config, onChange }: NodeConfigFormProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="delay-duration">Duration</Label>
        <Input
          id="delay-duration"
          type="number"
          min={1}
          value={String(config.duration ?? 1)}
          onChange={(e) => onChange({ ...config, duration: Number(e.target.value) || 1 })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="delay-unit">Unit</Label>
        <select
          id="delay-unit"
          className="h-10 rounded-md border border-border bg-background px-3 text-sm"
          value={String(config.unit ?? "seconds")}
          onChange={(e) => onChange({ ...config, unit: e.target.value })}
        >
          {["seconds", "minutes", "hours"].map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function CodeForm({ config, onChange }: NodeConfigFormProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="code-body">JavaScript</Label>
        <textarea
          id="code-body"
          rows={10}
          className="rounded-md border border-border bg-background p-2 font-mono text-xs"
          value={String(config.code ?? "")}
          onChange={(e) => onChange({ ...config, code: e.target.value, language: "javascript" })}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        Armazenado apenas. Nenhum código é executado nesta fase.
      </p>
    </div>
  );
}

/** Fallback for node types without a tailored form (if, switch, merge, transform, manualTrigger). */
function RawJsonForm({ nodeType, config, onChange }: ConfigFormProps) {
  const [text, setText] = useState(() => JSON.stringify(config, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(JSON.stringify(config, null, 2));
    setError(null);
  }, [config]);

  function handleBlur() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError("JSON inválido");
      return;
    }

    const definition = getNodeDefinition(nodeType);
    const result = definition?.configSchema.safeParse(parsed);
    if (result && !result.success) {
      setError("Configuração inválida para este tipo de node");
      return;
    }

    setError(null);
    onChange(parsed as Record<string, unknown>);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="raw-config">Config (JSON)</Label>
      <textarea
        id="raw-config"
        rows={10}
        className="rounded-md border border-border bg-background p-2 font-mono text-xs"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleBlur}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <p className="text-[11px] text-muted-foreground">
        Editor com formulário dedicado chega numa fase futura para este tipo de node.
      </p>
    </div>
  );
}
