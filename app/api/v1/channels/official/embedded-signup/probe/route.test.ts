import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { isPublicPath } from "@/lib/auth/public-paths";

const efeitos = vi.hoisted(() => ({
  audit: vi.fn(),
  conectar: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ audit: efeitos.audit }));
vi.mock("@/lib/channels/meta/conectar-canal-oficial", () => ({
  conectarCanalMetaOficial: efeitos.conectar,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: efeitos.createAdminClient }));

import { GET } from "./route";

const ROTA = "/api/v1/channels/official/embedded-signup/probe";

function requisicao(query = "", headers?: HeadersInit): Request {
  return new Request(`https://crm.exemplo${ROTA}${query}`, { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});

describe(`GET ${ROTA}`, () => {
  it("sem parâmetros entrega uma página humana e inerte", async () => {
    const resposta = await GET(requisicao());
    const html = await resposta.text();

    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html).toContain("Retorno do Meta Hosted Signup recebido.");
    expect(html).toContain("Nenhuma credencial foi salva e nenhum número foi conectado.");
    expect(html).toContain("Nenhum parâmetro recebido.");
    expect(html).toContain("Método HTTP</th><td>GET");
    expect(html).toContain(`Path da callback</th><td>${ROTA}`);
    expect(html).toMatch(/Timestamp<\/th><td>\d{4}-\d{2}-\d{2}T/);
    expect(html).toContain('href="/admin/meta"');
    expect(resposta.headers.get("set-cookie")).toBeNull();
  });

  it("mostra só presença e comprimento do code, nunca o conteúdo", async () => {
    const segredo = "code-super-secreto-123";
    const resposta = await GET(requisicao(`?code=${encodeURIComponent(segredo)}`));
    const html = await resposta.text();

    expect(html).toContain("code presente</th><td>true");
    expect(html).toContain(`comprimento de code</th><td>${segredo.length}`);
    expect(html).toContain("<code>code</code>");
    expect(html).not.toContain(segredo);
  });

  it("faz o mesmo com state e não reflete valores de erro", async () => {
    const state = "state-sensivel-456";
    const erro = "valor-de-erro-que-nao-deve-voltar";
    const resposta = await GET(
      requisicao(
        `?state=${encodeURIComponent(state)}&error=${encodeURIComponent(erro)}` +
          "&error_reason=razao-secreta&error_description=descricao-secreta",
      ),
    );
    const html = await resposta.text();

    expect(html).toContain("state presente</th><td>true");
    expect(html).toContain(`comprimento de state</th><td>${state.length}`);
    expect(html).toContain("error presente</th><td>true");
    expect(html).toContain("error_reason presente</th><td>true");
    expect(html).toContain("error_description presente</th><td>true");
    for (const valor of [state, erro, "razao-secreta", "descricao-secreta"]) {
      expect(html).not.toContain(valor);
    }
  });

  it("parâmetro desconhecido mostra só o nome escapado, nunca o valor", async () => {
    const valor = "segredo-desconhecido-789";
    const resposta = await GET(
      requisicao(
        `?campo%3Cscript%3E=${encodeURIComponent(valor)}` +
          "&organization_id=org-nao-confiavel&user_id=user-nao-confiavel",
      ),
    );
    const html = await resposta.text();

    expect(html).toContain("<code>campo&lt;script&gt;</code>");
    expect(html).toContain("<code>organization_id</code>");
    expect(html).toContain("<code>user_id</code>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain(valor);
    expect(html).not.toContain("org-nao-confiavel");
    expect(html).not.toContain("user-nao-confiavel");
  });

  it("não cacheia nem envia a URL sensível como referrer", async () => {
    const resposta = await GET(requisicao("?code=nao-cachear"));

    expect(resposta.headers.get("cache-control")).toBe("no-store");
    expect(resposta.headers.get("pragma")).toBe("no-cache");
    expect(resposta.headers.get("referrer-policy")).toBe("no-referrer");
    expect(resposta.headers.get("x-content-type-options")).toBe("nosniff");
    expect(resposta.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("é alcançável numa volta cross-site, mas só no path exato", async () => {
    expect(isPublicPath(ROTA)).toBe(true);
    expect(isPublicPath(`${ROTA}/admin`)).toBe(false);

    const resposta = await GET(requisicao("?code=abc", { "Sec-Fetch-Site": "cross-site" }));
    expect(resposta.status).toBe(200);
  });

  it("não toca banco, auditoria, Graph API nem serviço de conexão", async () => {
    const resposta = await GET(
      requisicao("?code=credencial&state=estado&organization_id=org&user_id=user"),
    );
    await resposta.text();

    expect(efeitos.createAdminClient).not.toHaveBeenCalled();
    expect(efeitos.audit).not.toHaveBeenCalled();
    expect(efeitos.conectar).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    const fonte = readFileSync(
      "app/api/v1/channels/official/embedded-signup/probe/route.ts",
      "utf8",
    );
    expect(fonte).not.toMatch(
      /createAdminClient|conectarCanalMetaOficial|\baudit\s*\(|fetch\s*\(|\blogger\b|captureException|console\./,
    );
  });
});
