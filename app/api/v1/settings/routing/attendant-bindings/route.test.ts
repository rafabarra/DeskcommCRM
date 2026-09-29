import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { PROVIDERS_DE_MENSAGEM, PROVIDERS_SEM_MENSAGEM } from "@/lib/channels/capabilities";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { PATCH } from "./route";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG = "10000000-0000-4000-8000-000000000001";
const MANAGER = "10000000-0000-4000-8000-000000000002";
const ATTENDANT = "10000000-0000-4000-8000-000000000003";
const CHANNEL = "10000000-0000-4000-8000-000000000004";
const PREVIOUS_CHANNEL = "10000000-0000-4000-8000-000000000005";

const rpc = vi.fn();
const memberSingle = vi.fn();
const channelSingle = vi.fn();
const memberEq = vi.fn();
const channelEq = vi.fn();

function builder(single: typeof memberSingle, eq: typeof memberEq) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn((column: string, value: unknown) => {
      eq(column, value);
      return chain;
    }),
    not: vi.fn(() => chain),
    maybeSingle: single,
  };
  return chain;
}

const memberBuilder = builder(memberSingle, memberEq);
const channelBuilder = builder(channelSingle, channelEq);
const from = vi.fn((table: string) => {
  if (table === "user_organizations") return memberBuilder;
  if (table === "channel_sessions") return channelBuilder;
  throw new Error(`unexpected table: ${table}`);
});

function request(body: unknown): Request {
  return new Request("http://localhost/api/v1/settings/routing/attendant-bindings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: MANAGER },
    org: { orgId: ORG },
  } as never);
  vi.mocked(mfaEmDivida).mockResolvedValue(false);
  vi.mocked(createAdminClient).mockReturnValue({ from, rpc } as never);
  memberSingle.mockResolvedValue({
    data: {
      user_id: ATTENDANT,
      role: "agent",
      revoked_at: null,
      accepted_at: "2026-09-28T00:00:00Z",
    },
    error: null,
  });
  channelSingle.mockResolvedValue({
    data: { id: CHANNEL, provider: PROVIDERS_DE_MENSAGEM[0], archived_at: null },
    error: null,
  });
  rpc.mockResolvedValue({
    data: {
      user_id: ATTENDANT,
      purpose: "personal_handoff",
      previous_channel_session_id: null,
      channel_session_id: CHANNEL,
      changed: true,
    },
    error: null,
  });
});

