#!/usr/bin/env bash
# =====================================================================
# Fase 10.5B-1 — prova executável do CONTRATO do adaptador Mercado Pago,
# SEM node_modules do projeto e SEM rede: nenhuma chamada HTTP, nenhuma
# credencial, nenhum executor registrado.
#
#   1. copia os módulos REAIS (conferidos por sha256) para uma árvore
#      temporária: lib/execution/effects.ts e
#      server/execution/effects/providers/mercadopago/{contract,capabilities}.ts;
#   2. compila com tsc --strict (+ noUncheckedIndexedAccess);
#   3. roda spec.mjs contra o contract.js compilado;
#   4. roda isolation.mjs: nenhum import/require de capabilities.ts fora do
#      adaptador em lib/ server/ app/ components/.
#
#   ./scripts/effects-spec/mercadopago/run.sh            # build + spec + isolamento
#   ./scripts/effects-spec/mercadopago/run.sh --mutate   # + mutações do contrato e do isolamento
#
# Requer node >= 20 e tsc no PATH. @types/node: node_modules do projeto, ou
# TYPES_ROOT apontando para uma pasta que contenha node/.
# =====================================================================
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WORK="${WORK:-$(mktemp -d)}"
if [ -z "${TYPES_ROOT:-}" ]; then
  for c in "$ROOT/node_modules/@types" "$(npm root -g 2>/dev/null)/ts-node/node_modules/@types"; do
    [ -d "$c/node" ] && TYPES_ROOT="$c" && break
  done
fi
[ -n "${TYPES_ROOT:-}" ] || { echo "@types/node não encontrado; defina TYPES_ROOT"; exit 2; }

REAL=(
  lib/execution/effects.ts
  server/execution/effects/providers/mercadopago/contract.ts
  server/execution/effects/providers/mercadopago/capabilities.ts
)
rm -rf "$WORK/src" "$WORK/out"; mkdir -p "$WORK/src" "$WORK/out"
for f in "${REAL[@]}"; do mkdir -p "$WORK/src/$(dirname "$f")"; cp "$ROOT/$f" "$WORK/src/$f"; done
for f in "${REAL[@]}"; do
  [ "$(sha256sum < "$ROOT/$f")" = "$(sha256sum < "$WORK/src/$f")" ] || { echo "cópia divergente: $f"; exit 1; }
done
echo "módulos reais copiados e conferidos: ${#REAL[@]}"
cat > "$WORK/tsconfig.json" <<JSON
{ "compilerOptions": {
    "target": "ES2022", "module": "ES2022", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true, "skipLibCheck": true,
    "isolatedModules": true, "lib": ["ES2022"], "types": ["node"], "typeRoots": ["$TYPES_ROOT"],
    "rootDir": "src", "outDir": "out", "paths": { "@/*": ["./src/*"] } },
  "include": ["src/**/*.ts"] }
JSON
(cd "$WORK" && tsc -p tsconfig.json)
echo "tsc --strict: 0 erros"
# O contrato só importa TIPOS de @/lib/execution/effects (apagados na
# compilação). Se um import de runtime aparecer, isto para: o contrato deixou
# de ser puro.
if grep -nE '^\s*import\s|require\(' "$WORK/out/server/execution/effects/providers/mercadopago/contract.js" "$WORK/out/server/execution/effects/providers/mercadopago/capabilities.js"; then
  echo "contract.js/capabilities.js têm import de runtime — o contrato deixou de ser puro"; exit 1
fi
echo '{"type":"module"}' > "$WORK/out/package.json"
cp "$HERE/spec.mjs" "$WORK/spec.mjs"
(cd "$WORK" && node spec.mjs | tail -1)
node "$HERE/isolation.mjs" $( [[ " $* " == *" --mutate "* ]] && echo --mutate )

for arg in "$@"; do
  case "$arg" in
    --mutate) WORK="$WORK" node "$HERE/mutate.mjs" ;;
  esac
done
