import { createServerFn } from "@tanstack/react-start";

const RECALL_BASE = "https://us-west-2.recall.ai/api/v1";

// outputMediaUrl (CAMADA 3): quando presente, o Recall renderiza essa página
// pública num navegador na nuvem dele e transmite o áudio+vídeo dela como
// câmera+microfone do bot dentro da reunião (o avatar fala DENTRO do Meet).
// Sem outputMediaUrl, o comportamento é idêntico ao das Camadas 1/2.
type CreateBotInput = {
  apiKey: string;
  meetingUrl: string;
  botName?: string;
  outputMediaUrl?: string;
};

export const recallCreateBot = createServerFn({ method: "POST" })
  .inputValidator((data: CreateBotInput) => {
    if (!data?.apiKey) throw new Error("apiKey ausente");
    if (!data?.meetingUrl) throw new Error("meetingUrl ausente");
    return data;
  })
  .handler(async ({ data }) => {
    const body: Record<string, unknown> = {
      meeting_url: data.meetingUrl,
      bot_name: data.botName || "Renante",
      recording_config: {
        transcript: {
          provider: { meeting_captions: {} },
        },
      },
    };
    if (data.outputMediaUrl) {
      body.output_media = {
        camera: {
          kind: "webpage",
          config: { url: data.outputMediaUrl },
        },
      };
      // Renderizar o avatar (WebRTC) + recapturar + re-codificar pro Meet é pesado.
      // A máquina padrão do bot derruba frames → trava. Sobe pra uma maior só aqui
      // (Camada 3). Camadas 1/2 não usam output_media e seguem na máquina padrão.
      body.variant = { google_meet: "web_4_core" };
      // Transcrição REALTIME do próprio Recall (não depende do CC do Meet estar
      // ligado, ao contrário do meeting_captions). É isso que alimenta o WebSocket
      // que a página /meet escuta → faz o avatar "ouvir" a reunião.
      body.recording_config = {
        transcript: {
          provider: {
            recallai_streaming: {
              mode: "prioritize_low_latency",
              language_code: "pt",
            },
          },
        },
      };
    }
    const res = await fetch(`${RECALL_BASE}/bot/`, {
      method: "POST",
      headers: {
        Authorization: `Token ${data.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, ok: res.ok, body: text, bot: json };
  });

type BotIdInput = { apiKey: string; botId: string };

export const recallGetTranscript = createServerFn({ method: "POST" })
  .inputValidator((data: BotIdInput) => {
    if (!data?.apiKey) throw new Error("apiKey ausente");
    if (!data?.botId) throw new Error("botId ausente");
    return data;
  })
  .handler(async ({ data }) => {
    const res = await fetch(
      `${RECALL_BASE}/bot/${encodeURIComponent(data.botId)}/transcript/`,
      {
        method: "GET",
        headers: { Authorization: `Token ${data.apiKey}` },
      },
    );
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, ok: res.ok, body: text, transcript: json };
  });

export const recallLeaveBot = createServerFn({ method: "POST" })
  .inputValidator((data: BotIdInput) => {
    if (!data?.apiKey) throw new Error("apiKey ausente");
    if (!data?.botId) throw new Error("botId ausente");
    return data;
  })
  .handler(async ({ data }) => {
    const res = await fetch(
      `${RECALL_BASE}/bot/${encodeURIComponent(data.botId)}/leave_call/`,
      {
        method: "POST",
        headers: { Authorization: `Token ${data.apiKey}` },
      },
    );
    const text = await res.text();
    return { status: res.status, ok: res.ok, body: text };
  });
