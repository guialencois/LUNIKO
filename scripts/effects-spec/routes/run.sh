#!/usr/bin/env bash
# =====================================================================
# Fase 10.5A — as ROTAS reais de /api/effects e /api/workflows (arquivar,
# restaurar, apagar, editar, listar, executar), compiladas e executadas em Node com
# next/server, a sessão e os repositórios trocados por stubs roteirizados.
# O que está sob teste é a TRADUÇÃO PARA HTTP: status, código, corpo, e o
# que a rota repassa (ou não) ao repositório. O repositório em si é
# validado contra PostgreSQL (scripts/f4f-lifecycle-harness.sql, seção 9).
#
#   ./scripts/effects-spec/routes/run.sh            # build + spec
#   ./scripts/effects-spec/routes/run.sh --mutate   # + mutações nas rotas
# Requer node >= 20, tsc, TYPES_ROOT e ZOD_ROOT (ver ../run.sh).
# =====================================================================
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WORK="${WORK:-$(mktemp -d)}/routes"
: "${TYPES_ROOT:?defina TYPES_ROOT (pasta com node/)}"
: "${ZOD_ROOT:?defina ZOD_ROOT (pacote zod 3.x)}"
REAL=(
  "app/api/effects/route.ts" "app/api/effects/[operationId]/route.ts" "app/api/effects/[operationId]/resolve/route.ts"
  "app/api/workflows/[id]/archive/route.ts" "app/api/workflows/[id]/restore/route.ts" "app/api/workflows/[id]/route.ts"
  "app/api/workflows/route.ts" "app/api/workflows/[id]/execute/route.ts"
  "lib/api-error.ts" "server/execution/effects/resolution.ts"
  "server/execution/effects/effect-view.ts" "server/workflows/errors.ts"
  "server/execution/validation.ts" "lib/execution/types.ts" "lib/execution/errors.ts" "lib/execution/effects.ts"
)
rm -rf "$WORK"; mkdir -p "$WORK/src/stubs" "$WORK/node_modules"
for f in "${REAL[@]}"; do mkdir -p "$WORK/src/$(dirname "$f")"; cp "$ROOT/$f" "$WORK/src/$f"; done
for f in "${REAL[@]}"; do
  [ "$(sha256sum < "$ROOT/$f")" = "$(sha256sum < "$WORK/src/$f")" ] || { echo "cópia divergente: $f"; exit 1; }
done
put() { mkdir -p "$(dirname "$WORK/src/$2")"; cp "$HERE/stubs/$1" "$WORK/src/$2"; }
put next-server.ts stubs/next-server.ts
put session.ts lib/auth/session.ts
put actions.ts lib/auth/actions.ts
put effect-decision.ts server/execution/effects/effect-decision.ts
put effect-repository.ts server/execution/effects/effect-repository.ts
put workflow-mutations.ts server/workflows/mutations.ts
put workflow-queries.ts server/workflows/queries.ts
put workflow-validation.ts server/workflows/validation.ts
put execute-workflow.ts server/execution/execute-workflow.ts
put enqueue-workflow-execution.ts server/execution/enqueue-workflow-execution.ts
put execution-queue.ts server/execution/execution-queue.ts
ln -sfn "$ZOD_ROOT" "$WORK/node_modules/zod"
echo "rotas reais copiadas e conferidas: ${#REAL[@]}"
cat > "$WORK/tsconfig.json" <<JSON
{ "compilerOptions": {
    "target": "ES2022", "module": "ES2022", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true, "skipLibCheck": true, "isolatedModules": true,
    "lib": ["ES2022", "DOM"], "types": ["node"], "typeRoots": ["$TYPES_ROOT"],
    "rootDir": "src", "outDir": "out",
    "paths": { "@/*": ["./src/*"], "next/server": ["./src/stubs/next-server.ts"] } },
  "include": ["src/**/*.ts"] }
JSON
(cd "$WORK" && tsc -p tsconfig.json)
echo "tsc --strict (rotas reais + stubs): 0 erros"
python3 - "$WORK/out" <<'EOPY'
import os, re, sys
out = sys.argv[1]
for root, _, files in os.walk(out):
    for fn in files:
        if not fn.endswith(".js"): continue
        path = os.path.join(root, fn); src = open(path).read()
        def fix(m):
            spec = m.group(2)
            if spec == "next/server": spec = "@/stubs/next-server"
            if spec.startswith("@/"):
                spec = os.path.relpath(os.path.join(out, spec[2:]), root)
                if not spec.startswith("."): spec = "./" + spec
            if spec.startswith(".") and not spec.endswith(".js"): spec += ".js"
            return f'{m.group(1)}"{spec}"'
        open(path, "w").write(re.sub(r'(from\s+|import\s+)"([^"]+)"', fix, src))
