import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 6,
});
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

const ORG = "0446aaaa-0000-4000-8000-000000000001";
const OTHER_ORG = "0446bbbb-0000-4000-8000-000000000001";
const AGENT = "0446aaaa-1111-4000-8000-000000000001";
const OTHER_AGENT = "0446aaaa-1111-4000-8000-000000000002";
const MANAGER = "0446aaaa-1111-4000-8000-000000000003";
const ADMIN = "0446aaaa-1111-4000-8000-000000000004";
const NEIGHBOR = "0446bbbb-1111-4000-8000-000000000001";
const SOURCE_SESSION = "0446aaaa-2222-4000-8000-000000000001";
const DESTINATION_SESSION = "0446aaaa-2222-4000-8000-000000000002";
const ARCHIVED_SESSION = "0446aaaa-2222-4000-8000-000000000003";
const VOICE_SESSION = "0446aaaa-2222-4000-8000-000000000004";
const OTHER_SESSION = "0446bbbb-2222-4000-8000-000000000001";
const CONTACT = "0446aaaa-3333-4000-8000-000000000001";
const SOURCE = "0446aaaa-4444-4000-8000-000000000001";
const DESTINATION = "0446aaaa-4444-4000-8000-000000000002";
const DEMAND = "0446aaaa-5555-4000-8000-000000000001";
const CONFLICTING_DEMAND = "0446aaaa-5555-4000-8000-000000000002";
const PIPELINE = "0446aaaa-6666-4000-8000-000000000001";
const STAGE = "0446aaaa-6666-4000-8000-000000000002";
const LEAD = "0446aaaa-7777-4000-8000-000000000001";
const KEY = "0446aaaa-8888-4000-8000-000000000001";
const SECOND_KEY = "0446aaaa-8888-4000-8000-000000000002";
const MESSAGE_PROVIDERS = ["waha", "meta_cloud", "zernio", "zernio_social", "datafy"];

type HandoffResult = {
  id?: string;
  status: "completed" | "failed" | "conflict";
  replayed?: boolean;
  destination_conversation_id?: string;
  failure_code?: string;
};

async function handoff(
  actor = AGENT,
  key = KEY,
  org = ORG,
  source = SOURCE,
  providers = MESSAGE_PROVIDERS,
): Promise<HandoffResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const result = await client.query(
      "select public.fn_manual_channel_handoff($1,$2,$3,$4,$5) result",
      [org, source, actor, key, providers],
    );
    await client.query("commit");
    return result.rows[0].result as HandoffResult;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function asAuthenticated(userId: string, text: string, args: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: userId, aal: "aal2" }),
    ]);
    const result = await client.query(text, args);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await query(
    `insert into auth.users(id,email,raw_user_meta_data) values
       ($1,'handoff-agent@invariant.test','{"full_name":"Agente Origem"}'),
       ($2,'handoff-other-agent@invariant.test','{"full_name":"Outro Agente"}'),
       ($3,'handoff-manager@invariant.test','{"full_name":"Gerente"}'),
       ($4,'handoff-admin@invariant.test','{"full_name":"Admin"}'),
       ($5,'handoff-neighbor@invariant.test','{"full_name":"Vizinho"}')
     on conflict(id) do nothing`,
    [AGENT, OTHER_AGENT, MANAGER, ADMIN, NEIGHBOR],
  );
  await query(
    `insert into organizations(id,slug,legal_name,display_name) values
       ($1,'handoff-inv','Handoff Invariant','Handoff Inv'),
       ($2,'handoff-neighbor','Handoff Neighbor','Handoff Neighbor')
     on conflict(id) do nothing`,
    [ORG, OTHER_ORG],
  );
  await query(
    `insert into user_organizations(organization_id,user_id,role,accepted_at) values
       ($1,$2,'agent',now()),($1,$3,'agent',now()),($1,$4,'manager',now()),
       ($1,$5,'admin',now()),($6,$7,'admin',now())
     on conflict do nothing`,
    [ORG, AGENT, OTHER_AGENT, MANAGER, ADMIN, OTHER_ORG, NEIGHBOR],
  );
  await query(
    `insert into channel_sessions
       (id,organization_id,waha_session_name,display_name,webhook_secret_encrypted,archived_at)
     values
       ($1,$2,'handoff-source','Origem','\\x00'::bytea,null),
       ($3,$2,'handoff-destination','Pessoal','\\x00'::bytea,null),
       ($4,$2,'handoff-archived','Arquivada','\\x00'::bytea,now()),
       ($5,$6,'handoff-neighbor','Vizinha','\\x00'::bytea,null)
     on conflict(id) do nothing`,
    [SOURCE_SESSION, ORG, DESTINATION_SESSION, ARCHIVED_SESSION, OTHER_SESSION, OTHER_ORG],
  );
  await query(
    `insert into channel_sessions
       (id,organization_id,provider,wacalls_session_id,display_name,webhook_secret_encrypted)
     values($1,$2,'wacalls','handoff-voice','Voz','\\x00'::bytea)
     on conflict(id) do nothing`,
    [VOICE_SESSION, ORG],
  );
  await query(
    `insert into contacts(id,organization_id,display_name)
       values($1,$2,'Contato Handoff') on conflict(id) do nothing`,
    [CONTACT, ORG],
  );
  await query(
    `insert into crm_pipelines(id,organization_id,name,slug)
       values($1,$2,'Handoff','handoff-inv') on conflict(id) do nothing`,
    [PIPELINE, ORG],
  );
  await query(
    `insert into crm_stages(id,organization_id,pipeline_id,name,slug,position)
       values($1,$2,$3,'Novo','novo',1000) on conflict(id) do nothing`,
    [STAGE, ORG, PIPELINE],
  );
  await query(
    `insert into crm_leads(id,organization_id,pipeline_id,stage_id,title,contact_id)
       values($1,$2,$3,$4,'Negócio Handoff',$5) on conflict(id) do nothing`,
    [LEAD, ORG, PIPELINE, STAGE, CONTACT],
  );
});

