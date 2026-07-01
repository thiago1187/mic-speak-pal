import { createServerFn } from "@tanstack/react-start";
import { verifyAppToken } from "@/lib/auth.functions";

const RECALL_BASE = "https://us-west-2.recall.ai/api/v1";

async function requireAuth(token?: string) {
  if (!(await verifyAppToken(token))) {
    throw new Error("Não autorizado — faça login.");
  }
}

// A apiKey pode vir vazia do cliente: usamos a env RECALL_API_KEY (.env / Vercel).
function resolveRecallKey(clientKey?: string): string {
  const key = (clientKey || process.env.RECALL_API_KEY || "").trim();
  if (!key) {
    throw new Error(
      "Recall API key ausente. Defina RECALL_API_KEY no .env (local) e nas Environment Variables da Vercel.",
    );
  }
  return key;
}

// outputMediaUrl (CAMADA 3): quando presente, o Recall renderiza essa página
// pública num navegador na nuvem dele e transmite o áudio+vídeo dela como
// câmera+microfone do bot dentro da reunião (o avatar fala DENTRO do Meet).
// Sem outputMediaUrl, o comportamento é idêntico ao das Camadas 1/2.
type CreateBotInput = {
  apiKey?: string;
  meetingUrl: string;
  botName?: string;
  outputMediaUrl?: string;
  authToken?: string;
};

export const recallCreateBot = createServerFn({ method: "POST" })
  .inputValidator((data: CreateBotInput) => {
    if (!data?.meetingUrl) throw new Error("meetingUrl ausente");
    return data;
  })
  .handler(async ({ data }) => {
    await requireAuth(data.authToken);
    const apiKey = resolveRecallKey(data.apiKey);
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
      // Transcrição REALTIME via Deepgram (streaming) — rápida E suporta português,
      // ao contrário do recallai_streaming (cujo modo PT é lento). É isso que
      // alimenta o WebSocket que a página /meet escuta → o avatar "ouve" rápido.
      // A API KEY do Deepgram fica no PAINEL do Recall (dashboard/transcription),
      // não aqui — o Recall usa a credencial salva.
      body.recording_config = {
        transcript: {
          provider: {
            deepgram_streaming: {
              language: "pt-BR",
              model: "nova-2",
            },
          },
        },
      };
    }
    const res = await fetch(`${RECALL_BASE}/bot/`, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
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

type BotIdInput = { apiKey?: string; botId: string; authToken?: string };

export const recallGetTranscript = createServerFn({ method: "POST" })
  .inputValidator((data: BotIdInput) => {
    if (!data?.botId) throw new Error("botId ausente");
    return data;
  })
  .handler(async ({ data }) => {
    await requireAuth(data.authToken);
    const apiKey = resolveRecallKey(data.apiKey);
    const res = await fetch(
      `${RECALL_BASE}/bot/${encodeURIComponent(data.botId)}/transcript/`,
      {
        method: "GET",
        headers: { Authorization: `Token ${apiKey}` },
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
    if (!data?.botId) throw new Error("botId ausente");
    return data;
  })
  .handler(async ({ data }) => {
    await requireAuth(data.authToken);
    const apiKey = resolveRecallKey(data.apiKey);
    const res = await fetch(
      `${RECALL_BASE}/bot/${encodeURIComponent(data.botId)}/leave_call/`,
      {
        method: "POST",
        headers: { Authorization: `Token ${apiKey}` },
      },
    );
    const text = await res.text();
    return { status: res.status, ok: res.ok, body: text };
  });
