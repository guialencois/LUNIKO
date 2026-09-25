#!/usr/bin/env bash
# =====================================================================
# Fases 10 e 10.5A — prova executável da camada de efeitos externos, SEM
# node_modules do projeto.
#
# O que faz:
#   1. copia os módulos REAIS (conferidos por sha256) para uma árvore
#      temporária e troca SÓ server/execution/effects/effect-repository.ts
#      pelo stub em memória (effect-repository.memory.ts), que espelha cada
#      WHERE do SQL e o guard de transições do banco;
#   2. compila com tsc --strict (+ noUncheckedIndexedAccess);
#   3. roda spec.mjs: MockExternalEffect nos 7 cenários, testes A–K,
#      achados da revisão independente, ponta a ponta com runExecutionPlan;
#      e (10.5A) o contrato de resolução — resolution.ts REAL, com zod —, as
#      views de /api/effects (effect-view.ts REAL) e o modelo de resolução.
#
#   ./scripts/effects-spec/run.sh            # build + spec
#   ./scripts/effects-spec/run.sh --mutate   # + mutações (a spec TEM de falhar em todas)
#   ./scripts/effects-spec/run.sh --types    # + effect-repository.ts e server/workflows contra um modelo de tipos do Drizzle
#   ./scripts/effects-spec/run.sh --routes   # + as rotas reais (10.5A) com Next/sessão/repositórios em stub
#   ./scripts/effects-spec/run.sh --routes-mutate  # + mutações nas rotas
#
# Requer node >= 20 e tsc no PATH. @types/node: node_modules do projeto, ou
# TYPES_ROOT apontando para uma pasta que contenha node/ (ex.: .../@types).
# zod (10.5A): node_modules/zod do projeto, ou ZOD_ROOT apontando para um
# pacote zod 3.x (a API usada é a mesma da 3.23 fixada no package.json).
#
# O que isto NÃO valida: o SQL que o Drizzle gera (isso é
# scripts/f4f-lifecycle-harness.sql, seções 8-9, contra PostgreSQL) nem a
# concorrência entre sessões (scripts/concurrency-check.sh, cenários 6-9).
# =====================================================================
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="${WORK:-$(mktemp -d)}"
if [ -z "${TYPES_ROOT:-}" ]; then
  for c in "$ROOT/node_modules/@types" "$(npm root -g 2>/dev/null)/ts-node/node_modules/@types"; do
    [ -d "$c/node" ] && TYPES_ROOT="$c" && break
  done
fi
[ -n "${TYPES_ROOT:-}" ] || { echo "@types/node não encontrado; defina TYPES_ROOT"; exit 2; }
if [ -z "${ZOD_ROOT:-}" ] && [ -f "$ROOT/node_modules/zod/package.json" ]; then ZOD_ROOT="$ROOT/node_modules/zod"; fi
[ -n "${ZOD_ROOT:-}" ] && [ -f "$ZOD_ROOT/package.json" ] || { echo "zod não encontrado; defina ZOD_ROOT"; exit 2; }

REAL=(
  lib/execution/effects.ts lib/execution/types.ts lib/execution/errors.ts
  lib/execution/context.ts lib/execution/executor.ts lib/execution/data.ts
  lib/execution/executors/registry.ts lib/execution/executors/manual-trigger.ts
  lib/execution/executors/set.ts
  server/execution/effects/effect-key.ts server/execution/effects/effect-decision.ts
  server/execution/effects/effect-runner.ts
  server/execution/effects/resolution.ts server/execution/effects/effect-view.ts
  server/execution/effects/test-support/mock-external-effect.ts
  server/execution/effects/test-support/mock-effect-executor.ts
)
rm -rf "$WORK/src" "$WORK/out"; mkdir -p "$WORK/src" "$WORK/out"
for f in "${REAL[@]}"; do mkdir -p "$WORK/src/$(dirname "$f")"; cp "$ROOT/$f" "$WORK/src/$f"; done
cp "$HERE/effect-repository.memory.ts" "$WORK/src/server/execution/effects/effect-repository.ts"
for f in "${REAL[@]}"; do
  [ "$(sha256sum < "$ROOT/$f")" = "$(sha256sum < "$WORK/src/$f")" ] || { echo "cópia divergente: $f"; exit 1; }