afterAll(() => pool.end());

beforeEach(async () => {
  await query("delete from channel_handoffs where organization_id=$1", [ORG]);
  await query(
    "delete from crm_lead_activities where organization_id=$1 and source_module='channel_handoff'",
    [ORG],
  );
  await query("delete from conversation_assignment_events where organization_id=$1", [ORG]);
  await query("delete from demanda_conversas where organization_id=$1", [ORG]);
  await query("delete from conversations where organization_id=$1", [ORG]);
  await query("delete from demandas where organization_id=$1", [ORG]);
  await query("delete from attendant_channel_bindings where organization_id=$1", [ORG]);
  await query("update channel_sessions set archived_at=null where id=$1", [DESTINATION_SESSION]);
  await query("update channel_sessions set archived_at=now() where id=$1", [ARCHIVED_SESSION]);

  await query(
    `insert into demandas
       (id,organization_id,contact_id,lead_id,origem,estado,dono_kind,dono_user_id,proximo_passo)
     values($1,$2,$3,$4,'manual','em_atendimento','humano',$5,'Continuar o atendimento')`,
    [DEMAND, ORG, CONTACT, LEAD, AGENT],
  );
  await query(
    `insert into conversations
       (id,organization_id,contact_id,channel_session_id,status,assigned_to_user_id,
        assigned_to_user_name,assigned_at,assignee_kind,bot_silenced_until,
        current_demanda_id,service_revision,service_started_at)
     values($1,$2,$3,$4,'claimed',$5,'Agente Origem',now(),'user','infinity',$6,7,now())`,
    [SOURCE, ORG, CONTACT, SOURCE_SESSION, AGENT, DEMAND],
  );
  await query(
    `insert into demanda_conversas(organization_id,demanda_id,conversation_id,service_revision)
       values($1,$2,$3,7)`,
    [ORG, DEMAND, SOURCE],
  );
  await query(
    `insert into attendant_channel_bindings
       (organization_id,user_id,channel_session_id,purpose,created_by_user_id)
     values($1,$2,$3,'personal_handoff',$4)`,
    [ORG, AGENT, DESTINATION_SESSION, MANAGER],
  );
});

