import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  LiveAvatarSession,
  SessionEvent,
  AgentEventsEnum,
} from "@heygen/liveavatar-web-sdk";
import { getSessionToken } from "@/lib/heygen.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Teste HeyGen LiveAvatar com Voz" },
      { name: "description", content: "Demo simples LiveAvatar + microfone" },
    ],
  }),
  component: Index,
});

const FILLER_WEBHOOK =
  "https://n8n.srv1435894.hstgr.cloud/webhook/filler";
const RENANTE_WEBHOOK =
  "https://n8n.srv1435894.hstgr.cloud/webhook/c32e3b52-1d99-483f-8da7-c2b2f981687b";
const SESSION_ID = "teste-voz-001";

type LogEntry = { t: number; msg: string; kind?: "info" | "err" | "ok" };

function Index() {
  const fetchToken = useServerFn(getSessionToken);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<LiveAvatarSession | null>(null);
  const recognitionRef = useRef<any>(null);
  const isAvatarSpeakingRef = useRef(false);
  const isMutedRef = useRef(true);
  const shouldListenRef = useRef(false);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [text, setText] = useState("");
  const [connected, setConnected] = useState(false);
  const [starting, setStarting] = useState(false);
  const [listening, setListening] = useState(false);
  const [muted, setMuted] = useState(true);
  const [avatarSpeaking, setAvatarSpeaking] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);

  const log = useCallback(
    (msg: string, kind: LogEntry["kind"] = "info") => {
      setLogs((p) => [...p, { t: Date.now(), msg, kind }].slice(-200));
      // eslint-disable-next-line no-console
      console.log(`[${kind}]`, msg);
    },
    [],
  );

  // Init Web Speech
  useEffect(() => {
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SR) {
      setSpeechSupported(false);
      log(
        "Seu navegador não suporta reconhecimento de voz. Use o Google Chrome no computador.",
        "err",
      );
      return;
    }
    const rec = new SR();
    rec.lang = "pt-BR";
    rec.interimResults = true;
    rec.continuous = false;

    rec.onstart = () => {
      setListening(true);
      log("ouvindo...");
    };
    rec.onresult = (e: any) => {
      let interim = "";
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      const display = (final || interim).trim();
      if (display) setText(display);
      if (final.trim()) {
        log(`voz reconhecida: ${final.trim()}`, "ok");
      }
    };
    rec.onerror = (e: any) => {
      log(
        `erro no reconhecimento: ${e.error || "desconhecido"} ${e.message || ""}`,
        "err",
      );
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        log(
          "permissão de microfone negada. Libere nas configurações do navegador.",
          "err",
        );
        isMutedRef.current = true;
        setMuted(true);
      }
    };
    rec.onend = () => {
      setListening(false);
      const finalText = text.trim();
      // Use latest text via state snapshot trick
      setText((cur) => {
        const t = cur.trim();
        if (t) {
          // auto-send
          setTimeout(() => handleSend(t), 0);
        }
        return cur;
      });
      // restart only if user wants and avatar not speaking and not muted
      maybeStartListening();
      void finalText;
    };
    recognitionRef.current = rec;
    return () => {
      try {
        rec.stop();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const maybeStartListening = useCallback(() => {
    if (
      shouldListenRef.current &&
      !isMutedRef.current &&
      !isAvatarSpeakingRef.current &&
      recognitionRef.current
    ) {
      try {
        recognitionRef.current.start();
      } catch {
        /* already started */
      }
    }
  }, []);

  const startListening = useCallback(() => {
    if (!recognitionRef.current) return;
    isMutedRef.current = false;
    setMuted(false);
    shouldListenRef.current = true;
    setText("");
    maybeStartListening();
  }, [maybeStartListening]);

  const muteMic = useCallback(() => {
    isMutedRef.current = true;
    setMuted(true);
    shouldListenRef.current = false;
    try {
      recognitionRef.current?.stop();
    } catch {}
    log("microfone mutado");
  }, [log]);

  const toggleMute = useCallback(() => {
    if (muted) {
      log("microfone ativado");
      startListening();
    } else {
      muteMic();
    }
  }, [muted, log, startListening, muteMic]);

  const startSession = useCallback(async () => {
    if (sessionRef.current) return;
    setStarting(true);
    try {
      log("obtendo session_token...");
      const { session_token, session_id } = await fetchToken();
      log(`token recebido. session_id=${session_id}`, "ok");

      const session = new LiveAvatarSession(session_token, {
        voiceChat: false,
      });
      sessionRef.current = session;

      session.on(SessionEvent.SESSION_STATE_CHANGED, (s: any) => {
        log(`sessão estado: ${s}`);
      });
      session.on(SessionEvent.SESSION_STREAM_READY, () => {
        log("stream do avatar pronto", "ok");
        setConnected(true);
      });
      session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => {
        isAvatarSpeakingRef.current = true;
        setAvatarSpeaking(true);
        log("avatar começou a falar");
        // pausa mic anti-eco
        try {
          recognitionRef.current?.stop();
        } catch {}
      });
      session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
        isAvatarSpeakingRef.current = false;
        setAvatarSpeaking(false);
        log("avatar terminou de falar");
        maybeStartListening();
      });

      if (videoRef.current) {
        session.attach(videoRef.current);
      }
      await session.start();
      log("sessão iniciada", "ok");
    } catch (e: any) {
      log(`erro ao iniciar sessão: ${e?.message || String(e)}`, "err");
    } finally {
      setStarting(false);
    }
  }, [fetchToken, log, maybeStartListening]);

  const stopSession = useCallback(async () => {
    try {
      await sessionRef.current?.stop();
    } catch {}
    sessionRef.current = null;
    setConnected(false);
    log("sessão encerrada");
  }, [log]);

  // Wait for avatar speak to end
  const waitForAvatarEnd = useCallback(() => {
    return new Promise<void>((resolve) => {
      if (!isAvatarSpeakingRef.current) {
        resolve();
        return;
      }
      const s = sessionRef.current;
      if (!s) {
        resolve();
        return;
      }
      const onEnd = () => {
        s.off(AgentEventsEnum.AVATAR_SPEAK_ENDED, onEnd);
        resolve();
      };
      s.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, onEnd);
    });
  }, []);

  const speakAndWait = useCallback(
    async (txt: string) => {
      const s = sessionRef.current;
      if (!s) return;
      // ensure not already speaking
      if (isAvatarSpeakingRef.current) await waitForAvatarEnd();
      // Trigger speak and wait for ended event
      const ended = new Promise<void>((resolve) => {
        const onEnd = () => {
          s.off(AgentEventsEnum.AVATAR_SPEAK_ENDED, onEnd);
          resolve();
        };
        s.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, onEnd);
      });
      await (s as any).repeat(txt);
      await ended;
    },
    [waitForAvatarEnd],
  );

  const handleSend = useCallback(
    async (rawText?: string) => {
      const question = (rawText ?? text).trim();
      if (!question) return;
      if (!sessionRef.current || !connected) {
        log("sessão ainda não conectada. Clique em Conectar.", "err");
        return;
      }
      setText("");
      log(`enviando pergunta: ${question}`);

      const fillerP = fetch(FILLER_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      })
        .then(async (r) => {
          const t = await r.text();
          try {
            return JSON.parse(t);
          } catch {
            return { filler: t };
          }
        })
        .catch((e) => {
          log(`erro filler: ${e?.message || e}`, "err");
          return { filler: "" };
        });

      const renanteP = fetch(RENANTE_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, sessionId: SESSION_ID }),
      })
        .then(async (r) => {
          const t = await r.text();
          try {
            return JSON.parse(t);
          } catch {
            return { output: t };
          }
        })
        .catch((e) => {
          log(`erro Renante: ${e?.message || e}`, "err");
          return { output: "" };
        });

      // Filler first (await), then Renante
      const fillerJson: any = await fillerP;
      const fillerText: string = (fillerJson?.filler ?? "").toString().trim();
      log(`filler recebido: "${fillerText}"`, "ok");
      if (fillerText) {
        try {
          await speakAndWait(fillerText);
        } catch (e: any) {
          log(`erro speak filler: ${e?.message || e}`, "err");
        }
      } else {
        log("filler vazio — pulando direto pra resposta");
      }

      const renanteJson: any = await renanteP;
      const renanteText: string = (
        renanteJson?.output ??
        renanteJson?.text ??
        renanteJson?.message ??
        ""
      )
        .toString()
        .trim();
      log(
        `resposta Renante recebida: ${
          renanteText || JSON.stringify(renanteJson)
        }`,
        "ok",
      );
      if (renanteText) {
        try {
          await speakAndWait(renanteText);
        } catch (e: any) {
          log(`erro speak resposta: ${e?.message || e}`, "err");
        }
      } else {
        log("resposta Renante vazia.", "err");
      }
    },
    [text, connected, log, speakAndWait],
  );

  return (
    <div className="min-h-screen bg-background text-foreground p-4 md:p-8">
      <div className="max-w-3xl mx-auto flex flex-col gap-4">
        <header className="flex items-center justify-between">
          <h1 className="text-xl md:text-2xl font-semibold">
            Teste LiveAvatar + Voz
          </h1>
          {!connected ? (
            <button
              onClick={startSession}
              disabled={starting}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
            >
              {starting ? "Conectando..." : "Conectar avatar"}
            </button>
          ) : (
            <button
              onClick={stopSession}
              className="px-4 py-2 rounded-md bg-destructive text-destructive-foreground text-sm font-medium"
            >
              Encerrar
            </button>
          )}
        </header>

        <div className="relative w-full aspect-video bg-black rounded-lg overflow-hidden border border-border">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="w-full h-full object-cover"
          />
          {avatarSpeaking && (
            <div className="absolute top-2 left-2 px-2 py-1 rounded bg-primary/80 text-primary-foreground text-xs">
              falando...
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 justify-center">
          <button
            onClick={toggleMute}
            disabled={!connected || !speechSupported}
            aria-label={muted ? "Ativar microfone" : "Mutar microfone"}
            className={`relative w-20 h-20 rounded-full flex items-center justify-center text-3xl transition-all border-2 disabled:opacity-40 disabled:cursor-not-allowed ${
              listening
                ? "bg-destructive text-destructive-foreground border-destructive animate-pulse"
                : muted
                  ? "bg-muted text-muted-foreground border-border"
                  : "bg-primary text-primary-foreground border-primary"
            }`}
          >
            {muted ? "🎙️" : listening ? "🔴" : "🎤"}
          </button>
          <div className="text-sm text-muted-foreground">
            {!speechSupported
              ? "Sem suporte a voz"
              : muted
                ? "Microfone mutado"
                : listening
                  ? "Ouvindo..."
                  : avatarSpeaking
                    ? "Avatar falando (mic pausado)"
                    : "Aguardando"}
          </div>
        </div>

        <div className="flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSend();
            }}
            placeholder="Digite ou fale uma pergunta..."
            className="flex-1 px-3 py-2 rounded-md bg-input border border-border text-sm"
          />
          <button
            onClick={() => handleSend()}
            disabled={!connected || !text.trim()}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
          >
            Enviar
          </button>
        </div>

        <div className="rounded-md border border-border bg-card text-card-foreground">
          <div className="px-3 py-2 border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
            Log
          </div>
          <div className="p-3 h-72 overflow-auto font-mono text-xs space-y-1">
            {logs.length === 0 && (
              <div className="text-muted-foreground">Sem eventos ainda.</div>
            )}
            {logs.map((l, i) => (
              <div
                key={i}
                className={
                  l.kind === "err"
                    ? "text-destructive"
                    : l.kind === "ok"
                      ? "text-foreground"
                      : "text-muted-foreground"
                }
              >
                [{new Date(l.t).toLocaleTimeString()}] {l.msg}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
