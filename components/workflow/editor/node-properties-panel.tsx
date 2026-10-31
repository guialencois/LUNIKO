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
          nodeId={node.id}
          nodeType={node.data.nodeType}
          config={node.data.config}
          onChange={(config) => updateNodeConfig(node.id, config)}
        />
      </div>
    </div>
  );
}

interface ConfigFormProps {
  nodeId: string;
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
function ConfigForm({ nodeId, nodeType, config, onChange }: ConfigFormProps) {
  switch (nodeType) {
    case "httpRequest":
      return <HttpRequestForm config={config} onChange={onChange} />;
    case "webhookTrigger":
      return <WebhookTriggerForm nodeId={nodeId} config={config} onChange={onChange} />;
    case "scheduleTrigger":
      return <ScheduleTriggerForm config={config} onChange={onChange} />;
    case "delay":
      return <DelayForm config={config} onChange={onChange} />;
    case "code":
      return <CodeForm config={config} onChange={onChange} />;
    default:
      return <RawJsonForm nodeId={nodeId} nodeType={nodeType} config={config} onChange={onChange} />;
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

/**
 * Fase 5A — ver docs/webhook-trigger.md. A URL só é gerada para um nó que já
 * está no workflow SALVO: o servidor confere isso, e o botão avisa antes.
 */
function WebhookTriggerForm({ nodeId, config, onChange }: NodeConfigFormProps & { nodeId: string }) {
  const workflowId = useWorkflowEditorStore((s) => s.workflowId);
  const isDirty = useWorkflowEditorStore((s) => s.isDirty);
  const provider = String(config.provider ?? "generic");
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!workflowId) return;
    let cancelled = false;
    fetch(`/api/workflows/${workflowId}/webhooks?nodeId=${encodeURIComponent(nodeId)}`)
      .then((r) => (r.ok ? r.json() : { url: null }))
      .then((data: { url: string | null }) => {
        if (!cancelled) setUrl(data.url);
      })
      .catch(() => {
        // Sem URL ainda é o estado normal; o botão continua disponível.
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, nodeId]);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/workflows/${workflowId}/webhooks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data?.error?.message ?? "Não foi possível gerar a URL");
        return;
      }
      setUrl(data.url);
    } catch {
      setError("Não foi possível gerar a URL");
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Sem permissão de clipboard: o campo continua selecionável.
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="webhook-provider">Origem</Label>
        <select
          id="webhook-provider"
          className="h-10 rounded-md border border-border bg-background px-3 text-sm"
          value={provider}
          onChange={(e) => onChange({ ...config, provider: e.target.value })}
        >
          <option value="generic">Genérico (qualquer serviço)</option>
          <option value="whatsapp">WhatsApp (Meta Cloud API)</option>
          <option value="instagram">Instagram (ainda sem executor)</option>
        </select>
      </div>

      {provider === "instagram" && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
          Esse provider existe só para desenhar o fluxo. Chamar esta URL hoje
          responde 501 (não implementado) — a verificação de assinatura e o
          parser do payload do Instagram ainda não foram feitos.
        </p>
      )}

      {provider === "generic" && (
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
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="webhook-url">URL</Label>
        {url ? (
          <div className="flex gap-2">
            <Input id="webhook-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" variant="outline" size="sm" onClick={copy}>
              {copied ? "Copiada" : "Copiar"}
            </Button>
          </div>
        ) : (
          <Button type="button" variant="outline" size="sm" disabled={loading || isDirty} onClick={generate}>
            {loading ? "Gerando..." : "Gerar URL"}
          </Button>
        )}
        {!url && isDirty && (
          <p className="text-[11px] text-muted-foreground">Salve o workflow antes de gerar a URL.</p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      <p className="text-[11px] text-muted-foreground">
        {provider === "whatsapp"
          ? "Cole esta URL no painel da Meta (WhatsApp > Configuração > Webhook). Cada mensagem recebida vira um item. A assinatura da Meta é conferida antes de o workflow rodar."
          : provider === "instagram"
            ? "Ainda não cole esta URL em lugar nenhum — toda chamada recebe 501 até o executor existir."
            : "Quem chamar esta URL dispara o workflow. Trate-a como uma senha."}
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