describe("fn_manual_channel_handoff", () => {
  it("cria outra conversa real sem mexer na origem, com mesmo contato, demanda e responsável", async () => {
    const result = await handoff();
    expect(result).toMatchObject({ status: "completed", replayed: false });
    expect(result.destination_conversation_id).not.toBe(SOURCE);

    const { rows } = await query(
      `select s.channel_session_id source_session,s.status source_status,
              s.assigned_to_user_id source_owner,s.current_demanda_id source_demanda,
              d.id destination_id,d.contact_id,d.channel_session_id destination_session,
              d.assigned_to_user_id destination_owner,d.current_demanda_id destination_demanda,
              dm.dono_kind,dm.dono_user_id,
              (select count(*)::int from demanda_conversas dc where dc.demanda_id=dm.id) links,
              (select count(*)::int from messages m where m.conversation_id=d.id) destination_messages
         from conversations s
         join conversations d on d.id=$4
         join demandas dm on dm.id=$3
        where s.organization_id=$1 and s.id=$2`,
      [ORG, SOURCE, DEMAND, result.destination_conversation_id],
    );
    expect(rows[0]).toMatchObject({
      source_session: SOURCE_SESSION,
      source_status: "claimed",
      source_owner: AGENT,
      source_demanda: DEMAND,
      contact_id: CONTACT,
      destination_session: DESTINATION_SESSION,
      destination_owner: AGENT,
      destination_demanda: DEMAND,
      dono_kind: "humano",
      dono_user_id: AGENT,
      links: 2,
      destination_messages: 0,
    });
    expect(
      (
        await query(
          `select count(*)::int n from conversation_assignment_events
            where organization_id=$1 and conversation_id=$2 and reason='handoff'`,
          [ORG, result.destination_conversation_id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await query(
          `select count(*)::int n from crm_lead_activities
            where organization_id=$1 and lead_id=$2 and type='conversation_channel_handoff'`,
          [ORG, LEAD],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("reutiliza conversa compatível e impõe nela o mesmo responsável", async () => {
    await query(
      `insert into conversations
         (id,organization_id,contact_id,channel_session_id,status,assigned_to_user_id,
          assigned_at,assignee_kind,current_demanda_id,service_revision)
       values($1,$2,$3,$4,'open',$5,now(),'user',$6,3)`,
      [DESTINATION, ORG, CONTACT, DESTINATION_SESSION, OTHER_AGENT, DEMAND],
    );
    await query(
      `insert into demanda_conversas(organization_id,demanda_id,conversation_id,service_revision)
       values($1,$2,$3,3)`,
      [ORG, DEMAND, DESTINATION],
    );
    const result = await handoff();
    expect(result.destination_conversation_id).toBe(DESTINATION);
    expect(
      (
        await query(
          "select assigned_to_user_id from conversations where organization_id=$1 and id=$2",
          [ORG, DESTINATION],
        )
      ).rows[0].assigned_to_user_id,
    ).toBe(AGENT);
  });

  it("a mesma chave, inclusive concorrente, produz um recibo e um destino", async () => {
    const [first, second] = await Promise.all([handoff(), handoff()]);
    expect(first.destination_conversation_id).toBe(second.destination_conversation_id);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    const counts = await query(
      `select
         (select count(*)::int from channel_handoffs where organization_id=$1) handoffs,
         (select count(*)::int from conversations where organization_id=$1 and channel_session_id=$2) destinations,
         (select count(*)::int from conversation_assignment_events where organization_id=$1 and reason='handoff') events`,
      [ORG, DESTINATION_SESSION],
    );
    expect(counts.rows[0]).toMatchObject({ handoffs: 1, destinations: 1, events: 1 });
  });

  it("a mesma chave com outro ator conflita em vez de reaplicar", async () => {
    expect((await handoff()).status).toBe("completed");
    expect(await handoff(MANAGER)).toMatchObject({
      status: "conflict",
      failure_code: "idempotency_conflict",
    });
  });

  it("falha sem vínculo e retenta a mesma chave depois que a configuração é corrigida", async () => {
    await query("delete from attendant_channel_bindings where organization_id=$1", [ORG]);
    const failed = await handoff();
    expect(failed).toMatchObject({ status: "failed", failure_code: "binding_not_found" });
    await query(
      `insert into attendant_channel_bindings
         (organization_id,user_id,channel_session_id,purpose,created_by_user_id)
       values($1,$2,$3,'personal_handoff',$4)`,
      [ORG, AGENT, DESTINATION_SESSION, MANAGER],
    );
    const completed = await handoff();
    expect(completed).toMatchObject({ status: "completed", replayed: false, id: failed.id });
    expect(
      (await query("select attempt_count from channel_handoffs where id=$1", [completed.id]))
        .rows[0].attempt_count,
    ).toBe(2);
  });

  it.each([
    [ARCHIVED_SESSION, "binding_invalid"],
    [VOICE_SESSION, "binding_invalid"],
    [SOURCE_SESSION, "destination_same_as_source"],
  ])("recusa vínculo inválido para a sessão %s", async (session, failureCode) => {
    await query(
      `update attendant_channel_bindings set channel_session_id=$1
        where organization_id=$2 and user_id=$3`,
      [session, ORG, AGENT],
    );
    expect(await handoff()).toMatchObject({ status: "failed", failure_code: failureCode });
  });

  it("agent não opera conversa alheia; manager e admin podem fazer override", async () => {
    expect(await handoff(OTHER_AGENT)).toMatchObject({
      status: "failed",
      failure_code: "source_not_owned",
    });
    expect(await handoff(MANAGER, SECOND_KEY)).toMatchObject({ status: "completed" });

    await query("delete from channel_handoffs where organization_id=$1", [ORG]);
    expect(await handoff(ADMIN, KEY)).toMatchObject({ status: "completed" });
  });

  it("não atravessa tenant nem resolve vínculo de outra organização", async () => {
    expect(await handoff(NEIGHBOR, KEY, OTHER_ORG)).toMatchObject({
      status: "failed",
      failure_code: "source_not_found",
    });
    expect(
      (
        await query("select count(*)::int n from channel_handoffs where organization_id=$1", [
          OTHER_ORG,
        ])
      ).rows[0].n,
    ).toBe(0);
  });

  it("recusa destino que já carrega outra demanda aberta e o deixa intacto", async () => {
    await query(
      `insert into demandas
         (id,organization_id,contact_id,origem,estado,dono_kind,proximo_passo)
       values($1,$2,$3,'manual','aberta','ia','Atender outra demanda')`,
      [CONFLICTING_DEMAND, ORG, CONTACT],
    );
    await query(
      `insert into conversations
         (id,organization_id,contact_id,channel_session_id,status,current_demanda_id,service_revision)
       values($1,$2,$3,$4,'open',$5,2)`,
      [DESTINATION, ORG, CONTACT, DESTINATION_SESSION, CONFLICTING_DEMAND],
    );
    await query(
      `insert into demanda_conversas(organization_id,demanda_id,conversation_id,service_revision)
       values($1,$2,$3,2)`,
      [ORG, CONFLICTING_DEMAND, DESTINATION],
    );
    expect(await handoff()).toMatchObject({
      status: "failed",
      failure_code: "destination_demanda_conflict",
    });
    expect(
      (await query("select current_demanda_id from conversations where id=$1", [DESTINATION]))
        .rows[0].current_demanda_id,
    ).toBe(CONFLICTING_DEMAND);
  });
});

describe("channel_handoffs é um recibo server-only", () => {
  it("authenticated não lê, escreve nem executa a RPC", async () => {
    await handoff();
    await expect(
      asAuthenticated(AGENT, "select * from channel_handoffs where organization_id=$1", [ORG]),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asAuthenticated(
        AGENT,
        `insert into channel_handoffs
          (organization_id,source_conversation_id,demanda_id,assigned_user_id,
           created_by_user_id,idempotency_key,request_hash)
         values($1,$2,$3,$4,$4,$5,'\\x00')`,
        [ORG, SOURCE, DEMAND, AGENT, SECOND_KEY],
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asAuthenticated(AGENT, "select fn_manual_channel_handoff($1,$2,$3,$4,$5)", [
        ORG,
        SOURCE,
        AGENT,
        SECOND_KEY,
        MESSAGE_PROVIDERS,
      ]),
    ).rejects.toThrow(/permission denied/i);
  });
});
