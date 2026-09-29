/**
 * [P1] A porta da distribuição de atendimento (issue #144).
 *
 * O contribuidor pediu: distribuir leads em rodízio entre atendentes, e cada um
 * enxergando só os seus. Medido antes de escrever: as duas coisas existiam
 * inteiras no backend (worker `lib/routing/`, RLS `fn_can_view_lead`) e não
 * havia UMA tela que as ligasse — nenhum arquivo de `app/` consumia
 * `/api/v1/settings/routing`, e `visibility_mode` só aparecia sendo LIDO. O
 * único jeito de ligar era `UPDATE` à mão no Postgres.
 *
 * Esta spec prova o caminho como o dono do negócio o faria: pela tela, logado,
 * clicando. `curl` na rota provaria o backend — que já funcionava — e não a
 * existência da porta, que é o defeito.
 *
 * Cobre também o RBAC da tela (agent não entra) e a persistência de verdade
 * (recarrega e o estado voltou do banco, não do estado local do React).
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const localDb = credenciaisSupabaseDeTeste();
const db = createClient(localDb.url, localDb.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface Creds {
  org_id: string;
  password: string;
  users: Record<string, { id: string; email: string }>;
}

function loadCreds(): Creds {
  const precisa = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager;
  };
  if (precisa())
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();
let personalBindingUserId: string | null = null;
let personalChannelId: string | null = null;
let sourceChannelId: string | null = null;
let handoffContactId: string | null = null;
let handoffDemandId: string | null = null;
let handoffSourceId: string | null = null;
let handoffDestinationId: string | null = null;

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

/** O estado marcado vem do atributo que o próprio componente escreve. */
async function marcada(page: Page, nome: string, valor: string): Promise<boolean> {
  return (await page.getByTestId(`opcao-${nome}-${valor}`).getAttribute("data-marcada")) === "sim";
}

