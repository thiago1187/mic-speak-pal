import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentEventsEnum, LiveAvatarSession, SessionEvent } from "@heygen/liveavatar-web-sdk";
import { getSessionToken } from "@/lib/heygen.functions";
import { getMeetListenPaused } from "@/lib/listen-control.functions";

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

// Mesma lógica do modo Reunião do app principal (tolerante a variações do ASR).
const WAKE_RE = /\b(renante|renan|renando|renato|render|dante)\b/;
const END_RE =
  /\b(desligar|desliga|pode desligar|pode parar|pode encerrar|encerra|encerrar|para (renante|renan|renato|render|dante)|chega|tchau|pode ir|era so isso|obrigado por enquanto|dispensar|ja chega|ja deu)\b/;
const END_ACTIVE_RE = /\b(valeu|vlw|obrigado|obrigada|brigado)\b/; // só conta como desligar quando ATIVO
const WAKE_GREETING = "Oi, tô aqui!";
const SLEEP_GREETING = "Beleza, tô saindo. É só me chamar.";

type Cfg = {
  apiKey: string;
  avatarId: string;
  voiceId: string;
  contextId: string;
  language: string;
  webhookReuniao: string;
  webhookFiller: string;
  greeting: string; // fala inicial ao entrar (vazio = não fala)
  meetMode: "wake" | "always"; // wake = só após o nome; always = responde tudo
  bargeIn: boolean; // permitir interromper a fala dele falando por cima
  sid: string; // sessionId enviado ao webhook (= modo: conversa/reuniao/entrevistador)
  silenceSec: number; // pausa de silêncio antes de fechar a fala e mandar pro n8n
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
    greeting: q.get("greeting") ?? "",
    meetMode: q.get("mmode") === "always" ? "always" : "wake",
    bargeIn: q.get("barge") === "1",
    sid: q.get("sid") || "reuniao",
    silenceSec: Number(q.get("sil")) || 0.5,
  };
}

