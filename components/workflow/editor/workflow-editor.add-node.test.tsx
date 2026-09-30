// @vitest-environment jsdom
import { describe, it, expect } from "vitest";

/**
 * REPARE NO QUE ESTE ARQUIVO NAO IMPORTA.
 *
 * Nao ha `import "@/lib/workflows/definitions"` aqui. O registro chega
 * populado pelo grafo real de modulos do editor: workflow-editor.tsx importa
 * node-library.tsx (linha 7), e e node-library.tsx que carrega as definicoes.
 *
 * O que este teste cobre e o par de linhas que QUEBRA com o registro vazio,
 * em workflow-editor.tsx:93-94:
 *
 *     assertKnownNodeType(nodeType);
 *     const definition = getNodeDefinition(nodeType)!;
 *
 * O `!` afirma ao TypeScript que nunca e undefined. Com registro vazio, e —
 * e o acesso a `definition.displayName` na linha 105 estoura em tempo de
 * execucao, sem que o typecheck tenha reclamado de nada.
 *
 * LIMITE CONHECIDO: este teste importa o editor mas nao o RENDERIZA. Montar
 * <WorkflowEditor /> exige @xyflow/react no jsdom, que precisa de um stub de
 * ResizeObserver e de hidratacao da store — infraestrutura de teste que este
 * projeto ainda nao tem. O que esta coberto e a pre-condicao exata de
 * handleAddNode pelo caminho de producao; o clique de ponta a ponta esta
 * coberto pelo ultimo teste de node-library.test.tsx.
 */
import { WorkflowEditor } from "./workflow-editor";
import { assertKnownNodeType } from "./workflow-canvas";
import { getNodeDefinition } from "@/lib/workflows/registry";

describe("o editor consegue adicionar um node", () => {
  it("o modulo do editor carrega e traz o registro populado", () => {
    expect(typeof WorkflowEditor).toBe("function");
    expect(getNodeDefinition("manualTrigger")).toBeDefined();
  });

  it("assertKnownNodeType aceita manualTrigger", () => {
    // Com registro vazio: "Cannot add unknown node type: manualTrigger".
    expect(() => assertKnownNodeType("manualTrigger")).not.toThrow();
  });

  it("assertKnownNodeType continua recusando um tipo inexistente", () => {
    expect(() => assertKnownNodeType("naoExiste")).toThrow(
      "Cannot add unknown node type: naoExiste"
    );
  });

  it("tem tudo que handleAddNode le para montar o node", () => {
    const definition = getNodeDefinition("manualTrigger");
    expect(definition).toBeDefined();

    // linha 105: data.label = definition.displayName
    expect(definition!.displayName).toBe("Manual Trigger");
    // linha 106: data.config = definition.defaultData
    expect(definition!.defaultData).toBeDefined();
    expect(() => definition!.configSchema.parse(definition!.defaultData)).not.toThrow();
  });

  it("o botao do estado vazio do canvas usa um tipo que existe", () => {
    // workflow-editor.tsx:186 chama onAddNode("manualTrigger") direto.
    expect(() => assertKnownNodeType("manualTrigger")).not.toThrow();
  });
});
