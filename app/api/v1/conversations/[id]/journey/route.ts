import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  decodeJourneyCursor,
  JourneyNotFoundError,
  loadConversationJourney,
} from "@/lib/inbox/journey-query";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const auth = await requireRole("viewer", { requestId, resource: "conversations" });
  if (!auth.ok) return auth.response;
  const t = (text: string) => traduzir(text, auth.user.idioma ?? "pt-BR");
  if (!z.uuid().safeParse(id).success) {
    return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  }

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors,
    });
  }
  const cursor = parsed.data.cursor ? decodeJourneyCursor(parsed.data.cursor) : null;
  if (parsed.data.cursor && !cursor) {
    return fail("invalid_cursor", t("Cursor inválido."), 422, { requestId });
  }

  try {
    // O cliente de sessão é deliberado: cada conversation/linha da demanda e
    // cada mensagem é filtrada pelas policies do ator. O admin só lê o recibo
    // server-only depois que as duas pontas visíveis já foram determinadas.
    const session = await createClient();
    const result = await loadConversationJourney(session, createAdminClient(), {
      organizationId: auth.org.orgId,
      conversationId: id,
      limit: parsed.data.limit,
      cursor,
    });
    return ok(result.page, {
      requestId,
      meta: { cursor: result.cursor, has_more: result.hasMore },
    });
  } catch (error) {
    if (error instanceof JourneyNotFoundError) {
      return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
    }
    return fail("internal_error", t("Não foi possível carregar a jornada."), 500, {
      requestId,
    });
  }
}