function MeetAvatar() {
  const fetchToken = useServerFn(getSessionToken);
  const callGetMeetListenPaused = useServerFn(getMeetListenPaused);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Diagnóstico do WebSocket de transcrição (só com ?debug=1, via console).
  const wsDiagRef = useRef({ state: "—", count: 0, last: "" });
  const logsRef = useRef<{ t: number; msg: string; kind?: "info" | "err" | "ok" }[]>([]);
  const sessionRef = useRef<LiveAvatarSession | null>(null);
  const connectedRef = useRef(false);
  const isAvatarSpeakingRef = useRef(false);
  const meetingActiveRef = useRef(false); // false = só ouvindo; true = respondendo
  const wsRef = useRef<WebSocket | null>(null);
  const lastSegRef = useRef(""); // dedupe de transcrições repetidas
  // Idempotência: bloqueia handleSend duplicado pro mesmo texto numa janela curta.
  const lastSendRef = useRef<{ text: string; timestamp: number }>({ text: "", timestamp: 0 });
  const cfgRef = useRef<Cfg>(readConfig());
  // Buffer + timer de silêncio: acumula os trechos e só envia quando a pessoa para.
  const meetBufferRef = useRef("");
  const meetSilenceTimerRef = useRef<number | null>(null);
  // sessionId ÚNICO desta sessão de /meet (≠ app principal; evita colisão do filler).
  // Usado tanto no webhook principal quanto no filler, pra a tool conectar os dois.
  const meetSessionIdRef = useRef<string>("");
  // Filler: histórico das últimas 3 respostas não-vazias (FIFO, em memória).
  const fillerHistoryRef = useRef<string[]>([]);
  const handleTranscriptRef = useRef<
    ((text: string, speaker: string, isFinal: boolean) => void) | null
  >(null);
  // Controlado pelo operador via server function: quando true, ignora transcrições novas.
  const listenPausedRef = useRef(false);
  const debugRef = useRef(false);

  const [status, setStatus] = useState("inicializando…");
  const [speaking, setSpeaking] = useState(false);
  const [active, setActive] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);

  const log = useCallback((msg: string, kind: "info" | "err" | "ok" = "info") => {
    const line = `${new Date().toISOString()} [MEET] ${msg}`;
    if (kind === "err") console.error(line);
    else console.log(line);
    if (debugRef.current) {
      logsRef.current = [...logsRef.current, { t: Date.now(), msg, kind }].slice(-200);
    }
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

  // ---- envio pro n8n com FILLER INSTANTÂNEO (webhook = o do modo escolhido) ----
  const handleSend = useCallback(
    async (question: string, responder: boolean) => {
      // Rate limit: no máx 1 handleSend por segundo (= no máx ~2 chamadas/seg ao n8n,
      // filler + agente). Barra duplicatas/eco do STT sem comparar texto.
      const trimmed = (question || "").trim();
      if (!trimmed) return;
      const nowMs = Date.now();
      const sinceLast = nowMs - lastSendRef.current.timestamp;
      if (sinceLast < 1000) {
        console.warn("[THROTTLED]", `${sinceLast}ms`, trimmed);
        log(`[THROTTLED] envio ignorado (${sinceLast}ms desde o último): "${trimmed}"`);
        return;
      }
      lastSendRef.current = { text: trimmed, timestamp: nowMs };

      const s = cfgRef.current;
      // sessionId ÚNICO desta sessão de /meet (não o modo), pra não colidir com o
      // app principal e pra a tool conseguir ligar filler ↔ agente. `responder` só
      // faz sentido no modo "wake" (Reunião); nos outros o avatar sempre responde.
      const sessionId = meetSessionIdRef.current || `meet-${s.sid}`;
      const body: Record<string, unknown> = { question, sessionId };
      if (s.meetMode === "wake") body.responder = responder;
      log(`→ webhook ${s.sid} (sessionId=${sessionId}, responder=${responder}): "${question}"`);

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
      // AJUSTES 2 e 3 — filler com sessionId próprio + histórico das últimas 3.
      const fillerHistorico = [...fillerHistoryRef.current];
      if (s.webhookFiller) {
        log(
          `filler enviado: question="${question}", sessionId="${sessionId}", historico_filler.length=${fillerHistorico.length}`,
        );
      }
      const fillerP = s.webhookFiller
        ? fetch(s.webhookFiller, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              question,
              sessionId,
              historico_filler: fillerHistorico,
            }),
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
        // AJUSTE 2 — guarda no histórico (FIFO 3) só os fillers não-vazios.
        fillerHistoryRef.current = [...fillerHistoryRef.current, fillerText].slice(-3);
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

  // ---- classifica a fala COMPLETA (já acumulada) e decide o que fazer ----
  const routeSegment = useCallback(
    async (rawText: string, speaker: string) => {
      const t = (rawText ?? "").trim();
      if (!t) return;

      // Modo "sempre ativo": responde tudo, sem wake/desligar.
      if (cfgRef.current.meetMode === "always") {
        await handleSend(t, true);
        return;
      }

      // Modo "wake": classifica wake/desligar (4 casos), igual ao app principal.
      const low = t
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "");
      const isActive = meetingActiveRef.current;
      const hasWake = WAKE_RE.test(low);
      let hasEnd = END_RE.test(low);
      if (!hasEnd && isActive && END_ACTIVE_RE.test(low)) hasEnd = true;

      // CASO 2 — ATIVO + desligar → DORMINDO + despedida fixa (sem n8n).
      if (isActive && hasEnd) {
        meetingActiveRef.current = false;
        setActive(false);
        log(`→ DORMINDO (desligar: "${t}")`, "ok");
        try {
          await speakAndWait(SLEEP_GREETING);
        } catch (e: any) {
          log(`erro despedida: ${e?.message ?? e}`, "err");
        }
        return;
      }

      // CASO 1 — DORMINDO + wake word (e não é adeus) → ATIVO.
      if (!isActive && hasWake && !hasEnd) {
        meetingActiveRef.current = true;
        setActive(true);
        log(`→ ATIVO (wake word: "${t}")`, "ok");
        const resto = low
          .replace(/\b(ola|oi|ei|hey|alo|e ai|eai|opa|fala)\b/g, " ")
          .replace(/\b(renante|renan|renando|renato|render|dante)\b/g, " ")
          .replace(/[^a-z0-9]+/g, " ")
          .trim();
        if (resto.length >= 4) {
          await handleSend(t, true); // veio pergunta junto com o nome
        } else {
          try {
            await speakAndWait(WAKE_GREETING); // só chamou o nome
          } catch (e: any) {
            log(`erro saudação: ${e?.message ?? e}`, "err");
          }
        }
        return;
      }

      // CASO 3 — ATIVO + fala normal → responde.
      if (isActive) {
        await handleSend(t, true);
        return;
      }

      // CASO 4 — DORMINDO + fala normal → grava contexto (responder:false), sem falar.
      await handleSend(t, false);
    },
    [handleSend, log, speakAndWait],
  );

  // Junta os trechos acumulados e dispara a classificação quando a pessoa para.
  const flushMeet = useCallback(() => {
    if (meetSilenceTimerRef.current !== null) {
      window.clearTimeout(meetSilenceTimerRef.current);
      meetSilenceTimerRef.current = null;
    }
    const buffered = meetBufferRef.current.trim();
    meetBufferRef.current = "";
    lastSegRef.current = "";
    if (buffered) {
      log(`pausa (~${cfgRef.current.silenceSec}s) — fala completa: "${buffered}"`, "ok");
      void routeSegment(buffered, "");
    }
  }, [log, routeSegment]);

  // Recebe cada trecho do WebSocket. Acumula só os FINAIS; partials (e finais)
  // reiniciam o timer. Só envia ao n8n após `silenceSec` de silêncio contínuo.
  const onTranscript = useCallback(
    (rawText: string, speaker: string, isFinal: boolean) => {
      const t = (rawText ?? "").trim();
      if (!t) return;
      // Operador cortou a escuta: ignora novos trechos. Transcrições já no buffer
      // continuam e são enviadas ao n8n normalmente (timer/buffer intactos).
      if (listenPausedRef.current) return;
      // ignora a própria fala do avatar (evita loop de ouvir a própria voz)
      if (speaker && /renante|renan|dante/i.test(speaker)) return;

      // Avatar falando? Barge-in decide: interrompe (ON) ou ignora (OFF).
      if (isAvatarSpeakingRef.current) {
        if (cfgRef.current.bargeIn) {
          try {
            (sessionRef.current as any)?.interrupt?.();
          } catch {}
        } else {
          return; // ignora enquanto fala
        }
      }

      // Acumula só os finais (partials mudam). Dedupe de final repetido seguido.
      if (isFinal && t !== lastSegRef.current) {
        meetBufferRef.current = `${meetBufferRef.current} ${t}`.trim();
        lastSegRef.current = t;
      }

      // (Re)inicia o timer de silêncio a cada trecho (a pessoa ainda está falando).
      if (meetSilenceTimerRef.current !== null) window.clearTimeout(meetSilenceTimerRef.current);
      const ms = Math.max(200, (cfgRef.current.silenceSec || 0.5) * 1000);
      meetSilenceTimerRef.current = window.setTimeout(flushMeet, ms);
    },
    [flushMeet],
  );

  useEffect(() => {
    handleTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  // Polling a cada 3s: verifica se o operador cortou a escuta do avatar no Meet.
  useEffect(() => {
    const poll = async () => {
      try {
        const r = await callGetMeetListenPaused();
        listenPausedRef.current = r.paused;
      } catch {}
    };
    const id = window.setInterval(poll, 3000);
    return () => window.clearInterval(id);
  }, [callGetMeetListenPaused]);

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
    const isDebug = new URLSearchParams(window.location.search).get("debug") === "1";
    debugRef.current = isDebug;

    // sessionId único desta sessão de /meet (gerado uma vez, estável enquanto durar).
    if (!meetSessionIdRef.current) {
      const rnd =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.round(Number.MAX_SAFE_INTEGER * 0.5)}`;
      meetSessionIdRef.current = `meet-${cfg.sid}-${rnd}`;
      log(`sessionId desta sessão: ${meetSessionIdRef.current}`);
    }

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
        ws.onopen = () => {
          log("WebSocket de transcrição do Recall conectado", "ok");
          if (debugRef.current) wsDiagRef.current = { ...wsDiagRef.current, state: "CONECTADO" };
        };
        ws.onerror = (e) => {
          log(`WebSocket erro: ${JSON.stringify(e)?.slice(0, 200)}`, "err");
          if (debugRef.current) wsDiagRef.current = { ...wsDiagRef.current, state: "ERRO" };
        };
        ws.onclose = () => {
          log("WebSocket fechado; reconectando em 3s");
          if (debugRef.current) wsDiagRef.current = { ...wsDiagRef.current, state: "FECHADO (reconectando)" };
          if (!cancelled) window.setTimeout(connectWs, 3000);
        };
        ws.onmessage = (event) => {
          // Captura a mensagem CRUA pra diagnóstico (confirma o schema real).
          if (debugRef.current) {
            wsDiagRef.current = {
              state: "RECEBENDO",
              count: wsDiagRef.current.count + 1,
              last: String(event.data).slice(0, 300),
            };
          }
          let parsed: any = null;
          try {
            parsed = JSON.parse(event.data);
          } catch {
            log(`ws msg não-JSON: ${String(event.data).slice(0, 200)}`);
            return;
          }
          // Envelope pode vir de várias formas: {transcript:{...}}, {data:{...}},
          // {event,data:{...}} ou o objeto direto {participant,words,...}.
          const tr =
            parsed?.transcript ?? parsed?.data?.transcript ?? parsed?.data ?? parsed;
          const words = Array.isArray(tr?.words) ? tr.words : [];
          const text =
            words.map((w: any) => w?.text ?? "").join(" ").trim() ||
            (tr?.text ?? "").toString().trim();
          const speaker = (tr?.speaker ?? tr?.participant?.name ?? parsed?.speaker ?? "").toString();
          const isFinal = tr?.is_final ?? tr?.isFinal;
          if (!text) return;
          // Partials (is_final=false) só reiniciam o timer; finais entram no buffer.
          // Se o schema não trouxer is_final, trata como final.
          handleTranscriptRef.current?.(text, speaker, isFinal !== false);
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

        // Estado inicial conforme o modo configurado.
        if (cfg.meetMode === "always") {
          meetingActiveRef.current = true;
          setActive(true);
          setStatus("conectado — sempre ativo (responde tudo)");
        } else {
          setStatus("conectado — dormindo (diga o nome pra acordar)");
        }

        // Começa a ouvir a reunião antes de falar (não perde transcrição).
        connectWs();

        // Fala inicial configurada (se houver). A própria voz é ignorada na rota.
        const greeting = (cfg.greeting ?? "").trim();
        if (greeting) {
          // SUBSTITUI a saudação automática do HeyGen: interrompe o que ele começar
          // a falar sozinho (repete algumas vezes pra pegar o auto-greeting que às
          // vezes começa com pequeno atraso) e então fala a SUA saudação.
          for (let i = 0; i < 4 && !cancelled; i++) {
            try {
              (sessionRef.current as any)?.interrupt?.();
            } catch {}
            await new Promise((r) => window.setTimeout(r, 250));
          }
          if (cancelled) return;
          try {
            log(`fala inicial (substitui a do HeyGen): "${greeting}"`, "ok");
            await speakAndWait(greeting);
          } catch (e: any) {
            log(`erro fala inicial: ${e?.message ?? e}`, "err");
          }
        }
      } catch (e: any) {
        log(`erro no boot: ${e?.message ?? e}`, "err");
        setStatus(`erro: ${e?.message ?? e}`);
      }
    };

    void boot();

    return () => {
      cancelled = true;
      if (meetSilenceTimerRef.current !== null) {
        window.clearTimeout(meetSilenceTimerRef.current);
        meetSilenceTimerRef.current = null;
      }
      try {
        wsRef.current?.close();
      } catch {}
      try {
        void sessionRef.current?.stop();
      } catch {}
      sessionRef.current = null;
    };
  }, [fetchToken, log, tryPlay, speakAndWait]);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black">
      {/* Avatar em tela cheia — saída direta do vídeo. É exatamente isto que o
          Recall captura como câmera+microfone do bot na reunião. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        onClick={() => void tryPlay()}
        className="absolute inset-0 h-full w-full bg-black object-contain"
      />

      {/* Botão de fallback para autoplay bloqueado. */}
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
    </div>
  );
}
