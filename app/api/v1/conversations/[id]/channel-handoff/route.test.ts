import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { PROVIDERS_DE_MENSAGEM } from "@/lib/channels/capabilities";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { loadManualChannelHandoffAvailability } from "@/lib/routing/manual-channel-handoff";
import { createAdminClient } from "@/lib/supabase/admin";

import { GET, POST } from "./route";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/routing/manual-channel-handoff", () => ({
  loadManualChannelHandoffAvailability: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const USER = "aaaaaaaa-0000-4000-8000-000000000002";
const SOURCE = "aaaaaaaa-0000-4000-8000-000000000003";
const DESTINATION = "aaaaaaaa-0000-4000-8000-000000000004";
const DEMANDA = "aaaaaaaa-0000-4000-8000-000000000005";
const SESSION = "aaaaaaaa-0000-4000-8000-000000000006";
const KEY = "aaaaaaaa-0000-4000-8000-000000000007";

const rpc = vi.fn();
const ctx = { params: Promise.resolve({ id: SOURCE }) };

function request(body: unknown = {}, key: string | null = KEY) {
  return new NextRequest(`http://localhost/api/v1/conversations/${SOURCE}/channel-handoff`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(
    null as unknown as Awaited<ReturnType<typeof requireSupportWrite>>,
  );
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent", name: "Org" },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createAdminClient).mockReturnValue({ rpc } as never);
  vi.mocked(loadManualChannelHandoffAvailability).mockResolvedValue({
    available: true,
    destination_channel_name: "Número pessoal",
  });
  rpc.mockResolvedValue({
    data: {
      id: KEY,
      status: "completed",
      replayed: false,
      source_conversation_id: SOURCE,
      destination_conversation_id: DESTINATION,
      demanda_id: DEMANDA,
      destination_channel_session_id: SESSION,
      assigned_user_id: USER,
    },
    error: null,
  });
});

describe("GET /api/v1/conversations/[id]/channel-handoff", () => {
  it("calcula disponibilidade com tenant e ator vindos da sessão", async () => {
    const response = await GET(
      new NextRequest(`http://localhost/api/v1/conversations/${SOURCE}/channel-handoff`),
      ctx,
    );
    expect(response.status).toBe(200);
    expect(loadManualChannelHandoffAvailability).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      SOURCE,
      USER,
      "agent",
    );
  });
});

describe("POST /api/v1/conversations/[id]/channel-handoff", () => {
  it("resolve o destino na RPC sem aceitar channel_session_id do cliente", async () => {
    const response = await POST(request(), ctx);
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_manual_channel_handoff", {
      p_org: ORG,
      p_source_conversation_id: SOURCE,
      p_actor_user_id: USER,
      p_idempotency_key: KEY,
      p_message_capable_providers: [...PROVIDERS_DE_MENSAGEM],
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.channel_handoff_completed",
        organizationId: ORG,
        actorUserId: USER,
        resourceId: SOURCE,
      }),
    );
  });

  it("recusa qualquer destino enviado pelo navegador", async () => {
    const response = await POST(request({ channel_session_id: SESSION }), ctx);
    expect(response.status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("exige chave UUID de idempotência", async () => {
    expect((await POST(request({}, null), ctx)).status).toBe(422);
    expect((await POST(request({}, "nao-e-uuid"), ctx)).status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("mapeia ownership para 403 e audita a falha", async () => {
    rpc.mockResolvedValue({
      data: { status: "failed", failure_code: "source_not_owned" },
      error: null,
    });
    const response = await POST(request(), ctx);
    expect(response.status).toBe(403);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.channel_handoff_failed",
        metadata: expect.objectContaining({ failure_code: "source_not_owned" }),
      }),
    );
  });

  it("replay devolve o mesmo destino sem duplicar o audit de sucesso", async () => {
    rpc.mockResolvedValue({
      data: {
        status: "completed",
        replayed: true,
        destination_conversation_id: DESTINATION,
      },
      error: null,
    });
    const response = await POST(request(), ctx);
    expect(response.status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });
});
