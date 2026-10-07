import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

export const TABELA_DE_NONCES_DE_SIGNUP = "oauth_signup_nonces";

export interface VinculoDoNonceDeSignup {
  nonce: string;
  flowType: string;
  organizationId: string;
  userId: string;
  authSessionId?: string;
  expiresAt: Date;
}

export function hashDoNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

export async function criarNonceDeSignup(
  db: SupabaseClient,
  vinculo: VinculoDoNonceDeSignup,
): Promise<{ ok: true } | { ok: false; code?: string }> {
  try {
    const { error } = await db.from(TABELA_DE_NONCES_DE_SIGNUP).insert({
      nonce_hash: hashDoNonce(vinculo.nonce),
      flow_type: vinculo.flowType,
      organization_id: vinculo.organizationId,
      user_id: vinculo.userId,
      auth_session_id: vinculo.authSessionId ?? null,
      expires_at: vinculo.expiresAt.toISOString(),
    });
    return error ? { ok: false, code: error.code } : { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Reserva atômica para o callback futuro: o primeiro UPDATE que casar marca o
 * uso; concorrentes encontram `consumed_at is null` falso e não consomem.
 */
export async function consumirNonceDeSignup(
  db: SupabaseClient,
  vinculo: Omit<VinculoDoNonceDeSignup, "expiresAt">,
  agora: Date,
): Promise<{ ok: true; consumed: boolean } | { ok: false; code?: string }> {
  try {
    let query = db
      .from(TABELA_DE_NONCES_DE_SIGNUP)
      .update({ consumed_at: agora.toISOString() })
      .eq("nonce_hash", hashDoNonce(vinculo.nonce))
      .eq("flow_type", vinculo.flowType)
      .eq("organization_id", vinculo.organizationId)
      .eq("user_id", vinculo.userId)
      .is("consumed_at", null)
      .gt("expires_at", agora.toISOString());

    query = vinculo.authSessionId
      ? query.eq("auth_session_id", vinculo.authSessionId)
      : query.is("auth_session_id", null);

    const { data, error } = await query.select("nonce_hash");
    if (error) return { ok: false, code: error.code };
    return { ok: true, consumed: Array.isArray(data) && data.length === 1 };
  } catch {
    return { ok: false };
  }
}
