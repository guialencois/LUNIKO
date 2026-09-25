#!/usr/bin/env bash
# =====================================================================
# Concorrência REAL entre sessões — o que f4f-lifecycle-harness.sql não
# consegue exercer, porque um arquivo psql é uma sessão só.
#
# O harness prova os predicados atômicos (UPDATE condicional sob row
# lock) exercitando-os em sequência. Aqui duas sessões psql de verdade
# se sobrepõem no tempo, que é o único jeito de exercitar o mecanismo do
# claimNextQueuedExecution: SELECT ... FOR UPDATE SKIP LOCKED — e, desde a
# Fase 10 (cenário 6), a disputa de duas sessões pela MESMA operação
# externa: o UNIQUE no reserve, o FOR UPDATE no begin, e o FOR SHARE que
# faz o reaper esperar o begin do dono. Fase 10.5A (cenários 7–9):
# arquivar x executar, duas pessoas resolvendo o mesmo unknown, e
# resolução x resposta tardia do provedor.
#
# Requer o harness já carregado no banco (as funções h.*).
#
#   DB=ap4g ./scripts/concurrency-check.sh
# =====================================================================
set -uo pipefail
DB="${DB:-ap4g}"
PSQL=(psql -qtA -d "$DB")
export PGOPTIONS='-c client_min_messages=warning'
pass=0; fail=0
check() { # label got want
  if [ "$2" = "$3" ]; then echo "PASS  $(printf '%-54s' "$1")  ($2)"; pass=$((pass+1));
  else echo "FAIL  $(printf '%-54s' "$1")  esperado: $3  obtido: $2"; fail=$((fail+1)); fi
}

"${PSQL[@]}" -c "SELECT h.seed();" >/dev/null

# --- 1. dois workers, UMA linha na fila ------------------------------
# Sessão 1 claima dentro de uma transação e segura o lock por 1s.
# Sessão 2 corre em paralelo: SKIP LOCKED faz ela pular a linha travada
# em vez de bloquear, então ela volta de mãos vazias.
E=$("${PSQL[@]}" -c "SELECT h.create_queued();")
"${PSQL[@]}" -c "BEGIN; SELECT id FROM h.claim_next(); SELECT pg_sleep(1); COMMIT;" > /tmp/s1.out 2>&1 &
S1=$!
sleep 0.2
"${PSQL[@]}" -c "SELECT count(*) FROM h.claim_next();" > /tmp/s2.out 2>&1
wait $S1
GOT2=$(tail -1 /tmp/s2.out)
check "duas sessões, uma linha: a segunda não pega nada" "$GOT2" "0"
check "a linha ficou com exatamente um claim" \
  "$("${PSQL[@]}" -c "SELECT status||'/'||claim_attempts FROM executions WHERE id='$E';")" "running/1"

# --- 2. dois workers, DUAS linhas na fila ----------------------------
# SKIP LOCKED deve deixar cada sessão pegar uma linha diferente, sem
# bloquear uma na outra e sem as duas pegarem a mesma.
"${PSQL[@]}" -c "SELECT h.seed();" >/dev/null
"${PSQL[@]}" -c "SELECT h.create_queued(); SELECT h.create_queued();" >/dev/null
"${PSQL[@]}" -c "BEGIN; SELECT id FROM h.claim_next(); SELECT pg_sleep(1); COMMIT;" > /tmp/s3.out 2>&1 &
S3=$!
sleep 0.2
"${PSQL[@]}" -c "SELECT id FROM h.claim_next();" > /tmp/s4.out 2>&1
wait $S3
A=$(grep -oE '[0-9a-f-]{36}' /tmp/s3.out | head -1)
B=$(grep -oE '[0-9a-f-]{36}' /tmp/s4.out | head -1)
check "duas sessões, duas linhas: pegam linhas diferentes" \
  "$([ -n "$A" ] && [ -n "$B" ] && [ "$A" != "$B" ] && echo sim || echo nao)" "sim"