describe("configuração da conexão pessoal do atendente", () => {
  it("manager cria o vínculo com organização e ator vindos da sessão", async () => {
    const response = await PATCH(request({ user_id: ATTENDANT, channel_session_id: CHANNEL }));

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_set_attendant_channel_binding", {
      p_org: ORG,
      p_user_id: ATTENDANT,
      p_channel_session_id: CHANNEL,
      p_actor_user_id: MANAGER,
      p_message_capable_providers: [...PROVIDERS_DE_MENSAGEM],
    });
    expect(memberEq).toHaveBeenCalledWith("organization_id", ORG);
    expect(channelEq).toHaveBeenCalledWith("organization_id", ORG);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "routing.config_changed",
        organizationId: ORG,
        resourceId: ATTENDANT,
        metadata: expect.objectContaining({ channel_session_id: CHANNEL }),
      }),
    );
  });

  it("manager altera o vínculo e a auditoria conserva origem e destino", async () => {
    rpc.mockResolvedValue({
      data: {
        user_id: ATTENDANT,
        purpose: "personal_handoff",
        previous_channel_session_id: PREVIOUS_CHANNEL,
        channel_session_id: CHANNEL,
        changed: true,
      },
      error: null,
    });

    expect((await PATCH(request({ user_id: ATTENDANT, channel_session_id: CHANNEL }))).status).toBe(
      200,
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          purpose: "personal_handoff",
          previous_channel_session_id: PREVIOUS_CHANNEL,
          channel_session_id: CHANNEL,
        },
      }),
    );
  });

  it("manager remove o vínculo sem exigir que a conexão antiga ainda seja válida", async () => {
    rpc.mockResolvedValue({
      data: {
        user_id: ATTENDANT,
        purpose: "personal_handoff",
        previous_channel_session_id: PREVIOUS_CHANNEL,
        channel_session_id: null,
        changed: true,
      },
      error: null,
    });

    const response = await PATCH(request({ user_id: ATTENDANT, channel_session_id: null }));
    expect(response.status).toBe(200);
    expect(from).not.toHaveBeenCalledWith("channel_sessions");
    expect(rpc).toHaveBeenCalledWith(
      "fn_set_attendant_channel_binding",
      expect.objectContaining({
        p_channel_session_id: null,
        p_message_capable_providers: [...PROVIDERS_DE_MENSAGEM],
      }),
    );
  });

  it("agent não escreve e support readonly não chega à RPC", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    expect((await PATCH(request({ user_id: ATTENDANT, channel_session_id: CHANNEL }))).status).toBe(
      403,
    );
    expect(rpc).not.toHaveBeenCalled();

    vi.mocked(requireSupportWrite).mockResolvedValueOnce(
      new Response(null, { status: 403 }) as never,
    );
    expect((await PATCH(request({ user_id: ATTENDANT, channel_session_id: CHANNEL }))).status).toBe(
      403,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("MFA em dívida recusa antes de ler ou gravar", async () => {
    vi.mocked(mfaEmDivida).mockResolvedValue(true);
    expect((await PATCH(request({ user_id: ATTENDANT, channel_session_id: CHANNEL }))).status).toBe(
      403,
    );
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("não aceita organização no corpo nem usa sessão de outra organização", async () => {
    expect(
      (
        await PATCH(
          request({
            user_id: ATTENDANT,
            channel_session_id: CHANNEL,
            organization_id: "20000000-0000-4000-8000-000000000001",
          }),
        )
      ).status,
    ).toBe(422);

    channelSingle.mockResolvedValueOnce({ data: null, error: null });
    expect((await PATCH(request({ user_id: ATTENDANT, channel_session_id: CHANNEL }))).status).toBe(
      404,
    );
    expect(channelEq).toHaveBeenCalledWith("organization_id", ORG);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    [
      "sessão arquivada",
      {
        id: CHANNEL,
        provider: PROVIDERS_DE_MENSAGEM[0],
        archived_at: "2026-09-28T00:00:00Z",
      },
    ],
    [
      "provider sem mensagens",
      { id: CHANNEL, provider: PROVIDERS_SEM_MENSAGEM[0], archived_at: null },
    ],
  ])("recusa %s", async (_label, channel) => {
    channelSingle.mockResolvedValueOnce({ data: channel, error: null });
    expect((await PATCH(request({ user_id: ATTENDANT, channel_session_id: CHANNEL }))).status).toBe(
      422,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    [
      "membro revogado",
      {
        user_id: ATTENDANT,
        role: "agent",
        revoked_at: "2026-09-28T00:00:00Z",
        accepted_at: "2026-09-28T00:00:00Z",
      },
    ],
    [
      "convite ainda não aceito",
      { user_id: ATTENDANT, role: "agent", revoked_at: null, accepted_at: null },
    ],
    [
      "membro inelegível",
      {
        user_id: ATTENDANT,
        role: "viewer",
        revoked_at: null,
        accepted_at: "2026-09-28T00:00:00Z",
      },
    ],
  ])("recusa %s", async (_label, member) => {
    memberSingle.mockResolvedValueOnce({ data: member, error: null });
    expect((await PATCH(request({ user_id: ATTENDANT, channel_session_id: CHANNEL }))).status).toBe(
      422,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("traduz a unicidade da conexão em conflito e não audita falha", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "23505" } });
    expect((await PATCH(request({ user_id: ATTENDANT, channel_session_id: CHANNEL }))).status).toBe(
      409,
    );
    expect(audit).not.toHaveBeenCalled();
  });

  it("falha fechado se a autoridade mudar entre o guard e a transação", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    expect((await PATCH(request({ user_id: ATTENDANT, channel_session_id: CHANNEL }))).status).toBe(
      403,
    );
    expect(audit).not.toHaveBeenCalled();
  });

  it("não audita uma gravação idempotente sem mudança", async () => {
    rpc.mockResolvedValue({
      data: {
        user_id: ATTENDANT,
        purpose: "personal_handoff",
        previous_channel_session_id: CHANNEL,
        channel_session_id: CHANNEL,
        changed: false,
      },
      error: null,
    });
    expect((await PATCH(request({ user_id: ATTENDANT, channel_session_id: CHANNEL }))).status).toBe(
      200,
    );
    expect(audit).not.toHaveBeenCalled();
  });
});
