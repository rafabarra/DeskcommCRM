import { randomBytes, randomUUID } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { appDaMeta } from "@/lib/channels/meta/app";
import {
  CAMINHO_DO_FLUXO_SIGNUP,
  emitirEstadoDoSignup,
  NOME_DO_COOKIE_SIGNUP,
  TIPO_DO_FLUXO_SIGNUP,
  VALIDADE_DO_COOKIE_SIGNUP_S,
  VALIDADE_DO_SIGNUP_MS,
} from "@/lib/channels/meta/estado-do-signup";
import { env } from "@/lib/env";
import { authenticatedSessionId, requireSupportWrite } from "@/lib/impersonate/support";
import { criarNonceDeSignup } from "@/lib/oauth/signup-nonce";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

export const dynamic = "force-dynamic";

function configuracaoAusente(message: string, requestId: string): NextResponse {
  return fail("upstream_unavailable", message, 503, { requestId });
}

function urlHospedadaValida(valor: string): boolean {
  try {
    return new URL(valor).protocol === "https:";
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const authz = await requireRole("admin", {
    requestId,
    resource: "channel_embedded_signup",
  });
  if (!authz.ok) return authz.response;

  const app = await appDaMeta();
  if (!app.appId?.trim()) {
    return configuracaoAusente("O App ID da conexão oficial não está configurado.", requestId);
  }
  const hostedSignupUrl = app.hostedSignupUrl?.trim() ?? "";
  if (!hostedSignupUrl) {
    return configuracaoAusente(
      "A URL hospedada da conexão oficial não está configurada.",
      requestId,
    );
  }
  if (!urlHospedadaValida(hostedSignupUrl)) {
    return configuracaoAusente("A URL hospedada da conexão oficial é inválida.", requestId);
  }

  let authSessionId: string | undefined;
  try {
    authSessionId = await authenticatedSessionId();
  } catch {
    // A identidade de usuário e organização já foi revalidada por requireRole.
    // O vínculo de sessão é adicional e só entra quando o claim está disponível.
  }

  const agora = new Date();
  const expiraEm = new Date(agora.getTime() + VALIDADE_DO_SIGNUP_MS);
  const nonce = randomBytes(32).toString("base64url");

  let state: string;
  try {
    state = emitirEstadoDoSignup(
      {
        organizationId: authz.org.orgId,
        userId: authz.user.id,
        ...(authSessionId ? { authSessionId } : {}),
        nonce,
      },
      { segredo: env.INTERNAL_SECRET, agora },
    );
  } catch {
    return configuracaoAusente("Não foi possível proteger o início da conexão.", requestId);
  }

  const persistido = await criarNonceDeSignup(createAdminClient(), {
    nonce,
    flowType: TIPO_DO_FLUXO_SIGNUP,
    organizationId: authz.org.orgId,
    userId: authz.user.id,
    ...(authSessionId ? { authSessionId } : {}),
    expiresAt: expiraEm,
  });
  if (!persistido.ok) {
    return fail(
      "upstream_unavailable",
      "Não foi possível iniciar a conexão agora. Tente novamente.",
      503,
      { requestId },
    );
  }

  await audit({
    action: "channel.embedded_signup_started",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    requestId,
    metadata: { expires_at: expiraEm.toISOString() },
  });

  // A documentação disponível não prova suporte a `state` arbitrário na URL
  // hospedada. O Location sai exatamente da configuração server-side: nada da
  // query do navegador é copiado ou anexado.
  const response = new NextResponse(null, {
    status: 307,
    headers: { Location: hostedSignupUrl },
  });
  response.headers.set("X-Request-Id", requestId);
  response.cookies.set(NOME_DO_COOKIE_SIGNUP, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: CAMINHO_DO_FLUXO_SIGNUP,
    maxAge: VALIDADE_DO_COOKIE_SIGNUP_S,
  });
  return response;
}
