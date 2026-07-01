import { createServerFn } from "@tanstack/react-start";
import { verifyAppToken } from "@/lib/auth.functions";

// Barra chamadas não autenticadas (quando o login está ligado via APP_PASSWORD).
async function requireAuth(token?: string) {
  if (!(await verifyAppToken(token))) {
    throw new Error("Não autorizado — faça login.");
  }
}

type TokenInput = {
  apiKey?: string;
  avatarId: string;
  voiceId: string;
  contextId: string;
  language: string;
  authToken?: string;
};

// A apiKey pode vir vazia do cliente: nesse caso usamos a variável de ambiente
// HEYGEN_API_KEY (definida no .env local e no painel da Vercel). Assim a chave não
// precisa ser digitada na UI nem fica embutida no bundle do site.
function resolveHeygenKey(clientKey?: string): string {
  const key = (clientKey || process.env.HEYGEN_API_KEY || "").trim();
  if (!key) {
    throw new Error(
      "HeyGen API key ausente. Defina HEYGEN_API_KEY no .env (local) e nas Environment Variables da Vercel.",
    );
  }
  return key;
}

export const getSessionToken = createServerFn({ method: "POST" })
  .inputValidator((data: TokenInput) => {
    if (!data?.avatarId) throw new Error("avatarId ausente");
    if (!data?.voiceId) throw new Error("voiceId ausente");
    if (!data?.contextId) throw new Error("contextId ausente");
    if (!data?.language) throw new Error("language ausente");
    return data;
  })
  .handler(async ({ data }) => {
    await requireAuth(data.authToken);
    const apiKey = resolveHeygenKey(data.apiKey);
    const res = await fetch("https://api.liveavatar.com/v1/sessions/token", {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
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

// Gera um token de curta duração do Deepgram a partir da API key, pra usar com
// segurança no navegador (o token vai pro WebSocket; a key fica no servidor).
// Se a key não tiver permissão de "grant", cai pro fallback de usar a própria key.
type DeepgramInput = { apiKey?: string; authToken?: string };
export const getDeepgramToken = createServerFn({ method: "POST" })
  .inputValidator((data: DeepgramInput) => data ?? {})
  .handler(async ({ data }) => {
    await requireAuth(data?.authToken);
    const apiKey = (data?.apiKey || process.env.DEEPGRAM_API_KEY || "").trim();
    if (!apiKey) {
      throw new Error(
        "Deepgram API key ausente. Defina DEEPGRAM_API_KEY no .env (local) e nas Environment Variables da Vercel.",
      );
    }
    try {
      const r: Response = await fetch("https://api.deepgram.com/v1/auth/grant", {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl_seconds: 60 }),
      });
      if (r.ok) {
        const j: any = await r.json();
        if (j?.access_token) {
          return { token: j.access_token as string, temporary: true };
        }
      }
    } catch {
      /* cai no fallback abaixo */
    }
    // Fallback: usa a própria key (funciona se o grant não for permitido).
    return { token: apiKey, temporary: false };
  });

// Diagnóstico: o servidor enxerga as variáveis de ambiente? (retorna só booleans).
export const getEnvStatus = createServerFn({ method: "GET" }).handler(async () => ({
  heygen: Boolean((process.env.HEYGEN_API_KEY || "").trim()),
  deepgram: Boolean((process.env.DEEPGRAM_API_KEY || "").trim()),
  recall: Boolean((process.env.RECALL_API_KEY || "").trim()),
}));

type ListInput = { apiKey?: string; authToken?: string };

export type AvatarOption = {
  id: string;
  name: string;
  previewUrl: string;
  defaultVoiceId: string;
  defaultVoiceName: string;
  owned: boolean;
};

export type VoiceOption = {
  id: string;
  name: string;
  language: string;
  gender: string;
};

// Lista avatares: primeiro os da conta (GET /v1/avatars) e depois os públicos
// (GET /v1/avatars/public, paginado). Retorna combinado, com os "owned" primeiro.
export const listAvatars = createServerFn({ method: "POST" })
  .inputValidator((data: ListInput) => data ?? {})
  .handler(async ({ data }) => {
    await requireAuth(data?.authToken);
    const headers = { "X-API-KEY": resolveHeygenKey(data?.apiKey) };
    const out: AvatarOption[] = [];
    const push = (results: any[], owned: boolean) => {
      for (const a of results ?? []) {
        if (!a?.id) continue;
        if (a.status && a.status !== "ACTIVE") continue;
        out.push({
          id: a.id,
          name: a.name ?? a.id,
          previewUrl: a.preview_url ?? "",
          defaultVoiceId: a.default_voice?.id ?? "",
          defaultVoiceName: a.default_voice?.name ?? "",
          owned,
        });
      }
    };

    try {
      const resp: Response = await fetch("https://api.liveavatar.com/v1/avatars", { headers });
      const body: any = await resp.json();
      push(body?.data?.results, true);
    } catch {
      /* sem avatares da conta — segue só com públicos */
    }

    let nextUrl: string | null = "https://api.liveavatar.com/v1/avatars/public?page_size=50";
    let pages = 0;
    while (nextUrl && pages < 4) {
      const resp: Response = await fetch(nextUrl, { headers });
      const body: any = await resp.json();
      push(body?.data?.results, false);
      nextUrl = (body?.data?.next as string | null) ?? null;
      pages++;
    }

    return out;
  });

// Lista as vozes disponíveis (GET /v1/voices). Hoje a API só retorna presets em
// inglês — vozes custom em PT não aparecem (use o campo manual de voice_id).
export const listVoices = createServerFn({ method: "POST" })
  .inputValidator((data: ListInput) => data ?? {})
  .handler(async ({ data }) => {
    await requireAuth(data?.authToken);
    const r = await fetch("https://api.liveavatar.com/v1/voices?page_size=100", {
      headers: { "X-API-KEY": resolveHeygenKey(data?.apiKey) },
    });
    const j = await r.json();
    return ((j?.data?.results ?? []) as any[]).map<VoiceOption>((v) => ({
      id: v.id,
      name: v.name ?? v.id,
      language: v.language ?? "",
      gender: v.gender ?? "",
    }));
  });
