import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentEventsEnum, LiveAvatarSession, SessionEvent } from "@heygen/liveavatar-web-sdk";
import { getSessionToken } from "@/lib/heygen.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Diagnóstico HeyGen LiveAvatar" },
      {
        name: "description",
        content: "Diagnóstico visível de LiveAvatar, vídeo, microfone e voz",
      },
    ],
  }),
  component: Index,
});

const SPEAK_TIMEOUT_MS = 60_000;
const SETTINGS_KEY = "liveavatar.settings.v1";
const MODE_KEY = "liveavatar.mode.v1";

type Mode = "conversa" | "reuniao" | "entrevistador";
const MODES: { id: Mode; label: string }[] = [
  { id: "conversa", label: "Conversa" },
  { id: "reuniao", label: "Reunião" },
  { id: "entrevistador", label: "Entrevistador" },
];

type Settings = {
  webhookConversa: string;
  webhookReuniao: string;
  webhookEntrevistador: string;
  webhookFiller: string;
  apiKey: string;
  avatarId: string;
  voiceId: string;
  contextId: string;
  language: string;
  meetLink: string;
  recallApiKey: string;
};

const DEFAULT_SETTINGS: Settings = {
  webhookConversa: "https://n8n.srv1435894.hstgr.cloud/webhook/c32e3b52-1d99-483f-8da7-c2b2f981687b",
  webhookReuniao: "https://n8n.srv1435894.hstgr.cloud/webhook/renante-reuniao",
  webhookEntrevistador: "https://n8n.srv1435894.hstgr.cloud/webhook/renante-entrevistador",
  webhookFiller: "https://n8n.srv1435894.hstgr.cloud/webhook/filler",
  apiKey: "33003367-5918-11f1-8d28-066a7fa2e369",
  avatarId: "17593eee-5774-419c-9923-64694d710c57",
  voiceId: "ef51b5eb-5b39-4e6d-84e8-8b49a1b2e098",
  contextId: "620eb98d-45ae-4a6c-9971-2c0915b4c279",
  language: "pt",
  meetLink: "",
  recallApiKey: "",
};

function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadMode(): Mode {
  if (typeof window === "undefined") return "conversa";
  const v = window.localStorage.getItem(MODE_KEY) as Mode | null;
  return v === "conversa" || v === "reuniao" || v === "entrevistador" ? v : "conversa";
}

type LogEntry = { t: number; msg: string; kind?: "info" | "err" | "ok" };
type StatusKind = "waiting" | "ok" | "err";
type StatusKey = "token" | "session" | "video" | "microphone";
type StatusItem = { label: string; state: StatusKind; detail: string };
type RecognitionMode = "chat" | "test";

const initialStatuses: Record<StatusKey, StatusItem> = {
  token: {
    label: "Token de sessão",
    state: "waiting",
    detail: "Aguardando clique em Conectar avatar",
  },
  session: {
    label: "Sessão LiveAvatar",
    state: "waiting",
    detail: "Não iniciada",
  },
  video: {
    label: "Vídeo do avatar",
    state: "waiting",
    detail: "Sem stream",
  },
  microphone: {
    label: "Microfone",
    state: "waiting",
    detail: "Detectando suporte do navegador",
  },
};