check "as duas linhas ficaram claimadas, uma vez cada" \
  "$("${PSQL[@]}" -c "SELECT count(*)||'/'||max(claim_attempts) FROM executions WHERE status='running';")" "2/1"

# --- 3. reaper em paralelo com um finish -----------------------------
# A sessão 1 segura a linha travada enquanto finaliza; o reaper tenta
# recuperar ao mesmo tempo e tem de esperar o lock, encontrando a linha
# já terminal — nunca recuperando algo que acabou de concluir.
"${PSQL[@]}" -c "SELECT h.seed();" >/dev/null
E=$("${PSQL[@]}" -c "SELECT h.create_queued();")
EP=$("${PSQL[@]}" -c "SELECT h.claim('$E');")
"${PSQL[@]}" -c "SELECT h.expire_lease('$E');" >/dev/null
"${PSQL[@]}" -c "BEGIN; SELECT h.finish('$E','success',$EP); SELECT pg_sleep(1); COMMIT;" >/dev/null 2>&1 &
S5=$!
sleep 0.2
"${PSQL[@]}" -c "SELECT h.recover_one('$E', 3);" > /tmp/s6.out 2>&1
wait $S5
check "reaper em paralelo com finish: não recupera" "$(tail -1 /tmp/s6.out)" "skipped"
check "estado final continua sendo o do worker" \
  "$("${PSQL[@]}" -c "SELECT status FROM executions WHERE id='$E';")" "success"

# --- 4. dois WORKERS drenando a mesma fila em paralelo ----------------
# O caso do consumidor real: duas invocações agendadas que se sobrepõem.
# Cada sessão drena em laço até a fila secar. Nenhum job pode ser
# reclamado duas vezes, e nenhum pode sobrar.
"${PSQL[@]}" -c "SELECT h.seed();" >/dev/null
for i in 1 2 3 4 5 6; do "${PSQL[@]}" -c "SELECT h.create_queued();" >/dev/null; done

drain() { # $1 = arquivo de saída
  "${PSQL[@]}" -c "
    DO \$\$
    DECLARE r record;
    BEGIN
      LOOP
        SELECT * INTO r FROM h.claim_next();
        EXIT WHEN r.id IS NULL;
        PERFORM pg_sleep(0.05);
        PERFORM h.insert_nodes(r.id, r.epoch, 'no');
        PERFORM h.finish(r.id, 'success', r.epoch);
        RAISE WARNING 'claimed %', r.id;  -- WARNING, não NOTICE: o script roda com client_min_messages=warning
      END LOOP;
    END \$\$;" > "$1" 2>&1
}
drain /tmp/w1.out & W1=$!
drain /tmp/w2.out & W2=$!
wait $W1 $W2

A=$(grep -c "claimed" /tmp/w1.out)
B=$(grep -c "claimed" /tmp/w2.out)
check "dois workers em paralelo drenam os 6 jobs" "$((A + B))" "6"
check "nenhum job foi reclamado por ambos" \
  "$(cat /tmp/w1.out /tmp/w2.out | grep -oE 'claimed [0-9a-f-]{36}' | sort | uniq -d | wc -l)" "0"
check "todos terminaram em success, com um claim cada" \
  "$("${PSQL[@]}" -c "SELECT count(*)||'/'||max(claim_attempts) FROM executions WHERE status='success';")" "6/1"
check "cada execução tem exatamente uma linha de nó" \
  "$("${PSQL[@]}" -c "SELECT count(*) FROM execution_nodes;")" "6"
echo "  (worker 1 pegou $A, worker 2 pegou $B)"

