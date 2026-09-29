import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_MANAGER,
  GOV_ORG,
  GOV_SESSION,
  GOV_VIEWER,
  seedGov,
} from "./gov-helpers";

const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

const SECOND_CHANNEL = "e1000000-0000-4000-8000-000000000001";
const ARCHIVED_CHANNEL = "e1000000-0000-4000-8000-000000000002";
const VOICE_CHANNEL = "e1000000-0000-4000-8000-000000000003";
const OTHER_ORG = "e2000000-0000-4000-8000-000000000001";
const OTHER_USER = "e2000000-0000-4000-8000-000000000002";
const OTHER_CHANNEL = "e2000000-0000-4000-8000-000000000003";

async function asUser(userId: string, text: string, args: unknown[] = []) {
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

async function setBinding(
  userId: string,
  channelId: string | null,
  actorId = GOV_MANAGER,
  messageCapableProviders = ["waha", "meta_cloud", "zernio", "zernio_social", "datafy"],
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const result = await client.query(
      "select fn_set_attendant_channel_binding($1,$2,$3,$4,$5) result",
      [GOV_ORG, userId, channelId, actorId, messageCapableProviders],
    );
    await client.query("commit");
    return result.rows[0].result as {
      changed: boolean;
      previous_channel_session_id: string | null;
      channel_session_id: string | null;
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  seedGov();
  await query(
    `insert into auth.users(id,email) values($1,'binding-other@invariant.test') on conflict do nothing`,
    [OTHER_USER],
  );
  await query(
    `insert into organizations(id,slug,legal_name,display_name)
     values($1,'binding-other','Binding Other','Binding Other') on conflict do nothing`,
    [OTHER_ORG],
  );
  await query(
    `insert into user_organizations(organization_id,user_id,role,accepted_at)
     values($1,$2,'admin',now()) on conflict do nothing`,
    [OTHER_ORG, OTHER_USER],
  );
  await query(
    `insert into channel_sessions
       (id,organization_id,waha_session_name,webhook_secret_encrypted)
     values
       ($1,$2,'binding-second','\\x00'::bytea),
       ($3,$2,'binding-archived','\\x00'::bytea),
       ($4,$5,'binding-other','\\x00'::bytea)
     on conflict(id) do nothing`,
    [SECOND_CHANNEL, GOV_ORG, ARCHIVED_CHANNEL, OTHER_CHANNEL, OTHER_ORG],
  );
  await query(
    `insert into channel_sessions
       (id,organization_id,provider,wacalls_session_id,webhook_secret_encrypted)
     values($1,$2,'wacalls','binding-voice','\\x00'::bytea)
     on conflict(id) do nothing`,
    [VOICE_CHANNEL, GOV_ORG],
  );
});

afterAll(() => pool.end());

beforeEach(async () => {
  await query("delete from attendant_channel_bindings");
  await query(
    "update user_organizations set revoked_at=null, accepted_at=coalesce(accepted_at,now()), role=case when user_id=$1 then 'viewer' else role end where organization_id=$2",
    [GOV_VIEWER, GOV_ORG],
  );
  await query(
    "update user_organizations set role='agent', revoked_at=null where organization_id=$1 and user_id=any($2)",
    [GOV_ORG, [GOV_AGENT_A, GOV_AGENT_B]],
  );
  await query("update channel_sessions set archived_at=null where id=any($1)", [
    [GOV_SESSION, SECOND_CHANNEL, ARCHIVED_CHANNEL, VOICE_CHANNEL],
  ]);
});

describe("conexão pessoal opcional por atendente", () => {
  it("manager cria, altera e remove sem deixar duas linhas para a pessoa", async () => {
    const created = await setBinding(GOV_AGENT_A, GOV_SESSION);
    expect(created).toMatchObject({ changed: true, channel_session_id: GOV_SESSION });

    const changed = await setBinding(GOV_AGENT_A, SECOND_CHANNEL);
    expect(changed).toMatchObject({
      changed: true,
      previous_channel_session_id: GOV_SESSION,
      channel_session_id: SECOND_CHANNEL,
    });
    expect(
      (
        await query(
          "select count(*)::int n from attendant_channel_bindings where organization_id=$1 and user_id=$2",
          [GOV_ORG, GOV_AGENT_A],
        )
      ).rows[0].n,
    ).toBe(1);

    const removed = await setBinding(GOV_AGENT_A, null);
    expect(removed).toMatchObject({
      changed: true,
      previous_channel_session_id: SECOND_CHANNEL,
      channel_session_id: null,
    });
    expect((await setBinding(GOV_AGENT_A, null)).changed).toBe(false);
  });

  it("agent lê só o próprio vínculo; manager lê a organização; vizinho não lê", async () => {
    await setBinding(GOV_AGENT_A, GOV_SESSION);
    expect(
      (
        await asUser(
          GOV_AGENT_A,
          "select * from attendant_channel_bindings where organization_id=$1",
          [GOV_ORG],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await asUser(
          GOV_AGENT_B,
          "select * from attendant_channel_bindings where organization_id=$1",
          [GOV_ORG],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await asUser(
          GOV_MANAGER,
          "select * from attendant_channel_bindings where organization_id=$1",
          [GOV_ORG],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await asUser(
          OTHER_USER,
          "select * from attendant_channel_bindings where organization_id=$1",
          [GOV_ORG],
        )
      ).rowCount,
    ).toBe(0);
  });

  it("authenticated não faz DML direto nem executa a RPC service-only", async () => {
    await expect(
      asUser(
        GOV_AGENT_A,
        `insert into attendant_channel_bindings
          (organization_id,user_id,channel_session_id,created_by_user_id)
         values($1,$2,$3,$2)`,
        [GOV_ORG, GOV_AGENT_A, GOV_SESSION],
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asUser(GOV_MANAGER, "select fn_set_attendant_channel_binding($1,$2,$3,$4,$5)", [
        GOV_ORG,
        GOV_AGENT_A,
        GOV_SESSION,
        GOV_MANAGER,
        ["waha"],
      ]),
    ).rejects.toThrow(/permission denied/i);
  });

  it("recusa sessão de outra organização também pela FK composta", async () => {
    await expect(setBinding(GOV_AGENT_A, OTHER_CHANNEL)).rejects.toMatchObject({ code: "P0002" });
    await expect(
      query(
        `insert into attendant_channel_bindings
          (organization_id,user_id,channel_session_id,created_by_user_id)
         values($1,$2,$3,$4)`,
        [GOV_ORG, GOV_AGENT_A, OTHER_CHANNEL, GOV_MANAGER],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("recusa sessão arquivada e capability de mensagens negada", async () => {
    await query("update channel_sessions set archived_at=now() where id=$1", [ARCHIVED_CHANNEL]);
    await expect(setBinding(GOV_AGENT_A, ARCHIVED_CHANNEL)).rejects.toMatchObject({
      code: "P0002",
    });
    await expect(setBinding(GOV_AGENT_A, VOICE_CHANNEL)).rejects.toMatchObject({
      code: "P0002",
    });
  });

  it("recusa membro revogado, viewer e ator sem autoridade", async () => {
    await query(
      "update user_organizations set revoked_at=now() where organization_id=$1 and user_id=$2",
      [GOV_ORG, GOV_AGENT_A],
    );
    await expect(setBinding(GOV_AGENT_A, GOV_SESSION)).rejects.toMatchObject({ code: "22023" });

    await expect(setBinding(GOV_VIEWER, GOV_SESSION)).rejects.toMatchObject({ code: "22023" });
    await expect(setBinding(GOV_AGENT_B, GOV_SESSION, GOV_VIEWER)).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("recusa convite ainda não aceito", async () => {
    await query(
      "update user_organizations set accepted_at=null where organization_id=$1 and user_id=$2",
      [GOV_ORG, GOV_AGENT_A],
    );
    await expect(setBinding(GOV_AGENT_A, GOV_SESSION)).rejects.toMatchObject({ code: "22023" });
  });

  it("uma conexão não pertence a dois atendentes para personal_handoff", async () => {
    await setBinding(GOV_AGENT_A, GOV_SESSION);
    await expect(setBinding(GOV_AGENT_B, GOV_SESSION)).rejects.toMatchObject({ code: "23505" });
    const rows = await query(
      "select user_id from attendant_channel_bindings where organization_id=$1 and channel_session_id=$2",
      [GOV_ORG, GOV_SESSION],
    );
    expect(rows.rows.map((row) => row.user_id)).toEqual([GOV_AGENT_A]);
  });

  it("rebaixamento, revogação ou membership pendente remove o vínculo", async () => {
    await setBinding(GOV_AGENT_A, GOV_SESSION);
    await query(
      "update user_organizations set role='viewer' where organization_id=$1 and user_id=$2",
      [GOV_ORG, GOV_AGENT_A],
    );
    expect(
      (
        await query(
          "select count(*)::int n from attendant_channel_bindings where organization_id=$1",
          [GOV_ORG],
        )
      ).rows[0].n,
    ).toBe(0);

    await query(
      "update user_organizations set role='agent', revoked_at=null where organization_id=$1 and user_id=$2",
      [GOV_ORG, GOV_AGENT_A],
    );
    await setBinding(GOV_AGENT_A, GOV_SESSION);
    await query(
      "update user_organizations set revoked_at=now() where organization_id=$1 and user_id=$2",
      [GOV_ORG, GOV_AGENT_A],
    );
    expect(
      (
        await query(
          "select count(*)::int n from attendant_channel_bindings where organization_id=$1",
          [GOV_ORG],
        )
      ).rows[0].n,
    ).toBe(0);
    await setBinding(GOV_AGENT_B, GOV_SESSION);

    await query(
      "update user_organizations set accepted_at=null where organization_id=$1 and user_id=$2",
      [GOV_ORG, GOV_AGENT_B],
    );
    expect(
      (
        await query(
          "select count(*)::int n from attendant_channel_bindings where organization_id=$1",
          [GOV_ORG],
        )
      ).rows[0].n,
    ).toBe(0);
  });
});
