-- 0445 — conexão pessoal opcional por atendente.
--
-- Esta tabela guarda somente CONFIGURAÇÃO. Ela não abre conversa, não transfere
-- atendimento e não envia mensagem. Ausência de linha significa "sem conexão
-- pessoal" e preserva integralmente o comportamento anterior.
--
-- As FKs compostas são a defesa de tenant no catálogo: mesmo quem escreve como
-- owner do banco não consegue ligar uma pessoa da organização A a uma sessão da
-- organização B. A escrita humana passa exclusivamente pela rota de configuração,
-- que usa a RPC service-only abaixo; authenticated recebe SELECT sob RLS, mas não
-- recebe DML nem EXECUTE da função.

create table if not exists public.attendant_channel_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  channel_session_id uuid not null,
  purpose text not null default 'personal_handoff'
    check (purpose in ('personal_handoff')),
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendant_channel_bindings_member_org_fk
    foreign key (user_id, organization_id)
    references public.user_organizations(user_id, organization_id)
    on delete cascade,
  constraint attendant_channel_bindings_session_org_fk
    foreign key (organization_id, channel_session_id)
    references public.channel_sessions(organization_id, id)
    on delete cascade,
  constraint attendant_channel_bindings_user_purpose_unique
    unique (organization_id, user_id, purpose),
  constraint attendant_channel_bindings_session_purpose_unique
    unique (organization_id, channel_session_id, purpose)
);

create index if not exists attendant_channel_bindings_org_idx
  on public.attendant_channel_bindings (organization_id);

alter table public.attendant_channel_bindings enable row level security;

revoke all on public.attendant_channel_bindings
  from public, anon, authenticated, service_role;
grant select on public.attendant_channel_bindings
  to authenticated, service_role;

drop policy if exists attendant_channel_bindings_select on public.attendant_channel_bindings;
create policy attendant_channel_bindings_select
  on public.attendant_channel_bindings
  for select
  to authenticated
  using (
    (
      organization_id in (select public.fn_user_org_ids())
      and (
        user_id = auth.uid()
        or public.fn_role_at_least(organization_id, 'manager')
      )
    )
    or public.fn_is_platform_admin()
  );

drop trigger if exists trg_attendant_channel_bindings_updated_at
  on public.attendant_channel_bindings;
create trigger trg_attendant_channel_bindings_updated_at
  before update on public.attendant_channel_bindings
  for each row execute function public.fn_set_updated_at();