# --- 5. heartbeat vs reaper, em sessões concorrentes de verdade -------
# O caso J: um worker VIVO renovando o lease enquanto um reaper varre em
# paralelo. O reaper não pode recuperar uma execução cujo dono continua
# se anunciando — e no instante em que o worker para de renovar, tem de
# recuperar.
"${PSQL[@]}" -c "SELECT h.seed();" >/dev/null
E=$("${PSQL[@]}" -c "SELECT h.create_queued();")
# lease curto (1s) para o teste não demorar; o worker renova a cada 300ms
EP=$("${PSQL[@]}" -c "SELECT h.claim('$E', 1000);")

# "worker vivo": renova por ~3s
( for i in $(seq 1 10); do
    "${PSQL[@]}" -c "SELECT h.renew('$E', $EP, 1000);" >/dev/null
    sleep 0.3
  done ) & WORKER=$!

# "reaper": varre em paralelo durante o mesmo período
( for i in $(seq 1 10); do
    "${PSQL[@]}" -c "SELECT count(*) FROM h.sweep(3);" >> /tmp/sweeps.out 2>&1
    sleep 0.3
  done ) & REAPER=$!
rm -f /tmp/sweeps.out; wait $WORKER $REAPER

check "worker vivo não é recuperado pelo reaper concorrente" \
  "$("${PSQL[@]}" -c "SELECT status||'/'||claim_attempts FROM executions WHERE id='$E';")" "running/1"

# agora o worker para de renovar: o lease vence e a execução vira recuperável
sleep 1.2
"${PSQL[@]}" -c "SELECT count(*) FROM h.sweep(3);" >/dev/null
check "worker que parou de renovar é recuperado" \
  "$("${PSQL[@]}" -c "SELECT status FROM executions WHERE id='$E';")" "queued"
check "e a recuperação não gastou tentativa" \
  "$("${PSQL[@]}" -c "SELECT claim_attempts FROM executions WHERE id='$E';")" "1"

# --- 6. (Fase 10, teste C) duas sessões disputando a MESMA operação externa
# O provedor é falso (h.fake_provider_ledger): nada sai daqui. A "chamada"
# roda numa invocação psql separada, DEPOIS do commit do begin — como no
# runner, nunca dentro de uma transação — e só quem cruzou o ponto sem
# volta a faz.
"${PSQL[@]}" -c "SELECT h.seed(); TRUNCATE h.fake_provider_ledger RESTART IDENTITY;" >/dev/null
E=$("${PSQL[@]}" -c "SELECT h.create_queued();")
EP=$("${PSQL[@]}" -c "SELECT h.claim('$E');")
K=$("${PSQL[@]}" -c "SELECT h.eff_key('$E','send','lead-42','mock.send_message');")

# 6a. reserve x reserve: a segunda sessão espera o commit da primeira no
# índice UNIQUE e então encontra a linha — não cria outra.
"${PSQL[@]}" -c "BEGIN; SELECT h.eff_reserve('$E','send','lead-42','mock.send_message','fp',$EP); SELECT pg_sleep(1); COMMIT;" > /tmp/e1.out 2>&1 &
S1=$!; sleep 0.2
T0=$(date +%s%N)
"${PSQL[@]}" -c "SELECT h.eff_reserve('$E','send','lead-42','mock.send_message','fp',$EP);" > /tmp/e2.out 2>&1
T1=$(date +%s%N)
wait $S1
WAITED=$(( (T1 - T0) / 1000000 ))
check "C  reserve concorrente: uma reserva, outra encontra" \
  "$(grep -E '^(reserved|exists)$' /tmp/e1.out)/$(tail -1 /tmp/e2.out)" "reserved/exists"
check "C  ...a segunda esperou o commit da primeira" \
  "$([ "$WAITED" -ge 600 ] && echo esperou || echo "nao-esperou(${WAITED}ms)")" "esperou"
check "C  uma operação, um evento 'reserved'" \
  "$("${PSQL[@]}" -c "SELECT count(DISTINCT o.id)||'/'||count(a.id) FROM effect_operations o JOIN effect_attempts a ON a.operation_id=o.id AND a.event='reserved' WHERE o.idempotency_key='$K';")" "1/1"

