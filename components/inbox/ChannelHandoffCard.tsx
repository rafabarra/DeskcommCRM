"use client";

import { Button } from "@/components/ui/button";
import { ChannelLogo } from "@/components/inbox/ChannelLogo";
import { useT } from "@/hooks/i18n/useT";
import { nomeDoCanal } from "@/lib/channels/estado";
import type { JourneyEpisode, JourneyHandoffItem } from "@/lib/inbox/journey";
import { ClockCounterClockwise } from "@/lib/ui/icons";

interface Props {
  item: JourneyHandoffItem;
  episodes: ReadonlyMap<string, JourneyEpisode>;
  onOpenConversation: (conversationId: string) => void;
}

function channelLabel(episode: JourneyEpisode | undefined, fallback: string): string {
  if (!episode) return fallback;
  return nomeDoCanal(episode.channel);
}

export function ChannelHandoffCard({ item, episodes, onOpenConversation }: Props) {
  const t = useT();
  const source = episodes.get(item.source_conversation_id);
  const destination = episodes.get(item.destination_conversation_id);
  const sourceName = channelLabel(source, t("Conversa de origem"));
  const destinationName = channelLabel(destination, t("Conversa de destino"));

  return (
    <div
      data-testid="journey-handoff"
      className="mx-4 my-3 rounded-xl border border-border bg-muted/40 px-3 py-3"
    >
      <div className="flex items-start gap-2">
        <ClockCounterClockwise size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("Atendimento continuado em outro número")}</p>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <ChannelLogo channel={source?.channel} size={14} />
            <span className="truncate">{sourceName}</span>
            <span aria-hidden>→</span>
            <ChannelLogo channel={destination?.channel} size={14} />
            <span className="truncate">{destinationName}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenConversation(item.source_conversation_id)}
            >
              {t("Abrir conversa de origem")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenConversation(item.destination_conversation_id)}
            >
              {t("Abrir conversa de destino")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
