import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Message } from "@/lib/types/messaging";

import {
  selectJourneyPage,
  type JourneyEpisode,
  type JourneyHandoffItem,
  type JourneyItem,
  type JourneyMessageItem,
  type JourneyPage,
} from "./journey";

const MESSAGE_COLUMNS =
  "id, organization_id, conversation_id, channel_session_id, contact_id, external_id, type, direction, status, ack, error_code, error_message, body, media_url, media_mime, media_size_bytes, media_storage_path, sent_via, sent_by_user_id, sent_on_behalf_of_user_id, sent_at, delivered_at, read_at, metadata, edited_at, revoked_at, reply_to_message_id, created_at, service_revision, demanda_id";

const cursorSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["message", "channel_handoff"]),
  occurred_at: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});

export type JourneyCursor = z.infer<typeof cursorSchema>;

export function encodeJourneyCursor(item: JourneyItem): string {
  const cursor: JourneyCursor = {
    version: 1,
    kind: item.kind,
    occurred_at: item.occurred_at,
    id: item.id,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}
export function decodeJourneyCursor(raw: string): JourneyCursor | null {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

export class JourneyNotFoundError extends Error {
  constructor() {
    super("journey_conversation_not_found");
  }
}

interface LoadJourneyInput {
  organizationId: string;
  conversationId: string;
  limit: number;
  cursor: JourneyCursor | null;
}

interface LoadJourneyResult {
  page: JourneyPage;
  cursor: string | null;
  hasMore: boolean;
}

type ChannelEmbed = {
  display_name: string | null;
  phone_number: string | null;
  provider: string | null;
  social_platform: string | null;
};

type ConversationRow = {
  id: string;
  contact_id: string;
  current_demanda_id: string | null;
  status: string;
  service_revision: number;
  channel_sessions: ChannelEmbed | ChannelEmbed[] | null;
};

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function emptyPage(conversationId: string): LoadJourneyResult {
  return {
    page: {
      available: false,
      demand_id: null,
      active_conversation_id: conversationId,
      episodes: [],
      items: [],
    },
    cursor: null,
    hasMore: false,
  };
}

function failOn(error: { message: string } | null, operation: string): void {
  if (error) throw new Error(`${operation}: ${error.message}`);
}

/**
 * Projeção de leitura da jornada. `session` decide QUAIS conversations e
 * mensagens existem para quem pediu; `admin` lê apenas o recibo server-only de
 * handoff, depois que o conjunto visível já foi fechado pela RLS.
 */
export async function loadConversationJourney(
  session: SupabaseClient,
  admin: SupabaseClient,
  input: LoadJourneyInput,
): Promise<LoadJourneyResult> {
  const { organizationId, conversationId, limit, cursor } = input;

  const sourceResult = await session
    .from("conversations")
    .select("id, contact_id, current_demanda_id, status, service_revision")
    .eq("organization_id", organizationId)
    .eq("id", conversationId)
    .maybeSingle();
  failOn(sourceResult.error, "journey_source");
  const source = sourceResult.data as Omit<ConversationRow, "channel_sessions"> | null;
  if (!source) throw new JourneyNotFoundError();
  if (!source.current_demanda_id) return emptyPage(conversationId);

  const demandResult = await session
    .from("demandas")
    .select("id, contact_id, aberta_em, fechada_em")
    .eq("organization_id", organizationId)
    .eq("id", source.current_demanda_id)
    .eq("contact_id", source.contact_id)
    .maybeSingle();
  failOn(demandResult.error, "journey_demand");
  const demand = demandResult.data as {
    id: string;
    contact_id: string;
    aberta_em: string;
    fechada_em: string | null;
  } | null;
  if (!demand) return emptyPage(conversationId);

  const linksResult = await session
    .from("demanda_conversas")
    .select("conversation_id, service_revision, vinculada_em")
    .eq("organization_id", organizationId)
    .eq("demanda_id", demand.id)
    .order("vinculada_em", { ascending: true })
    .limit(101);
  failOn(linksResult.error, "journey_links");
  const links = (linksResult.data ?? []) as Array<{
    conversation_id: string;
    service_revision: number | null;
    vinculada_em: string;
  }>;
  if (links.length > 100) throw new Error("journey_too_many_episodes");
  if (!links.some((link) => link.conversation_id === conversationId)) {
    throw new Error("journey_source_unlinked");
  }

  const linkByConversation = new Map(links.map((link) => [link.conversation_id, link]));
  const linkedIds = links.map((link) => link.conversation_id);
  const conversationsResult = await session
    .from("conversations")
    .select(
      "id, contact_id, current_demanda_id, status, service_revision, channel_sessions:channel_session_id(phone_number, display_name, provider, social_platform:metadata->>social_platform)",
    )
    .eq("organization_id", organizationId)
    .eq("contact_id", demand.contact_id)
    .in("id", linkedIds);
  failOn(conversationsResult.error, "journey_visible_conversations");

  // A ausência aqui é a autorização funcionando: a RLS da conversation
  // remove o episódio antes de qualquer mensagem ou recibo administrativo.
  const visibleRows = (conversationsResult.data ?? []) as unknown as ConversationRow[];
  const visibleIds = visibleRows.map((row) => row.id);
  const visible = new Set(visibleIds);
  if (!visible.has(conversationId)) throw new JourneyNotFoundError();

  // A mesma conversation pode participar de demandas diferentes ao longo do
  // tempo. O vínculo guarda a revisão exata daquele atendimento; sem este
  // recorte, uma mensagem de outra demanda dentro de uma janela sobreposta
  // poderia aparecer na Jornada. Vínculos legados sem revisão conservam o
  // melhor recorte disponível (conversation + janela temporal da demanda).
  const messageBoundaries = visibleIds.map((id) => {
    const revision = linkByConversation.get(id)?.service_revision;
    return revision == null
      ? `conversation_id.eq.${id}`
      : `and(conversation_id.eq.${id},service_revision.eq.${revision})`;
  });

  const episodes: JourneyEpisode[] = visibleRows
    .map((row) => {
      const link = linkByConversation.get(row.id)!;
      const channel = one(row.channel_sessions);
      return {
        conversation_id: row.id,
        linked_at: link.vinculada_em,
        service_revision: link.service_revision,
        status: row.status,
        channel: {
          display_name: channel?.display_name ?? null,
          phone_number: channel?.phone_number ?? null,
          provider: channel?.provider ?? null,
          social_platform: channel?.social_platform ?? null,
        },
      };
    })
    .sort(
      (a, b) =>
        a.linked_at.localeCompare(b.linked_at) ||
        a.conversation_id.localeCompare(b.conversation_id),
    );

  let messagesQuery = session
    .from("messages")
    .select(MESSAGE_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("contact_id", demand.contact_id)
    .or(messageBoundaries.join(","))
    // Inbound traz o carimbo exato da demanda. Outbound humano legado não o
    // traz em todas as linhas, então pertence à janela temporal da demanda.
    .or(`direction.eq.outbound,and(direction.eq.inbound,demanda_id.eq.${demand.id})`)
    .gte("sent_at", demand.aberta_em)
    .order("sent_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (demand.fechada_em) messagesQuery = messagesQuery.lte("sent_at", demand.fechada_em);
  if (cursor) {
    messagesQuery =
      cursor.kind === "message"
        ? messagesQuery.or(
            `sent_at.lt.${cursor.occurred_at},and(sent_at.eq.${cursor.occurred_at},id.lt.${cursor.id})`,
          )
        : messagesQuery.lt("sent_at", cursor.occurred_at);
  }

  // `channel_handoffs` não é uma superfície do browser. O admin recebe org e
  // demanda derivadas da source visível e ainda exige AS DUAS pontas visíveis.
  let handoffsQuery = admin
    .from("channel_handoffs")
    .select("id, created_at, source_conversation_id, destination_conversation_id")
    .eq("organization_id", organizationId)
    .eq("demanda_id", demand.id)
    .eq("status", "completed")
    .in("source_conversation_id", visibleIds)
    .in("destination_conversation_id", visibleIds)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (cursor) {
    handoffsQuery =
      cursor.kind === "message"
        ? handoffsQuery.lte("created_at", cursor.occurred_at)
        : handoffsQuery.or(
            `created_at.lt.${cursor.occurred_at},and(created_at.eq.${cursor.occurred_at},id.lt.${cursor.id})`,
          );
  }

  const [messagesResult, handoffsResult] = await Promise.all([messagesQuery, handoffsQuery]);
  failOn(messagesResult.error, "journey_messages");
  failOn(handoffsResult.error, "journey_handoffs");

  const messageItems: JourneyMessageItem[] = ((messagesResult.data ?? []) as unknown[]).map(
    (raw) => {
      const row = raw as Message & { service_revision?: number | null; demanda_id?: string | null };
      const { service_revision: _serviceRevision, demanda_id: _demandId, ...publicMessage } = row;
      return {
        kind: "message",
        id: row.id,
        occurred_at: row.sent_at,
        conversation_id: row.conversation_id,
        message: publicMessage as Message,
      };
    },
  );
  const handoffItems: JourneyHandoffItem[] = (
    (handoffsResult.data ?? []) as Array<{
      id: string;
      created_at: string;
      source_conversation_id: string;
      destination_conversation_id: string | null;
    }>
  ).flatMap((row) =>
    row.destination_conversation_id
      ? [
          {
            kind: "channel_handoff" as const,
            id: row.id,
            occurred_at: row.created_at,
            source_conversation_id: row.source_conversation_id,
            destination_conversation_id: row.destination_conversation_id,
          },
        ]
      : [],
  );

  const selected = selectJourneyPage([...messageItems, ...handoffItems], limit);
  return {
    page: {
      available: true,
      demand_id: demand.id,
      active_conversation_id: conversationId,
      episodes,
      items: selected.items,
    },
    cursor: selected.hasMore && selected.oldest ? encodeJourneyCursor(selected.oldest) : null,
    hasMore: selected.hasMore,
  };
}