# 6b. begin x begin na mesma operação: FOR UPDATE serializa; só uma
# sessão cruza o ponto sem volta, e só ela chama o provedor.
OP=$("${PSQL[@]}" -c "SELECT id FROM effect_operations WHERE idempotency_key='$K';")
race_begin() { # $1 = arquivo; $2 = segura o lock por N segundos
  local r
  r=$("${PSQL[@]}" -c "BEGIN; SELECT h.eff_begin('$OP','$E',$EP); SELECT pg_sleep($2); COMMIT;" 2>&1 | grep -E '^(done|stale|fenced)$')
  echo "$r" > "$1"
  if [ "$r" = "done" ]; then   # a chamada, depois do commit e fora de transação
    "${PSQL[@]}" -c "SELECT h.provider_accept('$K');" >/dev/null
  fi
}
race_begin /tmp/b1.out 1 & B1=$!; sleep 0.2
race_begin /tmp/b2.out 0 & B2=$!
wait $B1 $B2
check "C  begin concorrente: um 'done', um 'stale'" "$(sort /tmp/b1.out /tmp/b2.out | tr '\n' ' ')" "done stale "
check "C  o provedor recebeu exatamente 1 requisição" \
  "$("${PSQL[@]}" -c "SELECT count(*) FROM h.fake_provider_ledger WHERE idempotency_key='$K';")" "1"
check "C  um único 'began' no histórico" \
  "$("${PSQL[@]}" -c "SELECT count(*) FROM effect_attempts WHERE operation_id='$OP' AND event='began';")" "1"

# 6c. begin (dono atual) x reclaim do reaper: FOR SHARE na execução faz o
# reaper ESPERAR o begin terminar. O begin nunca acontece "depois" de a
# posse ter mudado: ou ele commita como dono legítimo e a próxima época
# encontra in_flight (-> unknown, sem reenvio), ou o reclaim vem antes e
# o begin é fenced.
"${PSQL[@]}" -c "SELECT h.seed(); TRUNCATE h.fake_provider_ledger RESTART IDENTITY;" >/dev/null
E=$("${PSQL[@]}" -c "SELECT h.create_queued();")
EP=$("${PSQL[@]}" -c "SELECT h.claim('$E');")
K=$("${PSQL[@]}" -c "SELECT h.eff_key('$E','send','lead-42','mock.send_message');")
"${PSQL[@]}" -c "SELECT h.eff_reserve('$E','send','lead-42','mock.send_message','fp',$EP);" >/dev/null
OP=$("${PSQL[@]}" -c "SELECT id FROM effect_operations WHERE idempotency_key='$K';")
"${PSQL[@]}" -c "SELECT h.expire_lease('$E');" >/dev/null     # o dono está lento; o lease venceu
( r=$("${PSQL[@]}" -c "BEGIN; SELECT h.eff_begin('$OP','$E',$EP); SELECT pg_sleep(1); COMMIT;" 2>&1 | grep -E '^(done|stale|fenced)$')
  echo "$r" > /tmp/c1.out
  [ "$r" = "done" ] && "${PSQL[@]}" -c "SELECT h.provider_accept('$K');" >/dev/null ) & C1=$!
sleep 0.2
T0=$(date +%s%N)
"${PSQL[@]}" -c "SELECT h.recover_one('$E', 3);" > /tmp/c2.out 2>&1
T1=$(date +%s%N)
wait $C1
WAITED=$(( (T1 - T0) / 1000000 ))
check "   begin do dono legítimo commita" "$(cat /tmp/c1.out)" "done"
check "   reaper esperou o begin (FOR SHARE) e então recuperou" \
  "$(tail -1 /tmp/c2.out)/$([ "$WAITED" -ge 600 ] && echo esperou || echo "nao-esperou(${WAITED}ms)")" "reclaimed/esperou"
