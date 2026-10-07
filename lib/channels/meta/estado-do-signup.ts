import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

export const VALIDADE_DO_SIGNUP_MS = 10 * 60 * 1000;
export const VALIDADE_DO_COOKIE_SIGNUP_S = VALIDADE_DO_SIGNUP_MS / 1000;
export const NOME_DO_COOKIE_SIGNUP = "crm_embedded_signup_state";
export const CAMINHO_DO_FLUXO_SIGNUP = "/api/v1/channels/official/embedded-signup";
export const TIPO_DO_FLUXO_SIGNUP = "channel_embedded_signup";

const TAMANHO_MINIMO_DO_SEGREDO = 16;

const estadoSchema = z
  .object({
    v: z.literal(1),
    fluxo: z.literal(TIPO_DO_FLUXO_SIGNUP),
    organizationId: z.string().uuid(),
    userId: z.string().uuid(),
    authSessionId: z.string().uuid().optional(),
    nonce: z
      .string()
      .min(32)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    expiraEmMs: z.number().int().positive(),
  })
  .strict();

export type EstadoDoSignup = z.infer<typeof estadoSchema>;

function segredoValido(segredo: string): string {
  const valor = segredo?.trim() ?? "";
  if (valor.length < TAMANHO_MINIMO_DO_SEGREDO) {
    throw new Error("Segredo interno indisponível para assinar o fluxo de conexão.");
  }
  return valor;
}

function assinatura(carga: string, segredo: string): Buffer {
  return createHmac("sha256", segredo).update(carga, "utf8").digest();
}

export function emitirEstadoDoSignup(
  dados: Omit<EstadoDoSignup, "v" | "fluxo" | "expiraEmMs">,
  opcoes: { segredo: string; agora: Date; validadeMs?: number },
): string {
  const segredo = segredoValido(opcoes.segredo);
  const estado = estadoSchema.parse({
    v: 1,
    fluxo: TIPO_DO_FLUXO_SIGNUP,
    ...dados,
    expiraEmMs: opcoes.agora.getTime() + (opcoes.validadeMs ?? VALIDADE_DO_SIGNUP_MS),
  });
  const carga = Buffer.from(JSON.stringify(estado), "utf8").toString("base64url");
  return `${carga}.${assinatura(carga, segredo).toString("hex")}`;
}

export function verificarEstadoDoSignup(
  token: string | null | undefined,
  opcoes: { segredo: string; agora: Date },
): EstadoDoSignup | null {
  if (!token) return null;
  const segredo = segredoValido(opcoes.segredo);
  const partes = token.split(".");
  if (partes.length !== 2) return null;
  const [carga, assinaturaHex] = partes;
  if (!carga || !assinaturaHex || !/^[0-9a-f]{64}$/i.test(assinaturaHex)) return null;

  const esperada = assinatura(carga, segredo);
  const recebida = Buffer.from(assinaturaHex, "hex");
  if (recebida.length !== esperada.length || !timingSafeEqual(recebida, esperada)) return null;

  try {
    const estado = estadoSchema.parse(JSON.parse(Buffer.from(carga, "base64url").toString("utf8")));
    return opcoes.agora.getTime() <= estado.expiraEmMs ? estado : null;
  } catch {
    return null;
  }
}
