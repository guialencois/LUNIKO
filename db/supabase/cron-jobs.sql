-- =====================================================================
-- Agendamento do consumidor da fila — Supabase Cron (pg_cron + pg_net)
--
-- NÃO FAZ PARTE DA CADEIA DE MIGRATIONS, DE PROPÓSITO.
-- Este arquivo é a configuração canônica do agendamento no Supabase.
-- Deve ser aplicado manualmente no SQL Editor do projeto Supabase.
--
-- SEGURANÇA:
-- - os segredos ficam no Vault;
-- - os helpers ficam em schema privado, sem acesso de anon/authenticated;
-- - as chamadas incluem o bypass da proteção da Vercel e o CRON_SECRET.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------
-- 1. Schema privado e segredos
--
-- NÃO cole URL, CRON_SECRET ou bypass diretamente em cron.job.
-- Guarde os três valores no Supabase Vault:
--
-- select vault.create_secret('https://SEU-APP.vercel.app', 'automation_app_url');
-- select vault.create_secret('SEU_CRON_SECRET_AQUI', 'automation_cron_secret');
-- select vault.create_secret('SEU_VERCEL_BYPASS_AQUI', 'automation_vercel_bypass');
--
-- CRON_SECRET deve ser o mesmo valor configurado na Vercel.
-- ---------------------------------------------------------------------

create schema if not exists automation_cron;

revoke all on schema automation_cron from public;
revoke all on schema automation_cron from anon;
revoke all on schema automation_cron from authenticated;
revoke all on schema automation_cron from service_role;

create or replace function automation_cron.scheduler_headers()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'Content-Type', 'application/json',
    'x-vercel-protection-bypass', (
      select decrypted_secret from vault.decrypted_secrets
      where name = 'automation_vercel_bypass'
    ),
    'Authorization', 'Bearer ' || (
      select decrypted_secret from vault.decrypted_secrets
      where name = 'automation_cron_secret'
    )
  );
$$;

create or replace function automation_cron.app_url()
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets
  where name = 'automation_app_url';
$$;

revoke all on function automation_cron.scheduler_headers() from public;
revoke all on function automation_cron.scheduler_headers() from anon;
revoke all on function automation_cron.scheduler_headers() from authenticated;
revoke all on function automation_cron.scheduler_headers() from service_role;

revoke all on function automation_cron.app_url() from public;
revoke all on function automation_cron.app_url() from anon;
revoke all on function automation_cron.app_url() from authenticated;
revoke all on function automation_cron.app_url() from service_role;

-- ---------------------------------------------------------------------
-- 2. Worker — consome a fila
-- ---------------------------------------------------------------------

select cron.schedule(
  'automation-worker',
  '30 seconds',
  $$
    select net.http_post(
      url     := automation_cron.app_url() || '/api/internal/worker',
      headers := automation_cron.scheduler_headers(),
      body    := '{}'::jsonb,
      timeout_milliseconds := 290000
    );
  $$
);

-- ---------------------------------------------------------------------
-- 3. Reaper — recupera execuções de worker com lease vencido
-- ---------------------------------------------------------------------

select cron.schedule(
  'automation-reaper',
  '30 seconds',
  $$
    select net.http_post(
      url     := automation_cron.app_url() || '/api/internal/reaper',
      headers := automation_cron.scheduler_headers(),
      body    := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $$
);

-- ---------------------------------------------------------------------
-- 4. Operação
-- ---------------------------------------------------------------------

-- Ver o que está agendado:
-- select jobid, jobname, schedule, active, command
-- from cron.job
-- where jobname like 'automation-%'
-- order by jobname;

-- Ver as últimas execuções do Cron:
-- select r.jobid, j.jobname, r.status, r.return_message,
--        r.start_time, r.end_time
-- from cron.job_run_details r
-- join cron.job j on j.jobid = r.jobid
-- where j.jobname like 'automation-%'
-- order by r.start_time desc
-- limit 20;

-- Ver respostas HTTP do pg_net:
-- select id, status_code, content, created
-- from net._http_response
-- order by created desc
-- limit 20;

-- Para atualizar os jobs existentes, remova-os primeiro:
-- select cron.unschedule('automation-worker');
-- select cron.unschedule('automation-reaper');

-- Depois execute novamente as duas chamadas cron.schedule acima.

-- ---------------------------------------------------------------------
-- 5. Limitações
--
-- - pg_cron dispara a requisição; o estado real das execuções fica em
--   public.executions.
-- - O reaper só recupera executions com runner = 'worker' e lease vencido.
--   Execuções síncronas antigas (runner = 'request') não entram no reaper.
-- ---------------------------------------------------------------------
