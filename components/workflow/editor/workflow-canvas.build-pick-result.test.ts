// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
/**
 * Mesmo motivo do import em node-library.tsx (ver o comentário lá): popula
 * o registro antes de qualquer leitura, no mesmo Map de módulo que
 * buildPickResult/getNodeDefinition consultam.
 */
import "@/lib/workflows/definitions";
import { buildPickResult, assertKnownNodeType, type PendingConnection } from "./workflow-canvas";

/**
 * buildPickResult é o núcleo puro dos três gatilhos de "conexão fácil"
 * (arrastar para o vazio, "+" no handle de saída, "+" no meio de uma
 * aresta) — ver workflow-canvas.tsx. Cobre exatamente a decisão de QUAL
 * node e QUAIS edges resultam de cada PendingConnection, sem precisar
 * montar <WorkflowCanvas> (que exige @xyflow/react rodando no jsdom —
 * infraestrutura que este projeto ainda não tem, ver
 * workflow-editor.add-node.test.tsx).
 */
describe("buildPickResult", () => {
  const flowPosition = { x: 300, y: 150 };

  it("drag a partir de um output (handleType 'source') conecta o node arrastado -> o novo node", () => {
    const pending: PendingConnection = {
      kind: "drag",
      nodeId: "node_a",
      handleId: "output",
      handleType: "source",
    };

    const result = buildPickResult(pending, "httpRequest", flowPosition);

    expect(result.newNode.position).toEqual(flowPosition);
    expect(result.newNode.data.nodeType).toBe("httpRequest");
    expect(result.newEdges).toEqual([
      {
        source: "node_a",
        sourceHandle: "output",
        target: result.newNode.id,
        targetHandle: "input",
      },
    ]);
    expect(result.removeEdgeId).toBeUndefined();
  });

  it("drag a partir de um input (handleType 'target') conecta o novo node -> o node arrastado", () => {
    const pending: PendingConnection = {
      kind: "drag",
      nodeId: "node_b",
      handleId: "input",
      handleType: "target",
    };

    const result = buildPickResult(pending, "httpRequest", flowPosition);

    expect(result.newEdges).toEqual([
      {
        source: result.newNode.id,
        sourceHandle: "output",
        target: "node_b",
        targetHandle: "input",
      },
    ]);
  });

  it("drag a partir de um output quando o novo node é um trigger (sem input) não cria edge nenhuma", () => {
    // Um trigger não tem input — não dá para conectar algo "para dentro"
    // dele. buildPickResult não deve estourar nem inventar uma edge solta
    // com targetHandle undefined.
    const pending: PendingConnection = {
      kind: "drag",
      nodeId: "node_a",
      handleId: "output",
      handleType: "source",
    };

    const result = buildPickResult(pending, "manualTrigger", flowPosition);

    expect(result.newEdges).toEqual([]);
  });

  it("'+' no handle de saída (output-button) conecta o node de origem -> o novo node", () => {
    const pending: PendingConnection = {
      kind: "output-button",
      nodeId: "node_a",
      handleId: "output",
    };

    const result = buildPickResult(pending, "delay", flowPosition);

    expect(result.newEdges).toEqual([
      {
        source: "node_a",
        sourceHandle: "output",
        target: result.newNode.id,
        targetHandle: "input",
      },
    ]);
    expect(result.removeEdgeId).toBeUndefined();
  });

  it("'+' no meio de uma aresta (edge-split) insere o node entre os dois e marca a aresta antiga para remoção", () => {
    const pending: PendingConnection = {
      kind: "edge-split",
      edgeId: "edge_1",
      source: "node_a",
      sourceHandle: "output",
      target: "node_b",
      targetHandle: "input",
    };

    const result = buildPickResult(pending, "delay", flowPosition);

    expect(result.removeEdgeId).toBe("edge_1");
    expect(result.newEdges).toEqual([
      {
        source: "node_a",
        sourceHandle: "output",
        target: result.newNode.id,
        targetHandle: "input",
      },
      {
        source: result.newNode.id,
        sourceHandle: "output",
        target: "node_b",
        targetHandle: "input",
      },
    ]);
  });

  it("edge-split com sourceHandle/targetHandle nulos (edge sem handle nomeado) não propaga null para as novas edges", () => {
    const pending: PendingConnection = {
      kind: "edge-split",
      edgeId: "edge_1",
      source: "node_a",
      sourceHandle: null,
      target: "node_b",
      targetHandle: null,
    };

    const result = buildPickResult(pending, "delay", flowPosition);

    expect(result.newEdges[0]?.sourceHandle).toBeUndefined();
    expect(result.newEdges[1]?.targetHandle).toBeUndefined();
  });

  it("cada chamada gera um id de node novo e diferente", () => {
    const pending: PendingConnection = {
      kind: "output-button",
      nodeId: "node_a",
      handleId: "output",
    };

    const first = buildPickResult(pending, "delay", flowPosition);
    const second = buildPickResult(pending, "delay", flowPosition);

    expect(first.newNode.id).not.toBe(second.newNode.id);
  });

  it("recusa um tipo de node desconhecido, como assertKnownNodeType", () => {
    const pending: PendingConnection = {
      kind: "output-button",
      nodeId: "node_a",
      handleId: "output",
    };

    expect(() => buildPickResult(pending, "naoExiste", flowPosition)).toThrow(
      "Cannot add unknown node type: naoExiste"
    );
    expect(() => assertKnownNodeType("naoExiste")).toThrow();
  });
});
