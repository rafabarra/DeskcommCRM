"use client";

import { format, isSameDay } from "date-fns";
import { useEffect, useMemo, useRef } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useUser } from "@/hooks/auth/AuthProvider";
import { useConversationJourney } from "@/hooks/inbox/useConversationJourney";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { nomeDoCanal } from "@/lib/channels/estado";
import { mergeJourneyPages, type JourneyEpisode, type JourneyItem } from "@/lib/inbox/journey";

import { ChannelHandoffCard } from "./ChannelHandoffCard";
import { ChannelLogo } from "./ChannelLogo";
import { MessageBubble } from "./MessageBubble";

interface Props {
  conversationId: string;
  onOpenConversation: (conversationId: string) => void;
}

function channelLabel(episode: JourneyEpisode, t: (text: string) => string): string {
  const name = nomeDoCanal(episode.channel, t);
  const phone = episode.channel.phone_number?.trim();
  return phone && phone !== name ? `${name} · ${phone}` : name;
}

function shouldShowDay(items: JourneyItem[], index: number): boolean {
  if (index === 0) return true;
  return !isSameDay(
    new Date(items[index - 1]!.occurred_at),
    new Date(items[index]!.occurred_at),
  );
}

export function JourneyThread({ conversationId, onOpenConversation }: Props) {
  const t = useT();
  const locale = useLocaleDeData();
  const user = useUser();
  const q = useConversationJourney(conversationId, true, true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const anchored = useRef(false);

  const pages = useMemo(() => q.data?.pages.map((page) => page.data) ?? [], [q.data]);
  const items = useMemo(() => mergeJourneyPages(pages), [pages]);
  const episodes = useMemo(() => pages[0]?.episodes ?? [], [pages]);
  const episodesById = useMemo(
    () => new Map(episodes.map((episode) => [episode.conversation_id, episode])),
    [episodes],
  );
  const messagesById = useMemo(
    () =>
      new Map(
        items.flatMap((item) =>
          item.kind === "message" ? [[item.message.id, item.message] as const] : [],
        ),
      ),
    [items],
  );

  useEffect(() => {
    if (anchored.current || q.isPending || items.length === 0) return;
    anchored.current = true;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [items.length, q.isPending]);

  async function loadOlder() {
    const scroller = scrollerRef.current;
    const previousHeight = scroller?.scrollHeight ?? 0;
    const previousTop = scroller?.scrollTop ?? 0;
    await q.fetchNextPage();
    requestAnimationFrame(() => {
      if (!scroller) return;
      scroller.scrollTop = previousTop + (scroller.scrollHeight - previousHeight);
    });
  }

  if (q.isPending) {
    return (
      <div className="space-y-4 p-4" data-testid="journey-loading">
        <Skeleton className="h-16 w-3/4" />
        <Skeleton className="ml-auto h-16 w-2/3" />
        <Skeleton className="h-16 w-4/5" />
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t("Não foi possível carregar a jornada.")}
      </div>
    );
  }
  if (!pages[0]?.available) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t("Esta conversa ainda não possui uma jornada multicanal.")}
      </div>
    );
  }

  return (
    <div
      ref={scrollerRef}
      data-testid="journey-thread"
      data-realtime-status={q.realtimeStatus}
      data-refetch-divergencias={q.seguranca.divergencias}
      className="h-full overflow-y-auto py-3"
    >
      {q.hasNextPage && (
        <div className="mb-3 flex justify-center">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={q.isFetchingNextPage}
            onClick={() => void loadOlder()}
          >
            {q.isFetchingNextPage ? t("Carregando...") : t("Carregar mensagens mais antigas")}
          </Button>
        </div>
      )}

      {items.length === 0 && (
        <p className="px-6 py-12 text-center text-sm text-muted-foreground">
          {t("Nenhuma mensagem nesta jornada.")}
        </p>
      )}

      {items.map((item, index) => {
        const episode =
          item.kind === "message" ? episodesById.get(item.conversation_id) : undefined;
        return (
          <div key={`${item.kind}:${item.id}`}>
            {shouldShowDay(items, index) && (
              <div className="my-3 flex justify-center">
                <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
                  {format(new Date(item.occurred_at), "dd MMM yyyy", { locale })}
                </span>
              </div>
            )}
            {item.kind === "channel_handoff" ? (
              <ChannelHandoffCard
                item={item}
                episodes={episodesById}
                onOpenConversation={onOpenConversation}
              />
            ) : episode ? (
              <div data-conversation-id={item.conversation_id} className="py-1">
                <div className="flex items-center gap-1.5 px-4 text-xs text-muted-foreground">
                  <ChannelLogo channel={episode.channel} size={14} />
                  <span>{channelLabel(episode, t)}</span>
                  {item.conversation_id === conversationId && (
                    <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      {t("Conversa atual")}
                    </span>
                  )}
                </div>
                <MessageBubble
                  message={item.message}
                  viewerUserId={user.id}
                  citada={
                    item.message.reply_to_message_id
                      ? (messagesById.get(item.message.reply_to_message_id) ?? null)
                      : null
                  }
                />
                {item.conversation_id !== conversationId && (
                  <div className="flex px-4 pb-1">
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto px-0 text-xs"
                      onClick={() => onOpenConversation(item.conversation_id)}
                    >
                      {t("Abrir esta conversa")}
                    </Button>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
