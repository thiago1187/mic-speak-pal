import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentEventsEnum, LiveAvatarSession, SessionEvent } from "@heygen/liveavatar-web-sdk";
import { getSessionToken } from "@/lib/heygen.functions";

// =====================================================================
// CAMADA 3 — Página pública do avatar DENTRO da reunião.
//
// O Recall renderiza ESTA página num navegador na nuvem dele e transmite
// o áudio+vídeo dela como câmera+microfone do bot no Google Meet. Logo,
// a página tem que ser AUTO-SUFICIENTE: conecta o LiveAvatar, ouve a
// transcrição da reunião (WebSocket do Recall), aplica wake/end words,
// chama o webhook Reunião do n8n (com filler instantâneo) e faz o avatar
// falar. O que o avatar fala sai pelo bot na reunião.
//
// NÃO depende do app principal (index.tsx). As Camadas 1/2 seguem intactas.
//
// Config vem pela query string (montada pelo app ao criar o bot):
//   /meet?apiKey=..&avatarId=..&voiceId=..&contextId=..&language=pt
//        &wr=<webhookReuniao>&wf=<webhookFiller>
// =====================================================================

export const Route = createFileRoute("/meet")({
  head: () => ({
    meta: [{ title: "Renante — Avatar na Reunião" }],
  }),
  component: MeetAvatar,
});

const SPEAK_TIMEOUT_MS = 60_000;
const RECALL_TRANSCRIPT_WS = "wss://meeting-data.bot.recall.ai/api/v1/transcript";

// Mesmas wake/end words do modo Reunião do app principal.
const WAKE_RE = /\b(ola |oi |ei |hey |alo )?(renante|renan|dante)\b/;
const END_RE =
  /\b(desligar (renante|renan|dante)|tchau (renante|renan|dante)|valeu (renante|renan|dante)|obrigado (renante|renan|dante)|encerra|encerrar|pode parar)\b/;

type Cfg = {
  apiKey: string;
  avatarId: string;
  voiceId: string;
  contextId: string;
  language: string;
  webhookReuniao: string;
  webhookFiller: string;
};

function readConfig(): Cfg {
  const q =
    typeof window === "undefined"
      ? new URLSearchParams()
      : new URLSearchParams(window.location.search);
  return {
    apiKey: q.get("apiKey") ?? "",
    avatarId: q.get("avatarId") ?? "",
    voiceId: q.get("voiceId") ?? "",
    contextId: q.get("contextId") ?? "",
    language: q.get("language") ?? "pt",
    webhookReuniao: q.get("wr") ?? "",
    webhookFiller: q.get("wf") ?? "",
  };
}

