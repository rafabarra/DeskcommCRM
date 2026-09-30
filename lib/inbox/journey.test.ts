import { describe, expect, it } from "vitest";

import type { Message } from "@/lib/types/messaging";

import {
  mergeJourneyPages,
  selectJourneyPage,
  type JourneyHandoffItem,
  type JourneyItem,
  type JourneyMessageItem,
  type JourneyPage,
} from "./journey";

function message(id: string, occurredAt: string, conversationId = "conv-a"): JourneyMessageItem {
  return {
    kind: "message",
    id,
    occurred_at: occurredAt,
    conversation_id: conversationId,
    message: {
      id,
      organization_id: "org-a",
      conversation_id: conversationId,
      channel_session_id: "session-a",
      contact_id: "contact-a",
      external_id: null,
      type: "text",
      direction: "inbound",
      status: "received",
      ack: null,
      error_code: null,
      error_message: null,
      body: id,
      media_url: null,
      media_mime: null,
      media_size_bytes: null,
      media_storage_path: null,
      sent_via: "crm",
      sent_by_user_id: null,
      sent_at: occurredAt,
      delivered_at: null,
      read_at: null,
      metadata: {},
      edited_at: null,
      revoked_at: null,
      reply_to_message_id: null,
      created_at: occurredAt,
    } satisfies Message,
  };
}

function handoff(id: string, occurredAt: string): JourneyHandoffItem {
  return {
    kind: "channel_handoff",
    id,
    occurred_at: occurredAt,
    source_conversation_id: "conv-a",
    destination_conversation_id: "conv-b",
  };
}

function page(items: JourneyItem[]): JourneyPage {
  return {
    available: true,
    demand_id: "demand-a",
    active_conversation_id: "conv-a",
    episodes: [],
    items,
  };
}

describe("jornada multicanal — ordenação e paginação", () => {
  it("intercala mensagens de conversations diferentes e o handoff em ordem cronológica", () => {
    const instant = "2026-09-29T12:01:00.000Z";
    const result = selectJourneyPage(
      [
        message("m-destino", instant, "conv-b"),
        message("m-origem", "2026-09-29T12:00:00.000Z"),
        handoff("h-1", instant),
      ],
      50,
    );

    expect(result.items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      "message:m-origem",
      "channel_handoff:h-1",
      "message:m-destino",
    ]);
    expect(result.hasMore).toBe(false);
  });

  it("usa id como desempate e devolve cursor no item mais antigo da página", () => {
    const instant = "2026-09-29T12:00:00.000Z";
    const result = selectJourneyPage(
      [message("0001", instant), message("0003", instant), message("0002", instant)],
      2,
    );

    expect(result.items.map((item) => item.id)).toEqual(["0002", "0003"]);
    expect(result.oldest?.id).toBe("0002");
    expect(result.hasMore).toBe(true);
  });

  it("deduplica a borda entre refetch e página anterior sem perder a ordem global", () => {
    const repeated = message("m-2", "2026-09-29T12:01:00.000Z");
    const result = mergeJourneyPages([
      page([repeated, message("m-3", "2026-09-29T12:02:00.000Z")]),
      page([message("m-1", "2026-09-29T12:00:00.000Z"), repeated]),
    ]);

    expect(result.map((item) => item.id)).toEqual(["m-1", "m-2", "m-3"]);
  });
});
