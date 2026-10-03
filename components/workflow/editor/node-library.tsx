"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
/**
 * Import de efeito colateral: popula o registro de nodes ANTES de qualquer
 * leitura. Sem esta linha o `Map` de lib/workflows/registry.ts fica vazio NO
 * NAVEGADOR, `getAllNodeDefinitions()` devolve [] e esta lateral renderiza
 * "Nenhum node encontrado" — que foi exatamente o defeito relatado.
 *
 * O registro e um `Map` de modulo, entao existe UMA INSTANCIA POR RUNTIME. O
 * lado servidor ja estava correto: lib/workflows/schema.ts faz este mesmo
 * import na linha 2, e o server component do editor carrega o schema. Mas o
 * bundle do cliente e outro grafo de modulos, com outro `Map`, e nenhum
 * componente cliente alcancava as definicoes.
 *
 * Fica aqui, e nao no ponto de entrada do editor, para que esta lateral seja
 * autossuficiente: ela e o unico consumidor que precisa do registro INTEIRO,
 * e assim pode ser testada sozinha, sem que o teste precise importar as
 * definicoes por fora (o que mascararia o defeito). Como workflow-editor.tsx
 * importa este arquivo, os outros consumidores do cliente
 * (workflow-canvas, node-properties-panel, workflow-node-view) ficam cobertos
 * pelo mesmo import.
 */
import "@/lib/workflows/definitions";
import { getAllNodeDefinitions } from "@/lib/workflows/registry";
import { getNodeIcon } from "../nodes/node-icon-map";
import type { NodeCategory } from "@/lib/workflows/types";
import { cn } from "@/lib/utils";

const CATEGORY_LABELS: Record<NodeCategory, string> = {
  trigger: "Triggers",
  action: "Actions",
  logic: "Logic",
  data: "Data",
  utilities: "Utilities",
  code: "Code",
};

const CATEGORY_ORDER: NodeCategory[] = [
  "trigger",
  "action",
  "logic",
  "data",
  "utilities",
  "code",
];

interface NodeLibraryProps {
  onAddNode: (nodeType: string) => void;
}

export function NodeLibrary({ onAddNode }: NodeLibraryProps) {
  const [query, setQuery] = useState("");
  const definitions = useMemo(() => getAllNodeDefinitions(), []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return definitions;
    return definitions.filter(
      (def) =>
        def.displayName.toLowerCase().includes(q) ||
        def.description.toLowerCase().includes(q)
    );
  }, [definitions, query]);

  const grouped = useMemo(() => {
    const map = new Map<NodeCategory, typeof definitions>();
    for (const def of filtered) {
      const list = map.get(def.category) ?? [];
      list.push(def);
      map.set(def.category, list);
    }
    return map;
  }, [filtered]);

  return (
    <div className="flex h-full w-72 flex-col border-r border-border">
      <div className="border-b border-border p-3">
        <div className="mb-2 text-sm font-medium">Add node</div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search nodes..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {CATEGORY_ORDER.map((category) => {
          const items = grouped.get(category);
          if (!items || items.length === 0) return null;
          return (
            <div key={category} className="mb-3">
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {CATEGORY_LABELS[category]}
              </div>
              {items.map((def) => {
                const Icon = getNodeIcon(def.icon);
                return (
                  <button
                    key={def.type}
                    type="button"
                    onClick={() => onAddNode(def.type)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    )}
                  >
                    <div
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                      style={{ backgroundColor: `${def.color}1a` }}
                    >
                      <Icon className="h-3.5 w-3.5" style={{ color: def.color }} />
                    </div>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-medium leading-tight">
                        {def.displayName}
                      </span>
                      <span className="truncate text-[11px] leading-tight text-muted-foreground">
                        {def.description}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="p-3 text-sm text-muted-foreground">Nenhum node encontrado.</p>
        )}
      </div>
    </div>
  );
}
