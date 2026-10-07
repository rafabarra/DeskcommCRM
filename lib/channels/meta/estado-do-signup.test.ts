import { describe, expect, it } from "vitest";

import {
  emitirEstadoDoSignup,
  TIPO_DO_FLUXO_SIGNUP,
  VALIDADE_DO_SIGNUP_MS,
  verificarEstadoDoSignup,
} from "@/lib/channels/meta/estado-do-signup";

const SEGREDO = "segredo-interno-de-teste-com-tamanho-suficiente";
const AGORA = new Date("2026-10-07T12:00:00.000Z");
const DADOS = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  authSessionId: "33333333-3333-4333-8333-333333333333",
  nonce: "nonce_seguro_de_teste_com_mais_de_32_caracteres",
};

describe("state do Embedded Signup", () => {
  it("assina organização, pessoa, sessão, nonce, tipo e prazo de dez minutos", () => {
    const token = emitirEstadoDoSignup(DADOS, { segredo: SEGREDO, agora: AGORA });
    expect(verificarEstadoDoSignup(token, { segredo: SEGREDO, agora: AGORA })).toEqual({
      v: 1,
      fluxo: TIPO_DO_FLUXO_SIGNUP,
      ...DADOS,
      expiraEmMs: AGORA.getTime() + VALIDADE_DO_SIGNUP_MS,
    });
  });

  it("recusa adulteração sem revelar qual campo falhou", () => {
    const token = emitirEstadoDoSignup(DADOS, { segredo: SEGREDO, agora: AGORA });
    const [carga, assinatura] = token.split(".");
    if (!carga || !assinatura) throw new Error("state inválido no arranjo do teste");
    const alterada = Buffer.from(
      Buffer.from(carga, "base64url").toString("utf8").replace(DADOS.userId, DADOS.organizationId),
      "utf8",
    ).toString("base64url");
    expect(
      verificarEstadoDoSignup(`${alterada}.${assinatura}`, { segredo: SEGREDO, agora: AGORA }),
    ).toBeNull();
  });

  it("aceita a borda e vence um milissegundo depois", () => {
    const token = emitirEstadoDoSignup(DADOS, { segredo: SEGREDO, agora: AGORA });
    const expira = new Date(AGORA.getTime() + VALIDADE_DO_SIGNUP_MS);
    expect(verificarEstadoDoSignup(token, { segredo: SEGREDO, agora: expira })).not.toBeNull();
    expect(
      verificarEstadoDoSignup(token, { segredo: SEGREDO, agora: new Date(expira.getTime() + 1) }),
    ).toBeNull();
  });

  it("falha fechado sem segredo forte", () => {
    expect(() => emitirEstadoDoSignup(DADOS, { segredo: "curto", agora: AGORA })).toThrow(
      /Segredo interno indisponível/,
    );
  });
});