done
echo "módulos reais copiados e conferidos: ${#REAL[@]}"
mkdir -p "$WORK/node_modules" && ln -sfn "$ZOD_ROOT" "$WORK/node_modules/zod"
echo "zod: $(node -e "console.log(require('$ZOD_ROOT/package.json').version)")"
cat > "$WORK/tsconfig.json" <<JSON
{ "compilerOptions": {
    "target": "ES2022", "module": "ES2022", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true, "skipLibCheck": true,
    "isolatedModules": true, "esModuleInterop": true, "lib": ["ES2022", "DOM"],
    "types": ["node"], "typeRoots": ["$TYPES_ROOT"],
    "rootDir": "src", "outDir": "out", "paths": { "@/*": ["./src/*"] } },
  "include": ["src/**/*.ts"] }
JSON
(cd "$WORK" && tsc -p tsconfig.json)
echo "tsc --strict: 0 erros"
python3 - "$WORK/out" <<'EOPY'
import os, re, sys
out = sys.argv[1]
for root, _, files in os.walk(out):
    for fn in files:
        if not fn.endswith(".js"): continue
        path = os.path.join(root, fn); src = open(path).read()
        def fix(m):
            spec = m.group(2)
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

for arg in "$@"; do
  case "$arg" in
    --mutate) WORK="$WORK" "$HERE/mutate.sh" ;;
    --routes) TYPES_ROOT="$TYPES_ROOT" ZOD_ROOT="$ZOD_ROOT" WORK="$WORK" "$HERE/routes/run.sh" ;;
    --routes-mutate) TYPES_ROOT="$TYPES_ROOT" ZOD_ROOT="$ZOD_ROOT" WORK="$WORK" "$HERE/routes/run.sh" --mutate ;;
    --types)
      # O código que fala com o banco (Fase 10 + 10.5A) contra o modelo de
      # tipos do Drizzle: effect-repository.ts, e os workflows (queries e
      # mutations: arquivar/restaurar/apagar). Os módulos importados são os
      # REAIS; só drizzle-orm, @/lib/db, o schema e a sessão são modelo.
      T="$WORK/types"; rm -rf "$T"; mkdir -p "$T/src/server/execution/effects" "$T/src/server/workflows" "$T/src/lib/execution" "$T/src/lib/workflows" "$T/node_modules"
      cp -r "$HERE/types-model/lib" "$T/src/"
      cp "$ROOT/server/execution/effects/effect-repository.ts" "$ROOT/server/execution/effects/effect-decision.ts" \
         "$ROOT/server/execution/effects/resolution.ts" "$T/src/server/execution/effects/"
      cp "$ROOT/server/workflows/mutations.ts" "$ROOT/server/workflows/queries.ts" "$ROOT/server/workflows/errors.ts" "$T/src/server/workflows/"
      cp "$ROOT/lib/execution/effects.ts" "$T/src/lib/execution/"
      cp "$ROOT/lib/workflows/types.ts" "$T/src/lib/workflows/"
      cp "$ROOT/lib/db/errors.ts" "$T/src/lib/db/"
      ln -sfn "$ZOD_ROOT" "$T/node_modules/zod"
      cat > "$T/tsconfig.json" <<JSON
{ "compilerOptions": { "target": "ES2022", "module": "ES2022", "moduleResolution": "bundler", "strict": true,
    "noUncheckedIndexedAccess": true, "noEmit": true, "isolatedModules": true, "lib": ["ES2022"], "types": [],
    "skipLibCheck": true, "paths": { "@/*": ["./src/*"] } },
  "files": ["$HERE/types-model/drizzle-orm/index.d.ts", "src/server/execution/effects/effect-repository.ts",
            "src/server/workflows/mutations.ts", "src/server/workflows/queries.ts"] }
JSON
      (cd "$T" && tsc -p tsconfig.json) && echo "effect-repository.ts + workflows (queries, mutations) contra o modelo de tipos: 0 erros" ;;
  esac
done
