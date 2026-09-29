import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { PROVIDERS_DE_MENSAGEM, transportaMensagem } from "@/lib/channels/capabilities";
import { requireSupportWrite } from "@/lib/impersonate/support";
import type { ATTENDANT_CHANNEL_BINDING_PURPOSE } from "@/lib/routing/attendant-channel-bindings";
import { attendantChannelBindingPatchSchema } from "@/lib/schemas/routing";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface BindingResult {
  user_id: string;
  purpose: typeof ATTENDANT_CHANNEL_BINDING_PURPOSE;
  previous_channel_session_id: string | null;
  channel_session_id: string | null;
  changed: boolean;
}

/**
 * PATCH /api/v1/settings/routing/attendant-bindings
 *
 * A única superfície de escrita da configuração vendedor → conexão pessoal.
 * A organização vem da sessão; o corpo nunca escolhe tenant. A capability do
 * provider é decidida pela matriz canônica de canais antes da RPC service-only.
 */
export async function PATCH(req: Request): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", {
    requestId,
    resource: "settings_routing",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  if (await mfaEmDivida()) {
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  }

  const parsed = attendantChannelBindingPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Confira o atendente e a conexão selecionada.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const organizationId = authz.org.orgId;
  const { user_id: userId, channel_session_id: channelSessionId } = parsed.data;
  const admin = createAdminClient();

  // Service role exige filtro explícito de organização em TODA leitura. A RPC
  // repete os predicados sob lock para fechar a corrida entre validar e gravar.
  const { data: member, error: memberError } = await admin
    .from("user_organizations")
    .select("user_id, role, revoked_at, accepted_at")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (memberError) return fail("internal_error", memberError.message, 500, { requestId });
  if (
    channelSessionId !== null &&
    (!member ||
      member.revoked_at !== null ||
      member.accepted_at === null ||
      !["agent", "manager", "admin"].includes(member.role))
  ) {
    return fail(
      "validation_failed",
      "O membro não está elegível para receber uma conexão pessoal.",
      422,
      { requestId },
    );
  }

  if (channelSessionId !== null) {
    const { data: channel, error: channelError } = await admin
      .from("channel_sessions")
      .select("id, provider, archived_at")
      .eq("organization_id", organizationId)
      .eq("id", channelSessionId)
      .maybeSingle();
    if (channelError) return fail("internal_error", channelError.message, 500, { requestId });
    if (!channel) return fail("not_found", "Conexão não encontrada.", 404, { requestId });
    if (channel.archived_at !== null || !transportaMensagem(channel.provider)) {
      return fail(
        "validation_failed",
        "Escolha uma conexão de mensagens ativa da organização.",
        422,
        { requestId },
      );
    }
  }

  const { data, error } = await admin.rpc("fn_set_attendant_channel_binding", {
    p_org: organizationId,
    p_user_id: userId,
    p_channel_session_id: channelSessionId,
    p_actor_user_id: authz.user.id,
    p_message_capable_providers: [...PROVIDERS_DE_MENSAGEM],
  });
  if (error) {
    if (error.code === "23505") {
      return fail("conflict", "Esta conexão pessoal já está vinculada a outro atendente.", 409, {
        requestId,
      });
    }
    if (error.code === "P0002") {
      return fail("not_found", "A equipe ou a conexão mudou. Atualize a página.", 404, {
        requestId,
      });
    }
    if (error.code === "22023") {
      return fail(
        "validation_failed",
        "A equipe ou a conexão mudou. Atualize a página e selecione novamente.",
        422,
        { requestId },
      );
    }
    if (error.code === "42501") {
      return fail("forbidden", "Esta sessão não pode alterar conexões pessoais.", 403, {
        requestId,
      });
    }
    return fail("internal_error", "Não foi possível salvar a conexão pessoal.", 500, {
      requestId,
    });
  }

  const result = data as unknown as BindingResult;
  if (result.changed) {
    void audit({
      action: "routing.config_changed",
      actorUserId: authz.user.id,
      organizationId,
      resourceType: "attendant_channel_binding",
      resourceId: userId,
      requestId,
      bypassedRls: true,
      metadata: {
        purpose: result.purpose,
        previous_channel_session_id: result.previous_channel_session_id,
        channel_session_id: result.channel_session_id,
      },
    });
  }

  return ok(result, { requestId });
}
