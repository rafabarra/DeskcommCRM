import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { consumirNonceDeSignup, criarNonceDeSignup, hashDoNonce } from "@/lib/oauth/signup-nonce";

const NONCE = "nonce-secreto-que-nao-deve-chegar-ao-banco";
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";

interface Linha {
  nonce_hash: string;
  flow_type: string;
  organization_id: string;
  user_id: string;
  auth_session_id: string | null;
  expires_at: string;
  consumed_at?: string | null;
}

function bancoEmMemoria() {
  let linha: Linha | null = null;
  return {
    linha: () => linha,
    db: {
      from: () => ({
        insert: async (valor: Linha) => {
          linha = { ...valor, consumed_at: null };
          return { error: null };
        },
        update: (mudanca: Pick<Linha, "consumed_at">) => {
          const filtros: Array<(registro: Linha) => boolean> = [];
          const query = {
            eq(campo: keyof Linha, valor: unknown) {
              filtros.push((registro) => registro[campo] === valor);
              return query;
            },
            is(campo: keyof Linha, valor: unknown) {
              filtros.push((registro) => registro[campo] === valor);
              return query;
            },
            gt(campo: keyof Linha, valor: string) {
              filtros.push((registro) => String(registro[campo]) > valor);
              return query;
            },
            async select() {
              if (!linha || !filtros.every((filtro) => filtro(linha!))) {
                return { data: [], error: null };
              }
              linha = { ...linha, ...mudanca };
              return { data: [{ nonce_hash: linha.nonce_hash }], error: null };
            },
          };
          return query;
        },
      }),
    } as unknown as SupabaseClient,
  };
}

describe("nonce genérico de OAuth/signup", () => {
  it("persiste somente o hash e os vínculos", async () => {
    const memoria = bancoEmMemoria();
    const expiresAt = new Date("2026-10-07T12:10:00.000Z");
    expect(
      await criarNonceDeSignup(memoria.db, {
        nonce: NONCE,
        flowType: "channel_embedded_signup",
        organizationId: ORG,
        userId: USER,
        authSessionId: SESSION,
        expiresAt,
      }),
    ).toEqual({ ok: true });
    expect(memoria.linha()).toMatchObject({
      nonce_hash: hashDoNonce(NONCE),
      organization_id: ORG,
      user_id: USER,
      auth_session_id: SESSION,
      expires_at: expiresAt.toISOString(),
    });
    expect(JSON.stringify(memoria.linha())).not.toContain(NONCE);
  });

  it("consome uma vez e exige todos os vínculos e o prazo", async () => {
    const memoria = bancoEmMemoria();
    await criarNonceDeSignup(memoria.db, {
      nonce: NONCE,
      flowType: "channel_embedded_signup",
      organizationId: ORG,
      userId: USER,
      authSessionId: SESSION,
      expiresAt: new Date("2026-10-07T12:10:00.000Z"),
    });
    const vinculo = {
      nonce: NONCE,
      flowType: "channel_embedded_signup",
      organizationId: ORG,
      userId: USER,
      authSessionId: SESSION,
    };
    const agora = new Date("2026-10-07T12:05:00.000Z");
    expect(await consumirNonceDeSignup(memoria.db, { ...vinculo, userId: ORG }, agora)).toEqual({
      ok: true,
      consumed: false,
    });
    expect(await consumirNonceDeSignup(memoria.db, vinculo, agora)).toEqual({
      ok: true,
      consumed: true,
    });
    expect(await consumirNonceDeSignup(memoria.db, vinculo, agora)).toEqual({
      ok: true,
      consumed: false,
    });
  });

  it("falha fechado quando o armazenamento lança", async () => {
    const db = {
      from: () => {
        throw new Error("banco indisponível");
      },
    } as unknown as SupabaseClient;
    const vinculo = {
      nonce: NONCE,
      flowType: "channel_embedded_signup",
      organizationId: ORG,
      userId: USER,
      authSessionId: SESSION,
    };
    expect(
      await criarNonceDeSignup(db, {
        ...vinculo,
        expiresAt: new Date("2026-10-07T12:10:00.000Z"),
      }),
    ).toEqual({ ok: false });
    expect(await consumirNonceDeSignup(db, vinculo, new Date("2026-10-07T12:05:00.000Z"))).toEqual({
      ok: false,
    });
  });
});