function safeStringify(value: unknown) {
  const seen = new WeakSet<object>();
  try {
    if (value instanceof Event) {
      return JSON.stringify({
        eventType: value.type,
        error: (value as any).error,
        message: (value as any).message,
        name: (value as any).name,
        target: (value.target as any)?.constructor?.name,
      });
    }
    if (value instanceof Error) {
      return `${value.name}: ${value.message}\n${value.stack ?? "sem stack"}`;
    }
    return JSON.stringify(
      value,
      (_key, item) => {
        if (typeof item === "object" && item !== null) {
          if (seen.has(item)) return "[Circular]";
          seen.add(item);
        }
        if (typeof item === "function") return `[Function ${item.name || "anonymous"}]`;
        return item;
      },
      2,
    );
  } catch (error) {
    return String(value ?? error);
  }
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? "sem stack"}`;
  }
  if (error instanceof Event) {
    return `Event ${error.type}: ${safeStringify(error)}`;
  }
  return safeStringify(error) || String(error);
}

function summarizeArg(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const item = value as any;
  return {
    constructor: item.constructor?.name,
    identity: item.identity,
    sid: item.sid,
    kind: item.kind,
    source: item.source,
    state: item.state,
    name: item.name,
    error: item.error,
    message: item.message,
  };
}

function StatusDot({ state }: { state: StatusKind }) {
  const color =
    state === "ok" ? "bg-status-ok" : state === "err" ? "bg-destructive" : "bg-status-waiting";
  return <span className={`mt-1 h-3 w-3 shrink-0 rounded-full ${color}`} />;
}

function Index() {
  const fetchToken = useServerFn(getSessionToken);
  const videoRef = useRef<HTMLVideoElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<LiveAvatarSession | null>(null);
  const recognitionRef = useRef<any>(null);
  const isRecognitionRunningRef = useRef(false);
  const recognitionModeRef = useRef<RecognitionMode>("chat");
  const resultSinceStartRef = useRef(false);
  const finalTranscriptRef = useRef("");
  const lastTranscriptRef = useRef("");
  const handleSendRef = useRef<((rawText?: string) => Promise<void>) | null>(null);
  const handleVoiceUtteranceRef = useRef<((text: string) => Promise<void>) | null>(null);
  const isAvatarSpeakingRef = useRef(false);
  const isMutedRef = useRef(true);
  const shouldListenRef = useRef(false);
  const micPermissionGrantedRef = useRef(false);
  const bargeInRef = useRef(false);
  const meetingActiveRef = useRef(false);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [statuses, setStatuses] = useState<Record<StatusKey, StatusItem>>(initialStatuses);
  const [text, setText] = useState("");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [mode, setMode] = useState<Mode>("conversa");
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const modeRef = useRef<Mode>("conversa");

  useEffect(() => {
    const s = loadSettings();
    const m = loadMode();
    setSettings(s);
    setSettingsDraft(s);
    setMode(m);
    settingsRef.current = s;
    modeRef.current = m;
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    modeRef.current = mode;
    if (typeof window !== "undefined") window.localStorage.setItem(MODE_KEY, mode);
  }, [mode]);

  const saveSettings = useCallback(() => {
    setSettings(settingsDraft);
    settingsRef.current = settingsDraft;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsDraft));
    }
    setSettingsSaved(true);
    setTimeout(() => setSettingsSaved(false), 1800);
  }, [settingsDraft]);

  const [liveTranscript, setLiveTranscript] = useState("");
  const [connected, setConnected] = useState(false);
  const [starting, setStarting] = useState(false);
  const [listening, setListening] = useState(false);
  const [muted, setMuted] = useState(true);
  const [avatarSpeaking, setAvatarSpeaking] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [showStartMediaButton, setShowStartMediaButton] = useState(false);
  const [webrtcState, setWebrtcState] = useState("aguardando");

  const log = useCallback((msg: string, kind: LogEntry["kind"] = "info") => {
    const line = `${new Date().toISOString()} ${msg}`;
    setLogs((p) => [...p, { t: Date.now(), msg, kind }].slice(-500));
    if (kind === "err") console.error(line);
    else if (kind === "ok") console.info(line);
    else console.log(line);
  }, []);

  const setStatus = useCallback((key: StatusKey, state: StatusKind, detail: string) => {
    setStatuses((prev) => ({
      ...prev,
      [key]: { ...prev[key], state, detail },
    }));
  }, []);

  const logError = useCallback(
    (label: string, error: unknown) => {
      const formatted = formatError(error);
      log(`${label}: ${formatted}`, "err");
      return formatted;
    },
    [log],
  );

  const attemptVideoPlay = useCallback(async () => {
    const video = videoRef.current;
    if (!video) {
      log("video.play(): elemento <video> não encontrado", "err");
      setStatus("video", "err", "Elemento <video> não encontrado");
      return;
    }
    try {
      video.autoplay = true;
      video.playsInline = true;
      video.muted = false;
      log(
        `video.play(): tentando iniciar. readyState=${video.readyState} paused=${video.paused} muted=${video.muted}`,
      );
      await video.play();
      setShowStartMediaButton(false);
      setStatus("video", "ok", "Stream recebido e play() executado");
      log("video.play(): ok", "ok");
    } catch (error) {
      const formatted = logError("video.play() bloqueado/falhou", error);
      setShowStartMediaButton(true);
      setStatus("video", "err", `Stream recebido, mas play() falhou/bloqueou: ${formatted}`);
    }
  }, [log, logError, setStatus]);

  const requestMicrophonePermission = useCallback(async () => {
    log("getUserMedia({ audio: { EC/NS/AGC: true } }): solicitando permissão");
    if (!navigator.mediaDevices?.getUserMedia) {
      const message = "navigator.mediaDevices.getUserMedia não existe neste navegador";
      setStatus("microphone", "err", message);
      log(message, "err");
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      stream.getTracks().forEach((track) => track.stop());
      micPermissionGrantedRef.current = true;
      setStatus("microphone", "ok", "Microfone permitido (EC/NS/AGC). Funciona melhor no Chrome desktop.");
      log("getUserMedia: permitido; tracks de teste encerradas", "ok");
      return true;
    } catch (error: any) {
      micPermissionGrantedRef.current = false;
      const formatted = formatError(error);
      const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
      setStatus(
        "microphone",
        "err",
        `${denied ? "Microfone negado" : "Erro no microfone"}: ${formatted}`,
      );
      log(`getUserMedia: ${denied ? "negado" : "erro"}: ${formatted}`, "err");
      return false;
    }
  }, [log, setStatus]);

  const maybeStartListening = useCallback(
    (reason = "restart automático") => {
      if (
        shouldListenRef.current &&
        !isMutedRef.current &&
        recognitionRef.current &&
        !isRecognitionRunningRef.current
      ) {
        try {
          resultSinceStartRef.current = false;
          finalTranscriptRef.current = "";
          lastTranscriptRef.current = "";
          recognitionRef.current.start();
          log(`recognition.start(): ${reason}`);
        } catch (error) {
          logError(`recognition.start() falhou (${reason})`, error);
        }
      } else {
        log(
          `recognition não reiniciado (${reason}). shouldListen=${shouldListenRef.current} muted=${isMutedRef.current} running=${isRecognitionRunningRef.current}`,
        );
      }
    },
    [log, logError],
  );

  useEffect(() => {
    log("Inicializando diagnósticos globais");
    const onError = (event: ErrorEvent) => {
      logError("window.onerror capturado", event.error ?? event.message ?? event);
    };
    const onUnhandled = (event: PromiseRejectionEvent) => {
      logError("window.unhandledrejection capturado", event.reason ?? event);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandled);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandled);
    };
  }, [log, logError]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" });
  }, [logs]);

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    log(
      `Detecção SpeechRecognition: SpeechRecognition=${Boolean((window as any).SpeechRecognition)} webkitSpeechRecognition=${Boolean((window as any).webkitSpeechRecognition)}`,
      SR ? "ok" : "err",
    );
    if (!SR) {
      setSpeechSupported(false);
      const message =
        "Este navegador não tem reconhecimento de voz. Abra no Google Chrome no computador.";
      setStatus("microphone", "err", message);
      log(message, "err");
      return;
    }

    setSpeechSupported(true);
    setStatus(
      "microphone",
      "waiting",
      "Reconhecimento de voz suportado; permissão será solicitada ao ligar o microfone",
    );

    const rec = new SR();
    rec.lang = "pt-BR";
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      isRecognitionRunningRef.current = true;
      resultSinceStartRef.current = false;
      finalTranscriptRef.current = "";
      setListening(true);
      setStatus(
        "microphone",
        micPermissionGrantedRef.current ? "ok" : "waiting",
        micPermissionGrantedRef.current
          ? "Microfone permitido; ouvindo..."
          : "Ouvindo; permissão ainda não confirmada",
      );
      log('SpeechRecognition onstart: "ouvindo..."', "ok");
    };
    rec.onaudiostart = (event: any) => {
      log(`SpeechRecognition onaudiostart: ${safeStringify(event)}`, "ok");
    };
    rec.onsoundstart = (event: any) => {
      log(`SpeechRecognition onsoundstart: ${safeStringify(event)}`);
    };
    rec.onspeechstart = (event: any) => {
      log(`SpeechRecognition onspeechstart: ${safeStringify(event)}`, "ok");
    };
    rec.onresult = (event: any) => {
      try {
        let interim = "";
        let final = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i]?.[0]?.transcript ?? "";
          if (event.results[i].isFinal) final += transcript;
          else interim += transcript;
        }
        const partial = interim.trim();
        const done = final.trim();
        resultSinceStartRef.current = true;
        if (done) finalTranscriptRef.current = `${finalTranscriptRef.current} ${done}`.trim();
        const display = (done || partial || finalTranscriptRef.current).trim();
        if (display) {
          setText(display);
          setLiveTranscript(display);
          lastTranscriptRef.current = display;
        }
        log(
          `SpeechRecognition onresult: parcial="${partial}" final="${done}" finalAcumulado="${finalTranscriptRef.current}"`,
          done ? "ok" : "info",
        );
      } catch (error) {
        logError("Erro dentro de SpeechRecognition onresult", error);
      }
    };
    rec.onspeechend = (event: any) => {
      log(`SpeechRecognition onspeechend: ${safeStringify(event)}`);
    };
    rec.onaudioend = (event: any) => {
      log(`SpeechRecognition onaudioend: ${safeStringify(event)}`);
    };
    rec.onerror = (event: any) => {
      const details = `error=${event?.error ?? "desconhecido"} message=${event?.message ?? ""} raw=${safeStringify(event)}`;
      log(`SpeechRecognition onerror: ${details}`, "err");
      if (event?.error === "not-allowed" || event?.error === "service-not-allowed") {
        isMutedRef.current = true;
        shouldListenRef.current = false;
        setMuted(true);
        setStatus("microphone", "err", `Permissão de microfone negada: ${details}`);
      } else if (event?.error === "no-speech") {
        setStatus("microphone", "waiting", `Nenhuma fala detectada: ${details}`);
      } else if (event?.error === "network" || event?.error === "aborted") {
        setStatus("microphone", "err", `Erro de reconhecimento: ${details}`);
      }
    };
    rec.onend = () => {
      isRecognitionRunningRef.current = false;
      setListening(false);
      const finalText = finalTranscriptRef.current.trim();
      log(
        `SpeechRecognition onend: final="${finalText}" houveResultado=${resultSinceStartRef.current} mode=${recognitionModeRef.current}`,
      );
      if (!resultSinceStartRef.current) {
        log(
          "SpeechRecognition onend disparou sem resultado — alguns navegadores encerram e exigem reiniciar a cada fala.",
          "err",
        );
      }
      const transcriptToSend = finalText || lastTranscriptRef.current.trim();
      if (recognitionModeRef.current === "chat" && transcriptToSend) {
        setTimeout(() => void handleSendRef.current?.(transcriptToSend), 0);
      }
      maybeStartListening("onend");
    };

    recognitionRef.current = rec;
    log("SpeechRecognition configurado: lang=pt-BR interimResults=true continuous=false", "ok");
    return () => {
      try {
        rec.stop();
      } catch {}
      recognitionRef.current = null;
    };
  }, [log, logError, maybeStartListening, setStatus]);

  const startRecognition = useCallback(
    async (mode: RecognitionMode, reason: string) => {
      if (!speechSupported || !recognitionRef.current) {
        const message = "Reconhecimento de voz indisponível; use Google Chrome desktop";
        setStatus("microphone", "err", message);
        log(message, "err");
        return;
      }
      recognitionModeRef.current = mode;
      shouldListenRef.current = true;
      isMutedRef.current = false;
      setMuted(false);
      setLiveTranscript("");
      setText("");
      log(`microfone ativo (${reason}); modo=${mode}`);
      const allowed = await requestMicrophonePermission();
      if (!allowed) return;
      maybeStartListening(reason);
    },
    [log, maybeStartListening, requestMicrophonePermission, setStatus, speechSupported],
  );

  const startListening = useCallback(() => {
    void startRecognition("chat", "botão principal/desmutar");
  }, [startRecognition]);

  const muteMic = useCallback(() => {
    isMutedRef.current = true;
    setMuted(true);
    shouldListenRef.current = false;
    try {
      recognitionRef.current?.stop();
    } catch (error) {
      logError("recognition.stop() falhou ao mutar", error);
    }
    setStatus(
      "microphone",
      speechSupported ? (micPermissionGrantedRef.current ? "ok" : "waiting") : "err",
      speechSupported ? "microfone mutado" : "Reconhecimento de voz não suportado",
    );
    log("microfone mutado");
  }, [log, logError, setStatus, speechSupported]);

  const toggleMute = useCallback(() => {
    if (muted) startListening();
    else muteMic();
  }, [muted, startListening, muteMic]);

  const attachRoomDiagnostics = useCallback(
    (session: LiveAvatarSession) => {
      const room = (session as any).room;
      if (!room?.on) {
        log("Room/WebRTC interno não encontrado no SDK para diagnósticos de baixo nível", "err");
        return;
      }
      const roomEvents = [
        "connected",
        "reconnecting",
        "signalReconnecting",
        "reconnected",
        "disconnected",
        "connectionStateChanged",
        "participantConnected",
        "participantDisconnected",
        "trackPublished",
        "trackSubscribed",
        "trackSubscriptionFailed",
        "trackUnsubscribed",
        "mediaDevicesChanged",
      ];
      roomEvents.forEach((eventName) => {
        try {
          room.on(eventName, (...args: unknown[]) => {
            log(`[WebRTC/LiveKit event] ${eventName}: ${safeStringify(args.map(summarizeArg))}`);
            if (eventName === "connectionStateChanged") {
              const state = String(args[0] ?? "desconhecido");
              setWebrtcState(state);
              log(`Estado WebRTC: ${state}`, state === "connected" ? "ok" : "info");
            }
            if (eventName === "connected") {
              setWebrtcState("connected");
            }
            if (eventName === "disconnected") {
              setWebrtcState("disconnected");
            }
          });
        } catch (error) {
          logError(`Falha ao registrar evento WebRTC ${eventName}`, error);
        }
      });
      log(`Diagnósticos WebRTC registrados: ${roomEvents.join(", ")}`, "ok");
    },
    [log, logError],
  );

  const registerSdkEvents = useCallback(
    (session: LiveAvatarSession) => {
      const sessionEvents = Object.values(SessionEvent);
      const agentEvents = Object.values(AgentEventsEnum);

      sessionEvents.forEach((eventName) => {
        session.on(eventName as any, (...args: unknown[]) => {
          log(`[SDK event] ${eventName}: ${safeStringify(args)}`);
        });
      });
      agentEvents.forEach((eventName) => {
        session.on(eventName as any, (...args: unknown[]) => {
          log(`[SDK agent event] ${eventName}: ${safeStringify(args)}`);
        });
      });

      session.on(SessionEvent.SESSION_STATE_CHANGED, (state: any) => {
        setStatus(
          "session",
          state === "CONNECTED" ? "ok" : state === "DISCONNECTED" ? "waiting" : "waiting",
          `Estado SDK: ${state}`,
        );
        if (state === "CONNECTED") setConnected(true);
        if (state === "DISCONNECTED") setConnected(false);
      });
      session.on(SessionEvent.SESSION_STREAM_READY, () => {
        log("SESSION_STREAM_READY: stream de áudio+vídeo recebido", "ok");
        setStatus("video", "ok", "Recebendo stream; anexando ao <video>");
        try {
          if (videoRef.current) {
            session.attach(videoRef.current);
            log("session.attach(video): ok", "ok");
          } else {
            throw new Error("videoRef.current está vazio");
          }
        } catch (error) {
          const formatted = logError("session.attach(video) falhou", error);
          setStatus("video", "err", formatted);
        }
        void attemptVideoPlay();
      });
      session.on(SessionEvent.SESSION_DISCONNECTED, (reason: any) => {
        setConnected(false);
        setStatus("session", "waiting", `Desconectada: ${safeStringify(reason)}`);
      });
      session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => {
        isAvatarSpeakingRef.current = true;
        setAvatarSpeaking(true);
        log("avatar começou a falar (mic permanece ligado; confiando em EC)", "ok");
      });
      session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
        isAvatarSpeakingRef.current = false;
        setAvatarSpeaking(false);
        log("avatar terminou de falar", "ok");
        if (modeRef.current === "entrevistador" && shouldListenRef.current && !isMutedRef.current) {
          maybeStartListening("entrevistador: pronto pra resposta");
        }
      });
      log(`Eventos SDK registrados: ${[...sessionEvents, ...agentEvents].join(", ")}`, "ok");
    },
    [attemptVideoPlay, log, logError, maybeStartListening, setStatus],
  );

  const startSession = useCallback(async () => {
    if (sessionRef.current) {
      log("startSession ignorado: sessão já existe");
      return;
    }
    setStarting(true);
    setShowStartMediaButton(false);
    setStatus("token", "waiting", "Solicitando token...");
    setStatus("session", "waiting", "Conectando...");
    setStatus("video", "waiting", "Aguardando stream");
    setWebrtcState("conectando");
    try {
      log("Obtendo session_token via função de backend...");
      const s = settingsRef.current;
      const tokenResult = await fetchToken({
        data: {
          apiKey: s.apiKey,
          avatarId: s.avatarId,
          voiceId: s.voiceId,
          contextId: s.contextId,
          language: s.language,
        },
      });
      log(
        `Resposta completa token: HTTP ${tokenResult.token_http_status}\n${tokenResult.token_response_body}`,
        "ok",
      );
      setStatus("token", "ok", `Obtido. session_id=${tokenResult.session_id}`);

      const session = new LiveAvatarSession(tokenResult.session_token, { voiceChat: false });
      sessionRef.current = session;
      log(
        `LiveAvatarSession criada: mode=${session.mode} agentType=${session.agentType} state=${session.state}`,
        "ok",
      );
      registerSdkEvents(session);
      attachRoomDiagnostics(session);

      log("session.start(): iniciando");
      await session.start();
      setConnected(true);
      setStatus("session", "ok", `Conectada. SDK state=${session.state}`);
      log(`session.start(): ok. sessionId=${session.sessionId} state=${session.state}`, "ok");
    } catch (error) {
      const formatted = logError("erro ao iniciar sessão LiveAvatar", error);
      setStatus("session", "err", formatted);
      if (!sessionRef.current) setStatus("token", "err", formatted);
      setConnected(false);
      setWebrtcState("erro");
      try {
        await sessionRef.current?.stop();
      } catch (stopError) {
        logError("erro ao limpar sessão após falha", stopError);
      }
      sessionRef.current = null;
    } finally {
      setStarting(false);
    }
  }, [attachRoomDiagnostics, fetchToken, log, logError, registerSdkEvents, setStatus]);

  const stopSession = useCallback(async () => {
    log("Encerrando sessão manualmente...");
    try {
      await sessionRef.current?.stop();
      log("session.stop(): ok", "ok");
    } catch (error) {
      logError("session.stop() falhou", error);
    }
    sessionRef.current = null;
    setConnected(false);
    setStatus("session", "waiting", "Sessão encerrada pelo usuário");
    setStatus("video", "waiting", "Sem stream");
    setWebrtcState("desconectado");
  }, [log, logError, setStatus]);

  const waitForAvatarEnd = useCallback((timeoutMs = SPEAK_TIMEOUT_MS) => {
    return new Promise<void>((resolve, reject) => {
      const session = sessionRef.current;
      if (!session || !isAvatarSpeakingRef.current) {
        resolve();
        return;
      }
      const timer = window.setTimeout(() => {
        session.off(AgentEventsEnum.AVATAR_SPEAK_ENDED, onEnd);
        reject(new Error(`Timeout aguardando avatar.speak_ended após ${timeoutMs}ms`));
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
      if (!session) throw new Error("Sem sessão LiveAvatar para speak_text");
      if (!connected) throw new Error("Sessão LiveAvatar ainda não conectada para speak_text");
      const clean = txt.trim();
      if (!clean) return;
      try {
        log(`speak_text: aguardando fala anterior, texto="${clean}"`);
        if (isAvatarSpeakingRef.current) await waitForAvatarEnd();
        const ended = new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            session.off(AgentEventsEnum.AVATAR_SPEAK_ENDED, onEnd);
            reject(
              new Error(
                `Timeout aguardando avatar.speak_ended do speak_text após ${SPEAK_TIMEOUT_MS}ms`,
              ),
            );
          }, SPEAK_TIMEOUT_MS);
          const onEnd = () => {
            window.clearTimeout(timer);
            session.off(AgentEventsEnum.AVATAR_SPEAK_ENDED, onEnd);
            resolve();
          };
          session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, onEnd);
        });
        const eventId = session.repeat(clean);
        log(`speak_text enviado via repeat(): event_id=${eventId}`, "ok");
        await ended;
        log(`speak_text finalizado: event_id=${eventId}`, "ok");
      } catch (error) {
        logError("speak_text/repeat falhou", error);
        throw error;
      }
    },
    [connected, log, logError, waitForAvatarEnd],
  );

  const handleSend = useCallback(
    async (rawText?: string) => {
      const question = (rawText ?? text).trim();
      if (!question) {
        log("handleSend ignorado: texto vazio");
        return;
      }
      if (!sessionRef.current || !connected) {
        log("sessão ainda não conectada. Clique em Conectar.", "err");
        return;
      }
      setText("");
      setLiveTranscript("");
      const s = settingsRef.current;
      const currentMode = modeRef.current;
      const renanteUrl =
        currentMode === "conversa"
          ? s.webhookConversa
          : currentMode === "reuniao"
            ? s.webhookReuniao
            : s.webhookEntrevistador;
      const useFiller = currentMode !== "entrevistador";
      log(`enviando pergunta (modo=${currentMode}): ${question}`);

      const fillerP = useFiller
        ? fetch(s.webhookFiller, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question }),
          })
            .then(async (response) => {
              const body = await response.text();
              log(`Webhook filler: HTTP ${response.status} ${response.statusText}\n${body}`);
              if (!response.ok) throw new Error(`Filler HTTP ${response.status}: ${body}`);
              try {
                return JSON.parse(body);
              } catch {
                return { filler: body };
              }
            })
            .catch((error) => {
              logError("erro filler", error);
              return { filler: "" };
            })
        : Promise.resolve({ filler: "" });

      const renanteP = fetch(renanteUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, sessionId: currentMode }),
      })
        .then(async (response) => {
          const body = await response.text();
          log(`Webhook Renante (${currentMode}): HTTP ${response.status} ${response.statusText}\n${body}`);
          if (!response.ok) throw new Error(`Renante HTTP ${response.status}: ${body}`);
          try {
            return JSON.parse(body);
          } catch {
            return { output: body };
          }
        })
        .catch((error) => {
          logError("erro Renante", error);
          return { output: "" };
        });

      const fillerJson: any = await fillerP;
      const fillerText = (fillerJson?.filler ?? "").toString().trim();
      if (useFiller) {
        log(`filler recebido: "${fillerText}" payload=${safeStringify(fillerJson)}`, "ok");
      } else {
        log("modo entrevistador — filler desligado");
      }
      if (fillerText) {
        try {
          await speakAndWait(fillerText);
        } catch (error) {
          logError("erro speak_text filler", error);
        }
      } else if (useFiller) {
        log("filler vazio — pulando direto pra resposta");
      }


      const renanteJson: any = await renanteP;
      const renanteText = (renanteJson?.output ?? renanteJson?.text ?? renanteJson?.message ?? "")
        .toString()
        .trim();
      log(`resposta Renante recebida: ${renanteText || safeStringify(renanteJson)}`, "ok");
      if (renanteText) {
        try {
          await speakAndWait(renanteText);
        } catch (error) {
          logError("erro speak_text resposta", error);
        }
      } else {
        log(`resposta Renante vazia. Payload=${safeStringify(renanteJson)}`, "err");
      }
    },
    [connected, log, logError, speakAndWait, text],
  );

  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);

  const testAvatar = useCallback(async () => {
    log('Teste isolado avatar: "Oi, teste de áudio, tá funcionando"');
    try {
      await speakAndWait("Oi, teste de áudio, tá funcionando");
      log("Teste isolado avatar concluído", "ok");
    } catch (error) {
      logError("Teste isolado avatar falhou", error);
    }
  }, [log, logError, speakAndWait]);

  const testMicrophone = useCallback(() => {
    log("Teste isolado microfone: ligando reconhecimento sem enviar para webhooks/avatar");
    void startRecognition("test", "teste isolado de microfone");
  }, [log, startRecognition]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <h1 className="text-xl font-semibold md:text-2xl">HeyGen LiveAvatar — Renante</h1>
            <div className="flex items-center gap-3">
              <div className="text-sm text-muted-foreground">WebRTC: {webrtcState}</div>
              <button
                onClick={() => {
                  setSettingsDraft(settings);
                  setSettingsOpen(true);
                }}
                className="rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-muted"
                aria-label="Configurações"
                title="Configurações"
              >
                ⚙️ Configurações
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={`rounded-md border px-4 py-2 text-sm font-medium transition-colors ${
                  mode === m.id
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-foreground hover:bg-muted"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div className="grid gap-2 md:grid-cols-4">
            {(Object.keys(statuses) as StatusKey[]).map((key) => (
              <div
                key={key}
                className="rounded-md border border-border bg-card p-3 text-card-foreground"
              >
                <div className="flex items-start gap-2">
                  <StatusDot state={statuses[key].state} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{statuses[key].label}</div>
                    <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-muted-foreground">
                      {statuses[key].detail}
                    </pre>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>

      <main className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-8">
        {!speechSupported && (
          <div className="rounded-md border border-destructive bg-card p-4 text-lg font-semibold text-destructive">
            Este navegador não tem reconhecimento de voz. Abra no Google Chrome no computador.
          </div>
        )}

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)]">
          <div className="flex flex-col gap-3">
            <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-card">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted={false}
                controls
                className="h-full w-full object-cover"
              />
              {avatarSpeaking && (
                <div className="absolute left-2 top-2 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground">
                  falando...
                </div>
              )}
              {showStartMediaButton && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/80">
                  <button
                    onClick={attemptVideoPlay}
                    className="rounded-md bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow"
                  >
                    ▶️ Iniciar vídeo/áudio
                  </button>
                </div>
              )}
            </div>

            <div className="grid gap-3 md:grid-cols-[auto_1fr] md:items-center">
              <button
                onClick={toggleMute}
                disabled={!speechSupported}
                aria-label={muted ? "Ativar microfone" : "Mutar microfone"}
                className={`relative h-20 w-20 rounded-full border-2 text-3xl transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
                  listening
                    ? "animate-pulse border-destructive bg-destructive text-destructive-foreground"
                    : muted
                      ? "border-border bg-muted text-muted-foreground"
                      : "border-primary bg-primary text-primary-foreground"
                }`}
              >
                {muted ? "🎙️" : listening ? "🔴" : "🎤"}
              </button>
              <div className="rounded-md border border-border bg-card p-4">
                <div className="text-sm font-medium">Transcrição ao vivo</div>
                <div className="mt-2 min-h-16 rounded-md border border-border bg-background p-3 text-lg font-semibold">
                  {liveTranscript || text || "Fale algo para ver a transcrição aqui em tempo real."}
                </div>
                <div className="mt-2 text-sm text-muted-foreground">
                  {!speechSupported
                    ? "Sem suporte a voz"
                    : muted
                      ? "Microfone mutado"
                      : listening
                        ? "Ouvindo..."
                        : avatarSpeaking
                          ? "Avatar falando (mic pausado)"
                          : "Aguardando fala"}
                </div>
              </div>
            </div>

            <div className="grid gap-2 md:grid-cols-2">
              <button
                onClick={testAvatar}
                disabled={!connected}
                className="rounded-md bg-secondary px-4 py-3 text-sm font-semibold text-secondary-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                🔊 Testar avatar (falar oi)
              </button>
              <button
                onClick={testMicrophone}
                disabled={!speechSupported}
                className="rounded-md bg-secondary px-4 py-3 text-sm font-semibold text-secondary-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                🎤 Testar microfone
              </button>
            </div>
          </div>

          <aside className="flex flex-col gap-3">
            <div className="flex gap-2">
              {!connected ? (
                <button
                  onClick={startSession}
                  disabled={starting}
                  className="flex-1 rounded-md bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {starting ? "Conectando..." : "Conectar avatar"}
                </button>
              ) : (
                <button
                  onClick={stopSession}
                  className="flex-1 rounded-md bg-destructive px-4 py-3 text-sm font-semibold text-destructive-foreground"
                >
                  Encerrar
                </button>
              )}
            </div>

            <div className="flex gap-2">
              <input
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setLiveTranscript(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleSend();
                }}
                placeholder="Digite ou fale uma pergunta..."
                className="min-w-0 flex-1 rounded-md border border-border bg-input px-3 py-2 text-sm"
              />
              <button
                onClick={() => void handleSend()}
                disabled={!connected || !text.trim()}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                Enviar
              </button>
            </div>

            <div className="rounded-md border border-border bg-card text-card-foreground">
              <div className="border-b border-border px-3 py-2 text-xs uppercase text-muted-foreground">
                Log verboso
              </div>
              <div className="h-[520px] overflow-auto p-3 font-mono text-xs leading-relaxed">
                {logs.length === 0 && (
                  <div className="text-muted-foreground">Sem eventos ainda.</div>
                )}
                {logs.map((entry, index) => (
                  <pre
                    key={`${entry.t}-${index}`}
                    className={`mb-2 whitespace-pre-wrap break-words ${
                      entry.kind === "err"
                        ? "text-destructive"
                        : entry.kind === "ok"
                          ? "text-foreground"
                          : "text-muted-foreground"
                    }`}
                  >
                    [{new Date(entry.t).toLocaleTimeString()}] {entry.msg}
                  </pre>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          </aside>
        </section>
      </main>

      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 p-4 backdrop-blur">
          <div className="my-8 w-full max-w-2xl rounded-lg border border-border bg-card p-6 text-card-foreground shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Configurações</h2>
              <button
                onClick={() => setSettingsOpen(false)}
                className="rounded-md border border-border px-3 py-1 text-sm hover:bg-muted"
              >
                Fechar
              </button>
            </div>

            <div className="space-y-5">
              <fieldset className="space-y-3">
                <legend className="text-sm font-semibold uppercase text-muted-foreground">
                  Webhooks n8n
                </legend>
                {(
                  [
                    ["webhookConversa", "Webhook Conversa"],
                    ["webhookReuniao", "Webhook Reunião"],
                    ["webhookEntrevistador", "Webhook Entrevistador"],
                    ["webhookFiller", "Webhook Filler"],
                  ] as [keyof Settings, string][]
                ).map(([key, label]) => (
                  <label key={key} className="block text-sm">
                    <span className="mb-1 block font-medium">{label}</span>
                    <input
                      value={settingsDraft[key]}
                      onChange={(e) =>
                        setSettingsDraft((d) => ({ ...d, [key]: e.target.value }))
                      }
                      className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                    />
                  </label>
                ))}
              </fieldset>

              <fieldset className="space-y-3">
                <legend className="text-sm font-semibold uppercase text-muted-foreground">
                  Avatar (LiveAvatar)
                </legend>
                {(
                  [
                    ["apiKey", "API Key"],
                    ["avatarId", "avatar_id"],
                    ["voiceId", "voice_id"],
                    ["contextId", "context_id"],
                    ["language", "idioma"],
                  ] as [keyof Settings, string][]
                ).map(([key, label]) => (
                  <label key={key} className="block text-sm">
                    <span className="mb-1 block font-medium">{label}</span>
                    <input
                      value={settingsDraft[key]}
                      onChange={(e) =>
                        setSettingsDraft((d) => ({ ...d, [key]: e.target.value }))
                      }
                      className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                    />
                  </label>
                ))}
              </fieldset>

              <fieldset className="space-y-3">
                <legend className="text-sm font-semibold uppercase text-muted-foreground">
                  Google Meet / Recall (opcional)
                </legend>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">Link do Google Meet</span>
                  <input
                    value={settingsDraft.meetLink}
                    onChange={(e) =>
                      setSettingsDraft((d) => ({ ...d, meetLink: e.target.value }))
                    }
                    className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">Recall API Key</span>
                  <input
                    value={settingsDraft.recallApiKey}
                    onChange={(e) =>
                      setSettingsDraft((d) => ({ ...d, recallApiKey: e.target.value }))
                    }
                    className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                  />
                </label>
              </fieldset>

              <div className="flex items-center gap-3">
                <button
                  onClick={saveSettings}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
                >
                  Salvar
                </button>
                <button
                  onClick={() => setSettingsDraft(DEFAULT_SETTINGS)}
                  className="rounded-md border border-border px-4 py-2 text-sm"
                >
                  Restaurar padrões
                </button>
                {settingsSaved && (
                  <span className="text-sm font-medium text-status-ok">Salvo!</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>

  );
}
