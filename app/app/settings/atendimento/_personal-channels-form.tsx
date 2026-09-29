"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import type {
  AttendantPersonalChannelBinding,
  AttendantPersonalChannelSettings,
} from "@/lib/routing/attendant-channel-bindings";

interface PatchResponse {
  data?: {
    channel_session_id: string | null;
  };
  error?: { message?: string };
}

export function AttendantPersonalChannelsForm({
  initial,
}: {
  initial: AttendantPersonalChannelSettings;
}) {
  const t = useT();
  const [members, setMembers] = useState(initial.members);
  const [drafts, setDrafts] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(
      initial.members.map((member) => [member.id, member.binding?.channel_session_id ?? null]),
    ),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");

  const boundTo = useMemo(
    () =>
      new Map(
        members.flatMap((member) =>
          member.binding?.valid ? ([[member.binding.channel_session_id, member.id]] as const) : [],
        ),
      ),
    [members],
  );

  async function save(userId: string) {
    const channelSessionId = drafts[userId] ?? null;
    setBusy(userId);
    setFeedback("");
    try {
      const response = await fetch("/api/v1/settings/routing/attendant-bindings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, channel_session_id: channelSessionId }),
      });
      const body = (await response.json()) as PatchResponse;
      if (!response.ok) {
        setFeedback(t(body.error?.message ?? "Não foi possível salvar. Tente novamente."));
        return;
      }

      const savedChannelId = body.data?.channel_session_id ?? null;
      const channel = initial.channels.find((candidate) => candidate.id === savedChannelId);
      const binding: AttendantPersonalChannelBinding | null = channel
        ? {
            channel_session_id: channel.id,
            channel_name: channel.name,
            valid: true,
            invalid_reason: null,
          }
        : null;
      setMembers((current) =>
        current.map((member) => (member.id === userId ? { ...member, binding } : member)),
      );
      setDrafts((current) => ({ ...current, [userId]: savedChannelId }));
      setFeedback(savedChannelId ? t("Conexão pessoal salva.") : t("Conexão pessoal removida."));
    } catch {
      setFeedback(t("Não foi possível salvar. Tente novamente."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="max-w-3xl space-y-4 p-4" data-testid="conexoes-pessoais-atendentes">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{t("Conexão pessoal de cada atendente")}</h2>
        <p className="text-xs text-muted-foreground">
          {t(
            "Não transfere atendimentos automaticamente. Define apenas a conexão pessoal que poderá ser utilizada por futuras regras de continuação entre canais.",
          )}
        </p>
      </div>

      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Nenhum atendente ativo na equipe.")}</p>
      ) : (
        <div className="divide-y rounded-md border">
          {members.map((member) => {
            const savedId = member.binding?.channel_session_id ?? null;
            const draftId = drafts[member.id] ?? null;
            const unchanged = draftId === savedId;
            const invalidUnchanged = member.binding !== null && !member.binding.valid && unchanged;

            return (
              <div
                key={member.id}
                className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] sm:items-end"
                data-testid={`conexao-pessoal-${member.id}`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{member.name}</p>
                  {member.binding && !member.binding.valid ? (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      {t(
                        "A conexão gravada não está mais disponível. Escolha outra ou remova o vínculo.",
                      )}
                    </p>
                  ) : null}
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`personal-channel-${member.id}`}>{t("Conexão pessoal")}</Label>
                  <select
                    id={`personal-channel-${member.id}`}
                    value={draftId ?? ""}
                    disabled={busy !== null}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [member.id]: event.target.value || null,
                      }))
                    }
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">{t("Nenhuma")}</option>
                    {member.binding && !member.binding.valid ? (
                      <option value={member.binding.channel_session_id} disabled>
                        {t("Indisponível")}: {member.binding.channel_name}
                      </option>
                    ) : null}
                    {initial.channels.map((channel) => {
                      const owner = boundTo.get(channel.id);
                      const belongsToAnother = owner !== undefined && owner !== member.id;
                      return (
                        <option key={channel.id} value={channel.id} disabled={belongsToAnother}>
                          {channel.name}
                          {belongsToAnother ? ` — ${t("já vinculada")}` : ""}
                        </option>
                      );
                    })}
                  </select>
                </div>
                <Button
                  type="button"
                  disabled={busy !== null || unchanged || invalidUnchanged}
                  onClick={() => void save(member.id)}
                >
                  {busy === member.id ? t("Salvando…") : t("Salvar")}
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {initial.channels.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Link className="underline" href="/app/connections">
            {t("Conecte um número de mensagens para escolher uma conexão pessoal.")}
          </Link>
        </p>
      ) : null}
      <p role="status" aria-live="polite" className="text-sm">
        {feedback}
      </p>
    </Card>
  );
}
