import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { JourneyEpisode, JourneyHandoffItem } from "@/lib/inbox/journey";

import { ChannelHandoffCard } from "./ChannelHandoffCard";

const SOURCE = "aaaaaaaa-0000-4000-8000-000000000001";
const DESTINATION = "aaaaaaaa-0000-4000-8000-000000000002";

function episode(conversationId: string, displayName: string): JourneyEpisode {
  return {
    conversation_id: conversationId,
    linked_at: "2026-09-29T12:00:00.000Z",
    service_revision: 1,
    status: "claimed",
    channel: {
      display_name: displayName,
      phone_number: null,
      provider: "waha",
      social_platform: null,
    },
  };
}

describe("ChannelHandoffCard", () => {
  it("abre origem e destino somente por gestos separados", async () => {
    const onOpen = vi.fn();
    const item: JourneyHandoffItem = {
      kind: "channel_handoff",
      id: "aaaaaaaa-0000-4000-8000-000000000003",
      occurred_at: "2026-09-29T12:01:00.000Z",
      source_conversation_id: SOURCE,
      destination_conversation_id: DESTINATION,
    };
    render(
      <ChannelHandoffCard
        item={item}
        episodes={new Map([
          [SOURCE, episode(SOURCE, "Número principal")],
          [DESTINATION, episode(DESTINATION, "Conexão pessoal")],
        ])}
        onOpenConversation={onOpen}
      />,
    );

    expect(screen.getByText("Atendimento continuado em outro número")).toBeVisible();
    expect(screen.getByText("Número principal")).toBeVisible();
    expect(screen.getByText("Conexão pessoal")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Abrir conversa de origem" }));
    await userEvent.click(screen.getByRole("button", { name: "Abrir conversa de destino" }));
    expect(onOpen.mock.calls).toEqual([[SOURCE], [DESTINATION]]);
  });
});
