import { createServerFn } from "@tanstack/react-start";

const API_KEY = "33003367-5918-11f1-8d28-066a7fa2e369";
const AVATAR_ID = "17593eee-5774-419c-9923-64694d710c57";
const VOICE_ID = "ef51b5eb-5b39-4e6d-84e8-8b49a1b2e098";
const CONTEXT_ID = "620eb98d-45ae-4a6c-9971-2c0915b4c279";
const LANGUAGE = "pt";

export const getSessionToken = createServerFn({ method: "POST" }).handler(
  async () => {
    try {
      const res = await fetch("https://api.liveavatar.com/v1/sessions/token", {
        method: "POST",
        headers: {
          "X-API-KEY": API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mode: "FULL",
          avatar_id: AVATAR_ID,
          avatar_persona: {
            voice_id: VOICE_ID,
            context_id: CONTEXT_ID,
            language: LANGUAGE,
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
    } catch (error) {
      console.error("HeyGen token request failed", error);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Token request failed: ${String(error)}`);
    }
  },
);
