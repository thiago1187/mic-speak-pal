import { createServerFn } from "@tanstack/react-start";

const RECALL_BASE = "https://us-west-2.recall.ai/api/v1";

type CreateBotInput = { apiKey: string; meetingUrl: string; botName?: string };

export const recallCreateBot = createServerFn({ method: "POST" })
  .inputValidator((data: CreateBotInput) => {
    if (!data?.apiKey) throw new Error("apiKey ausente");
    if (!data?.meetingUrl) throw new Error("meetingUrl ausente");
    return data;
  })
  .handler(async ({ data }) => {
    const body = {
      meeting_url: data.meetingUrl,
      bot_name: data.botName || "Renante",
      recording_config: {
        transcript: {
          provider: { meeting_captions: {} },
        },
      },
    };
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