EP2=$("${PSQL[@]}" -c "SELECT h.claim('$E');")
check "   nova época encontra in_flight e NÃO reenvia" \
  "$("${PSQL[@]}" -c "SELECT h.eff_attempt('$E','send','lead-42','mock.send_message','fp',$EP2,'success');")/$("${PSQL[@]}" -c "SELECT count(*) FROM h.fake_provider_ledger WHERE idempotency_key='$K';")" "unknown/1"
check "   a época antiga agora é fenced para qualquer decisão" \
  "$("${PSQL[@]}" -c "SELECT h.eff_reserve('$E','send','lead-43','mock.send_message','fp',$EP);")" "fenced"

# --- 7. (Fase 10.5A) arquivar x executar, nas duas ordens ----------------
# O lock da linha do workflow serializa as duas escritas: arquivar trava
# FOR UPDATE; inserir execução lê o workflow FOR SHARE (trigger da 0007).
# Nunca as duas: ou a execução nasce e o arquivamento a encontra, ou o
# arquivamento vem antes e a inserção é recusada (WK001).
"${PSQL[@]}" -c "SELECT h.seed();" >/dev/null
WF=$("${PSQL[@]}" -c "SELECT wf FROM h.ctx;")

# 7a. arquivar primeiro, segurando a transação; a execução chega no meio
"${PSQL[@]}" -c "BEGIN; SELECT h.wf_archive('$WF'); SELECT pg_sleep(1); COMMIT;" > /tmp/a1.out 2>&1 &
S1=$!; sleep 0.2
T0=$(date +%s%N)
"${PSQL[@]}" -c "SELECT h.try_enqueue();" > /tmp/a2.out 2>&1
T1=$(date +%s%N)
wait $S1
WAITED=$(( (T1 - T0) / 1000000 ))
check "7a arquivar x executar: arquiva, e a execução é recusada" \
  "$(grep -E '^(archived|already_archived|WORKFLOW_HAS_ACTIVE_EXECUTIONS)$' /tmp/a1.out)/$(tail -1 /tmp/a2.out)" "archived/WK001"
check "7a ...a inserção esperou o commit do arquivamento" \
  "$([ "$WAITED" -ge 600 ] && echo esperou || echo "nao-esperou(${WAITED}ms)")" "esperou"
check "7a ...nenhuma execução nasceu para o arquivado" \
  "$("${PSQL[@]}" -c "SELECT count(*) FROM executions WHERE workflow_id='$WF';")" "0"

# 7b. a execução primeiro, segurando a transação; o arquivamento chega no meio
"${PSQL[@]}" -c "SELECT h.wf_restore('$WF');" >/dev/null
"${PSQL[@]}" -c "BEGIN; SELECT h.try_enqueue(); SELECT pg_sleep(1); COMMIT;" > /tmp/a3.out 2>&1 &
S1=$!; sleep 0.2
T0=$(date +%s%N)
"${PSQL[@]}" -c "SELECT h.wf_archive('$WF');" > /tmp/a4.out 2>&1
T1=$(date +%s%N)
wait $S1
WAITED=$(( (T1 - T0) / 1000000 ))
check "7b executar x arquivar: executa, e o arquivamento é recusado" \
  "$(grep -E '^(enqueued|WK001)$' /tmp/a3.out)/$(tail -1 /tmp/a4.out)" "enqueued/WORKFLOW_HAS_ACTIVE_EXECUTIONS"
check "7b ...o arquivamento esperou o commit da execução" \
  "$([ "$WAITED" -ge 600 ] && echo esperou || echo "nao-esperou(${WAITED}ms)")" "esperou"
check "7b ...workflow segue ativo, com a execução na fila" \
  "$("${PSQL[@]}" -c "SELECT (w.archived_at IS NULL)::text||'/'||(SELECT string_agg(status, ',') FROM executions WHERE workflow_id=w.id) FROM workflows w WHERE w.id='$WF';")" "true/queued"

