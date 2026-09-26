# Workflow Editor — Arquitetura (Fase 2)

Este documento descreve o que existe hoje no editor visual de workflows. Não
descreve execução real, Redis, filas, webhooks reais ou scheduler — nada
disso existe ainda (ver `docs/adding-nodes.md` e o prompt mestre para o
roadmap das próximas fases).

## Visão geral

```
Node Definitions (lib/workflows/definitions/*.ts)
        ↓ registerNode()
Node Registry (lib/workflows/registry.ts) — fonte única de verdade
        ↓ getAllNodeDefinitions() / getNodeDefinition()
Editor (components/workflow/editor/*, components/workflow/nodes/*)
        ↓ buildWorkflowDocument()
WorkflowDocument (lib/workflows/types.ts) — validado por lib/workflows/schema.ts
        ↓ persistido como jsonb
workflows.document (Postgres, via Drizzle — lib/db/schema/workflows.ts)
```

O `WorkflowDocument` é o contrato entre o editor e o futuro Workflow Engine
(Fase 3+): é só dados (`nodes`, `edges`, `settings`, `schemaVersion`), nunca
componentes React, funções ou classes. O engine, quando existir, vai ler
esse mesmo formato sem precisar importar nada do editor.

## WorkflowDocument

Definido em `lib/workflows/types.ts`, validado em `lib/workflows/schema.ts`
(`workflowDocumentSchema`, Zod).

```ts
interface WorkflowNode {
  id: string;
  type: string;                    // tem que existir no Node Registry
  name: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;   // validado contra NodeDefinition.configSchema
  disabled?: boolean;
}

interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;    // se presente, tem que ser um output real do node source
  targetHandle?: string | null;    // se presente, tem que ser um input real do node target
}

interface WorkflowDocument {
  schemaVersion: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  settings: { executionMode: "default" };
}
```

`workflowDocumentSchema` (via `.superRefine`) rejeita:
- node id duplicado;
- edge id duplicado;
- `type` de node não registrado no Node Registry;
- `data` do node que não passa no `configSchema` da sua própria `NodeDefinition`;
- edge cujo `source`/`target` não existe entre os nodes do documento;
- `sourceHandle` que não é um output real do node de origem (consultando o Node Registry);
- `targetHandle` que não é um input real do node de destino (idem).

Limites: `MAX_NODES_PER_WORKFLOW = 500`, `MAX_EDGES_PER_WORKFLOW = 2000`.

O servidor **sempre** revalida com esse mesmo schema (`updateWorkflowRequestSchema`
em `server/workflows/validation.ts`) — o editor nunca é a única linha de
defesa, mesmo que ele também pudesse validar no cliente.

## Node Registry

`lib/workflows/registry.ts`: um `Map<string, NodeDefinition>` module-level.

```ts
interface NodeDefinition {
  type: string;
  displayName: string;
  description: string;
  category: "trigger" | "action" | "logic" | "data" | "utilities" | "code";
  icon: string;              // nome de ícone lucide-react
  color: string;
  inputs: { id: string; label: string }[];
  outputs: { id: string; label: string }[];
  configSchema: z.ZodTypeAny;
  defaultData: Record<string, unknown>;
}
```

`registerNode(definition)` registra (lança erro em `type` duplicado);
`getNodeDefinition(type)`, `getAllNodeDefinitions()`,
`getNodeDefinitionsByCategory(category)`, `isRegisteredNodeType(type)` leem.

Cada arquivo em `lib/workflows/definitions/*.ts` chama `registerNode(...)`
como side-effect ao ser importado. `lib/workflows/definitions/index.ts` é o
composition root — importa os 11 arquivos, uma vez, e é ele quem qualquer
outro módulo (schema, editor) importa para garantir que o registry está
populado. Ver `docs/adding-nodes.md` para adicionar um novo tipo.

Nenhum componente do editor tem uma lista de nodes hardcoded — todos
consultam o registry (`node-library.tsx`, `workflow-node-view.tsx`,
`node-properties-panel.tsx`).

## Estado: persistido vs. temporário

