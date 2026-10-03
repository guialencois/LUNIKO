// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

/**
 * REPARE NO QUE ESTE ARQUIVO NAO IMPORTA.
 *
 * Nao existe `import "@/lib/workflows/definitions"` aqui, de proposito. Este
 * teste so vale se a propria lateral carregar as definicoes: e exatamente o
 * defeito que ele guarda. Se o import de efeito colateral sair de
 * node-library.tsx, o primeiro teste abaixo volta a encontrar
 * "Nenhum node encontrado." e falha.
 *
 * O vitest isola o registro de modulos por arquivo, entao o
 * `import "./definitions"` que existe em lib/workflows/registry.test.ts nao
 * vaza para ca.
 */
import { NodeLibrary } from "./node-library";

const TIPOS_ESPERADOS = 11;

describe("<NodeLibrary />", () => {
  it("lista os nodes registrados em vez de 'Nenhum node encontrado'", () => {
    render(<NodeLibrary onAddNode={() => {}} />);

    expect(screen.queryByText("Nenhum node encontrado.")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(TIPOS_ESPERADOS);
  });

  it("mostra os seis tipos citados no relatorio", () => {
    render(<NodeLibrary onAddNode={() => {}} />);

    // "Code" fica de fora desta lista de proposito: e displayName de um node
    // E rotulo de categoria, entao getByText encontraria dois elementos.
    for (const nome of ["Manual Trigger", "Set", "Transform", "IF", "Switch", "Merge"]) {
      expect(screen.getByText(nome), nome).toBeInTheDocument();
    }
  });

  it("agrupa os nodes pelas categorias declaradas nas definicoes", () => {
    render(<NodeLibrary onAddNode={() => {}} />);

    for (const rotulo of ["Triggers", "Actions", "Logic", "Data", "Utilities"]) {
      expect(screen.getByText(rotulo), rotulo).toBeInTheDocument();
    }
  });

  it("a busca filtra sem esvaziar a lista", () => {
    render(<NodeLibrary onAddNode={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText("Search nodes..."), {
      target: { value: "set" },
    });

    expect(screen.getByText("Set")).toBeInTheDocument();
    expect(screen.queryByText("Manual Trigger")).toBeNull();
    expect(screen.queryByText("Nenhum node encontrado.")).toBeNull();
  });

  it("mostra a mensagem de lista vazia so quando a busca de fato nao casa", () => {
    // O texto de lista vazia nao e bug — ele existe para este caso. O bug era
    // ele aparecer com a busca vazia.
    render(<NodeLibrary onAddNode={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText("Search nodes..."), {
      target: { value: "zzzzzzzz" },
    });

    expect(screen.getByText("Nenhum node encontrado.")).toBeInTheDocument();
  });

  it("entrega o tipo certo ao editor quando o node e clicado", () => {
    const onAddNode = vi.fn();
    render(<NodeLibrary onAddNode={onAddNode} />);

    const botao = screen.getByText("Manual Trigger").closest("button");
    expect(botao).not.toBeNull();
    fireEvent.click(botao!);

    expect(onAddNode).toHaveBeenCalledWith("manualTrigger");
  });
});
