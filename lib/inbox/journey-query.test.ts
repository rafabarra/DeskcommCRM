import { describe, expect, it, vi } from "vitest";

import {
  decodeJourneyCursor,
  encodeJourneyCursor,
  loadConversationJourney,
} from "./journey-query";

class QueryFake {
  readonly calls: Array<[string, ...unknown[]]> = [];

  constructor(private readonly result: { data: unknown; error: null }) {}

  select(...args: unknown[]) { this.calls.push(["select", ...args]); return this; }
  eq(...args: unknown[]) { this.calls.push(["eq", ...args]); return this; }
  in(...args: unknown[]) { this.calls.push(["in", ...args]); return this; }
  order(...args: unknown[]) { this.calls.push(["order", ...args]); return this; }
  limit(...args: unknown[]) { this.calls.push(["limit", ...args]); return this; }
  or(...args: unknown[]) { this.calls.push(["or", ...args]); return this; }
  gte(...args: unknown[]) { this.calls.push(["gte", ...args]); return this; }
  lte(...args: unknown[]) { this.calls.push(["lte", ...args]); return this; }
  lt(...args: unknown[]) { this.calls.push(["lt", ...args]); return this; }
  maybeSingle() { this.calls.push(["maybeSingle"]); return Promise.resolve(this.result); }
  then(resolve: (value: { data: unknown; error: null }) => unknown, reject?: (error: unknown) => unknown) {
    return Promise.resolve(this.result).then(resolve, reject);
  }
}

describe("cursor da jornada", () => {
  it("preserva o eixo global de mensagem", () => {
    const raw = encodeJourneyCursor({
      kind: "message",
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      occurred_at: "2026-09-29T12:00:00.000Z",
      conversation_id: "conv-a",
      message: {} as never,
    });

    expect(decodeJourneyCursor(raw)).toEqual({
      version: 1,
      kind: "message",
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      occurred_at: "2026-09-29T12:00:00.000Z",
    });
  });

  it("recusa payload malformado, versão desconhecida e id que não é UUID", () => {
    expect(decodeJourneyCursor("nao-base64")).toBeNull();
    expect(
      decodeJourneyCursor(
        Buffer.from(
          JSON.stringify({
            version: 2,
            kind: "message",
            id: "nao-uuid",
            occurred_at: "ontem",
          }),
        ).toString("base64url"),
      ),
    ).toBeNull();
  });
});

describe("permissões da projeção da jornada", () => {
  it("usa a sessão para fechar os episódios e passa só esses ids ao recibo server-only", async () => {
    const org = "aaaaaaaa-0000-4000-8000-000000000001";
    const contact = "aaaaaaaa-0000-4000-8000-000000000002";
    const demand = "aaaaaaaa-0000-4000-8000-000000000003";
    const source = "aaaaaaaa-0000-4000-8000-000000000004";
    const destination = "aaaaaaaa-0000-4000-8000-000000000005";
    const handoff = "aaaaaaaa-0000-4000-8000-000000000006";
    const sourceQuery = new QueryFake({
      data: { id: source, contact_id: contact, current_demanda_id: demand, status: "open", service_revision: 1 },
      error: null,
    });
    const demandQuery = new QueryFake({
      data: { id: demand, contact_id: contact, aberta_em: "2026-09-29T10:00:00.000Z", fechada_em: null },
      error: null,
    });
    const linksQuery = new QueryFake({
      data: [source, destination].map((conversation_id, index) => ({
        conversation_id,
        service_revision: 1,
        vinculada_em: `2026-09-29T10:0${index}:00.000Z`,
      })),
      error: null,
    });
    const visibleQuery = new QueryFake({
      data: [source, destination].map((id) => ({
        id,
        contact_id: contact,
        current_demanda_id: demand,
        status: "open",
        service_revision: 1,
        channel_sessions: null,
      })),
      error: null,
    });
    const messagesQuery = new QueryFake({ data: [], error: null });
    const handoffsQuery = new QueryFake({
      data: [{
        id: handoff,
        created_at: "2026-09-29T10:01:00.000Z",
        source_conversation_id: source,
        destination_conversation_id: destination,
      }],
      error: null,
    });
    const queues: Record<string, QueryFake[]> = {
      conversations: [sourceQuery, visibleQuery],
      demandas: [demandQuery],
      demanda_conversas: [linksQuery],
      messages: [messagesQuery],
    };
    const session = { from: vi.fn((table: string) => queues[table]!.shift()!) };
    const admin = { from: vi.fn(() => handoffsQuery) };

    const result = await loadConversationJourney(session as never, admin as never, {
      organizationId: org,
      conversationId: source,
      limit: 50,
      cursor: null,
    });

    expect(session.from.mock.calls.map(([table]) => table)).toEqual([
      "conversations",
      "demandas",
      "demanda_conversas",
      "conversations",
      "messages",
    ]);
    expect(admin.from).toHaveBeenCalledWith("channel_handoffs");
    expect(messagesQuery.calls).toContainEqual([
      "or",
      [source, destination]
        .map((id) => `and(conversation_id.eq.${id},service_revision.eq.1)`)
        .join(","),
    ]);
    expect(handoffsQuery.calls).toContainEqual([
      "in",
      "source_conversation_id",
      [source, destination],
    ]);
    expect(handoffsQuery.calls).toContainEqual([
      "in",
      "destination_conversation_id",
      [source, destination],
    ]);
    expect(result.page.episodes.map((episode) => episode.conversation_id)).toEqual([
      source,
      destination,
    ]);
  });
});