create or replace function public.fn_set_attendant_channel_binding(
  p_org uuid,
  p_user_id uuid,
  p_channel_session_id uuid,
  p_actor_user_id uuid,
  p_message_capable_providers text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous_channel_session_id uuid;
begin
  -- Esta função não é uma superfície de usuário: só service_role executa. A rota
  -- resolve organização/ator da sessão, exige manager+, MFA e support-write, e
  -- envia a lista do seam canônico `lib/channels/capabilities.ts`. Revalidamos
  -- sob lock todas as identidades, o provider e o estado arquivado; a lista só é
  -- confiável porque authenticated não tem EXECUTE.
  if p_org is null or p_user_id is null or p_actor_user_id is null then
    raise exception 'attendant_channel_binding_invalid_input' using errcode = '22023';
  end if;

  perform 1
    from auth.users
   where id = p_actor_user_id
   for share;
  if not found then
    raise exception 'attendant_channel_binding_actor_not_found' using errcode = 'P0002';
  end if;

  perform 1
    from public.user_organizations
   where organization_id = p_org
     and user_id = p_actor_user_id
     and revoked_at is null
     and accepted_at is not null
     and role in ('manager', 'admin')
   for share;
  if not found then
    perform 1
      from public.platform_admins
     where user_id = p_actor_user_id
       and revoked_at is null
       and scope = 'full'
     for share;
    if not found then
      raise exception 'attendant_channel_binding_actor_forbidden' using errcode = '42501';
    end if;
  end if;

  select channel_session_id
    into v_previous_channel_session_id
    from public.attendant_channel_bindings
   where organization_id = p_org
     and user_id = p_user_id
     and purpose = 'personal_handoff'
   for update;

  -- Remover continua possível se um vínculo legado sobreviveu a membership ou
  -- sessão inválida. Isso é o caminho de reparo; criação/troca valida tudo abaixo.
  if p_channel_session_id is null then
    delete from public.attendant_channel_bindings
     where organization_id = p_org
       and user_id = p_user_id
       and purpose = 'personal_handoff';

    return jsonb_build_object(
      'user_id', p_user_id,
      'purpose', 'personal_handoff',
      'previous_channel_session_id', v_previous_channel_session_id,
      'channel_session_id', null,
      'changed', v_previous_channel_session_id is not null
    );
  end if;

  perform 1
    from public.user_organizations
   where organization_id = p_org
     and user_id = p_user_id
     and revoked_at is null
     and accepted_at is not null
     and role in ('agent', 'manager', 'admin')
   for share;
  if not found then
    raise exception 'attendant_channel_binding_member_ineligible' using errcode = '22023';
  end if;

  perform 1
    from public.channel_sessions
   where organization_id = p_org
     and id = p_channel_session_id
     and archived_at is null
     and provider = any(coalesce(p_message_capable_providers, array[]::text[]))
   for share;
  if not found then
    raise exception 'attendant_channel_binding_channel_invalid' using errcode = 'P0002';
  end if;

  if v_previous_channel_session_id = p_channel_session_id then
    return jsonb_build_object(
      'user_id', p_user_id,
      'purpose', 'personal_handoff',
      'previous_channel_session_id', v_previous_channel_session_id,
      'channel_session_id', p_channel_session_id,
      'changed', false
    );
  end if;

  insert into public.attendant_channel_bindings (
    organization_id,
    user_id,
    channel_session_id,
    purpose,
    created_by_user_id
  ) values (
    p_org,
    p_user_id,
    p_channel_session_id,
    'personal_handoff',
    p_actor_user_id
  )
  on conflict (organization_id, user_id, purpose)
  do update set
    channel_session_id = excluded.channel_session_id,
    updated_at = now();

  return jsonb_build_object(
    'user_id', p_user_id,
    'purpose', 'personal_handoff',
    'previous_channel_session_id', v_previous_channel_session_id,
    'channel_session_id', p_channel_session_id,
    'changed', true
  );
end;
$$;

revoke all on function public.fn_set_attendant_channel_binding(uuid, uuid, uuid, uuid, text[])
  from public, anon, authenticated, service_role;
grant execute on function public.fn_set_attendant_channel_binding(uuid, uuid, uuid, uuid, text[])
  to service_role;

-- Revogar ou rebaixar o membro invalida a finalidade de atendente e libera a
-- conexão para outra pessoa. O gesto que remove o acesso já é auditado pela
-- superfície de equipe; este trigger só mantém a integridade derivada.
create or replace function public.fn_cleanup_attendant_channel_binding_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.revoked_at is not null
     or new.accepted_at is null
     or new.role not in ('agent', 'manager', 'admin')
  then
    delete from public.attendant_channel_bindings
     where organization_id = new.organization_id
       and user_id = new.user_id;
  end if;
  return new;
end;
$$;

revoke all on function public.fn_cleanup_attendant_channel_binding_member()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_cleanup_attendant_channel_binding_member
  on public.user_organizations;
create trigger trg_cleanup_attendant_channel_binding_member
  after update of revoked_at, accepted_at, role on public.user_organizations
  for each row
  when (
    old.revoked_at is distinct from new.revoked_at
    or old.accepted_at is distinct from new.accepted_at
    or old.role is distinct from new.role
  )
  execute function public.fn_cleanup_attendant_channel_binding_member();

notify pgrst, 'reload schema';
