import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { enUS } from "date-fns/locale";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { JourneyPage } from "@/lib/inbox/journey";
import type { Message } from "@/lib/types/messaging";

import { JourneyThread } from "./JourneyThread";

const useJourney = vi.hoisted(() => vi.fn());

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock("@/hooks/inbox/useConversationJourney", () => ({
  useConversationJourney: useJourney,
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useUser: () => ({ id: "user-1" }) }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => enUS }));
vi.mock("./ChannelLogo", () => ({ ChannelLogo: () => <span data-testid="channel-logo" /> }));
vi.mock("./MessageBubble", () => ({
  MessageBubble: (props: Record<string, unknown>) => (
    <div
      data-testid="journey-message"
      data-readonly={
        !props.onResponder && !props.onEditar && !props.onApagar && !props.onOcultar
          ? "true"
          : "false"
      }
    >
      {(props.message as Message).body}
    </div>
  ),
}));

const ACTIVE = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "aaaaaaaa-0000-4000-8000-000000000002";

function message(id: string, conversationId: string, body: string, sentAt: string): Message {
  return {
    id,
    organization_id: "org-1",
    conversation_id: conversationId,
    channel_session_id: "channel-1",
    contact_id: "contact-1",
    external_id: null,
    type: "text",
    direction: "inbound",
    status: "received",
    ack: null,
    error_code: null,
    error_message: null,
    body,
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "crm",
    sent_by_user_id: null,
    sent_at: sentAt,
    delivered_at: null,
    read_at: null,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: sentAt,
  } as Message;
}

const page: JourneyPage = {
  available: true,
  demand_id: "demand-1",
  active_conversation_id: ACTIVE,
  episodes: [ACTIVE, OTHER].map((conversationId, index) => ({
    conversation_id: conversationId,
    linked_at: `2026-09-29T12:0${index}:00.000Z`,
    service_revision: 1,
    status: "open",
    channel: {
      display_name: index === 0 ? "Comercial" : "Pessoal",
      phone_number: null,
      provider: "waha",
      social_platform: null,
    },
  })),
  items: [
    {
      kind: "message",
      id: "11111111-0000-4000-8000-000000000001",
      occurred_at: "2026-09-29T12:00:00.000Z",
      conversation_id: ACTIVE,
      message: message(
        "11111111-0000-4000-8000-000000000001",
        ACTIVE,
        "Origem preservada",
        "2026-09-29T12:00:00.000Z",
      ),
    },
    {
      kind: "channel_handoff",
      id: "22222222-0000-4000-8000-000000000001",
      occurred_at: "2026-09-29T12:01:00.000Z",
      source_conversation_id: ACTIVE,
      destination_conversation_id: OTHER,
    },
    {
      kind: "message",
      id: "33333333-0000-4000-8000-000000000001",
      occurred_at: "2026-09-29T12:02:00.000Z",
      conversation_id: OTHER,
      message: message(
        "33333333-0000-4000-8000-000000000001",
        OTHER,
        "Destino separado",
        "2026-09-29T12:02:00.000Z",
      ),
    },
  ],
};

describe("JourneyThread", () => {
  it("projeta episódios separados, sem ação de mensagem, e só navega por gesto explícito", async () => {
    useJourney.mockReturnValue({
      data: { pages: [{ data: page, meta: { has_more: false, cursor: null } }] },
      isPending: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      realtimeStatus: "subscribed",
      seguranca: { divergencias: 0 },
    });
    const open = vi.fn();
    render(<JourneyThread conversationId={ACTIVE} onOpenConversation={open} />);

    expect(screen.getByText("Origem preservada")).toBeInTheDocument();
    expect(screen.getByText("Destino separado")).toBeInTheDocument();
    expect(screen.getByText("Conversa atual")).toBeInTheDocument();
    expect(
      screen
        .getAllByTestId("journey-message")
        .every((node) => node.getAttribute("data-readonly") === "true"),
    ).toBe(true);
    expect(open).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Abrir esta conversa" }));
    expect(open).toHaveBeenCalledWith(OTHER);
  });
});
