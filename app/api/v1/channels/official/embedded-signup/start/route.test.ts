import { readFileSync } from "node:fs";

import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isPublicPath } from "@/lib/auth/public-paths";
import { verificarEstadoDoSignup } from "@/lib/channels/meta/estado-do-signup";

const deps = vi.hoisted(() => ({
  appDaMeta: vi.fn(),
  audit: vi.fn(),
  authenticatedSessionId: vi.fn(),
  cookieSecure: vi.fn(),
  criarNonce: vi.fn(),
  requireRole: vi.fn(),
  support: vi.fn(),
  admin: {},
}));

vi.mock("@/lib/channels/meta/app", () => ({ appDaMeta: deps.appDaMeta }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.requireRole }));
vi.mock("@/lib/impersonate/support", () => ({
  authenticatedSessionId: deps.authenticatedSessionId,
  requireSupportWrite: deps.support,
}));
vi.mock("@/lib/oauth/signup-nonce", () => ({ criarNonceDeSignup: deps.criarNonce }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => deps.admin }));
vi.mock("@/lib/supabase/cookie-secure", () => ({ cookieSecure: deps.cookieSecure }));
vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_SECRET: "segredo-interno-de-teste-com-tamanho-suficiente",
  },
}));

import { GET } from "./route";

const ROTA = "/api/v1/channels/official/embedded-signup/start";
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const HOSTED = "https://business.facebook.com/wa/manage/embedded-signup/?config=servidor";

function request(query = ""): NextRequest {
  return new NextRequest(`https://crm.exemplo${ROTA}${query}`, {
    headers: { "x-request-id": "req-signup-1" },
  });
}

function sucesso(): void {
  deps.support.mockResolvedValue(null);
  deps.requireRole.mockResolvedValue({
    ok: true,
    user: { id: USER, email: "admin@example.test" },
    org: { orgId: ORG, name: "Org", role: "admin" },
  });
  deps.appDaMeta.mockResolvedValue({
    appId: "123456789",
    hostedSignupUrl: HOSTED,
    appSecret: null,
    verifyToken: null,
  });
  deps.authenticatedSessionId.mockResolvedValue(SESSION);
  deps.criarNonce.mockResolvedValue({ ok: true });
  deps.cookieSecure.mockReturnValue(true);
  deps.audit.mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
  sucesso();
});

describe(`GET ${ROTA}`, () => {
  it("continua atrás do proxy autenticado; só a probe de volta é pública", () => {
    expect(isPublicPath(ROTA)).toBe(false);
    expect(isPublicPath("/api/v1/channels/official/embedded-signup/probe")).toBe(true);
  });

  it("repassa 401 de usuário não autenticado", async () => {
    deps.requireRole.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: { code: "unauthenticated" } }, { status: 401 }),
    });
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(deps.appDaMeta).not.toHaveBeenCalled();
    expect(deps.criarNonce).not.toHaveBeenCalled();
  });

  it("exige admin e não persiste para papel insuficiente", async () => {
    deps.requireRole.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: { code: "forbidden_role" } }, { status: 403 }),
    });
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(deps.requireRole).toHaveBeenCalledWith("admin", expect.any(Object));
    expect(deps.criarNonce).not.toHaveBeenCalled();
  });

  it("barra suporte somente leitura antes do RBAC", async () => {
    deps.support.mockResolvedValue(
      NextResponse.json({ error: { code: "forbidden" } }, { status: 403 }),
    );
    expect((await GET(request())).status).toBe(403);
    expect(deps.requireRole).not.toHaveBeenCalled();
  });

  it.each([
    [{ appId: null, hostedSignupUrl: HOSTED }, "App ID"],
    [{ appId: "123", hostedSignupUrl: null }, "URL hospedada"],
    [{ appId: "123", hostedSignupUrl: "http://meta.example/signup" }, "inválida"],
    [{ appId: "123", hostedSignupUrl: "não-é-url" }, "inválida"],
  ])("falha fechado com configuração incompleta/inválida", async (app, trecho) => {
    deps.appDaMeta.mockResolvedValue({ ...app, appSecret: null, verifyToken: null });
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.text()).toContain(trecho);
    expect(deps.criarNonce).not.toHaveBeenCalled();
  });

  it("cria nonce de dez minutos vinculado só à sessão confiável e redireciona à URL intacta", async () => {
    const antes = Date.now();
    const response = await GET(
      request(
        "?organization_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&user_id=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb&state=forjado",
      ),
    );
    const depois = Date.now();

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(HOSTED);
    expect(deps.criarNonce).toHaveBeenCalledWith(
      deps.admin,
      expect.objectContaining({
        flowType: "channel_embedded_signup",
        organizationId: ORG,
        userId: USER,
        authSessionId: SESSION,
      }),
    );
    const vinculo = deps.criarNonce.mock.calls[0]?.[1];
    expect(vinculo.expiresAt.getTime()).toBeGreaterThanOrEqual(antes + 10 * 60 * 1000);
    expect(vinculo.expiresAt.getTime()).toBeLessThanOrEqual(depois + 10 * 60 * 1000);
    expect(JSON.stringify(vinculo)).not.toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(JSON.stringify(vinculo)).not.toContain("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(response.headers.get("location")).not.toContain("state=");
  });

  it("cookie é HttpOnly, Lax, Secure, limitado ao fluxo e contém state válido", async () => {
    const response = await GET(request());
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("crm_embedded_signup_state=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("Max-Age=600");
    expect(setCookie).toContain(`Path=/api/v1/channels/official/embedded-signup`);

    const valor = setCookie.match(/crm_embedded_signup_state=([^;]+)/)?.[1];
    const state = verificarEstadoDoSignup(valor, {
      segredo: "segredo-interno-de-teste-com-tamanho-suficiente",
      agora: new Date(),
    });
    expect(state).toMatchObject({
      organizationId: ORG,
      userId: USER,
      authSessionId: SESSION,
      nonce: deps.criarNonce.mock.calls[0]?.[1].nonce,
    });
  });

  it("Secure acompanha a URL pública e a sessão opcional pode faltar", async () => {
    deps.cookieSecure.mockReturnValue(false);
    deps.authenticatedSessionId.mockRejectedValue(new Error("claim ausente"));
    const response = await GET(request());
    expect(response.headers.get("set-cookie")).not.toContain("Secure");
    expect(deps.criarNonce.mock.calls[0]?.[1]).not.toHaveProperty("authSessionId");
  });

  it("falha sem cookie nem redirect quando persistir o nonce falha", async () => {
    deps.criarNonce.mockResolvedValue({ ok: false, code: "08006" });
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("não chama Graph, não conecta canal e não persiste token", async () => {
    await GET(request("?code=segredo-que-deve-ser-ignorado"));
    expect(fetch).not.toHaveBeenCalled();
    const fonte = readFileSync(
      "app/api/v1/channels/official/embedded-signup/start/route.ts",
      "utf8",
    );
    expect(fonte).not.toMatch(
      /graph\.facebook\.com|conectarCanalMetaOficial|business_token|token_encrypted/,
    );
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.embedded_signup_started",
        actorUserId: USER,
        organizationId: ORG,
      }),
    );
  });
});
