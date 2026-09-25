-- Débito de infraestrutura (achado na revisão da Fase 10.5A): RLS recursiva.
-- Nova migration — nenhuma anterior é reescrita.
--
-- O PROBLEMA
-- Toda policy de leitura deste projeto pergunta a mesma coisa — "quem está
-- lendo é membro deste workspace?" — lendo `workspace_members`. Como
-- `workspace_members` também tem RLS, e a policy DELA faz essa pergunta
-- sobre ela mesma (0000), qualquer leitura por um papel sujeito a RLS morre
-- com:
--
--   ERROR: infinite recursion detected in policy for relation "workspace_members"
--
-- Isso FECHA em vez de vazar (o erro nega a leitura), e não afeta o produto
-- hoje: a aplicação conecta pela própria DATABASE_URL, que não passa por
-- RLS, e a autorização real é `requireWorkspaceMembership` no código. Mas
-- deixa a barreira de isolamento inútil para qualquer leitura vinda do
-- cliente Supabase (PostgREST, anon/authenticated) — exatamente a barreira
-- que precisa existir antes de o produto ficar multi-tenant de verdade.
--
-- A CORREÇÃO (a usual no Supabase)
-- Uma função SECURITY DEFINER responde à pergunta. Ela roda como dona das
-- tabelas, fora do RLS, então não reentra em policy nenhuma. As policies
-- passam a chamá-la. O que cada uma PERMITE não muda: leitura para membro
-- do workspace, e nenhuma policy de escrita — escrita continua sendo só
-- pela conexão da aplicação, autorizada em código.
--
-- A função é segura de expor: ela só responde sobre o usuário que está
-- chamando (`auth.uid()`), nunca sobre terceiros.

CREATE OR REPLACE FUNCTION "public"."is_workspace_member"("ws" uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
-- search_path fixo: uma função SECURITY DEFINER sem isto pode ser
-- sequestrada por um schema temporário do chamador.
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "workspace_members" wm
    WHERE wm."workspace_id" = "ws" AND wm."user_id" = auth.uid()
  );
$$;

COMMENT ON FUNCTION "public"."is_workspace_member"(uuid) IS
  'RLS: o usuário autenticado é membro deste workspace? SECURITY DEFINER para não reentrar na policy de workspace_members (migration 0008).';

-- ---------------------------------------------------------------------
-- As mesmas policies de sempre, agora sem recursão. DROP + CREATE porque
-- PostgreSQL não tem CREATE OR REPLACE POLICY; o nome de cada uma é
-- mantido, para o diff com as migrations anteriores ser óbvio.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "workspaces_select_member" ON "workspaces";
CREATE POLICY "workspaces_select_member" ON "workspaces"
  FOR SELECT USING ("public"."is_workspace_member"("id"));

-- Esta é a que causava a recursão: a policy de workspace_members lia
-- workspace_members.
DROP POLICY IF EXISTS "workspace_members_select_same_workspace" ON "workspace_members";
CREATE POLICY "workspace_members_select_same_workspace" ON "workspace_members"
  FOR SELECT USING ("public"."is_workspace_member"("workspace_id"));

DROP POLICY IF EXISTS "workflows_select_member" ON "workflows";
CREATE POLICY "workflows_select_member" ON "workflows"
  FOR SELECT USING ("public"."is_workspace_member"("workspace_id"));

DROP POLICY IF EXISTS "executions_select_member" ON "executions";
CREATE POLICY "executions_select_member" ON "executions"
  FOR SELECT USING ("public"."is_workspace_member"("workspace_id"));

-- execution_nodes e effect_attempts não têm workspace_id próprio: continuam
-- autorizando pela linha dona, que já é restrita acima.
DROP POLICY IF EXISTS "execution_nodes_select_member" ON "execution_nodes";
CREATE POLICY "execution_nodes_select_member" ON "execution_nodes"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "executions" e
      WHERE e."id" = "execution_nodes"."execution_id"
        AND "public"."is_workspace_member"(e."workspace_id")
    )
  );

DROP POLICY IF EXISTS "effect_operations_select_member" ON "effect_operations";
CREATE POLICY "effect_operations_select_member" ON "effect_operations"
  FOR SELECT USING ("public"."is_workspace_member"("workspace_id"));

DROP POLICY IF EXISTS "effect_attempts_select_member" ON "effect_attempts";
CREATE POLICY "effect_attempts_select_member" ON "effect_attempts"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "effect_operations" eo
      WHERE eo."id" = "effect_attempts"."operation_id"
        AND "public"."is_workspace_member"(eo."workspace_id")
    )
  );
