import type { SupabaseClient } from "@supabase/supabase-js";

import { transportaMensagem } from "@/lib/channels/capabilities";
import { nomeDoCanal } from "@/lib/channels/estado";
import { roleAtLeast, type Role } from "@/lib/auth/types";
import { ATTENDANT_CHANNEL_BINDING_PURPOSE } from "@/lib/routing/attendant-channel-bindings";

export type ManualChannelHandoffUnavailableReason =
  | "source_not_found"
  | "source_is_group"
  | "source_unassigned"
  | "source_not_owned"
  | "active_demanda_not_found"
  | "binding_not_found"
  | "binding_invalid"
  | "destination_same_as_source";

export type ManualChannelHandoffAvailability =
  | { available: true; destination_channel_name: string }
  | { available: false; reason: ManualChannelHandoffUnavailableReason };

export interface ManualChannelHandoffResult {
  id?: string;
  status: "completed" | "failed" | "conflict";
  replayed?: boolean;
  source_conversation_id?: string;
  destination_conversation_id?: string;
  demanda_id?: string;
  destination_channel_session_id?: string;
  assigned_user_id?: string;
  failure_code?: string;
}

/**
 * Decide se a porta manual pode ser mostrada sem entregar ao navegador o id da
 * conexão pessoal. A POSTagem resolve tudo novamente dentro da transação: este
 * retrato é só apresentação, nunca autorização otimista.
 *
 * O client administrativo é aceito porque a organização e o ator já vieram de
 * `requireRole`; por isso TODAS as leituras repetem `organization_id`.
 */
export async function loadManualChannelHandoffAvailability(
  db: SupabaseClient,
  organizationId: string,
  conversationId: string,
  actorUserId: string,
  actorRole: Role,
): Promise<ManualChannelHandoffAvailability> {
  const { data: source, error: sourceError } = await db
    .from("conversations")
    .select(
      "id, contact_id, channel_session_id, assigned_to_user_id, current_demanda_id, service_revision, is_group",
    )
    .eq("organization_id", organizationId)
    .eq("id", conversationId)
    .maybeSingle();
  if (sourceError) throw new Error(sourceError.message);
  if (!source) return { available: false, reason: "source_not_found" };
  if (source.is_group) return { available: false, reason: "source_is_group" };
  if (!source.assigned_to_user_id) return { available: false, reason: "source_unassigned" };
  if (!roleAtLeast(actorRole, "manager") && source.assigned_to_user_id !== actorUserId) {
    return { available: false, reason: "source_not_owned" };
  }
  if (!source.current_demanda_id) {
    return { available: false, reason: "active_demanda_not_found" };
  }

  const { data: demand, error: demandError } = await db
    .from("demandas")
    .select("id, contact_id, fechada_em")
    .eq("organization_id", organizationId)
    .eq("id", source.current_demanda_id)
    .eq("contact_id", source.contact_id)
    .is("fechada_em", null)
    .maybeSingle();
  if (demandError) throw new Error(demandError.message);
  if (!demand) return { available: false, reason: "active_demanda_not_found" };

  const { data: demandLink, error: demandLinkError } = await db
    .from("demanda_conversas")
    .select("demanda_id")
    .eq("organization_id", organizationId)
    .eq("demanda_id", demand.id)
    .eq("conversation_id", source.id)
    .eq("service_revision", source.service_revision)
    .maybeSingle();
  if (demandLinkError) throw new Error(demandLinkError.message);
  if (!demandLink) return { available: false, reason: "active_demanda_not_found" };

  const { data: binding, error: bindingError } = await db
    .from("attendant_channel_bindings")
    .select("channel_session_id")
    .eq("organization_id", organizationId)
    .eq("user_id", source.assigned_to_user_id)
    .eq("purpose", ATTENDANT_CHANNEL_BINDING_PURPOSE)
    .maybeSingle();
  if (bindingError) throw new Error(bindingError.message);
  if (!binding) return { available: false, reason: "binding_not_found" };
  if (binding.channel_session_id === source.channel_session_id) {
    return { available: false, reason: "destination_same_as_source" };
  }

  const { data: session, error: sessionError } = await db
    .from("channel_sessions")
    .select("id, provider, display_name, phone_number, archived_at")
    .eq("organization_id", organizationId)
    .eq("id", binding.channel_session_id)
    .maybeSingle();
  if (sessionError) throw new Error(sessionError.message);
  if (!session || session.archived_at !== null || !transportaMensagem(session.provider)) {
    return { available: false, reason: "binding_invalid" };
  }

  return { available: true, destination_channel_name: nomeDoCanal(session) };
}
