"use client";

import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { useRefetchDeSeguranca } from "@/hooks/realtime/useRefetchDeSeguranca";
import { apiClient } from "@/lib/api/client";
import type { JourneyResponse } from "@/lib/inbox/journey";

export function useConversationJourney(
  conversationId: string | null,
  enabled = true,
  realtimeEnabled = false,
) {
  const qc = useQueryClient();
  const queryKey = useMemo(
    () => ["conversation-journey", conversationId] as const,
    [conversationId],
  );

  const query = useInfiniteQuery({
    queryKey,
    enabled: enabled && !!conversationId,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      if (!conversationId) {
        throw new Error("conversation_id_required");
      }
      const qs = new URLSearchParams({ limit: "50" });
      if (pageParam) qs.set("cursor", pageParam);
      try {
        return await apiClient.get<JourneyResponse>(
          `/api/v1/conversations/${conversationId}/journey?${qs.toString()}`,
        );
      } catch (error) {
        showApiError(error);
        throw error;
      }
    },
    getNextPageParam: (last) =>
      last.meta?.has_more && last.meta.cursor ? last.meta.cursor : undefined,
    refetchOnWindowFocus: true,
  });

  const onChange = useCallback(() => {
    qc.invalidateQueries({ queryKey });
    qc.invalidateQueries({ queryKey: ["conversations"] });
  }, [qc, queryKey]);

  // Uma única assinatura: a conversation ATIVA. Os demais episódios entram
  // pelo refetch invalidado pela lista ou pela rede de segurança abaixo.
  const { status: realtimeStatus, ultimaEntrega } = useRealtimeChannel({
    name:
      realtimeEnabled && conversationId
        ? `journey-active-${conversationId}`
        : "journey-active-disabled",
    postgresChanges:
      realtimeEnabled && conversationId
        ? {
            event: "*",
            schema: "public",
            table: "messages",
            filter: `conversation_id=eq.${conversationId}`,
          }
        : undefined,
    onChange,
    enabled: realtimeEnabled && !!conversationId,
  });

  const seguranca = useRefetchDeSeguranca<{ pages: JourneyResponse[] }>({
    queryKey,
    assinatura: (data) => {
      const items = data?.pages.flatMap((page) => page.data.items) ?? [];
      return `${items.length}:${items.at(-1)?.id ?? ""}`;
    },
    ultimaEntrega,
    enabled: realtimeEnabled && !!conversationId,
  });

  return { ...query, realtimeStatus, seguranca };
}
