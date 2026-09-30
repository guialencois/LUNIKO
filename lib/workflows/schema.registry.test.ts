import { describe, it, expect } from "vitest";

/**
 * REPARE NO QUE ESTE ARQUIVO NAO IMPORTA.
 *
 * Nao existe `import "./definitions"` aqui, de proposito. Os testes que ja
 * existiam (registry.test.ts:2 e definitions/definitions.test.ts:2) populam o
 * registro por conta propria, entao provam que as 11 definicoes sao bem
 * formadas — mas nao provam que a APLICACAO as carrega. Era essa a lacuna que
 * deixou o defeito passar.
 *
 * O vitest isola o registro de modulos por arquivo de teste, entao o
 * `import "./definitions"` daqueles outros arquivos nao vaza para este. Se o
 * `import "./definitions"` da linha 2 de schema.ts for removido, os testes
 * abaixo falham — e essa e a unica razao de eles existirem.
 */
import { parseWorkflowDocument, CURRENT_SCHEMA_VERSION } from "./schema";

const posicao = { x: 0, y: 0 };

function documentoComManualTrigger() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    nodes: [
      { id: "n1", type: "manualTrigger", name: "Manual Trigger", position: posicao, data: {} },
    ],
    edges: [],
    settings: { executionMode: "default" },
  };
}

function documentoComDoisNodesLigados() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    nodes: [
      { id: "n1", type: "manualTrigger", name: "Manual Trigger", position: posicao, data: {} },
      { id: "n2", type: "set", name: "Set", position: { x: 240, y: 0 }, data: { values: {} } },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2", sourceHandle: "output", targetHandle: "input" },
    ],
    settings: { executionMode: "default" },
  };
}

describe("schema.ts popula o registro pelo caminho de producao", () => {
  it("valida um documento com manualTrigger sem o teste importar as definicoes", () => {
    const resultado = parseWorkflowDocument(documentoComManualTrigger());

    // Com o registro vazio, o superRefine de schema.ts adiciona
    // "Unknown node type: manualTrigger" e este parse falha.
    expect(resultado.success).toBe(true);
  });

  it("nao reporta 'Unknown node type' para nenhum dos 11 tipos registrados", () => {
    const tipos = [
      "manualTrigger",
      "webhookTrigger",
      "scheduleTrigger",
      "httpRequest",
      "set",
      "if",
      "switch",
      "transform",
      "merge",
      "delay",
      "code",
    ];

    for (const tipo of tipos) {
      const resultado = parseWorkflowDocument({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        nodes: [{ id: "n1", type: tipo, name: tipo, position: posicao, data: {} }],
        edges: [],
        settings: { executionMode: "default" },
      });

      const mensagens = resultado.success
        ? []
        : resultado.error.issues.map((i) => i.message);

      expect(mensagens, `tipo ${tipo}`).not.toContain(`Unknown node type: ${tipo}`);
    }
  });

  it("ainda recusa um tipo que de fato nao existe", () => {
    // Prova que o teste acima nao passa por acidente: a validacao continua
    // rejeitando de verdade, ela so nao rejeita mais os tipos legitimos.
    const resultado = parseWorkflowDocument({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      nodes: [{ id: "n1", type: "naoExiste", name: "x", position: posicao, data: {} }],
      edges: [],
      settings: { executionMode: "default" },
    });

    expect(resultado.success).toBe(false);
    if (!resultado.success) {
      expect(resultado.error.issues.map((i) => i.message)).toContain(
        "Unknown node type: naoExiste"
      );
    }
  });
});

describe("um workflow valido nao vira documento vazio", () => {
  /**
   * app/dashboard/workflows/[workflowId]/page.tsx troca o documento por
   * createEmptyWorkflowDocument() quando o parse falha. O fallback existe de
   * proposito, para nao trancar o usuario fora da pagina. O que nao pode
   * acontecer e ele ser acionado por um documento legitimo — nesse caso o
   * usuario abre o editor e ve um canvas vazio no lugar do trabalho dele.
   */
  it("mantem os dois nodes e a aresta de um documento legitimo", () => {
    const resultado = parseWorkflowDocument(documentoComDoisNodesLigados());

    expect(resultado.success).toBe(true);
    if (resultado.success) {
      expect(resultado.data.nodes).toHaveLength(2);
      expect(resultado.data.edges).toHaveLength(1);
      expect(resultado.data.nodes.map((n) => n.type)).toEqual(["manualTrigger", "set"]);
    }
  });

  it("o ramo do fallback da pagina do editor nao e escolhido", () => {
    // Reproduz literalmente a decisao de page.tsx:27-29.
    const parsed = parseWorkflowDocument(documentoComDoisNodesLigados());
    const usariaFallback = !parsed.success;

    expect(usariaFallback).toBe(false);
  });

  it("aceita as handles declaradas pelas definicoes", () => {
    // sourceHandle "output" do manualTrigger e targetHandle "input" do set.
    // Com registro vazio isto tambem falharia, com mensagem de handle
    // inexistente em vez de tipo desconhecido.
    const resultado = parseWorkflowDocument(documentoComDoisNodesLigados());

    const mensagens = resultado.success
      ? []
      : resultado.error.issues.map((i) => i.message);

    expect(mensagens.filter((m) => m.includes("handle"))).toHaveLength(0);
  });
});
