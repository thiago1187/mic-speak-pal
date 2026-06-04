import { createServerFn } from "@tanstack/react-start";

type TokenInput = {
  apiKey: string;
  avatarId: string;
  voiceId: string;
  contextId: string;
  language: string;
};

export const getSessionToken = createServerFn({ method: "POST" })
  .inputValidator((data: TokenInput) => {
    if (!data?.apiKey) throw new Error("apiKey ausente");
    if (!data?.avatarId) throw new Error("avatarId ausente");
    if (!data?.voiceId) throw new Error("voiceId ausente");
    if (!data?.contextId) throw new Error("contextId ausente");
    if (!data?.language) throw new Error("language ausente");
    return data;
  })
  .handler(async ({ data }) => {
    const res = await fetch("https://api.liveavatar.com/v1/sessions/token", {
      method: "POST",
      headers: {
        "X-API-KEY": data.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: "FULL",
        avatar_id: data.avatarId,
        avatar_persona: {
          voice_id: data.voiceId,
          context_id: data.contextId,
          language: data.language,
        },
      }),
    });

    const text = await res.text();
    console.log("HeyGen token response", { status: res.status, body: text });
    if (!res.ok) {
      throw new Error(`Token error ${res.status} ${res.statusText}: ${text}`);
    }
    const json = JSON.parse(text);
    return {
      session_token: json.data.session_token as string,
      session_id: json.data.session_id as string,
      token_http_status: res.status,
      token_response_body: text,
    };
  });
