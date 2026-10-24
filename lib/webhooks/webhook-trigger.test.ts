import { describe, it, expect } from "vitest";
import { buildExecutionPlan } from "@/lib/execution/planner";
import { runExecutionPlan } from "@/lib/execution/executor";
import { ExecutionEngineError, ExecutionErrorCode } from "@/lib/execution/errors";
import { buildGenericItems, buildWhatsappItems } from "./payload";

/**
 * Fase 5A — o Webhook Trigger no motor (planner + executor) e a montagem
 * dos items de entrada. Nada aqui fala com banco.
 */

function node(id: string, type: string, data: Record<string, unknown> = {}) {
  return { id, type, name: id, position: { x: 0, y: 0 }, data };
}
function edge(id: string, source: string, target: string) {
  return { id, source, target };
}
function doc(nodes: unknown[], edges: unknown[]) {
  return { schemaVersion: 1, nodes, edges, settings: { executionMode: "default" } };
}

const logger = { info() {}, warn() {}, error() {} };
const baseOptions = { executionId: "ex-1", workflowId: "wf-1", workspaceId: "ws-1", logger };

describe("buildExecutionPlan com trigger de webhook", () => {
  it("começa pelo nó webhook pedido", () => {
    const raw = doc(
      [node("w", "webhookTrigger", { provider: "whatsapp", method: "POST" }), node("s", "set", { values: {} })],
      [edge("e1", "w", "s")]
    );
    const plan = buildExecutionPlan("wf-1", raw, { type: "webhook", nodeId: "w" });
    expect(plan.triggerNodeId).toBe("w");
  });

  it("não exige manualTrigger num disparo por webhook", () => {
    const raw = doc([node("w", "webhookTrigger", { provider: "generic", method: "POST" })], []);
    expect(() => buildExecutionPlan("wf-1", raw, { type: "webhook", nodeId: "w" })).not.toThrow();
  });

  it("recusa quando o nó sumiu ou não é webhookTrigger", () => {
    const raw = doc([node("t", "manualTrigger"), node("w", "webhookTrigger")], [edge("e1", "t", "w")]);
    for (const nodeId of ["nao-existe", "t"]) {
      try {
        buildExecutionPlan("wf-1", raw, { type: "webhook", nodeId });
        throw new Error("deveria ter lançado");
      } catch (err) {
        expect(err instanceof ExecutionEngineError).toBe(true);
        expect((err as ExecutionEngineError).code).toBe(ExecutionErrorCode.WORKFLOW_TRIGGER_NOT_FOUND);
      }
    }
  });

  it("o caminho manual continua igual mesmo com um webhook no documento", () => {
    const raw = doc(
      [node("t", "manualTrigger"), node("w", "webhookTrigger"), node("s", "set", { values: {} })],
      [edge("e1", "t", "s"), edge("e2", "w", "s")]
    );
    expect(buildExecutionPlan("wf-1", raw).triggerNodeId).toBe("t");
  });

  it("aceita documento antigo com `path` no webhookTrigger", () => {
    const raw = doc([node("w", "webhookTrigger", { method: "POST", path: "antigo" })], []);
    expect(() => buildExecutionPlan("wf-1", raw, { type: "webhook", nodeId: "w" })).not.toThrow();
  });
});

describe("runExecutionPlan disparado por webhook", () => {
  it("entrega os items do disparo ao próximo nó e não alcança o manualTrigger", async () => {
    const raw = doc(
      [
        node("t", "manualTrigger"),
        node("w", "webhookTrigger", { provider: "whatsapp", method: "POST" }),
        node("s", "set", { values: { recebido: true } }),
      ],
      [edge("e1", "w", "s")]
    );
    const plan = buildExecutionPlan("wf-1", raw, { type: "webhook", nodeId: "w" });
    const outcome = await runExecutionPlan(plan, {
      ...baseOptions,
      initialInput: { items: [{ json: { text: "oi" } }, { json: { text: "tudo bem?" } }] },
    });

    expect(outcome.status).toBe("success");
    expect(outcome.nodeResults.has("t")).toBe(false);
    expect(outcome.nodeResults.get("w")?.output?.items).toHaveLength(2);
    expect(outcome.nodeResults.get("s")?.status).toBe("success");
  });
});

describe("buildGenericItems", () => {
  it("parseia JSON e remove cabeçalhos sensíveis", () => {
    const [item] = buildGenericItems({
      method: "POST",
      query: { origem: "site" },
      headers: { "Content-Type": "application/json", Authorization: "Bearer segredo", Cookie: "a=b" },
      rawBody: JSON.stringify({ nome: "Maria" }),
    });
    expect(item?.json.body).toMatchObject({ nome: "Maria" });
    const headers = item?.json.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBe(undefined);
    expect(headers.cookie).toBe(undefined);
  });

  it("formulário vira objeto e texto continua texto", () => {
    const [form] = buildGenericItems({
      method: "POST",
      query: {},
      headers: { "content-type": "application/x-www-form-urlencoded" },
      rawBody: "nome=Jo%C3%A3o&passeio=lagoa",
    });
    expect(form?.json.body).toMatchObject({ nome: "João", passeio: "lagoa" });

    const [text] = buildGenericItems({ method: "POST", query: {}, headers: {}, rawBody: "ola" });
    expect(text?.json.body).toBe("ola");
  });
});

describe("buildWhatsappItems", () => {
  it("um item por mensagem, com horário em ISO", () => {
    const items = buildWhatsappItems([
      {
        phoneNumberId: "1",
        displayPhoneNumber: null,
        waMessageId: "wamid.A",
        contactWaId: "5598999990000",
        contactName: "Maria",
        messageType: "text",
        text: "Oi",
        sentAt: new Date(0),
        raw: {},
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.json).toMatchObject({ from: "5598999990000", text: "Oi", sentAt: "1970-01-01T00:00:00.000Z" });
  });
});
