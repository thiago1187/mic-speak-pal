import { createServerFn } from "@tanstack/react-start";

// ===================================================================
// Login por SENHA ÚNICA compartilhada. A senha fica na env APP_PASSWORD
// (servidor) — nunca vai pro navegador. O cliente recebe só um TOKEN
// assinado (HMAC) com validade, guardado no localStorage, e o envia nas
// chamadas protegidas. As server functions da API verificam esse token.
//
// FAIL-OPEN por segurança operacional: se APP_PASSWORD NÃO estiver
// definida, o login fica DESATIVADO (app abre normal). A proteção só
// entra em ação quando você define a senha (local no .env / Vercel).
// ===================================================================

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

function appPassword(): string {
  return (process.env.APP_PASSWORD || "").trim();
}

// HMAC-SHA256 via Web Crypto (disponível em Node 18+, Vercel, Cloudflare e browser)
// — sem depender de import "node:crypto", que quebraria o bundle do cliente.
async function hmacHex(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signToken(): Promise<string> {
  const exp = Date.now() + TOKEN_TTL_MS;
  const sig = await hmacHex(String(exp), appPassword());
  return `${exp}.${sig}`;
}

// true = autorizado. Se NÃO houver senha configurada, retorna true (login off).
export async function verifyAppToken(token?: string): Promise<boolean> {
  const pw = appPassword();
  if (!pw) return true; // login desativado (env não configurada)
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expected = await hmacHex(String(exp), pw);
  return constantTimeEqual(sig, expected);
}

// O cliente pergunta se o login está ligado (pra decidir mostrar a tela).
export const isAuthEnabled = createServerFn({ method: "GET" }).handler(async () => ({
  enabled: appPassword().length > 0,
}));

// Verifica um token já guardado no localStorage.
export const checkAuth = createServerFn({ method: "POST" })
  .inputValidator((data: { token?: string }) => data ?? {})
  .handler(async ({ data }) => ({ ok: await verifyAppToken(data?.token) }));

// Login: confere a senha e devolve um token assinado (ou ok:false).
export const login = createServerFn({ method: "POST" })
  .inputValidator((data: { password?: string }) => data ?? {})
  .handler(async ({ data }) => {
    const pw = appPassword();
    if (!pw) return { ok: true, token: "", disabled: true as const }; // login off
    if ((data?.password || "") === pw) {
      return { ok: true as const, token: await signToken() };
    }
    return { ok: false as const, token: "" };
  });
