import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { chaveDaRequisicao } from "@/lib/api/idempotency";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { PROVIDERS_DE_MENSAGEM } from "@/lib/channels/capabilities";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  loadManualChannelHandoffAvailability,
  type ManualChannelHandoffResult,
} from "@/lib/routing/manual-channel-handoff";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const emptyBodySchema = z.object({}).strict();

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return fail("validation_failed", traduzir("Conversa inválida.", authz.user.idioma), 422, {
      requestId,
    });
  }

  try {
    const availability = await loadManualChannelHandoffAvailability(
      createAdminClient(),
      authz.org.orgId,
      id,
      authz.user.id,
      authz.org.role,
    );
    return ok(availability, { requestId });
  } catch {
    return fail(
      "internal_error",
      traduzir("Falha ao verificar a conexão pessoal.", authz.user.idioma),
      500,
      { requestId },
    );
  }
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (text: string) => traduzir(text, authz.user.idioma);
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return fail("validation_failed", t("Conversa inválida."), 422, { requestId });
  }

  const key = chaveDaRequisicao(req);
  if (!key) {
    return fail("validation_failed", t("Header Idempotency-Key é obrigatório."), 422, {
      requestId,
    });
  }
  if (!z.uuid().safeParse(key).success) {
    return fail("validation_failed", t("Idempotency-Key deve ser UUID"), 422, { requestId });
  }

  const parsedBody = emptyBodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsedBody.success) {
    return fail(
      "validation_failed",
      t("O destino é definido pela conexão pessoal do responsável."),
      422,
      { requestId },
    );
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_manual_channel_handoff", {
    p_org: authz.org.orgId,
    p_source_conversation_id: id,
    p_actor_user_id: authz.user.id,
    p_idempotency_key: key,
    p_message_capable_providers: [...PROVIDERS_DE_MENSAGEM],
  });
  if (error) {
    await audit({
      action: "conversation.channel_handoff_failed",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "conversation",
      resourceId: id,
      requestId,
      metadata: { failure_code: "rpc_error" },
    });
    return fail("internal_error", t("Não foi possível continuar a conversa."), 500, {
      requestId,
    });
  }

  const result = data as ManualChannelHandoffResult;
  if (result.status !== "completed") {
    const code = result.failure_code ?? "internal_error";
    await audit({
      action: "conversation.channel_handoff_failed",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "conversation",
      resourceId: id,
      requestId,
      metadata: { failure_code: code, handoff_id: result.id ?? null },
    });
    const mapped = failureResponse(code, t, requestId);
    return mapped;
  }

  if (!result.replayed) {
    await audit({
      action: "conversation.channel_handoff_completed",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "conversation",
      resourceId: id,
      requestId,
      metadata: {
        handoff_id: result.id,
        destination_conversation_id: result.destination_conversation_id,
        demanda_id: result.demanda_id,
      },
    });
  }
  return ok(result, { requestId });
}

function failureResponse(code: string, t: (text: string) => string, requestId: string): Response {
  switch (code) {
    case "idempotency_conflict":
      return fail("conflict", t("Esta chave já foi usada para outra continuação."), 409, {
        requestId,
      });
    case "source_not_found":
      return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
    case "actor_forbidden":
    case "source_not_owned":
      return fail("forbidden", t("Você não pode continuar esta conversa."), 403, { requestId });
    case "destination_demanda_conflict":
      return fail(
        "conflict",
        t("A conversa da conexão pessoal já atende outra demanda aberta."),
        409,
        { requestId },
      );
    case "binding_not_found":
    case "binding_invalid":
    case "destination_same_as_source":
    case "source_is_group":
    case "source_unassigned":
    case "assignee_ineligible":
    case "active_demanda_not_found":
      return fail(
        "unprocessable_entity",
        t("Esta conversa não pode continuar na conexão pessoal agora."),
        422,
        { requestId, details: { reason: code } },
      );
    default:
      return fail("internal_error", t("Não foi possível continuar a conversa."), 500, {
        requestId,
      });
  }
}