EOPY
echo '{"type":"module"}' > "$WORK/out/package.json"
cp "$HERE/spec.mjs" "$WORK/spec.mjs"
(cd "$WORK" && node spec.mjs | tail -1)

if [ "${1:-}" = "--mutate" ]; then
  mut() { # nome arquivo old new
    rm -rf "$WORK/mut" && cp -r "$WORK/out" "$WORK/mut"
    python3 - "$WORK/mut/$2" "$3" "$4" <<'EOPY' || { echo "ERRO    $1 (padrão não encontrado)"; return; }
import sys, re
p, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read(); pat = r"\s+".join(re.escape(t) for t in old.split()); m = re.search(pat, s)
if not m: sys.exit(3)
open(p, "w").write(s[:m.start()] + new + s[m.end():])
EOPY
    sed 's#\./out/#./mut/#g' "$WORK/spec.mjs" > "$WORK/spec-mut.mjs"
    rc=0; out=$(cd "$WORK" && timeout 60 node spec-mut.mjs 2>&1) || rc=$?   # set -e: a falha é o esperado
    n=$(echo "$out" | grep -c '^FAIL ' || true)
    if [ $rc -eq 0 ]; then echo "VIVA    $1  <-- a spec NÃO detectou"
    elif [ "$n" -gt 0 ]; then echo "MORTA   $1  (asserção: $n FAIL)"
    else echo "MORTA   $1  (abortou: $(echo "$out" | grep -m1 -oE '(Error|error).{0,70}'))"; fi
  }
  E=app/api/effects; W=app/api/workflows
  mut "resolve dispensa o resfriamento" "$E/[operationId]/resolve/route.js" 'await resolveUnknownEffectOperation(user.id, workspaceId, params.operationId, input);' 'await resolveUnknownEffectOperation(user.id, workspaceId, params.operationId, input, { coolingPeriodSeconds: 0 });'
  mut "resolve aceita corpo sem validar" "$E/[operationId]/resolve/route.js" 'input = validateResolveEffectRequest(body);' 'input = body;'
  mut "not_unknown vira 400" "$E/[operationId]/resolve/route.js" '`This operation is already ${result.status}; only an operation whose outcome is unknown can be resolved.`, 409);' '`This operation is already ${result.status}; only an operation whose outcome is unknown can be resolved.`, 400);'
  mut "forbidden vira 404" "$E/[operationId]/resolve/route.js" '"Only a workspace owner or admin can resolve an external operation.", 403);' '"Only a workspace owner or admin can resolve an external operation.", 404);'
  mut "lista padrão = tudo" "$E/route.js" 'const rawStatus = params.get("status") ?? "unknown";' 'const rawStatus = params.get("status") ?? "all";'
  mut "lista sem limite máximo" "$E/route.js" 'limit < 1 || limit > 200' 'limit < 1'
  mut "lista devolve a linha crua" "$E/route.js" 'operations: rows.map(toEffectOperationView)' 'operations: rows'
  mut "detalhe sem checar UUID" "$E/[operationId]/route.js" 'if (!UUID.test(params.operationId)) {' 'if (false) {'
  mut "histórico devolvido cru" "$E/[operationId]/route.js" 'history: found.attempts.map(toEffectAttemptView),' 'history: found.attempts,'
  mut "apagar com histórico vira 500" "$W/[id]/route.js" 'if (err instanceof WorkflowConflictError) return apiError(err.code, err.message, 409); throw err;' 'throw err;'
  mut "arquivar em conflito vira 500" "$W/[id]/archive/route.js" 'if (err instanceof WorkflowConflictError) return apiError(err.code, err.message, 409);' ''
  mut "lista de workflows ignora ?archived" "$W/route.js" 'const items = await listWorkflows(user.id, workspaceId, { archived });' 'const items = await listWorkflows(user.id, workspaceId);'
  mut "resolve sem teto de corpo" "$E/[operationId]/resolve/route.js" 'if (raw.length > MAX_BODY_LENGTH) {' 'if (false) {'
  mut "arquivar sem checar UUID" "$W/[id]/archive/route.js" 'if (!UUID.test(params.id)) {' 'if (false) {'
  mut "executar arquivado vira 400" "$W/[id]/execute/route.js" 'return apiError("WORKFLOW_ARCHIVED", err.message, 409);' 'return apiError("WORKFLOW_ARCHIVED", err.message, 400);'
  mut "execute confia no workspace do corpo" "$W/[id]/execute/route.js" 'workspaceId, workflowId: params.id, input: parsed.input,' 'workspaceId: body?.workspaceId ?? workspaceId, workflowId: params.id, input: parsed.input,'
fi
