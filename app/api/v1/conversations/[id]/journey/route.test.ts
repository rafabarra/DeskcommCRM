import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import {
  JourneyNotFoundError,
  loadConversationJourney,
} from "@/lib/inbox/journey-query";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { GET } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/inbox/journey-query", async (importOriginal) => {
  const original = await importOriginal();
  return { ...(original as object), loadConversationJourney: vi.fn() };
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const USER = "aaaaaaaa-0000-4000-8000-000000000002";
const CONVERSATION = "aaaaaaaa-0000-4000-8000-000000000003";
const session = { kind: "session" };
const admin = { kind: "admin" };
const ctx = { params: Promise.resolve({ id: CONVERSATION }) };

function request(query = "") {
  return new NextRequest(`http://localhost/api/v1/conversations/${CONVERSATION}/journey${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent", name: "Org" },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createClient).mockResolvedValue(session as never);
  vi.mocked(createAdminClient).mockReturnValue(admin as never);
  vi.mocked(loadConversationJourney).mockResolvedValue({
    page: {
      available: true,
      demand_id: "aaaaaaaa-0000-4000-8000-000000000004",
      active_conversation_id: CONVERSATION,
      episodes: [],
      items: [],
    },
    cursor: null,
    hasMore: false,
  });
});

describe("GET /api/v1/conversations/[id]/journey", () => {
  it("ancora tenant e visibilidade na sessão autenticada", async () => {
    const response = await GET(request("?limit=25"), ctx);

    expect(response.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("viewer", expect.anything());
    expect(loadConversationJourney).toHaveBeenCalledWith(session, admin, {
      organizationId: ORG,
      conversationId: CONVERSATION,
      limit: 25,
      cursor: null,
    });
  });

  it("recusa cursor opaco inválido antes de consultar o banco", async () => {
    const response = await GET(request("?cursor=nao-e-um-cursor"), ctx);

    expect(response.status).toBe(422);
    expect(loadConversationJourney).not.toHaveBeenCalled();
  });

  it("não revela uma conversation removida pela RLS", async () => {
    vi.mocked(loadConversationJourney).mockRejectedValue(new JourneyNotFoundError());

    const response = await GET(request(), ctx);

    expect(response.status).toBe(404);
  });

  it("traduz falha interna sem lançar erro cru na borda", async () => {
    vi.mocked(loadConversationJourney).mockRejectedValue(new Error("database_detail"));

    const response = await GET(request(), ctx);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "internal_error", message: "Não foi possível carregar a jornada." },
    });
  });
});
