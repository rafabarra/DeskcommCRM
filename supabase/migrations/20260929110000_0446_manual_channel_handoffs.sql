-- 0446 — continuação manual entre canais, sem copiar mensagem nem fingir uma
-- única thread. A origem fica intacta; o destino é outra conversa real do
-- mesmo contato, ligada à mesma demanda e ao mesmo responsável humano.

create unique index if not exists conversations_org_id_unique
  on public.conversations (organization_id, id);
create unique index if not exists demandas_org_id_unique
  on public.demandas (organization_id, id);

create table if not exists public.channel_handoffs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_conversation_id uuid not null,
  destination_conversation_id uuid,
  demanda_id uuid not null,
  destination_channel_session_id uuid,
  assigned_user_id uuid not null references auth.users(id) on delete restrict,
  trigger_type text not null default 'manual' check (trigger_type in ('manual')),
  created_by_user_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key uuid not null,
  request_hash bytea not null,
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed')),
  failure_code text,
  attempt_count integer not null default 1 check (attempt_count > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint channel_handoffs_source_org_fk
    foreign key (organization_id, source_conversation_id)
    references public.conversations(organization_id, id) on delete cascade,
  constraint channel_handoffs_destination_org_fk
    foreign key (organization_id, destination_conversation_id)
    references public.conversations(organization_id, id) on delete cascade,
  constraint channel_handoffs_demanda_org_fk
    foreign key (organization_id, demanda_id)
    references public.demandas(organization_id, id) on delete cascade,
  constraint channel_handoffs_session_org_fk
    foreign key (organization_id, destination_channel_session_id)
    references public.channel_sessions(organization_id, id) on delete restrict,
  constraint channel_handoffs_idempotency_unique
    unique (organization_id, idempotency_key),
  constraint channel_handoffs_status_coherent check (
    (status = 'completed' and destination_conversation_id is not null
      and destination_channel_session_id is not null and failure_code is null)
    or (status = 'failed' and failure_code is not null)
    or status = 'processing'
  )
);

create index if not exists channel_handoffs_source_idx
  on public.channel_handoffs (organization_id, source_conversation_id, created_at desc);
create index if not exists channel_handoffs_destination_idx
  on public.channel_handoffs (organization_id, destination_conversation_id)
  where destination_conversation_id is not null;
create index if not exists channel_handoffs_demanda_idx
  on public.channel_handoffs (organization_id, demanda_id, created_at desc);

alter table public.channel_handoffs enable row level security;

-- Recibo de negócio server-only. A tela recebe o resultado da RPC; não ganha
-- uma segunda superfície de escrita/leitura direta sobre fatos de auditoria.
revoke all on public.channel_handoffs from public, anon, authenticated, service_role;
grant select on public.channel_handoffs to service_role;

drop trigger if exists trg_channel_handoffs_updated_at on public.channel_handoffs;
create trigger trg_channel_handoffs_updated_at
  before update on public.channel_handoffs
  for each row execute function public.fn_set_updated_at();

