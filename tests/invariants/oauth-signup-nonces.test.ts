import { beforeEach, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "05830000-0000-4000-8000-000000000001";
const USER = "05830000-0000-4000-8000-000000000002";
const OUTRO_USER = "05830000-0000-4000-8000-000000000003";
const SESSION = "05830000-0000-4000-8000-000000000004";
const HASH = "a".repeat(64);

function barrado(papel: "anon" | "authenticated", comando: string): boolean {
  try {
    sql(`set role ${papel}; ${comando}; reset role;`);
    return false;
  } catch (error) {
    return motivoDoErro(error).includes("permission denied");
  }
}

beforeEach(() => {
  sql(`
    delete from public.oauth_signup_nonces;
    insert into auth.users (id, email) values
      ('${USER}', 'nonce-a@example.test'),
      ('${OUTRO_USER}', 'nonce-b@example.test')
    on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'nonce-signup-0583', 'Nonce Signup 0583', 'Nonce Signup')
    on conflict (id) do nothing;
  `);
});

describe("oauth_signup_nonces", () => {
  it("é server-only com RLS ligada e sem policy", () => {
    expect(
      sql(
        `select relrowsecurity from pg_class where oid = 'public.oauth_signup_nonces'::regclass;`,
      ).trim(),
    ).toBe("t");
    expect(
      sql(
        `select count(*) from pg_policies where schemaname='public' and tablename='oauth_signup_nonces';`,
      ).trim(),
    ).toBe("0");
    expect(barrado("anon", "select * from public.oauth_signup_nonces")).toBe(true);
    expect(barrado("authenticated", "select * from public.oauth_signup_nonces")).toBe(true);
  });

  it("guarda só hash e todos os vínculos mínimos", () => {
    sql(`
      insert into public.oauth_signup_nonces
        (nonce_hash, flow_type, organization_id, user_id, auth_session_id, expires_at)
      values
        ('${HASH}', 'channel_embedded_signup', '${ORG}', '${USER}', '${SESSION}', now() + interval '10 minutes');
    `);
    expect(
      sql(`select nonce_hash || '|' || flow_type || '|' || organization_id || '|' || user_id || '|' || auth_session_id
             from public.oauth_signup_nonces where nonce_hash='${HASH}';`).trim(),
    ).toBe(`${HASH}|channel_embedded_signup|${ORG}|${USER}|${SESSION}`);
  });

  it("o UPDATE condicional consome exatamente uma vez", () => {
    sql(`
      insert into public.oauth_signup_nonces
        (nonce_hash, flow_type, organization_id, user_id, auth_session_id, expires_at)
      values
        ('${HASH}', 'channel_embedded_signup', '${ORG}', '${USER}', '${SESSION}', now() + interval '10 minutes');
    `);
    const consumir = () =>
      sql(`
        with consumido as (
          update public.oauth_signup_nonces
             set consumed_at = now()
           where nonce_hash = '${HASH}'
             and flow_type = 'channel_embedded_signup'
             and organization_id = '${ORG}'
             and user_id = '${USER}'
             and auth_session_id = '${SESSION}'
             and consumed_at is null
             and expires_at > now()
          returning nonce_hash
        ) select count(*) from consumido;
      `).trim();
    expect(consumir()).toBe("1");
    expect(consumir()).toBe("0");
  });

  it("vínculo errado ou prazo vencido não consome", () => {
    sql(`
      insert into public.oauth_signup_nonces
        (nonce_hash, flow_type, organization_id, user_id, auth_session_id, expires_at, created_at)
      values
        ('${HASH}', 'channel_embedded_signup', '${ORG}', '${USER}', '${SESSION}',
         now() - interval '1 minute', now() - interval '11 minutes');
    `);
    const resultado = sql(`
      with consumido as (
        update public.oauth_signup_nonces set consumed_at=now()
         where nonce_hash='${HASH}' and organization_id='${ORG}'
           and user_id='${OUTRO_USER}' and auth_session_id='${SESSION}'
           and consumed_at is null and expires_at > now()
        returning 1
      ) select count(*) from consumido;
    `).trim();
    expect(resultado).toBe("0");
    expect(
      sql(
        `select consumed_at is null from public.oauth_signup_nonces where nonce_hash='${HASH}';`,
      ).trim(),
    ).toBe("t");
  });
});