function MeetAvatar() {
  const fetchToken = useServerFn(getSessionToken);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<LiveAvatarSession | null>(null);
  const connectedRef = useRef(false);
  const isAvatarSpeakingRef = useRef(false);
  const meetingActiveRef = useRef(false); // false = só ouvindo; true = respondendo
  const wsRef = useRef<WebSocket | null>(null);
  const lastSegRef = useRef(""); // dedupe de transcrições repetidas
  const cfgRef = useRef<Cfg>(readConfig());

  const [logs, setLogs] = useState<{ t: number; msg: string; kind?: "info" | "err" | "ok" }[]>([]);
  const [status, setStatus] = useState("inicializando…");
  const [speaking, setSpeaking] = useState(false);
  const [active, setActive] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);
  // Por padrão a página é LIMPA (só o avatar, cara de câmera). HUD/logs só com ?debug=1.
  const [debug, setDebug] = useState(false);

  const log = useCallback((msg: string, kind: "info" | "err" | "ok" = "info") => {
    const line = `${new Date().toISOString()} [MEET] ${msg}`;
    if (kind === "err") console.error(line);
    else console.log(line);
    setLogs((p) => [...p, { t: Date.now(), msg, kind }].slice(-200));
  }, []);

  // ---- fila de fala (espera speak_ended antes da próxima) ----
  const waitForAvatarEnd = useCallback((timeoutMs = SPEAK_TIMEOUT_MS) => {
    return new Promise<void>((resolve, reject) => {
      const session = sessionRef.current;
      if (!session || !isAvatarSpeakingRef.current) {
        resolve();
        return;
      }
      const timer = window.setTimeout(() => {
        session.off(AgentEventsEnum.AVATAR_SPEAK_ENDED, onEnd);
        reject(new Error(`Timeout esperando speak_ended (${timeoutMs}ms)`));
      }, timeoutMs);
      const onEnd = () => {
        window.clearTimeout(timer);
        session.off(AgentEventsEnum.AVATAR_SPEAK_ENDED, onEnd);
        resolve();
      };
      session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, onEnd);
    });
  }, []);

  const speakAndWait = useCallback(
    async (txt: string) => {
      const session = sessionRef.current;
      const clean = (txt ?? "").trim();
      if (!session || !connectedRef.current || !clean) return;
      if (isAvatarSpeakingRef.current) await waitForAvatarEnd();
      const ended = new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          session.off(AgentEventsEnum.AVATAR_SPEAK_ENDED, onEnd);
          reject(new Error(`Timeout speak_ended (${SPEAK_TIMEOUT_MS}ms)`));
        }, SPEAK_TIMEOUT_MS);
        const onEnd = () => {
          window.clearTimeout(timer);
          session.off(AgentEventsEnum.AVATAR_SPEAK_ENDED, onEnd);
          resolve();
        };
        session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, onEnd);
      });
      const eventId = session.repeat(clean);
      log(`speak_text: "${clean}" (event_id=${eventId})`, "ok");
      await ended;
    },
    [log, waitForAvatarEnd],
  );

  // ---- envio pro n8n (Reunião) com FILLER INSTANTÂNEO ----
  const handleSend = useCallback(
    async (question: string, responder: boolean) => {
      const s = cfgRef.current;
      const body = { question, sessionId: "reuniao", responder };
      log(`→ webhook Reunião (responder=${responder}): "${question}"`);

      const sendTs = typeof performance !== "undefined" ? performance.now() : Date.now();

      const renanteP = fetch(s.webhookReuniao, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(async (r) => {
          const t = await r.text();
          log(`Reunião HTTP ${r.status}\n${t.slice(0, 300)}`);
          if (!r.ok) throw new Error(`Reunião HTTP ${r.status}: ${t}`);
          try {
            return JSON.parse(t);
          } catch {
            return { output: t };
          }
        })
        .catch((e) => {
          log(`erro Reunião: ${e?.message ?? e}`, "err");
          return { output: "" };
        });

      // Só fala quando está ATIVO (responder=true). Senão é só contexto de ambiente.
      if (!responder) {
        const j: any = await renanteP;
        log(`(dormindo) resposta ignorada: ${JSON.stringify(j)?.slice(0, 200)}`);
        return;
      }

      // Filler em paralelo: fala assim que chegar, sem esperar o agente.
      const fillerP = s.webhookFiller
        ? fetch(s.webhookFiller, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question }),
          })
            .then(async (r) => {
              const t = await r.text();
              if (!r.ok) throw new Error(`Filler HTTP ${r.status}: ${t}`);
              try {
                return JSON.parse(t);
              } catch {
                return { filler: t };
              }
            })
            .catch((e) => {
              log(`erro filler: ${e?.message ?? e}`, "err");
              return { filler: "" };
            })
        : Promise.resolve({ filler: "" });

      const fillerSpeakP = fillerP.then(async (fj: any) => {
        const fillerText = (fj?.filler ?? "").toString().trim();
        if (!fillerText) {
          log("filler vazio/SKIP — direto pra resposta");
          return;
        }
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        log(`filler pronto em ${Math.round(now - sendTs)}ms — falando: "${fillerText}"`, "ok");
        try {
          await speakAndWait(fillerText);
        } catch (e: any) {
          log(`erro speak filler: ${e?.message ?? e}`, "err");
        }
      });

      const renanteJson: any = await renanteP;
      const renanteText = (renanteJson?.output ?? renanteJson?.text ?? renanteJson?.message ?? "")
        .toString()
        .trim();
      if (!renanteText) {
        log("output vazio — avatar calado");
        await fillerSpeakP.catch(() => {});
        return;
      }
      await fillerSpeakP.catch(() => {});
      log(`resposta Renante: "${renanteText}"`, "ok");
      try {
        await speakAndWait(renanteText);
      } catch (e: any) {
        log(`erro speak resposta: ${e?.message ?? e}`, "err");
      }
    },
    [log, speakAndWait],
  );

  // ---- roteia um trecho transcrito (wake/end words da Reunião) ----
  const routeSegment = useCallback(
    async (rawText: string, speaker: string) => {
      const t = (rawText ?? "").trim();
      if (!t) return;
      // ignora a própria fala do avatar captada pela transcrição
      if (speaker && /renante/i.test(speaker)) {
        log(`(ignora própria fala) ${speaker}: ${t}`);
        return;
      }
      if (t === lastSegRef.current) return; // dedupe
      lastSegRef.current = t;

      const low = t
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "");
      const hasWake = WAKE_RE.test(low);
      const hasEnd = END_RE.test(low);

      if (hasEnd && meetingActiveRef.current) {
        meetingActiveRef.current = false;
        setActive(false);
        log(`comando de encerrar ("${t}") → DORMINDO`, "ok");
      }
      let responder = meetingActiveRef.current;
      if (!meetingActiveRef.current && hasWake) {
        meetingActiveRef.current = true;
        setActive(true);
        responder = true;
        log(`wake word ("${t}") → ATIVO`, "ok");
      }
      await handleSend(t, responder);
    },
    [handleSend, log],
  );

  // ---- play do vídeo: robusto, tenta várias vezes (Recall autoplaya, mas
  // o stream pode chegar com um pequeno atraso). Precisa ficar SEM mute pra
  // que o áudio do avatar seja captado e entre na reunião. ----
  const tryPlay = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = false;
    v.autoplay = true;
    v.playsInline = true;
    for (let i = 0; i < 12; i++) {
      try {
        await v.play();
      } catch {
        // autoplay pode ser bloqueado por um instante; tenta de novo
      }
      if (!v.paused) {
        setNeedsGesture(false);
        return;
      }
      await new Promise((r) => window.setTimeout(r, 400));
    }
    setNeedsGesture(true);
  }, []);

  // ---- bootstrap ----
  useEffect(() => {
    const cfg = readConfig();
    cfgRef.current = cfg;
    setDebug(new URLSearchParams(window.location.search).get("debug") === "1");

    const missing = (
      ["apiKey", "avatarId", "voiceId", "contextId", "webhookReuniao"] as (keyof Cfg)[]
    ).filter((k) => !cfg[k]);
    if (missing.length) {
      setStatus(`config faltando na URL: ${missing.join(", ")}`);
      log(`config faltando: ${missing.join(", ")}`, "err");
      return;
    }

    let cancelled = false;

    const connectWs = () => {
      try {
        const ws = new WebSocket(RECALL_TRANSCRIPT_WS);
        wsRef.current = ws;
        ws.onopen = () => log("WebSocket de transcrição do Recall conectado", "ok");
        ws.onerror = (e) => log(`WebSocket erro: ${JSON.stringify(e)?.slice(0, 200)}`, "err");
        ws.onclose = () => {
          log("WebSocket fechado; reconectando em 3s");
          if (!cancelled) window.setTimeout(connectWs, 3000);
        };
        ws.onmessage = (event) => {
          // Log cru ajuda a confirmar o schema real na primeira reunião de teste.
          let parsed: any = null;
          try {
            parsed = JSON.parse(event.data);
          } catch {
            log(`ws msg não-JSON: ${String(event.data).slice(0, 200)}`);
            return;
          }
          const tr = parsed?.transcript ?? parsed?.data?.transcript ?? parsed;
          const words = Array.isArray(tr?.words) ? tr.words : [];
          const text =
            words.map((w: any) => w?.text ?? "").join(" ").trim() ||
            (tr?.text ?? "").toString().trim();
          const speaker = (tr?.speaker ?? tr?.participant?.name ?? parsed?.speaker ?? "").toString();
          const isFinal = tr?.is_final ?? tr?.isFinal;
          if (!text) return;
          // Age apenas em finais. Se o schema não trouxer is_final, age em tudo (com dedupe).
          if (isFinal === false) return;
          void routeSegment(text, speaker);
        };
      } catch (e: any) {
        log(`falha ao abrir WebSocket: ${e?.message ?? e}`, "err");
      }
    };

    const boot = async () => {
      try {
        setStatus("obtendo token…");
        log("obtendo session_token…");
        const tok = await fetchToken({
          data: {
            apiKey: cfg.apiKey,
            avatarId: cfg.avatarId,
            voiceId: cfg.voiceId,
            contextId: cfg.contextId,
            language: cfg.language,
          },
        });
        if (cancelled) return;
        log(`token HTTP ${tok.token_http_status} session_id=${tok.session_id}`, "ok");

        const session = new LiveAvatarSession(tok.session_token, { voiceChat: false });
        sessionRef.current = session;

        session.on(SessionEvent.SESSION_STREAM_READY, () => {
          log("stream pronto; anexando vídeo", "ok");
          try {
            if (videoRef.current) session.attach(videoRef.current);
          } catch (e: any) {
            log(`attach falhou: ${e?.message ?? e}`, "err");
          }
          void tryPlay();
        });
        session.on(SessionEvent.SESSION_STATE_CHANGED, (st: any) => {
          if (st === "CONNECTED") {
            connectedRef.current = true;
            setStatus("conectado — ouvindo a reunião");
          }
          if (st === "DISCONNECTED") connectedRef.current = false;
        });
        session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => {
          isAvatarSpeakingRef.current = true;
          setSpeaking(true);
        });
        session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
          isAvatarSpeakingRef.current = false;
          setSpeaking(false);
        });

        setStatus("conectando sessão…");
        await session.start();
        if (cancelled) return;
        connectedRef.current = true;
        log("sessão LiveAvatar iniciada", "ok");
        setStatus("conectado — ouvindo a reunião");

        connectWs();
      } catch (e: any) {
        log(`erro no boot: ${e?.message ?? e}`, "err");
        setStatus(`erro: ${e?.message ?? e}`);
      }
    };

    void boot();

    return () => {
      cancelled = true;
      try {
        wsRef.current?.close();
      } catch {}
      try {
        void sessionRef.current?.stop();
      } catch {}
      sessionRef.current = null;
    };
  }, [fetchToken, log, routeSegment, tryPlay]);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black">
      {/* SÓ o avatar, ocupando a tela toda — vira a "câmera" do bot na reunião.
          onClick é só fallback p/ humano (autoplay com áudio bloqueado). */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        onClick={() => void tryPlay()}
        className="h-full w-full object-cover"
      />

      {/* Tudo abaixo é APENAS no modo de depuração (?debug=1). Na reunião fica limpo. */}
      {debug && (
        <>
          {needsGesture && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70">
              <button
                onClick={() => void tryPlay()}
                className="rounded-md bg-white px-6 py-3 text-lg font-semibold text-black"
              >
                ▶️ Iniciar avatar
              </button>
            </div>
          )}

          <div className="absolute left-3 top-3 flex items-center gap-2 rounded-md bg-black/50 px-3 py-1.5 text-xs text-white/90">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                speaking ? "bg-amber-400" : active ? "bg-emerald-400" : "bg-white/40"
              }`}
            />
            <span>{speaking ? "falando…" : active ? "ativo" : "ouvindo"}</span>
            <span className="text-white/50">·</span>
            <span className="text-white/60">{status}</span>
          </div>

          <div className="absolute bottom-3 left-3 max-h-40 w-[28rem] max-w-[90vw] overflow-auto rounded-md bg-black/50 p-2 font-mono text-[10px] leading-snug text-white/70">
            {logs.slice(-25).map((l, i) => (
              <div key={`${l.t}-${i}`} className={l.kind === "err" ? "text-red-300" : l.kind === "ok" ? "text-emerald-300" : ""}>
                [{new Date(l.t).toLocaleTimeString()}] {l.msg}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
