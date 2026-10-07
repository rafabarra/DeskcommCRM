-- 0583 — Nonces genéricos para fluxos OAuth/signup iniciados no servidor.
--
-- `calendar_oauth_nonces` é deliberadamente específica do Google Agenda: a
-- linha só nasce no CALLBACK e significa "nonce já usado". O Hosted Embedded
-- Signup precisa do inverso: registrar a ida, vincular organização/pessoa/
-- sessão e permitir que a volta futura consuma a mesma linha exatamente uma
-- vez. Reusar a tabela antiga mudaria sua semântica e ainda deixaria a sessão
-- sem vínculo.
--
-- O nonce cru não é persistido. O cookie guarda o state HMAC; o banco recebe
-- somente SHA-256, os vínculos mínimos, expiração e o instante de consumo.

create table if not exists public.oauth_signup_nonces (
  nonce_hash text primary key
    check (nonce_hash ~ '^[0-9a-f]{64}$'),
  flow_type text not null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  auth_session_id uuid,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint oauth_signup_nonces_expira_depois_de_criar
    check (expires_at > created_at),
  constraint oauth_signup_nonces_consumo_depois_de_criar
    check (consumed_at is null or consumed_at >= created_at)
);

comment on table public.oauth_signup_nonces is
  'Nonces de fluxos OAuth/signup iniciados no servidor. Guarda somente hash e vínculos; UPDATE condicional de consumed_at garante consumo único.';

create index if not exists oauth_signup_nonces_expiracao_idx
  on public.oauth_signup_nonces (expires_at);

alter table public.oauth_signup_nonces enable row level security;

-- Server-only: service_role grava/consome e sempre filtra todos os vínculos.
-- Nenhuma policy significa que um grant futuro não basta para servir linhas.
revoke all on public.oauth_signup_nonces from public, anon, authenticated;
grant select, insert, update, delete on public.oauth_signup_nonces to service_role;

-- A poda já existente passa a drenar as duas famílias sem ultrapassar o lote.
-- O cron continua chamando a MESMA RPC e o mesmo contrato de contagem.
create or replace function public.fn_expurgar_nonces_de_oauth(
  p_retencao_dias int default null,
  p_limite int default null
)
returns int
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_removidas int;
begin
  if p_retencao_dias is null or p_retencao_dias < 1 then
    p_retencao_dias := 1;
  end if;

  with alvo as (
    select 'calendar'::text as origem, nonce as chave, expira_em as expiracao
      from public.calendar_oauth_nonces
     where expira_em < now() - make_interval(days => p_retencao_dias)
    union all
    select 'signup'::text as origem, nonce_hash as chave, expires_at as expiracao
      from public.oauth_signup_nonces
     where expires_at < now() - make_interval(days => p_retencao_dias)
     order by expiracao
     limit greatest(coalesce(p_limite, 500), 1)
  ),
  apagados_calendar as (
    delete from public.calendar_oauth_nonces n
     using alvo
     where alvo.origem = 'calendar' and n.nonce = alvo.chave
     returning 1
  ),
  apagados_signup as (
    delete from public.oauth_signup_nonces n
     using alvo
     where alvo.origem = 'signup' and n.nonce_hash = alvo.chave
     returning 1
  )
  select (select count(*) from apagados_calendar) +
         (select count(*) from apagados_signup)
    into v_removidas;

  return v_removidas;
end$$;

revoke execute on function public.fn_expurgar_nonces_de_oauth(int, int)
  from public, anon, authenticated;
grant execute on function public.fn_expurgar_nonces_de_oauth(int, int) to service_role;

notify pgrst, 'reload schema';
