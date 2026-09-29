import type { SupabaseClient } from "@supabase/supabase-js";

import { transportaMensagem } from "@/lib/channels/capabilities";
import { nomeDoCanal } from "@/lib/channels/estado";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

/** Vocabulário fechado desta configuração; não é um purpose de chamada de IA. */
export const ATTENDANT_CHANNEL_BINDING_PURPOSE = "personal_handoff" as const;

export interface AttendantPersonalChannelBinding {
  channel_session_id: string;
  channel_name: string;
  valid: boolean;
  invalid_reason: "archived" | "not_message_capable" | "missing" | null;
}

export interface AttendantPersonalChannelSettings {
  members: Array<{
    id: string;
    name: string;
    binding: AttendantPersonalChannelBinding | null;
  }>;
  channels: Array<{
    id: string;
    name: string;
  }>;
}

interface ChannelRow {
  id: string;
  provider: string;
  display_name: string | null;
  phone_number: string | null;
  archived_at: string | null;
}

/**
 * Retrato da configuração vendedor → conexão pessoal para a organização.
 *
 * As quatro consultas carregam `organization_id` explicitamente. Hoje a página
 * usa o client da sessão (e a RLS continua valendo); manter o filtro aqui também
 * deixa o helper seguro se um chamador futuro precisar do client administrativo.
 */
export async function loadAttendantPersonalChannelSettings(
  db: SupabaseClient,
  organizationId: string,
): Promise<AttendantPersonalChannelSettings> {
  const [membersResult, bindingsResult, channelsResult] = await Promise.all([
    db
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", organizationId)
      .is("revoked_at", null)
      .not("accepted_at", "is", null)
      .in("role", ["agent", "manager", "admin"])
      .order("created_at", { ascending: true }),
    db
      .from("attendant_channel_bindings")
      .select("user_id, channel_session_id")
      .eq("organization_id", organizationId)
      .eq("purpose", ATTENDANT_CHANNEL_BINDING_PURPOSE),
    db
      .from("channel_sessions")
      .select("id, provider, display_name, phone_number, archived_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true }),
  ]);

  for (const result of [membersResult, bindingsResult, channelsResult]) {
    if (result.error) throw new Error(result.error.message);
  }

  const members = (membersResult.data ?? []) as Array<{ user_id: string }>;
  const bindings = (bindingsResult.data ?? []) as Array<{
    user_id: string;
    channel_session_id: string;
  }>;
  const channels = (channelsResult.data ?? []) as ChannelRow[];
  const channelById = new Map(channels.map((channel) => [channel.id, channel] as const));
  const bindingByUser = new Map(bindings.map((binding) => [binding.user_id, binding] as const));
  const names = await nomesDosAtendentes(members.map((member) => member.user_id));

  return {
    channels: channels
      .filter((channel) => channel.archived_at === null && transportaMensagem(channel.provider))
      .map((channel) => ({ id: channel.id, name: nomeDoCanal(channel) })),
    members: members.map((member) => {
      const rawBinding = bindingByUser.get(member.user_id);
      const channel = rawBinding ? channelById.get(rawBinding.channel_session_id) : undefined;
      let binding: AttendantPersonalChannelBinding | null = null;
      if (rawBinding) {
        const invalidReason = !channel
          ? "missing"
          : channel.archived_at !== null
            ? "archived"
            : !transportaMensagem(channel.provider)
              ? "not_message_capable"
              : null;
        binding = {
          channel_session_id: rawBinding.channel_session_id,
          channel_name: channel
            ? nomeDoCanal(channel)
            : `Conexão ${rawBinding.channel_session_id.slice(0, 8)}`,
          valid: invalidReason === null,
          invalid_reason: invalidReason,
        };
      }
      return {
        id: member.user_id,
        name: names.get(member.user_id) ?? `Atendente ${member.user_id.slice(0, 8)}`,
        binding,
      };
    }),
  };
}