# 7c. o backstop (WK002) sob corrida: escrita direta, sem a checagem do
# repositório, contra uma execução ainda não commitada
"${PSQL[@]}" -c "SELECT h.seed();" >/dev/null
WF=$("${PSQL[@]}" -c "SELECT wf FROM h.ctx;")
"${PSQL[@]}" -c "BEGIN; SELECT h.try_enqueue(); SELECT pg_sleep(1); COMMIT;" > /tmp/a5.out 2>&1 &
S1=$!; sleep 0.2
"${PSQL[@]}" -c "DO \$\$ BEGIN
    UPDATE workflows SET archived_at = now(), archived_by = (SELECT usr FROM h.ctx) WHERE id = '$WF';
    RAISE WARNING 'resultado=archived';
  EXCEPTION WHEN SQLSTATE 'WK002' THEN RAISE WARNING 'resultado=WK002';
  END \$\$;" > /tmp/a6.out 2>&1
wait $S1
check "7c UPDATE direto x execução: o trigger (WK002) recusa" \
  "$(grep -oE 'resultado=[A-Za-z0-9]+' /tmp/a6.out | cut -d= -f2)" "WK002"

# --- 8. (Fase 10.5A) duas pessoas resolvendo o mesmo unknown -------------
# FOR UPDATE na operação: a segunda espera, relê e encontra o estado já
# decidido. Ninguém sobrescreve ninguém; um único fato 'resolved'.
"${PSQL[@]}" -c "SELECT h.seed(); TRUNCATE h.fake_provider_ledger RESTART IDENTITY;" >/dev/null
ADMIN=$("${PSQL[@]}" -c "INSERT INTO workspace_members (workspace_id, user_id, role) SELECT ws, gen_random_uuid(), 'admin' FROM h.ctx RETURNING user_id;" | head -1)
OP=$("${PSQL[@]}" -c "SELECT h.unknown_op('lead-c8');")
"${PSQL[@]}" -c "BEGIN; SELECT h.eff_resolve('$OP', 'confirmed_sent', 'prov-A', 'provider_dashboard', NULL, 'a pessoa A viu no painel'); SELECT pg_sleep(1); COMMIT;" > /tmp/r1.out 2>&1 &
S1=$!; sleep 0.2
T0=$(date +%s%N)
"${PSQL[@]}" -c "SELECT h.eff_resolve('$OP', 'confirmed_not_sent', NULL, 'provider_dashboard', 'nada no painel', 'a pessoa B não achou nada', 0, '$ADMIN');" > /tmp/r2.out 2>&1
T1=$(date +%s%N)
wait $S1
WAITED=$(( (T1 - T0) / 1000000 ))
check "8  duas pessoas: uma resolve, a outra encontra decidido" \
  "$(grep -E '^(resolved|too_early|forbidden|not_found|not_unknown:.*|execution_active:.*)$' /tmp/r1.out)/$(tail -1 /tmp/r2.out)" "resolved/not_unknown:succeeded"
check "8  ...a segunda esperou o commit da primeira" \
  "$([ "$WAITED" -ge 600 ] && echo esperou || echo "nao-esperou(${WAITED}ms)")" "esperou"
check "8  ...vale a primeira, com UM fato resolved" \
  "$("${PSQL[@]}" -c "SELECT o.status||'/'||o.provider_reference||'/'||o.resolution||'/'||(SELECT count(*) FROM effect_attempts a WHERE a.operation_id=o.id AND a.event='resolved') FROM effect_operations o WHERE o.id='$OP';")" "succeeded/prov-A/confirmed_sent/1"