**Persistido** (vai para o banco no save, via `buildWorkflowDocument`):
- `nodes`, `edges` (convertidos de volta ao formato `WorkflowNode`/`WorkflowEdge`);
- `name` do workflow.

**Temporário** (só na store Zustand do editor, nunca enviado ao servidor):
- `selectedNodeId`;
- `isDirty`, `isSaving`, `lastSavedAt`, `saveError`;
- posição/estado do canvas do React Flow em si (zoom, viewport) — o React
  Flow gerencia isso internamente, não passa pela store.

Essa separação existe para que o React Flow, a store e o `WorkflowDocument`
nunca tenham três cópias divergentes do mesmo dado: a store Zustand
(`components/workflow/editor/workflow-editor-store.ts`) é a única fonte de
verdade para `nodes`/`edges` durante a edição; o canvas lê e escreve nela
diretamente (sem `useNodesState`/`useEdgesState` próprio do React Flow).

## React Flow

`components/workflow/editor/workflow-canvas.tsx` — um único componente
`WorkflowNodeView` (`components/workflow/nodes/workflow-node-view.tsx`)
renderiza qualquer tipo de node, estilizado a partir da sua `NodeDefinition`
(ícone, cor, displayName, inputs/outputs viram `<Handle>`).

- Criação de node: `NodeLibrary` → `handleAddNode` em `workflow-editor.tsx`
  (não no canvas em si) — gera id (`crypto.randomUUID()`), aplica
  `defaultData` da definição, posiciona com um deslocamento simples.
- Conexão: `onConnect` (valida `source !== target` e que ambos existem via
  `isValidConnection`) → `addEdge`.
- Seleção: `onNodesChange` filtra mudanças `type === "select"`.
- Exclusão: `deleteKeyCode={["Backspace", "Delete"]}` do próprio React Flow,
  mais limpeza manual de edges que ficariam órfãs (React Flow não faz isso
  sozinho).
- Zoom/pan/minimap/controls/background/fitView: componentes padrão do
  `@xyflow/react`.

Mudanças no canvas só viram `WorkflowDocument` no momento do save — não há
autosave nesta fase (decisão deliberada, ver item 28 do prompt mestre).

## Save

`workflow-editor.tsx::handleSave`: lê o estado atual da store →
`buildWorkflowDocument` → `PATCH /api/workflows/[id]` → sucesso limpa o
dirty state; erro preserva `nodes`/`edges` locais e mostra a mensagem no
header, sem resetar nada.

## CRUD

| Ação | Onde |
|---|---|
| Criar | `/dashboard/workflows/new` (server component, cria e redireciona) |
| Listar | `/dashboard/workflows` |
| Abrir | `/dashboard/workflows/[workflowId]` (o editor) |
| Renomear | Campo de nome no header do editor |
| Excluir | Botão na listagem, com confirmação |

Todas as operações passam por `server/workflows/{queries,mutations}.ts`, que
chamam `requireWorkspaceMembership` (`lib/auth/session.ts`) antes de tocar o
banco. Nenhuma rota de API aceita um `workspaceId` vindo do cliente — ele é
sempre derivado server-side a partir do usuário autenticado
(`ensureDefaultWorkspace`).

## Segurança

- Toda escrita passa por validação Zod no servidor, independente do que o
  cliente validou.
- `SUPABASE_SERVICE_ROLE_KEY` nunca é enviada ao browser (nem teria como:
  não tem prefixo `NEXT_PUBLIC_`, e nem é usada hoje — ver comentário em
  `.env.example`).
- Nenhum `eval`/`new Function` em lugar nenhum — o node `Code` só armazena a
  string, não executa.
- RLS habilitada em `workspaces`, `workspace_members` e `workflows`
  (`db/migrations/*.sql`) para leitura via clients que usem a anon key; a
  API do app conecta direto via `DATABASE_URL` e depende inteiramente de
  `requireWorkspaceMembership` no código, não de RLS, para autorização de
  escrita.

## O que NÃO existe nesta fase

Execução de workflow, Redis, filas, worker, webhook real, scheduler real,
`Code` node executando algo, credentials, retries, logs de execução,
undo/redo, autosave, drag & drop da biblioteca de nodes para o canvas.
