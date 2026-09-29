import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AttendantPersonalChannelSettings } from "@/lib/routing/attendant-channel-bindings";
import { AttendantPersonalChannelsForm } from "./_personal-channels-form";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));

const fetcher = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  fetcher.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { channel_session_id: null } }),
  });
});

const initial: AttendantPersonalChannelSettings = {
  channels: [
    { id: "channel-a", name: "WhatsApp Rafael" },
    { id: "channel-b", name: "WhatsApp Comercial" },
  ],
  members: [
    {
      id: "rafael",
      name: "Rafael Barra",
      binding: {
        channel_session_id: "channel-a",
        channel_name: "WhatsApp Rafael",
        valid: true,
        invalid_reason: null,
      },
    },
    { id: "outra", name: "Outra pessoa", binding: null },
  ],
};

describe("conexão pessoal de atendentes", () => {
  it("explica que a configuração não transfere atendimento", () => {
    render(<AttendantPersonalChannelsForm initial={initial} />);
    expect(
      screen.getByText(
        "Não transfere atendimentos automaticamente. Define apenas a conexão pessoal que poderá ser utilizada por futuras regras de continuação entre canais.",
      ),
    ).toBeVisible();
  });

  it("uma conexão já vinculada não pode ser escolhida por outra pessoa", () => {
    render(<AttendantPersonalChannelsForm initial={initial} />);
    const other = within(screen.getByTestId("conexao-pessoal-outra"));
    expect(other.getByRole("option", { name: "WhatsApp Rafael — já vinculada" })).toBeDisabled();
    expect(other.getByRole("option", { name: "WhatsApp Comercial" })).toBeEnabled();
  });

  it("binding antigo inválido aparece, não pode ser salvo de novo e pode ser removido", async () => {
    const invalid: AttendantPersonalChannelSettings = {
      channels: [{ id: "channel-b", name: "WhatsApp Comercial" }],
      members: [
        {
          id: "rafael",
          name: "Rafael Barra",
          binding: {
            channel_session_id: "channel-old",
            channel_name: "WhatsApp antigo",
            valid: false,
            invalid_reason: "archived",
          },
        },
      ],
    };
    render(<AttendantPersonalChannelsForm initial={invalid} />);
    const row = within(screen.getByTestId("conexao-pessoal-rafael"));
    expect(row.getByRole("option", { name: "Indisponível: WhatsApp antigo" })).toBeDisabled();
    expect(row.getByRole("button", { name: "Salvar" })).toBeDisabled();

    fireEvent.change(row.getByLabelText("Conexão pessoal"), { target: { value: "" } });
    expect(row.getByRole("button", { name: "Salvar" })).toBeEnabled();
    fireEvent.click(row.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({
      user_id: "rafael",
      channel_session_id: null,
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("removida"));
  });

  it("salva substituição pela rota dedicada e atualiza o estado visível", async () => {
    fetcher.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { channel_session_id: "channel-b" } }),
    });
    render(<AttendantPersonalChannelsForm initial={initial} />);
    const row = within(screen.getByTestId("conexao-pessoal-rafael"));
    fireEvent.change(row.getByLabelText("Conexão pessoal"), {
      target: { value: "channel-b" },
    });
    fireEvent.click(row.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({
      user_id: "rafael",
      channel_session_id: "channel-b",
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("salva"));
    expect(row.getByLabelText("Conexão pessoal")).toHaveValue("channel-b");
    expect(row.getByRole("button", { name: "Salvar" })).toBeDisabled();
  });
});
