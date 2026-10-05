/**
 * Conecta um canal Meta oficial com uma credencial já obtida.
 *
 * A borda HTTP continua dona de autenticação, Zod, tradução e status codes;
 * daqui para dentro a sequência é uma só: validar, cifrar, persistir ou
 * ressuscitar e, somente depois, registrar o webhook da sessão.
 *
 * O token em claro existe apenas durante esta chamada e nunca integra o retorno.
 */
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { reactivateChannelSession } from "@/lib/channels/reactivate";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { basePublicaDoWebhookMeta } from "@/lib/webhooks/url-publica";

import { validateMetaCredentials } from "./validate-credentials";
import { registrarWebhookDaSessao, type DesfechoDoWebhookDaSessao } from "./webhook-da-sessao";

export interface ConectarCanalMetaOficialInput {
  organizationId: string;
  userId: string;
  phoneNumberId: string;
  wabaId: string;
  token: string;
  requestId: string;
  /** Contexto confiável da requisição usado para resolver a URL pública. */
  webhookPublicBaseContext: {
    headers: Headers;
    nextUrl: URL;
  };
}

export type ConectarCanalMetaOficialResult =
  | {
      ok: true;
      displayName: string;
      phoneNumber: string | null;
      webhookRegistro: DesfechoDoWebhookDaSessao | null;
    }
  | { ok: false; tipo: "credencial_invalida"; mensagem: string }
  | { ok: false; tipo: "cifra_indisponivel" }
  | { ok: false; tipo: "persistencia_falhou"; mensagem: string };

export async function conectarCanalMetaOficial(
  input: ConectarCanalMetaOficialInput,
): Promise<ConectarCanalMetaOficialResult> {
  // Valida antes de gravar. O wabaId impede combinar um número válido com a
  // conta errada.
  const validacao = await validateMetaCredentials({
    phoneNumberId: input.phoneNumberId,
    token: input.token,
    wabaId: input.wabaId,
  });
  if (!validacao.ok) {
    return { ok: false, tipo: "credencial_invalida", mensagem: validacao.motivo };
  }

  const admin = createAdminClient();
  const cifrado = await encryptWebhookSecret(admin, input.token);
  if (!cifrado) {
    // Nunca degrada para texto em claro quando a cifra da instalação falha.
    return { ok: false, tipo: "cifra_indisponivel" };
  }

  // Inclui a linha arquivada de propósito: reconectar traz a mesma sessão de
  // volta, em vez de criar outra linha oficial na organização.
  const buscarExistente = (colunas: string) =>
    admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", input.organizationId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .maybeSingle();
  const { data: existenteRaw } = await queryTolerantToMissingArchived(
    () => buscarExistente(`id, ${ARCHIVED_AT}, webhook_path_token`),
    () => buscarExistente("id, webhook_path_token"),
  );
  const existente = existenteRaw as {
    id: string;
    archived_at?: string | null;
    webhook_path_token?: string | null;
  } | null;

  const linha = {
    organization_id: input.organizationId,
    provider: CHANNEL_PROVIDER_META,
    meta_phone_number_id: input.phoneNumberId,
    meta_waba_id: input.wabaId,
    meta_token_encrypted: cifrado,
    phone_number: validacao.displayPhoneNumber
      ? `+${validacao.displayPhoneNumber.replace(/\D/g, "")}`
      : null,
    display_name: validacao.verifiedName ?? "Canal oficial",
    status: "WORKING",
  };

  let idDaSessao: string | null = existente?.id ?? null;
  let webhookPathToken: string | null = existente?.webhook_path_token ?? null;
  let error: { message?: string | null } | null = null;

  if (existente) {
    ({ error } = await reactivateChannelSession(
      admin,
      {
        organizationId: input.organizationId,
        channelSessionId: existente.id,
        archivedAt: existente.archived_at ?? null,
      },
      linha,
      {
        userId: input.userId,
        requestId: input.requestId,
        metadata: { provider: CHANNEL_PROVIDER_META, phone_number: linha.phone_number },
      },
    ));
  } else {
    const inserida = await admin
      .from("channel_sessions")
      .insert({
        ...linha,
        webhook_secret_encrypted: cifrado,
        metadata: metadataInicialDoCanal(),
      })
      .select("id, webhook_path_token")
      .maybeSingle();
    error = inserida.error;
    idDaSessao = inserida.data?.id ?? null;
    webhookPathToken = inserida.data?.webhook_path_token ?? null;
  }

  if (error) {
    return {
      ok: false,
      tipo: "persistencia_falhou",
      mensagem: error.message ?? "channel_session_write_failed",
    };
  }

  // O registro ocorre depois da persistência: o handshake da Meta pode chegar
  // imediatamente e precisa encontrar a sessão pelo token do caminho.
  const webhookRegistro =
    idDaSessao && webhookPathToken
      ? await registrarWebhookDaSessao({
          admin,
          channelSessionId: idDaSessao,
          phoneNumberId: input.phoneNumberId,
          wabaId: input.wabaId,
          tokenCifrado: cifrado,
          webhookPathToken,
          base: basePublicaDoWebhookMeta(input.webhookPublicBaseContext),
          requestId: input.requestId,
        })
      : null;

  return {
    ok: true,
    displayName: linha.display_name,
    phoneNumber: linha.phone_number,
    webhookRegistro,
  };
}
