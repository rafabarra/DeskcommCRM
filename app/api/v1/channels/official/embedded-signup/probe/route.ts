/**
 * GET /api/v1/channels/official/embedded-signup/probe
 *
 * PROBE TEMPORÁRIA do redirect do Meta Hosted Embedded Signup / Coexistence.
 * Isto NÃO é o callback OAuth final: não valida state, não troca code por
 * token, não chama a Graph API, não grava nada e não conecta channel_session.
 *
 * A rota é pública porque recebe uma navegação cross-site da Meta e o cookie
 * de sessão do produto é SameSite=Strict. Ser pública não lhe concede
 * autoridade: organization_id, user_id e todos os valores da query são
 * ignorados. Só a forma segura da volta aparece no documento de diagnóstico.
 *
 * `code` e `state` podem ser credenciais. Seus valores nunca entram no HTML,
 * em logs, em observabilidade ou em outro serviço; mostramos apenas presença e
 * comprimento. Parâmetros desconhecidos contribuem somente com o próprio nome,
 * escapado como texto.
 */

const CAMINHO_DA_PROBE = "/api/v1/channels/official/embedded-signup/probe";

function escaparHtml(valor: string): string {
  return valor
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nomesDosParametros(params: URLSearchParams): string[] {
  return [...new Set(params.keys())].sort((a, b) => a.localeCompare(b));
}

function linha(rotulo: string, valor: string | number | boolean): string {
  return `<tr><th scope="row">${escaparHtml(rotulo)}</th><td>${escaparHtml(String(valor))}</td></tr>`;
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const nomes = nomesDosParametros(params);
  const listaDeNomes =
    nomes.length === 0
      ? "<li>Nenhum parâmetro recebido.</li>"
      : nomes.map((nome) => `<li><code>${escaparHtml(nome)}</code></li>`).join("");

  const html =
    '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow,noarchive">' +
    "<title>Retorno do Meta Hosted Signup</title></head><body>" +
    "<main><h1>Retorno do Meta Hosted Signup recebido.</h1>" +
    "<p>Nenhuma credencial foi salva e nenhum número foi conectado.</p>" +
    "<h2>Estrutura segura recebida</h2><table><tbody>" +
    linha("Método HTTP", "GET") +
    linha("Timestamp", new Date().toISOString()) +
    linha("Path da callback", CAMINHO_DA_PROBE) +
    linha("code presente", code !== null) +
    linha("comprimento de code", code?.length ?? 0) +
    linha("state presente", state !== null) +
    linha("comprimento de state", state?.length ?? 0) +
    linha("error presente", params.has("error")) +
    linha("error_reason presente", params.has("error_reason")) +
    linha("error_description presente", params.has("error_description")) +
    "</tbody></table><h2>Nomes dos parâmetros recebidos</h2><ul>" +
    listaDeNomes +
    '</ul><p><a href="/admin/meta">Voltar para API Oficial (Meta)</a></p></main></body></html>';

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Content-Security-Policy":
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    },
  });
}
