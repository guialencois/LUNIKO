#!/usr/bin/env bash
# Cada mutação reintroduz um bug plausível num CÓPIA do build; a spec TEM de
# falhar. "Morta" = a spec não passou: por asserção (FAIL), por travar, ou por
# abortar (ex.: o espelho do guard do banco recusou a transição).
S="${WORK:?rode via run.sh --mutate}"
patch_js() { # arquivo old new
  python3 - "$1" "$2" "$3" <<'EOPY'
import sys, re
p, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
pat = r"\s+".join(re.escape(tok) for tok in old.split())
m = re.search(pat, s)
if not m:
    print(f"TRECHO NÃO ENCONTRADO em {p}: {old!r}"); sys.exit(3)
open(p, "w").write(s[:m.start()] + new + s[m.end():])
EOPY
}
run_mut() { # nome arquivo old new [old2 new2]
  rm -rf "$S/mut" && cp -r "$S/out" "$S/mut"
  patch_js "$S/mut/$2" "$3" "$4" || { echo "ERRO    $1 (padrão não encontrado)"; return; }
  if [ -n "${5:-}" ]; then patch_js "$S/mut/$2" "$5" "$6" || { echo "ERRO    $1 (padrão 2)"; return; }; fi
  [ -s "$S/spec.mjs" ] || { echo "ERRO    spec.mjs ausente em $S — rode via run.sh --mutate"; exit 2; }
  sed 's#\./out/#./mut/#g' "$S/spec.mjs" > "$S/spec-mut.mjs"
  out=$(cd "$S" && timeout 60 node spec-mut.mjs 2>&1); rc=$?
  nfail=$(echo "$out" | grep -c '^FAIL ')
  if [ $rc -eq 0 ]; then echo "VIVA    $1  <-- a spec NÃO detectou"
  elif [ "$nfail" -gt 0 ]; then echo "MORTA   $1  (asserção: $nfail FAIL)"
  elif [ $rc -eq 124 ] || [ $rc -eq 13 ]; then echo "MORTA   $1  (a spec travou esperando)"
  else echo "MORTA   $1  (abortou: $(echo "$out" | grep -m1 -oE '^Error: .{0,70}'))"; fi
}
R=server/execution/effects/effect-repository.js
N=server/execution/effects/effect-runner.js
D=server/execution/effects/effect-decision.js
K=server/execution/effects/effect-key.js
X=server/execution/effects/test-support/mock-effect-executor.js
run_mut "unknown vira retry" $D 'case "unknown": return { kind: "report_unknown" };' 'case "unknown": return { kind: "begin" };'
run_mut "adotar in_flight como reserved" $R 'const nextStatus = from === "in_flight" ? "unknown" : "reserved";' 'const nextStatus = "reserved";'
run_mut "begin sem exigir reserved / began NULL" $R 'if (op.ownerEpoch !== input.epoch || op.status !== "reserved" || op.beganEpoch !== null) {' 'if (op.ownerEpoch !== input.epoch) {'
run_mut "fato cercado por POSSE em vez de autoria" $R 'const authored = op.executionId === input.executionId && op.beganEpoch === input.epoch;' 'const authored = op.executionId === input.executionId && op.ownerEpoch === input.epoch;'
run_mut "autoria sem a execução (#6)" $R 'const authored = op.executionId === input.executionId && op.beganEpoch === input.epoch;' 'const authored = op.beganEpoch === input.epoch;'
run_mut "fato não substitui resolução humana (#1)" $R 'const applies = authored && (fromPending || overridesResolution);' 'const applies = authored && fromPending;'
run_mut "trigger só a partir de running (#3)" $R 'e.status = "cancelled"; settleOnTerminal(executionId, "cancelled");' 'e.status = "cancelled";'
run_mut "trigger de término não converte in_flight" $R 'if (op.executionId !== executionId || op.status !== "in_flight") continue;' 'continue;'
run_mut "reserve sem checar posse da execução" $R 'if (!executionOwnedBy(input.executionId, input.epoch)) return { outcome: "fenced" }; // INSERT' 'if (false) return { outcome: "fenced" }; // INSERT'
run_mut "chamada que lança é gravada como failed" $N 'return { kind: "unknown", reason: `the call ended without a usable response (${kind})` };' 'return { kind: "failed", code: "X", message: "x" };'
run_mut "texto da exceção volta a ser gravado (#2)" $N 'return { kind: "unknown", reason: `the call ended without a usable response (${kind})` };' 'return { kind: "unknown", reason: `the call ended without a usable response (${err instanceof Error ? err.message : kind})` };'
run_mut "failed sem código aceito como definitivo (#9)" $N 'if (typeof o.code !== "string" || o.code.trim().length === 0) {' 'if (false) {' 'code: cleanText(o.code, MAX_CODE_LENGTH),' 'code: cleanText(String(o.code ?? "EXTERNAL_EFFECT_FAILED"), MAX_CODE_LENGTH),'
run_mut "sucesso sem referência aceito" $N 'value.length > 0 &&' 'value.length >= 0 &&'
run_mut "sem coalescência da mesma chave (#8)" $N 'const running = inProgress.get(idempotencyKey);' 'const running = undefined;'
run_mut "sem prazo por chamada (#10)" $N 'const first = await Promise.race([call, deadline]);' 'const first = await call;'
run_mut "resposta tardia descartada (#10)" $N 'if (late.kind !== "unknown") onLateAnswer(late);' 'void late;'
run_mut "decisão sem checar dono mais novo" $D 'if (op.ownerEpoch > myEpoch) return { kind: "fenced" };' 'if (false) return { kind: "fenced" };'
run_mut "payload mismatch ignorado" $D 'if (op.payloadFingerprint !== myFingerprint)' 'if (false)'
run_mut "época entra na chave" $K 'input.executionId, input.nodeId,' 'input.executionId, String(input.epoch), input.nodeId,'
run_mut "executor não valida todas as chaves antes" $X 'businessKeys.push(validateBusinessKey(item.json[field]));' 'businessKeys.push(String(item.json[field] ?? ""));'
# ---- Fase 10.5A ----------------------------------------------------------
Z=server/execution/effects/resolution.js
V=server/execution/effects/effect-view.js
run_mut "10.5A sent sem exigir referência" $Z 'if (ref === undefined) { ctx.addIssue({' 'if (false) { ctx.addIssue({'
run_mut "10.5A not_sent/rejected sem o que foi consultado" $Z 'if (detail.length < EVIDENCE_DETAIL_MIN * 2 && characters(detail) < EVIDENCE_DETAIL_MIN) {' 'if (false) {'
run_mut "10.5A not_sent aceita referência" $Z 'if (body.resolution === "confirmed_not_sent" && ref !== undefined) {' 'if (false) {'
run_mut "10.5A referência 'consertada' (aparada) aceita" $Z 'ref !== ref.trim() ||' ''
run_mut "10.5A comprimento em UTF-16, não em caracteres" $Z 'const characters = (v) => Array.from(v).length;' 'const characters = (v) => v.length;'
run_mut "10.5A justificativa sem mínimo" $Z 'justification: prose(JUSTIFICATION_MIN, JUSTIFICATION_MAX),' 'justification: prose(0, JUSTIFICATION_MAX),'
run_mut "10.5A fonte de evidência livre" $Z 'source: z.enum(EVIDENCE_SOURCES),' 'source: z.string(),'
run_mut "10.5A corpo aceita campos extras" $Z '}) .strict() .superRefine((body, ctx) => {' '}) .superRefine((body, ctx) => {'
run_mut "10.5A rejected vira succeeded" $Z 'return resolution === "confirmed_sent" ? "succeeded" : "failed";' 'return resolution === "confirmed_not_sent" ? "failed" : "succeeded";'
run_mut "10.5A view espalha a linha (vaza chave idempotente)" $V 'return { operationId: op.id,' 'return { ...op, operationId: op.id,'
run_mut "10.5A histórico copia o detail inteiro" $V 'const d = a.detail; for (const key of DETAIL_KEYS) {' 'const d = a.detail; Object.assign(detail, d); for (const key of []) {'
run_mut "10.5A evidence copiada inteira (vaza token)" $V 'detail.evidence = { source: typeof ev.source === "string" ? ev.source : null,' 'detail.evidence = { ...ev, source: typeof ev.source === "string" ? ev.source : null,'
run_mut "10.5A resolvableFrom sem resfriamento" $V '.getTime() + RESOLUTION_COOLING_PERIOD_SECONDS * 1000).toISOString()' '.getTime()).toISOString()'
run_mut "10.5A resolver com execução viva" $R 'if (!execution || !TERMINAL_EXECUTION_STATUSES.includes(execution.status)) {' 'if (!execution) {'
run_mut "10.5A resolver sem resfriamento" $R 'if (resolvableFrom.getTime() > memdb.clock().getTime())' 'if (false)'
run_mut "10.5A rejected grava a referência na operação" $R 'providerReference: input.resolution === "confirmed_sent" ? (input.providerReference ?? null) : null,' 'providerReference: input.providerReference ?? null,'
run_mut "10.5A fato do provedor não zera resolution" $R 'resolvedByUserId: null, resolution: null, });' 'resolvedByUserId: null, });'
run_mut "10.5A guard volta a aceitar pessoa sobre pessoa" $R '(before.resolvedByUserId !== null && after.resolvedByUserId === null)));' '(before.resolvedByUserId !== null)));'
run_mut "10.5A credenciais coladas aceitas" $Z ': hasCredential(v) ? CREDENTIAL_MESSAGE : null;' ': null;'
run_mut "10.5A texto varrido antes do limite (DoS)" $Z 'const n = v.length > max * 2 ? Number.POSITIVE_INFINITY : characters(v);' 'const n = hasCredential(v) && false ? 0 : characters(v);'
run_mut "10.5A header de autorização sem exigir o esquema" $Z '(?:basic|bearer|digest|negotiate|token|apikey)\b/i,' '/i,'
