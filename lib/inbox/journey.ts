import type { Message } from "@/lib/types/messaging";

/** A identidade operacional de uma conversation dentro da jornada. */
export interface JourneyChannel {
  display_name: string | null;
  phone_number: string | null;
  provider: string | null;
  social_platform: string | null;
}
export interface JourneyEpisode {
  conversation_id: string;
  linked_at: string;
  service_revision: number | null;
  status: string;
  channel: JourneyChannel;
}

export interface JourneyMessageItem {
  kind: "message";
  id: string;
  occurred_at: string;
  conversation_id: string;
  message: Message;
}

export interface JourneyHandoffItem {
  kind: "channel_handoff";
  id: string;
  occurred_at: string;
  source_conversation_id: string;
  destination_conversation_id: string;
}

export type JourneyItem = JourneyMessageItem | JourneyHandoffItem;

export interface JourneyPage {
  available: boolean;
  demand_id: string | null;
  active_conversation_id: string;
  episodes: JourneyEpisode[];
  items: JourneyItem[];
}

export interface JourneyResponse {
  data: JourneyPage;
  meta?: { cursor?: string | null; has_more?: boolean };
}

/**
 * Empate no mesmo instante: o handoff aconteceu antes da primeira mensagem do
 * novo episódio. Em ordem crescente ele aparece primeiro; em ordem decrescente
 * a mensagem recebe o maior rank.
 */
function rank(item: JourneyItem): number {
  return item.kind === "message" ? 1 : 0;
}

export function compareJourneyItemsDesc(a: JourneyItem, b: JourneyItem): number {
  const byTime = b.occurred_at.localeCompare(a.occurred_at);
  if (byTime !== 0) return byTime;
  const byKind = rank(b) - rank(a);
  if (byKind !== 0) return byKind;
  return b.id.localeCompare(a.id);
}

export function compareJourneyItemsAsc(a: JourneyItem, b: JourneyItem): number {
  return -compareJourneyItemsDesc(a, b);
}

export function journeyItemKey(item: JourneyItem): string {
  return `${item.kind}:${item.id}`;
}

/**
 * O servidor pagina do presente para o passado. A tela, porém, renderiza do
 * passado para o presente e precisa tolerar a sobreposição de um refetch com a
 * página anterior sem repetir uma fala ou um evento.
 */
export function mergeJourneyPages(pages: readonly JourneyPage[]): JourneyItem[] {
  const unique = new Map<string, JourneyItem>();
  for (const page of pages) {
    for (const item of page.items) unique.set(journeyItemKey(item), item);
  }
  return [...unique.values()].sort(compareJourneyItemsAsc);
}

/** Função pura usada pelo handler e pelos testes de borda da paginação. */
export function selectJourneyPage(
  candidates: readonly JourneyItem[],
  limit: number,
): { items: JourneyItem[]; hasMore: boolean; oldest: JourneyItem | null } {
  const ordered = [...candidates].sort(compareJourneyItemsDesc);
  const hasMore = ordered.length > limit;
  const selected = ordered.slice(0, limit);
  return {
    items: selected.slice().reverse(),
    hasMore,
    oldest: selected.at(-1) ?? null,
  };
}