create or replace function public.fn_manual_channel_handoff(
  p_org uuid,
  p_source_conversation_id uuid,
  p_actor_user_id uuid,
  p_idempotency_key uuid,
  p_message_capable_providers text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_source public.conversations%rowtype;
  v_destination public.conversations%rowtype;
  v_demanda public.demandas%rowtype;
  v_actor_role text;
  v_binding_session_id uuid;
  v_destination_provider text;
  v_destination_archived_at timestamptz;
  v_previous_destination_owner uuid;
  v_existing_handoff_id uuid;
  v_existing_source_id uuid;
  v_existing_destination_id uuid;
  v_existing_demanda_id uuid;
  v_existing_session_id uuid;
  v_existing_assigned_user_id uuid;
  v_existing_status text;
  v_existing_failure_code text;
  v_existing_hash bytea;
  v_handoff_id uuid;
  v_request_hash bytea;
  v_failure_code text;
  v_start_new_service boolean := false;
  v_destination_was_terminal boolean := false;
begin
  if p_org is null or p_source_conversation_id is null or p_actor_user_id is null
     or p_idempotency_key is null then
    return jsonb_build_object('status', 'failed', 'failure_code', 'invalid_input');
  end if;

  -- Uma chave por organização decide a corrida antes de qualquer efeito. Quem
  -- perde espera a primeira transação e então recebe o MESMO recibo.
  perform pg_advisory_xact_lock(
    hashtextextended(p_org::text || ':' || p_idempotency_key::text, 446)
  );
  v_request_hash := digest(
    convert_to(
      'manual_channel_handoff:v1:' || p_source_conversation_id::text || ':' || p_actor_user_id::text,
      'UTF8'
    ),
    'sha256'
  );

  select id, source_conversation_id, destination_conversation_id, demanda_id,
         destination_channel_session_id, assigned_user_id, status, failure_code, request_hash
    into v_existing_handoff_id, v_existing_source_id, v_existing_destination_id,
         v_existing_demanda_id, v_existing_session_id, v_existing_assigned_user_id,
         v_existing_status, v_existing_failure_code, v_existing_hash
    from public.channel_handoffs
   where organization_id = p_org and idempotency_key = p_idempotency_key
   for update;

  if v_existing_handoff_id is not null and v_existing_hash is distinct from v_request_hash then
    return jsonb_build_object(
      'status', 'conflict',
      'failure_code', 'idempotency_conflict'
    );
  end if;

  if v_existing_handoff_id is not null and v_existing_status = 'completed' then
    return jsonb_build_object(
      'id', v_existing_handoff_id,
      'status', 'completed',
      'replayed', true,
      'source_conversation_id', v_existing_source_id,
      'destination_conversation_id', v_existing_destination_id,
      'demanda_id', v_existing_demanda_id,
      'destination_channel_session_id', v_existing_session_id,
      'assigned_user_id', v_existing_assigned_user_id
    );
  end if;

  -- A trava de serviço é a mesma de fn_service_begin/fn_service_inbound. A
  -- leitura sem lock só descobre o contato; depois da trava a origem é relida.
  select * into v_source
    from public.conversations
   where organization_id = p_org and id = p_source_conversation_id;
  if not found then
    return jsonb_build_object('status', 'failed', 'failure_code', 'source_not_found');
  end if;
  perform public.fn_service_lock(p_org, v_source.contact_id);
  select * into v_source
    from public.conversations
   where organization_id = p_org and id = p_source_conversation_id
   for no key update;

  if v_source.is_group then
    return jsonb_build_object('status', 'failed', 'failure_code', 'source_is_group');
  end if;
  if v_source.assigned_to_user_id is null then
    return jsonb_build_object('status', 'failed', 'failure_code', 'source_unassigned');
  end if;

  v_actor_role := public.fn_member_role_in_org(p_actor_user_id, p_org);
  if coalesce(v_actor_role, 'none') not in ('agent', 'manager', 'admin') then
    return jsonb_build_object('status', 'failed', 'failure_code', 'actor_forbidden');
  end if;
  if v_actor_role = 'agent' and v_source.assigned_to_user_id <> p_actor_user_id then
    return jsonb_build_object('status', 'failed', 'failure_code', 'source_not_owned');
  end if;
  if coalesce(public.fn_member_role_in_org(v_source.assigned_to_user_id, p_org), 'none')
       not in ('agent', 'manager', 'admin') then
    return jsonb_build_object('status', 'failed', 'failure_code', 'assignee_ineligible');
  end if;

  select d.* into v_demanda
    from public.demandas d
    join public.demanda_conversas dc
      on dc.organization_id = d.organization_id
     and dc.demanda_id = d.id
     and dc.conversation_id = v_source.id
   where d.organization_id = p_org
     and d.id = v_source.current_demanda_id
     and d.contact_id = v_source.contact_id
     and d.fechada_em is null
     and dc.service_revision = v_source.service_revision
   for share of d;
  if not found then
    return jsonb_build_object('status', 'failed', 'failure_code', 'active_demanda_not_found');
  end if;

  if v_existing_handoff_id is null then
    insert into public.channel_handoffs (
      organization_id, source_conversation_id, demanda_id, assigned_user_id,
      trigger_type, created_by_user_id, idempotency_key, request_hash, status
    ) values (
      p_org, v_source.id, v_demanda.id, v_source.assigned_to_user_id,
      'manual', p_actor_user_id, p_idempotency_key, v_request_hash, 'processing'
    ) returning id into v_handoff_id;
  else
    v_handoff_id := v_existing_handoff_id;
    update public.channel_handoffs
       set source_conversation_id = v_source.id,
           demanda_id = v_demanda.id,
           assigned_user_id = v_source.assigned_to_user_id,
           destination_conversation_id = null,
           destination_channel_session_id = null,
           status = 'processing',
           failure_code = null,
           attempt_count = attempt_count + 1,
           updated_at = now()
     where id = v_handoff_id;
  end if;

  begin
    select b.channel_session_id into v_binding_session_id
      from public.attendant_channel_bindings b
     where b.organization_id = p_org
       and b.user_id = v_source.assigned_to_user_id
       and b.purpose = 'personal_handoff'
     for share;
    if v_binding_session_id is null then
      raise exception 'binding_not_found' using errcode = 'P0001';
    end if;

    select s.provider, s.archived_at
      into v_destination_provider, v_destination_archived_at
      from public.channel_sessions s
     where s.organization_id = p_org and s.id = v_binding_session_id
     for share;
    if not found or v_destination_archived_at is not null
       or not (v_destination_provider = any(coalesce(p_message_capable_providers, array[]::text[]))) then
      raise exception 'binding_invalid' using errcode = 'P0001';
    end if;
    if v_binding_session_id = v_source.channel_session_id then
      raise exception 'destination_same_as_source' using errcode = 'P0001';
    end if;

    select * into v_destination
      from public.conversations
     where organization_id = p_org
       and contact_id = v_source.contact_id
       and channel_session_id = v_binding_session_id
       and not is_group
     order by created_at, id
     limit 1
     for no key update;

    if v_destination.id is not null
       and v_destination.current_demanda_id is not null
       and v_destination.current_demanda_id <> v_demanda.id
       and exists (
         select 1 from public.demandas d
          where d.organization_id = p_org
            and d.id = v_destination.current_demanda_id
            and d.fechada_em is null
       ) then
      raise exception 'destination_demanda_conflict' using errcode = 'P0001';
    end if;

    if v_destination.id is null then
      insert into public.conversations (
        organization_id, contact_id, channel_session_id, channel, status,
        status_changed_at, assigned_to_user_id, assigned_to_user_name,
        assigned_at, assignee_kind, unread_count_for_assignee, is_group,
        bot_silenced_until, service_revision, service_started_at,
        current_demanda_id
      ) values (
        p_org, v_source.contact_id, v_binding_session_id, 'whatsapp', 'claimed',
        now(), v_source.assigned_to_user_id,
        (select raw_user_meta_data ->> 'full_name' from auth.users
          where id = v_source.assigned_to_user_id),
        now(), 'user', 0, false, 'infinity'::timestamptz, 1, now(), v_demanda.id
      ) returning * into v_destination;
      v_previous_destination_owner := null;
    else
      v_previous_destination_owner := v_destination.assigned_to_user_id;
      v_destination_was_terminal :=
        v_destination.status in ('closed', 'resolved', 'archived');
      v_start_new_service :=
        v_destination_was_terminal
        or (
          v_destination.current_demanda_id is not null
          and v_destination.current_demanda_id <> v_demanda.id
        );

      -- O trigger canônico de ciclo de vida incrementa a revisão e limpa a
      -- demanda ao sair de estado terminal. Fazemos essa transição primeiro e
      -- ligamos a demanda no UPDATE seguinte; tentar ambos na mesma linha faria
      -- o trigger apagar `current_demanda_id` quando ela já fosse a mesma.
      if v_destination_was_terminal then
        update public.conversations
           set status = 'claimed', status_changed_at = now(), updated_at = now()
         where organization_id = p_org and id = v_destination.id
         returning * into v_destination;
      end if;

      update public.conversations
         set status = 'claimed',
             status_changed_at = now(),
             assigned_to_user_id = v_source.assigned_to_user_id,
             assigned_to_user_name = (
               select raw_user_meta_data ->> 'full_name' from auth.users
                where id = v_source.assigned_to_user_id
             ),
             assigned_at = now(),
             assignee_kind = 'user',
             unread_count_for_assignee = 0,
             bot_silenced_until = 'infinity'::timestamptz,
             service_revision = service_revision + case
               when v_start_new_service and not v_destination_was_terminal then 1
               else 0
             end,
             service_started_at = case
               when v_start_new_service or service_started_at is null then now()
               else service_started_at
             end,
             service_closed_at = null,
             current_demanda_id = v_demanda.id,
             updated_at = now()
       where organization_id = p_org and id = v_destination.id
       returning * into v_destination;
    end if;

    insert into public.demanda_conversas (
      organization_id, demanda_id, conversation_id, service_revision
    ) values (
      p_org, v_demanda.id, v_destination.id, v_destination.service_revision
    )
    on conflict (demanda_id, conversation_id)
    do update set
      organization_id = excluded.organization_id,
      service_revision = excluded.service_revision;

    update public.demandas
       set dono_kind = 'humano',
           dono_user_id = v_source.assigned_to_user_id,
           updated_at = now()
     where organization_id = p_org and id = v_demanda.id;

    insert into public.conversation_assignment_events (
      organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason
    ) values (
      p_org, v_destination.id, v_previous_destination_owner,
      v_source.assigned_to_user_id, p_actor_user_id, 'handoff'
    );

    -- Log universal e visível no mesmo commit da mutação. Não agrega mensagens:
    -- registra somente o fato de a mesma demanda ter mudado de canal.
    if v_demanda.lead_id is not null then
      insert into public.crm_lead_activities (
        organization_id, lead_id, contact_id, source_module, source_id, type,
        payload, metadata, performed_at, created_at, performed_by_user_id,
        actor_kind, reason, evidence
      ) values (
        p_org, v_demanda.lead_id, v_source.contact_id, 'channel_handoff',
        v_handoff_id, 'conversation_channel_handoff',
        jsonb_build_object(
          'source_conversation_id', v_source.id,
          'destination_conversation_id', v_destination.id,
          'demanda_id', v_demanda.id
        ),
        '{}'::jsonb, now(), now(), p_actor_user_id, 'user',
        'Continuou o atendimento na conexão pessoal do responsável', '{}'::jsonb
      );
    end if;

    update public.channel_handoffs
       set destination_conversation_id = v_destination.id,
           destination_channel_session_id = v_binding_session_id,
           status = 'completed',
           failure_code = null,
           updated_at = now()
     where id = v_handoff_id;

    return jsonb_build_object(
      'id', v_handoff_id,
      'status', 'completed',
      'replayed', false,
      'source_conversation_id', v_source.id,
      'destination_conversation_id', v_destination.id,
      'demanda_id', v_demanda.id,
      'destination_channel_session_id', v_binding_session_id,
      'assigned_user_id', v_source.assigned_to_user_id
    );
  exception when others then
    v_failure_code := case
      when sqlerrm in (
        'binding_not_found', 'binding_invalid', 'destination_same_as_source',
        'destination_demanda_conflict'
      ) then sqlerrm
      else 'internal_error'
    end;
    update public.channel_handoffs
       set status = 'failed',
           failure_code = v_failure_code,
           destination_conversation_id = null,
           destination_channel_session_id = v_binding_session_id,
           updated_at = now()
     where id = v_handoff_id;
    return jsonb_build_object(
      'id', v_handoff_id,
      'status', 'failed',
      'replayed', false,
      'source_conversation_id', v_source.id,
      'demanda_id', v_demanda.id,
      'assigned_user_id', v_source.assigned_to_user_id,
      'failure_code', v_failure_code
    );
  end;
end;
$$;

revoke all on function public.fn_manual_channel_handoff(uuid, uuid, uuid, uuid, text[])
  from public, anon, authenticated, service_role;
grant execute on function public.fn_manual_channel_handoff(uuid, uuid, uuid, uuid, text[])
  to service_role;

notify pgrst, 'reload schema';