# --- 9. (Fase 10.5A) resolução x resposta tardia do provedor -------------
# Nas duas ordens, o final é o mesmo: vale o fato do provedor. A chamada
# estourou o prazo (unknown), a execução terminou, e a resposta chega
# depois — gravada por AUTORIA (a época que fez a chamada).
late_setup() { # imprime "execução época operação"
  "${PSQL[@]}" -c "SELECT h.seed(); TRUNCATE h.fake_provider_ledger RESTART IDENTITY;" >/dev/null
  local e ep op
  e=$("${PSQL[@]}" -c "SELECT h.create_queued();")
  ep=$("${PSQL[@]}" -c "SELECT h.claim('$e');")
  "${PSQL[@]}" -c "SELECT h.eff_reserve('$e','send','lead-c9','mock.send_message','fp',$ep);" >/dev/null
  op=$("${PSQL[@]}" -c "SELECT id FROM effect_operations WHERE execution_id='$e';")
  "${PSQL[@]}" -c "SELECT h.eff_begin('$op','$e',$ep);" >/dev/null
  "${PSQL[@]}" -c "SELECT h.eff_record('$op','$e',$ep,'unknown',NULL,NULL,'deadline');" >/dev/null   # os 20 s
  "${PSQL[@]}" -c "SELECT h.finish('$e','error',$ep);" >/dev/null
  echo "$e $ep $op"
}
final_state() { # $1 = operação
  "${PSQL[@]}" -c "SELECT status||'/'||coalesce(provider_reference,'NULL')||'/'||coalesce(resolution,'NULL')||'/'||(resolved_by_user_id IS NULL)::text FROM effect_operations WHERE id='$1';"
}

# 9a. a pessoa decide "não enviado" e segura a transação; a resposta chega no meio
read -r E EP OP <<< "$(late_setup)"
"${PSQL[@]}" -c "BEGIN; SELECT h.eff_resolve('$OP', 'confirmed_not_sent', NULL, 'provider_dashboard', 'nada no painel', 'não achei no painel do provedor'); SELECT pg_sleep(1); COMMIT;" > /tmp/l1.out 2>&1 &
S1=$!; sleep 0.2
"${PSQL[@]}" -c "SELECT h.eff_record('$OP','$E',$EP,'succeeded','prov-tardio');" > /tmp/l2.out 2>&1
wait $S1
check "9a resolução, depois o fato: os dois entram, o fato prevalece" \
  "$(grep -E '^(resolved|not_unknown:.*)$' /tmp/l1.out)/$(tail -1 /tmp/l2.out)/$(final_state "$OP")" "resolved/t/succeeded/prov-tardio/NULL/true"
check "9a ...histórico: a decisão e o fato, nessa ordem" \
  "$("${PSQL[@]}" -c "SELECT h.eff_events('$OP');")" "reserved@1 began@1 unknown@1 resolved@user succeeded@1"

# 9b. a resposta chega primeiro e segura a transação; a pessoa decide no meio
read -r E EP OP <<< "$(late_setup)"
"${PSQL[@]}" -c "BEGIN; SELECT h.eff_record('$OP','$E',$EP,'succeeded','prov-tardio'); SELECT pg_sleep(1); COMMIT;" > /tmp/l3.out 2>&1 &
S1=$!; sleep 0.2
"${PSQL[@]}" -c "SELECT h.eff_resolve('$OP', 'confirmed_not_sent', NULL, 'provider_dashboard', 'nada no painel', 'não achei no painel do provedor');" > /tmp/l4.out 2>&1
wait $S1
check "9b fato, depois a resolução: a decisão é recusada" \
  "$(grep -E '^(t|f)$' /tmp/l3.out)/$(tail -1 /tmp/l4.out)/$(final_state "$OP")" "t/not_unknown:succeeded/succeeded/prov-tardio/NULL/true"
check "9b ...e não deixa fato 'resolved' no histórico" \
  "$("${PSQL[@]}" -c "SELECT h.eff_events('$OP');")" "reserved@1 began@1 unknown@1 succeeded@1"

echo
echo "$pass PASS, $fail FAIL"
[ "$fail" -eq 0 ]