test.describe("distribuição de atendimento — a tela que liga o rodízio e a visibilidade", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async () => {
    const { data, error } = await db
      .from("channel_sessions")
      .insert({
        organization_id: creds.org_id,
        waha_session_name: `personal-binding-${randomUUID()}`,
        display_name: "Conexão pessoal E2E",
        status: "STOPPED",
        webhook_secret_encrypted: "\\x00",
      })
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("personal_channel_seed_failed");
    personalChannelId = data.id;

    const source = await db
      .from("channel_sessions")
      .insert({
        organization_id: creds.org_id,
        waha_session_name: `handoff-source-${randomUUID()}`,
        display_name: "Conexão principal E2E",
        status: "STOPPED",
        webhook_secret_encrypted: "\\x00",
      })
      .select("id")
      .single();
    if (source.error || !source.data) {
      throw source.error ?? new Error("source_channel_seed_failed");
    }
    sourceChannelId = source.data.id;
  });

  test.afterAll(async ({ browser }) => {
    // Devolve a org ao default do produto. Sem isto, uma spec que rode depois
    // herdaria `visibility_mode` alterado e mediria outro produto — e o vermelho
    // dela apontaria para o lugar errado.
    const page = await browser.newPage();
    await login(page, creds.users.manager!.email);
    await page.request.patch("/api/v1/settings/routing", {
      data: {
        mode: "manual",
        max_retries: 5,
        backoff_seconds: 60,
        visibility_mode: "own_and_unassigned",
      },
    });
    if (personalBindingUserId) {
      await page.request.patch("/api/v1/settings/routing/attendant-bindings", {
        data: { user_id: personalBindingUserId, channel_session_id: null },
      });
    }
    await page.close();
    if (handoffDestinationId) {
      await db.from("conversations").delete().eq("id", handoffDestinationId);
    }
    if (handoffSourceId) await db.from("conversations").delete().eq("id", handoffSourceId);
    if (handoffDemandId) await db.from("demandas").delete().eq("id", handoffDemandId);
    if (handoffContactId) await db.from("contacts").delete().eq("id", handoffContactId);
    if (personalChannelId) {
      const { error } = await db.from("channel_sessions").delete().eq("id", personalChannelId);
      if (error) throw error;
    }
    if (sourceChannelId) {
      const { error } = await db.from("channel_sessions").delete().eq("id", sourceChannelId);
      if (error) throw error;
    }
  });

  test("manager liga o rodízio e a restrição pela tela, e o estado sobrevive ao reload", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email);

    // 1. A tela é ALCANÇÁVEL pela navegação — não só pela URL digitada. É o
    //    defeito da issue: a feature existia e não tinha porta.
    await page.goto("/app/settings");
    const porta = page.getByRole("link", { name: /Distribuição de atendimento/i });
    await expect(porta).toBeVisible();
    await porta.click();
    await page.waitForURL(/\/app\/settings\/atendimento/);

    await expect(page.getByRole("heading", { name: "Distribuição de atendimento" })).toBeVisible();

    // 2. O default do produto aparece: manual + "os seus e os sem dono".
    expect(await marcada(page, "modo", "manual")).toBe(true);

    // 3. Liga o rodízio — e só então os knobs aparecem (config de retentativa
    //    não faz sentido no modo manual, em que ninguém retenta).
    await expect(page.locator("#max_retries")).toHaveCount(0);
    await page.getByTestId("opcao-modo-round_robin").click();
    await expect(page.locator("#max_retries")).toBeVisible();

    // 4. Restringe a visibilidade ao próprio atendente.
    await page.getByTestId("opcao-visibilidade-own").click();
    expect(await marcada(page, "visibilidade", "own")).toBe(true);

    // 5. Salva e recarrega: o estado tem de vir do BANCO. Sem o reload isto
    //    provaria só que o React guardou o clique.
    await page
      .getByTestId("form-atendimento")
      .getByRole("button", { name: "Salvar", exact: true })
      .click();
    await expect(page.getByText(/Distribuição de atendimento salva/i)).toBeVisible();

    await page.reload();
    expect(await marcada(page, "modo", "round_robin")).toBe(true);
    expect(await marcada(page, "visibilidade", "own")).toBe(true);
    await expect(page.locator("#max_retries")).toBeVisible();

    // 6. E a API concorda com a tela — se divergissem, uma das duas estaria
    //    mentindo e o operador não teria como saber qual.
    const res = await page.request.get("/api/v1/settings/routing");
    expect(res.status()).toBe(200);
    const { data } = (await res.json()) as {
      data: { mode: string; visibility_mode: string };
    };
    expect(data.mode).toBe("round_robin");
    expect(data.visibility_mode).toBe("own");
  });

  test("a combinação que mata a operação é avisada antes de salvar", async ({ page }) => {
    // "só os seus" + distribuição manual = ninguém enxerga a fila para pegar,
    // e nenhum cliente é atendido. É a configuração que o operador escolheria
    // achando que está sendo restritivo.
    await login(page, creds.users.manager!.email);
    await page.goto("/app/settings/atendimento");

    await page.getByTestId("opcao-modo-manual").click();
    await page.getByTestId("opcao-visibilidade-own").click();
    await expect(page.getByTestId("aviso-combinacao-morta")).toBeVisible();

    await page.getByTestId("opcao-modo-round_robin").click();
    await expect(page.getByTestId("aviso-combinacao-morta")).toHaveCount(0);
  });

  test("manager vincula uma conexão pessoal sem prometer transferência automática", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email);
    await page.goto("/app/settings/atendimento");

    const card = page.getByTestId("conexoes-pessoais-atendentes");
    await expect(card).toBeVisible();
    await expect(card.getByText(/Não transfere atendimentos automaticamente/i)).toBeVisible();

    const row = card.locator('[data-testid^="conexao-pessoal-"]').first();
    await expect(row).toBeVisible();
    personalBindingUserId =
      (await row.getAttribute("data-testid"))?.replace("conexao-pessoal-", "") ?? null;
    expect(personalBindingUserId).not.toBeNull();

    const select = row.getByLabel("Conexão pessoal");
    expect(personalChannelId).not.toBeNull();
    await expect(select.locator(`option[value="${personalChannelId}"]`)).toBeEnabled();
    await select.selectOption(personalChannelId!);
    await row.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(card.getByRole("status")).toContainText("Conexão pessoal salva");

    await page.reload();
    const persisted = page.getByTestId(`conexao-pessoal-${personalBindingUserId}`);
    await expect(persisted.getByLabel("Conexão pessoal")).toHaveValue(personalChannelId!);
  });

  test("manager continua a mesma demanda na conexão pessoal, sem enviar mensagem", async ({
    page,
  }) => {
    expect(personalBindingUserId).not.toBeNull();
    expect(personalChannelId).not.toBeNull();
    expect(sourceChannelId).not.toBeNull();

    const contact = await db
      .from("contacts")
      .insert({ organization_id: creds.org_id, display_name: "Contato handoff E2E" })
      .select("id")
      .single();
    if (contact.error || !contact.data) throw contact.error ?? new Error("handoff_contact_seed");
    handoffContactId = contact.data.id;

    const demand = await db
      .from("demandas")
      .insert({
        organization_id: creds.org_id,
        contact_id: handoffContactId,
        origem: "manual",
        estado: "em_atendimento",
        dono_kind: "humano",
        dono_user_id: personalBindingUserId,
        proximo_passo: "Continuar pela conexão pessoal",
      })
      .select("id")
      .single();
    if (demand.error || !demand.data) throw demand.error ?? new Error("handoff_demand_seed");
    handoffDemandId = demand.data.id;

    const source = await db
      .from("conversations")
      .insert({
        organization_id: creds.org_id,
        contact_id: handoffContactId,
        channel_session_id: sourceChannelId,
        status: "claimed",
        assigned_to_user_id: personalBindingUserId,
        assigned_to_user_name: "Responsável E2E",
        assigned_at: new Date().toISOString(),
        assignee_kind: "user",
        bot_silenced_until: "infinity",
        current_demanda_id: handoffDemandId,
        service_revision: 1,
        service_started_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (source.error || !source.data) throw source.error ?? new Error("handoff_source_seed");
    handoffSourceId = source.data.id;
    const link = await db.from("demanda_conversas").insert({
      organization_id: creds.org_id,
      demanda_id: handoffDemandId,
      conversation_id: handoffSourceId,
      service_revision: 1,
    });
    if (link.error) throw link.error;

    await login(page, creds.users.manager!.email);
    await page.goto(`/app/inbox?id=${handoffSourceId}&filter=all`);
    const action = page.getByRole("button", { name: "Continuar na conexão pessoal" });
    await expect(action).toBeVisible({ timeout: 30_000 });
    await action.click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("continuará em outro número");
    await expect(dialog).toContainText("Nenhuma mensagem será enviada agora");
    await dialog.getByRole("button", { name: "Abrir conversa" }).click();

    await expect(
      page.getByText("Conversa pronta na conexão pessoal. Nenhuma mensagem foi enviada."),
    ).toBeVisible();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("id"), { timeout: 30_000 })
      .not.toBe(handoffSourceId);
    handoffDestinationId = new URL(page.url()).searchParams.get("id");
    expect(handoffDestinationId).not.toBeNull();

    const [sourceAfter, destination, links, messages, receipt, audit] = await Promise.all([
      db
        .from("conversations")
        .select("channel_session_id,contact_id,current_demanda_id,assigned_to_user_id,status")
        .eq("id", handoffSourceId)
        .single(),
      db
        .from("conversations")
        .select("channel_session_id,contact_id,current_demanda_id,assigned_to_user_id,status")
        .eq("id", handoffDestinationId!)
        .single(),
      db
        .from("demanda_conversas")
        .select("conversation_id", { count: "exact" })
        .eq("demanda_id", handoffDemandId!),
      db
        .from("messages")
        .select("id", { count: "exact" })
        .eq("conversation_id", handoffDestinationId!),
      db
        .from("channel_handoffs")
        .select("status,destination_conversation_id,assigned_user_id")
        .eq("source_conversation_id", handoffSourceId)
        .single(),
      db
        .from("api_audit_log")
        .select("action")
        .eq("organization_id", creds.org_id)
        .eq("resource_id", handoffSourceId)
        .eq("action", "conversation.channel_handoff_completed")
        .limit(1),
    ]);
    for (const result of [sourceAfter, destination, links, messages, receipt, audit]) {
      if (result.error) throw result.error;
    }
    expect(sourceAfter.data).toMatchObject({
      channel_session_id: sourceChannelId,
      contact_id: handoffContactId,
      current_demanda_id: handoffDemandId,
      assigned_to_user_id: personalBindingUserId,
      status: "claimed",
    });
    expect(destination.data).toMatchObject({
      channel_session_id: personalChannelId,
      contact_id: handoffContactId,
      current_demanda_id: handoffDemandId,
      assigned_to_user_id: personalBindingUserId,
      status: "claimed",
    });
    expect(links.count).toBe(2);
    expect(messages.count).toBe(0);
    expect(receipt.data).toMatchObject({
      status: "completed",
      destination_conversation_id: handoffDestinationId,
      assigned_user_id: personalBindingUserId,
    });
    expect(audit.data).toHaveLength(1);
  });

  test("atendente não abre a tela nem consegue gravar pela API", async ({ page }) => {
    await login(page, creds.users.agent!.email);

    await page.goto("/app/settings/atendimento");
    await expect(page.getByTestId("form-atendimento")).toHaveCount(0);

    // O redirect da página não é a defesa — é conforto. A defesa é o servidor:
    // sem esta asserção, tirar o `requireRole` da rota deixaria a spec verde.
    const res = await page.request.patch("/api/v1/settings/routing", {
      data: { mode: "round_robin", max_retries: 5, backoff_seconds: 60, visibility_mode: "all" },
    });
    expect(res.status()).toBe(403);

    const bindingRes = await page.request.patch("/api/v1/settings/routing/attendant-bindings", {
      data: {
        user_id: "10000000-0000-4000-8000-000000000001",
        channel_session_id: null,
      },
    });
    expect(bindingRes.status()).toBe(403);
  });
});
