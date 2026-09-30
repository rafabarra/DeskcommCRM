"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type {
  ManualChannelHandoffAvailability,
  ManualChannelHandoffResult,
} from "@/lib/routing/manual-channel-handoff";

export function useManualChannelHandoff(conversationId: string, enabled: boolean) {
  const qc = useQueryClient();
  const t = useT();
  const availability = useQuery({
    queryKey: ["conversation-channel-handoff", conversationId],
    enabled: enabled && !!conversationId,
    retry: false,
    queryFn: () =>
      apiClient
        .get<{ data: ManualChannelHandoffAvailability }>(
          `/api/v1/conversations/${conversationId}/channel-handoff`,
        )
        .then((response) => response.data),
  });

  const mutation = useMutation({
    mutationFn: () =>
      apiClient
        .post<{ data: ManualChannelHandoffResult }>(
          `/api/v1/conversations/${conversationId}/channel-handoff`,
          {},
        )
        .then((response) => response.data),
    onError: showApiError,
    onSuccess: (result) => {
      toast.success(t("Conversa pronta na conexão pessoal. Nenhuma mensagem foi enviada."));
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
      qc.invalidateQueries({ queryKey: ["conversation-channel-handoff", conversationId] });
      qc.invalidateQueries({ queryKey: ["conversation-journey"] });
      if (result.destination_conversation_id) {
        qc.invalidateQueries({
          queryKey: ["conversation", result.destination_conversation_id],
        });
      }
    },
  });

  return { availability, mutation };
}
