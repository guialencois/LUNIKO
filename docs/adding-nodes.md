# Como adicionar um novo node

Só descreve o que existe hoje na Fase 2: registrar um tipo de node no
editor (aparece na biblioteca, pode ser adicionado ao canvas, tem
configuração validada). Não cobre execução — isso é Fase 3+.

## Passos

1. **Criar o schema Zod da configuração** em
   `lib/workflows/definitions/<seu-node>.ts`.
2. **Criar a `NodeDefinition`** e chamar `registerNode(...)` no mesmo
   arquivo, como side-effect do import.
3. **Definir `inputs`/`outputs`** — cada um é `{ id: string; label: string }`.
   Um trigger normalmente não tem `inputs`. Um node com múltiplas saídas
   condicionais (como o `if`) declara mais de um output (`true`/`false`).
   Esses `id`s são o que a validação de handles (`lib/workflows/schema.ts`)
   usa para aceitar/rejeitar uma conexão — o `id` do output que o React Flow
   usa no `<Handle>` (`components/workflow/nodes/workflow-node-view.tsx`)
   é sempre um desses `id`s, nunca inventado à mão.
4. **Definir `defaultData`** — precisa passar no próprio `configSchema`
   (`configSchema.parse(defaultData)` não pode lançar; há um teste que
   verifica isso para todos os nodes registrados, ver `definitions.test.ts`).
5. **Importar o arquivo em `lib/workflows/definitions/index.ts`** — sem
   isso, o `registerNode` nunca roda e o node não existe em lugar nenhum
   (nem na biblioteca, nem na validação).
6. **Criar UI específica no properties panel, se necessário.** Em
   `components/workflow/editor/node-properties-panel.tsx`, adicione um
   `case` no `switch` da função `ConfigForm` apontando para um novo
   componente de formulário. Se não fizer isso, o node cai automaticamente
   no fallback `RawJsonForm` (editor de JSON validado contra o
   `configSchema`) — funcional, só menos amigável.
7. **Criar testes**: adicione o `type` esperado em
   `lib/workflows/registry.test.ts` (`EXPECTED_TYPES`), e qualquer caso de
   validação específico do seu node em `lib/workflows/schema.test.ts` se ele
   introduzir uma regra nova (ex.: um novo tipo de handle).

Nenhum outro arquivo precisa mudar — nem `node-library.tsx`, nem
`workflow-node-view.tsx`, nem `workflow-canvas.tsx` — todos leem o Node
Registry dinamicamente.

## Exemplo real: o node `delay`

`lib/workflows/definitions/delay.ts` (arquivo completo):

```ts
import { z } from "zod";
import { registerNode } from "../registry";

export const delayConfigSchema = z.object({
  duration: z.number().positive().default(1),
  unit: z.enum(["seconds", "minutes", "hours"]).default("seconds"),
});

registerNode({
  type: "delay",
  displayName: "Delay",
  description: "Aguarda antes de continuar (execução real na Fase 3)",
  category: "utilities",
  icon: "Timer",
  color: "#a855f7",
  inputs: [{ id: "input", label: "Input" }],
  outputs: [{ id: "output", label: "Output" }],
  configSchema: delayConfigSchema,
  defaultData: { duration: 1, unit: "seconds" },
});
```

E o formulário dedicado correspondente em `node-properties-panel.tsx`
(`DelayForm`, usando `NodeConfigFormProps`) mostra dois campos — duração e
unidade — em vez de cair no fallback JSON.

Note a descrição: `"(execução real na Fase 3)"`. Isso é deliberado — o node
existe e é configurável agora, mas a config não faz nada sozinha ainda.
Sempre que um node novo não executa de verdade, deixe isso explícito na
`description`, do mesmo jeito.
