import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentEventsEnum, LiveAvatarSession, SessionEvent } from "@heygen/liveavatar-web-sdk";
import { getSessionToken } from "@/lib/heygen.functions";
import { recallCreateBot, recallGetTranscript, recallLeaveBot } from "@/lib/recall.functions";

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
type DiagStatus = "ok" | "fail" | "warn" | "info";
type DiagItem = {
  id: string;
  title: string;
  status: DiagStatus;
  detail: string;
  httpStatus?: number;
  durationMs?: number;
  rawPreview?: string;
};

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
  const callCreateBot = useServerFn(recallCreateBot);
  const callGetTranscript = useServerFn(recallGetTranscript);
  const callLeaveBot = useServerFn(recallLeaveBot);
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
  const [bargeIn, setBargeIn] = useState(false);
  const [meetingActive, setMeetingActive] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [diagRunning, setDiagRunning] = useState(false);
  const [diagResults, setDiagResults] = useState<DiagItem[]>([]);
  const [diagReport, setDiagReport] = useState("");
  const [diagCopied, setDiagCopied] = useState(false);

  // Painel de diagnóstico de voz (sempre visível quando mic ligado)
  type MicState = "desligado" | "pedindo permissão" | "ouvindo" | "erro";
  const [micState, setMicState] = useState<MicState>("desligado");
  const [micLastInterim, setMicLastInterim] = useState("");
  const [micLastFinal, setMicLastFinal] = useState("");
  const [micLastError, setMicLastError] = useState("");
  const [micTestRemaining, setMicTestRemaining] = useState(0);
  const micTestTimerRef = useRef<number | null>(null);

  // Meet-like fullscreen overlay
  const [meetOpen, setMeetOpen] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [logCollapsed, setLogCollapsed] = useState(true);
  const meetVideoRef = useRef<HTMLVideoElement>(null);
  const camVideoRef = useRef<HTMLVideoElement>(null);
  const camStreamRef = useRef<MediaStream | null>(null);

  // Recall.ai bot state
  const [botId, setBotId] = useState<string | null>(null);
  const [botJoining, setBotJoining] = useState(false);
  const [botStatus, setBotStatus] = useState<string>("");
  const botIdRef = useRef<string | null>(null);
  const recallSeenCountRef = useRef(0);
  const recallPollTimerRef = useRef<number | null>(null);
  useEffect(() => { botIdRef.current = botId; }, [botId]);




  useEffect(() => {
    bargeInRef.current = bargeIn;
  }, [bargeIn]);

  // Espelha estado da Reunião pra UI; meetingActiveRef é a fonte da verdade.
  useEffect(() => {
    const id = window.setInterval(() => {
      setMeetingActive((v) => (v !== meetingActiveRef.current ? meetingActiveRef.current : v));
    }, 400);
    return () => window.clearInterval(id);
  }, []);

  // Ao trocar de modo, reseta o estado DORMINDO da Reunião.
  useEffect(() => {
    meetingActiveRef.current = false;
    setMeetingActive(false);
  }, [mode]);

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
    setMicState("pedindo permissão");
    setMicLastError("");
    if (!window.isSecureContext) {
      const msg = "Contexto não seguro (precisa de HTTPS) para acessar o microfone.";
      setStatus("microphone", "err", msg);
      setMicState("erro");
      setMicLastError(msg);
      log(msg, "err");
      return false;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      const message = "navigator.mediaDevices.getUserMedia não existe neste navegador";
      setStatus("microphone", "err", message);
      setMicState("erro");
      setMicLastError(message);
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
      const msg = `${denied ? "Microfone negado pelo navegador" : "Erro no microfone"}: ${formatted}`;
      setStatus("microphone", "err", msg);
      setMicState("erro");
      setMicLastError(msg);
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
      setMicState("ouvindo");
      setMicLastError("");
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
        const finals: string[] = [];
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = (event.results[i]?.[0]?.transcript ?? "").trim();
          if (!transcript) continue;
          if (event.results[i].isFinal) finals.push(transcript);
          else interim += transcript + " ";
        }
        const partial = interim.trim();
        resultSinceStartRef.current = true;

        // Se avatar está falando e barge-in está DESLIGADO, ignora tudo.
        if (isAvatarSpeakingRef.current && !bargeInRef.current) {
          if (partial) log(`(avatar falando, barge-in OFF) interim ignorado: "${partial}"`);
          if (finals.length)
            log(`(avatar falando, barge-in OFF) final ignorado: "${finals.join(" | ")}"`);
          return;
        }

        if (partial) {
          setText(partial);
          setLiveTranscript(partial);
          setMicLastInterim(partial);
          lastTranscriptRef.current = partial;
          log(`SpeechRecognition interim: "${partial}"`);
        }

        for (const done of finals) {
          log(`SpeechRecognition FINAL: "${done}"`, "ok");
          setText(done);
          setLiveTranscript(done);
          setMicLastFinal(done);
          setMicLastInterim("");
          lastTranscriptRef.current = done;
          // Barge-in: se avatar fala e barge-in ON, interrompe antes de processar.
          if (isAvatarSpeakingRef.current && bargeInRef.current) {
            try {
              log("barge-in ON: interrompendo avatar", "ok");
              (sessionRef.current as any)?.interrupt?.();
            } catch (e) {
              logError("interrupt() falhou no barge-in", e);
            }
          }
          if (recognitionModeRef.current === "test") {
            log(`(modo teste de mic) final NÃO enviado: "${done}"`);
          } else {
            void handleVoiceUtteranceRef.current?.(done);
          }
        }
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
      const err = event?.error ?? "desconhecido";
      const details = `error=${err} message=${event?.message ?? ""} raw=${safeStringify(event)}`;
      log(`SpeechRecognition onerror: ${details}`, "err");
      setMicLastError(`${err}${event?.message ? ` — ${event.message}` : ""}`);
      if (err === "not-allowed" || err === "service-not-allowed") {
        isMutedRef.current = true;
        shouldListenRef.current = false;
        setMuted(true);
        setMicState("erro");
        setStatus("microphone", "err", `Permissão negada — use o campo de texto: ${details}`);
      } else if (err === "no-speech") {
        // Não é erro real, apenas silêncio. Mantém estado "ouvindo".
        setStatus("microphone", "waiting", `Nenhuma fala detectada: ${details}`);
      } else if (err === "network" || err === "aborted" || err === "audio-capture") {
        setMicState("erro");
        setStatus("microphone", "err", `Erro de reconhecimento: ${details}`);
      }
    };
    rec.onend = () => {
      isRecognitionRunningRef.current = false;
      setListening(false);
      log(
        `SpeechRecognition onend (mode=${recognitionModeRef.current}). Reiniciando se mic ligado.`,
      );
      // Web Speech API às vezes para sozinha — reinicia se mic ainda ligado.
      maybeStartListening("onend auto-restart");
    };

    recognitionRef.current = rec;
    log("SpeechRecognition configurado: lang=pt-BR interimResults=true continuous=true", "ok");
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
    if (micTestTimerRef.current !== null) {
      window.clearInterval(micTestTimerRef.current);
      micTestTimerRef.current = null;
      setMicTestRemaining(0);
    }
    try {
      recognitionRef.current?.stop();
    } catch (error) {
      logError("recognition.stop() falhou ao mutar", error);
    }
    setMicState("desligado");
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
    setMeetOpen(false);
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

  // Núcleo de envio: aceita override de modo e flag `responder` (Reunião).
  // Aplica REGRA DO VAZIO: se renante output vazio, não fala e não chama filler.
  const handleSend = useCallback(
    async (rawText?: string, opts?: { responder?: boolean }) => {
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

      // Reunião: corpo inclui `responder`. Texto digitado default = true.
      const responder = currentMode === "reuniao" ? opts?.responder ?? true : undefined;
      const willSpeak =
        currentMode === "conversa" ||
        currentMode === "entrevistador" ||
        (currentMode === "reuniao" && responder === true);
      const useFiller = willSpeak && currentMode !== "entrevistador";

      const body: Record<string, unknown> = { question, sessionId: currentMode };
      if (responder !== undefined) body.responder = responder;
      log(
        `enviando pergunta (modo=${currentMode}${responder !== undefined ? `, responder=${responder}` : ""}): ${question}`,
      );

      // Dispara filler e agente NO MESMO INSTANTE, em paralelo.
      const sendTs =
        typeof performance !== "undefined" ? performance.now() : Date.now();

      const renanteP = fetch(renanteUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(async (response) => {
          const txt = await response.text();
          log(`Webhook Renante (${currentMode}): HTTP ${response.status} ${response.statusText}\n${txt}`);
          if (!response.ok) throw new Error(`Renante HTTP ${response.status}: ${txt}`);
          try {
            return JSON.parse(txt);
          } catch {
            return { output: txt };
          }
        })
        .catch((error) => {
          logError("erro Renante", error);
          return { output: "" };
        });

      const fillerP = useFiller
        ? fetch(s.webhookFiller, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question }),
          })
            .then(async (response) => {
              const txt = await response.text();
              log(`Webhook filler: HTTP ${response.status} ${response.statusText}\n${txt}`);
              if (!response.ok) throw new Error(`Filler HTTP ${response.status}: ${txt}`);
              try {
                return JSON.parse(txt);
              } catch {
                return { filler: txt };
              }
            })
            .catch((error) => {
              logError("erro filler", error);
              return { filler: "" };
            })
        : Promise.resolve({ filler: "" });

      // Se não vai falar (Reunião dormindo), só espera o webhook pra logar e sai.
      if (!willSpeak) {
        const j: any = await renanteP;
        log(`(reuniao DORMINDO) resposta ignorada: ${safeStringify(j)}`);
        return;
      }

      // Assim que o filler chegar e for não-vazio, fala IMEDIATAMENTE (sem esperar agente).
      let fillerSpeakP: Promise<void> | null = null;
      if (useFiller) {
        fillerSpeakP = fillerP.then(async (fillerJson: any) => {
          const fillerText = (fillerJson?.filler ?? "").toString().trim();
          if (!fillerText) {
            log("filler vazio/SKIP — pulando direto pra resposta");
            return;
          }
          const now =
            typeof performance !== "undefined" ? performance.now() : Date.now();
          const dt = Math.round(now - sendTs);
          log(`filler pronto em ${dt}ms — falando: "${fillerText}"`, "ok");
          try {
            await speakAndWait(fillerText);
          } catch (error) {
            logError("erro speak_text filler", error);
          }
        });
      }

      // Aguarda agente. Se vazio, deixa o filler terminar e sai (sem resposta).
      const renanteJson: any = await renanteP;
      const renanteText = (renanteJson?.output ?? renanteJson?.text ?? renanteJson?.message ?? "")
        .toString()
        .trim();
      if (!renanteText) {
        log(`output vazio — sem resposta do agente. Payload=${safeStringify(renanteJson)}`);
        if (fillerSpeakP) await fillerSpeakP.catch(() => {});
        return;
      }

      // Espera o filler terminar (speak_ended) antes de falar a resposta.
      if (fillerSpeakP) await fillerSpeakP.catch(() => {});

      log(`resposta Renante: "${renanteText}"`, "ok");
      try {
        await speakAndWait(renanteText);
      } catch (error) {
        logError("erro speak_text resposta", error);
      }
    },
    [connected, log, logError, speakAndWait, text],
  );

  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);

  // Roteia falas reconhecidas no microfone, aplicando wake/end words da Reunião.
  const handleVoiceUtterance = useCallback(
    async (utter: string) => {
      const t = utter.trim();
      if (!t) return;
      const currentMode = modeRef.current;
      const low = t
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

      if (currentMode === "reuniao") {
        const wakeRe = /\b(ola |oi |ei |hey |alo )?(renante|renan|dante)\b/;
        const endRe = /\b(desligar (renante|renan|dante)|tchau (renante|renan|dante)|valeu (renante|renan|dante)|obrigado (renante|renan|dante)|encerra|encerrar|pode parar)\b/;
        const hasWake = wakeRe.test(low);
        const hasEnd = endRe.test(low);

        if (hasEnd && meetingActiveRef.current) {
          meetingActiveRef.current = false;
          log(`Reunião: comando de encerrar detectado ("${t}") → DORMINDO`, "ok");
        }
        let responder = meetingActiveRef.current;
        if (!meetingActiveRef.current && hasWake) {
          meetingActiveRef.current = true;
          responder = true;
          log(`Reunião: wake word detectada ("${t}") → ATIVO`, "ok");
        }
        await handleSend(t, { responder });
        return;
      }

      // Conversa e Entrevistador: fluxo padrão.
      await handleSend(t);
    },
    [handleSend, log],
  );

  useEffect(() => {
    handleVoiceUtteranceRef.current = handleVoiceUtterance;
  }, [handleVoiceUtterance]);

  // Interromper avatar (botão + tecla espaço).
  const interruptAvatar = useCallback(() => {
    const session = sessionRef.current as any;
    if (!session) {
      log("interrupt ignorado: sem sessão", "err");
      return;
    }
    try {
      log("⏹️ interrupt() chamado pelo usuário", "ok");
      session.interrupt?.();
    } catch (error) {
      logError("session.interrupt() falhou", error);
    }
  }, [log, logError]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      interruptAvatar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [interruptAvatar]);

  // ===== Recall.ai (bot no Google Meet) =====
  const joinMeetingWithBot = useCallback(async () => {
    const s = settingsRef.current;
    if (!s.recallApiKey) { log("Recall: API key vazia (Configurações)", "err"); return; }
    if (!s.meetLink) { log("Recall: Link do Google Meet vazio (Configurações)", "err"); return; }
    if (botIdRef.current) { log(`Recall: bot já ativo (${botIdRef.current})`, "info"); return; }
    setBotJoining(true);
    setBotStatus("entrando…");
    log(`[CAMADA 1] Recall POST /bot/ meeting_url=${s.meetLink} bot_name=Renante`);
    try {
      const r: any = await callCreateBot({ data: { apiKey: s.recallApiKey, meetingUrl: s.meetLink, botName: "Renante" } });
      log(`[CAMADA 1] Recall resposta HTTP ${r.status}\n${r.body}`, r.ok ? "ok" : "err");
      if (!r.ok || !r.bot?.id) { setBotStatus(`erro ${r.status}`); return; }
      const id = String(r.bot.id);
      setBotId(id);
      botIdRef.current = id;
      recallSeenCountRef.current = 0;
      setBotStatus(`bot ativo (${id.slice(0, 8)}…)`);
      log(`[CAMADA 1] ✅ Bot criado id=${id}. Transcrição em tempo real ativada (meeting_captions).`, "ok");
      log(`[CAMADA 2] iniciando polling de transcript a cada 2.5s`);
      log(`[CAMADA 3] ⚠ DESABILITADA: enviar vídeo/áudio do avatar para dentro do Meet requer "output_media" do Recall com URL de página hospedada do avatar (LiveKit em iframe público) ou stream RTMP. Setup atual do LiveAvatar usa LiveKit client SDK — não há saída publicável. Camadas 1 e 2 seguem funcionando normalmente.`, "info");
    } catch (e) {
      logError("Recall createBot falhou", e);
      setBotStatus("erro");
    } finally {
      setBotJoining(false);
    }
  }, [callCreateBot, log, logError]);

  const leaveMeetingWithBot = useCallback(async () => {
    const s = settingsRef.current;
    const id = botIdRef.current;
    if (!id) return;
    log(`Recall: removendo bot ${id}`);
    try {
      const r: any = await callLeaveBot({ data: { apiKey: s.recallApiKey, botId: id } });
      log(`Recall leave HTTP ${r.status}\n${r.body}`, r.ok ? "ok" : "err");
    } catch (e) {
      logError("Recall leaveBot falhou", e);
    }
    setBotId(null);
    botIdRef.current = null;
    setBotStatus("");
  }, [callLeaveBot, log, logError]);

  // Polling do transcript do Recall (CAMADA 2)
  useEffect(() => {
    if (!botId) return;
    let stopped = false;
    const poll = async () => {
      if (stopped || !botIdRef.current) return;
      const s = settingsRef.current;
      try {
        const r: any = await callGetTranscript({ data: { apiKey: s.recallApiKey, botId: botIdRef.current } });
        if (!r.ok) {
          log(`[CAMADA 2] transcript HTTP ${r.status} ${r.body.slice(0, 200)}`, "err");
        } else {
          const arr: any[] = Array.isArray(r.transcript)
            ? r.transcript
            : Array.isArray(r.transcript?.results)
              ? r.transcript.results
              : [];
          if (arr.length > recallSeenCountRef.current) {
            const novos = arr.slice(recallSeenCountRef.current);
            recallSeenCountRef.current = arr.length;
            for (const seg of novos) {
              const speaker = (seg?.speaker ?? seg?.participant?.name ?? "").toString();
              const words = Array.isArray(seg?.words) ? seg.words : [];
              const text = words.map((w: any) => w?.text ?? "").join(" ").trim()
                || (seg?.text ?? "").toString().trim();
              if (!text) continue;
              if (speaker && /renante/i.test(speaker)) {
                log(`[CAMADA 2] (ignora própria fala) ${speaker}: ${text}`);
                continue;
              }
              log(`[CAMADA 2] transcript "${speaker}": "${text}" → roteando p/ webhook reuniao via wake/end words`, "ok");
              try { await handleVoiceUtteranceRef.current?.(text); } catch (e) { logError("dispatch transcript", e); }
            }
          }
        }
      } catch (e) {
        logError("recall poll", e);
      }
    };
    void poll();
    recallPollTimerRef.current = window.setInterval(poll, 2500);
    return () => {
      stopped = true;
      if (recallPollTimerRef.current) { window.clearInterval(recallPollTimerRef.current); recallPollTimerRef.current = null; }
    };
  }, [botId, callGetTranscript, log, logError]);


  // Auto-open Meet overlay when avatar connects
  useEffect(() => {
    if (connected) setMeetOpen(true);
  }, [connected]);

  // Mirror avatar video stream into overlay <video>
  useEffect(() => {
    if (!meetOpen) return;
    const id = window.setInterval(() => {
      const src = videoRef.current?.srcObject ?? null;
      const dst = meetVideoRef.current;
      if (dst && dst.srcObject !== src) {
        dst.srcObject = src as MediaStream | null;
        if (src) dst.play?.().catch(() => {});
      }
    }, 400);
    return () => window.clearInterval(id);
  }, [meetOpen]);

  // Attach local camera stream to preview video
  useEffect(() => {
    const v = camVideoRef.current;
    if (v && camStreamRef.current) {
      v.srcObject = camStreamRef.current;
      v.play?.().catch(() => {});
    }
  }, [camOn, meetOpen]);

  const toggleCamera = useCallback(async () => {
    if (camOn) {
      camStreamRef.current?.getTracks().forEach((t) => t.stop());
      camStreamRef.current = null;
      setCamOn(false);
      setCamError(null);
      log("Câmera desligada");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      camStreamRef.current = stream;
      setCamOn(true);
      setCamError(null);
      log("Câmera ligada", "ok");
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      setCamError(msg);
      logError("getUserMedia(video) falhou", err);
    }
  }, [camOn, log, logError]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (err) {
      logError("fullscreen falhou", err);
    }
  }, [logError]);

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Cleanup camera on unmount
  useEffect(() => {
    return () => {
      camStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);





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
    log("Teste isolado microfone (5s): ligando reconhecimento sem enviar para webhooks/avatar");
    setMicLastFinal("");
    setMicLastInterim("");
    setMicLastError("");
    if (micTestTimerRef.current !== null) window.clearInterval(micTestTimerRef.current);
    void startRecognition("test", "teste isolado de microfone (5s)");
    let remaining = 5;
    setMicTestRemaining(remaining);
    micTestTimerRef.current = window.setInterval(() => {
      remaining -= 1;
      setMicTestRemaining(remaining);
      if (remaining <= 0) {
        if (micTestTimerRef.current !== null) {
          window.clearInterval(micTestTimerRef.current);
          micTestTimerRef.current = null;
        }
        log("Teste de microfone (5s): encerrando", "ok");
        muteMic();
      }
    }, 1000);
  }, [log, muteMic, startRecognition]);

  const runDiagnostic = useCallback(async () => {
    setDiagRunning(true);
    setDiagResults([]);
    setDiagReport("");
    const results: DiagItem[] = [];
    const push = (r: DiagItem) => {
      results.push(r);
      setDiagResults([...results]);
    };

    const s = settingsRef.current;
    const mask = (v: string) => (v ? `....${v.slice(-4)}` : "(vazio)");

    // 1) CONFIG
    const cfgLines = [
      `webhookConversa: ${s.webhookConversa ? "✅ " + s.webhookConversa : "❌ vazio"}`,
      `webhookReuniao: ${s.webhookReuniao ? "✅ " + s.webhookReuniao : "❌ vazio"}`,
      `webhookEntrevistador: ${s.webhookEntrevistador ? "✅ " + s.webhookEntrevistador : "❌ vazio"}`,
      `webhookFiller: ${s.webhookFiller ? "✅ " + s.webhookFiller : "❌ vazio"}`,
      `apiKey: ${s.apiKey ? "✅ " + mask(s.apiKey) : "❌ vazio"}`,
      `avatarId: ${s.avatarId ? "✅ " + s.avatarId : "❌ vazio"}`,
      `voiceId: ${s.voiceId ? "✅ " + s.voiceId : "❌ vazio"}`,
      `contextId: ${s.contextId ? "✅ " + s.contextId : "❌ vazio"}`,
      `language: ${s.language ? "✅ " + s.language : "❌ vazio"}`,
    ];
    const cfgMissing = [
      s.webhookConversa,
      s.webhookReuniao,
      s.webhookEntrevistador,
      s.webhookFiller,
      s.apiKey,
      s.avatarId,
      s.voiceId,
      s.contextId,
      s.language,
    ].some((v) => !v);
    push({
      id: "config",
      title: "Config carregada",
      status: cfgMissing ? "warn" : "ok",
      detail: cfgLines.join("\n"),
    });

    // 2) NAVEGADOR / MIC
    const ua = navigator.userAgent;
    const browser = /Edg\//.test(ua)
      ? "Edge"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Desconhecido";
    const hasSR = Boolean(
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition,
    );
    push({
      id: "browser",
      title: "Navegador / Web Speech API",
      status: hasSR ? "ok" : "fail",
      detail: `Navegador: ${browser}\nWeb Speech API: ${hasSR ? "✅ suportada" : "❌ NÃO suportada (use Chrome desktop)"}\nUA: ${ua}`,
    });

    // 3) ESTADO DO AVATAR
    const tokOk = statuses.token.state === "ok";
    const sessOk = statuses.session.state === "ok";
    const vidOk = statuses.video.state === "ok";
    const allOk = tokOk && sessOk && vidOk;
    push({
      id: "session",
      title: "Sessão LiveAvatar",
      status: allOk ? "ok" : sessOk || tokOk ? "warn" : "info",
      detail: [
        `Token obtido: ${tokOk ? "✅ sim" : "❌ não"} — ${statuses.token.detail}`,
        `Sessão iniciada: ${sessOk ? "✅ sim" : "❌ não"} — ${statuses.session.detail}`,
        `Vídeo conectado: ${vidOk ? "✅ sim" : "❌ não"} — ${statuses.video.detail}`,
        `WebRTC: ${webrtcState}`,
      ].join("\n"),
    });

    // 4) WEBHOOKS
    type WhTest = {
      id: string;
      title: string;
      url: string;
      body: any;
      validate: (parsed: any, raw: string) => { ok: boolean; reason: string };
    };
    const webhookTests: WhTest[] = [
      {
        id: "filler-gerar",
        title: 'Filler (gerar) — pergunta longa',
        url: s.webhookFiller,
        body: { question: "como ta minha agenda amanha" },
        validate: (p) => {
          const f = (p?.filler ?? "").toString().trim();
          return { ok: f.length > 0, reason: f ? `filler="${f}"` : "filler vazio (esperado NÃO vazio)" };
        },
      },
      {
        id: "filler-skip",
        title: 'Filler (skip) — pergunta curta',
        url: s.webhookFiller,
        body: { question: "oi" },
        validate: (p) => {
          const f = (p?.filler ?? "").toString().trim();
          return { ok: f.length === 0, reason: f ? `filler="${f}" (esperado vazio)` : "filler vazio (ok)" };
        },
      },
      {
        id: "conversa",
        title: "Conversa",
        url: s.webhookConversa,
        body: { question: "diagnostico, responda apenas OK", sessionId: "diagnostico" },
        validate: (p) => {
          const o = (p?.output ?? p?.text ?? p?.message ?? "").toString().trim();
          return { ok: o.length > 0, reason: o ? `output="${o}"` : "output vazio (esperado texto)" };
        },
      },
      {
        id: "reuniao-ambiente",
        title: "Reunião (ambiente, responder=false)",
        url: s.webhookReuniao,
        body: { question: "fala ambiente de teste", sessionId: "diagnostico-reuniao", responder: false },
        validate: (p) => {
          const o = (p?.output ?? "").toString().trim();
          return { ok: o.length === 0, reason: o ? `output="${o}" (esperado vazio)` : "output vazio (ok)" };
        },
      },
      {
        id: "reuniao-chamado",
        title: "Reunião (chamado, responder=true)",
        url: s.webhookReuniao,
        body: { question: "Renante, responda apenas OK", sessionId: "diagnostico-reuniao", responder: true },
        validate: (p) => {
          const o = (p?.output ?? "").toString().trim();
          return { ok: o.length > 0, reason: o ? `output="${o}"` : "output vazio (esperado texto)" };
        },
      },
      {
        id: "entrevistador",
        title: "Entrevistador",
        url: s.webhookEntrevistador,
        body: { question: "pode comecar", sessionId: "diagnostico-entrevista" },
        validate: (p) => {
          const o = (p?.output ?? "").toString().trim();
          return { ok: o.length > 0, reason: o ? `output="${o}"` : "output vazio (esperado pergunta)" };
        },
      },
    ];

    for (const t of webhookTests) {
      if (!t.url) {
        push({
          id: t.id,
          title: t.title,
          status: "fail",
          detail: "URL do webhook não configurada.",
        });
        continue;
      }
      const t0 = performance.now();
      try {
        const res = await fetch(t.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(t.body),
        });
        const dur = Math.round(performance.now() - t0);
        const raw = await res.text();
        const preview = raw.slice(0, 200);
        let parsed: any = {};
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = { _raw: raw };
        }
        if (!res.ok) {
          push({
            id: t.id,
            title: t.title,
            status: "fail",
            detail: `HTTP ${res.status} ${res.statusText} — corpo:\n${preview}`,
            httpStatus: res.status,
            durationMs: dur,
            rawPreview: preview,
          });
          continue;
        }
        const v = t.validate(parsed, raw);
        push({
          id: t.id,
          title: t.title,
          status: v.ok ? "ok" : "fail",
          detail: `${v.reason}\nResposta crua (200 chars): ${preview}`,
          httpStatus: res.status,
          durationMs: dur,
          rawPreview: preview,
        });
      } catch (err: any) {
        const dur = Math.round(performance.now() - t0);
        push({
          id: t.id,
          title: t.title,
          status: "fail",
          detail: `Erro de rede/CORS: ${err?.name ?? "Error"}: ${err?.message ?? String(err)}`,
          durationMs: dur,
        });
      }
    }

    // RELATÓRIO MARKDOWN
    const total = results.length;
    const okCount = results.filter((r) => r.status === "ok").length;
    const failed = results.filter((r) => r.status === "fail");
    const now = new Date();
    const header = [
      `# Diagnóstico HeyGen LiveAvatar — Renante`,
      ``,
      `**Data:** ${now.toLocaleString()}`,
      `**Resumo:** ${okCount} de ${total} testes OK`,
      failed.length
        ? `**Falhas (${failed.length}):** ${failed.map((f) => f.title).join(", ")}`
        : `**Falhas:** nenhuma 🎉`,
      ``,
      `---`,
      ``,
    ].join("\n");
    const body = results
      .map((r) => {
        const tag =
          r.status === "ok" ? "✅ OK" : r.status === "fail" ? "❌ FALHOU" : r.status === "warn" ? "⚠️ AVISO" : "ℹ️ INFO";
        const meta = [
          r.httpStatus !== undefined ? `HTTP ${r.httpStatus}` : null,
          r.durationMs !== undefined ? `${r.durationMs} ms` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return [
          `## ${tag} — ${r.title}${meta ? ` (${meta})` : ""}`,
          ``,
          "```",
          r.detail,
          "```",
          ``,
        ].join("\n");
      })
      .join("\n");
    setDiagReport(header + body);
    setDiagRunning(false);
  }, [statuses, webrtcState]);

  const copyDiagReport = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(diagReport);
      setDiagCopied(true);
      setTimeout(() => setDiagCopied(false), 1800);
    } catch {
      setDiagCopied(false);
    }
  }, [diagReport]);



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
              <button
                onClick={() => setDiagOpen(true)}
                className="rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-muted"
                aria-label="Diagnóstico"
                title="Diagnóstico"
              >
                🩺 Diagnóstico
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
                      ? "Mic desligado"
                      : avatarSpeaking
                        ? "Avatar falando"
                        : mode === "reuniao" && !meetingActive
                          ? 'Dormindo (diga "Renante")'
                          : mode === "reuniao" && meetingActive
                            ? "Sessão ativa"
                            : listening
                              ? "Ouvindo..."
                              : "Aguardando fala"}
                </div>
              </div>
            </div>

            <div
              className={`rounded-md border p-3 text-sm ${
                micState === "ouvindo"
                  ? "border-status-ok bg-card"
                  : micState === "erro"
                    ? "border-destructive bg-card"
                    : micState === "pedindo permissão"
                      ? "border-status-waiting bg-card"
                      : "border-border bg-card"
              }`}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="font-semibold">🎙️ Diagnóstico de voz</div>
                <div className="font-mono text-xs">
                  estado: <span className="font-semibold">{micState}</span>
                  {micTestRemaining > 0 && (
                    <> · teste: {micTestRemaining}s</>
                  )}
                </div>
              </div>
              <div className="grid gap-1 font-mono text-[11px] leading-snug">
                <div>
                  <span className="text-muted-foreground">parcial (interim):</span>{" "}
                  <span className="break-words">{micLastInterim || "—"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">último FINAL:</span>{" "}
                  <span className="break-words font-semibold">{micLastFinal || "—"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">último erro:</span>{" "}
                  <span className={`break-words ${micLastError ? "text-destructive" : ""}`}>
                    {micLastError || "—"}
                  </span>
                </div>
              </div>
              {typeof window !== "undefined" && !window.isSecureContext && (
                <div className="mt-2 text-xs text-destructive">
                  ⚠️ Página não está em HTTPS — microfone bloqueado.
                </div>
              )}
            </div>

            <div className="grid gap-2 md:grid-cols-[1fr_auto]">
              <button
                onClick={interruptAvatar}
                disabled={!connected}
                className="rounded-md bg-destructive px-4 py-3 text-sm font-semibold text-destructive-foreground disabled:cursor-not-allowed disabled:opacity-50"
                title="Atalho: barra de espaço"
              >
                ⏹️ Interromper (espaço)
              </button>
              <label className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={bargeIn}
                  onChange={(e) => setBargeIn(e.target.checked)}
                />
                Permitir interromper falando
              </label>
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
                🎤 Testar microfone (5s){micTestRemaining > 0 ? ` — ${micTestRemaining}s` : ""}
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

      {meetOpen && (
        <div className="fixed inset-0 z-40 flex flex-col bg-black text-white">
          {/* Top bar */}
          <div className="flex items-center justify-between px-4 py-2 text-xs text-white/70">
            <div className="flex items-center gap-3">
              <span className="font-semibold text-white">Renante · Reunião</span>
              <span>WebRTC: {webrtcState}</span>
              {avatarSpeaking && <span className="rounded bg-primary px-2 py-0.5 text-[10px] text-primary-foreground">falando…</span>}
            </div>
            <div className="flex items-center gap-2">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  className={`rounded-full px-3 py-1 text-xs transition-colors ${
                    mode === m.id ? "bg-white text-black" : "bg-white/10 text-white hover:bg-white/20"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Stage */}
          <div className="relative flex-1 overflow-hidden">
            <video
              ref={meetVideoRef}
              autoPlay
              playsInline
              className="h-full w-full object-contain bg-black"
            />

            {/* Local camera PiP */}
            {camOn && (
              <div className="absolute bottom-4 right-4 h-36 w-52 overflow-hidden rounded-lg border border-white/20 bg-black shadow-xl md:h-44 md:w-64">
                <video
                  ref={camVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="h-full w-full object-cover [transform:scaleX(-1)]"
                />
                <div className="absolute bottom-1 left-2 text-[10px] text-white/80">Você</div>
              </div>
            )}

            {camError && (
              <div className="absolute left-4 top-4 max-w-sm rounded-md bg-destructive/90 px-3 py-2 text-xs text-destructive-foreground">
                Câmera indisponível: {camError}
              </div>
            )}

            {/* Collapsible log */}
            <div className="absolute left-4 top-4 max-w-sm">
              <button
                onClick={() => setLogCollapsed((v) => !v)}
                className="rounded-md bg-white/10 px-2 py-1 text-[11px] text-white/80 hover:bg-white/20"
              >
                {logCollapsed ? "▸ log" : "▾ log"}
              </button>
              {!logCollapsed && (
                <div className="mt-2 max-h-64 w-80 overflow-auto rounded-md bg-black/70 p-2 font-mono text-[10px] leading-snug text-white/80">
                  {logs.slice(-40).map((entry, i) => (
                    <div key={`${entry.t}-${i}`} className={entry.kind === "err" ? "text-red-300" : ""}>
                      [{new Date(entry.t).toLocaleTimeString()}] {entry.msg}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Live transcript caption */}
            {(liveTranscript || micLastInterim) && (
              <div className="pointer-events-none absolute bottom-28 left-1/2 max-w-3xl -translate-x-1/2 rounded-md bg-black/60 px-4 py-2 text-center text-base text-white">
                {liveTranscript || micLastInterim}
              </div>
            )}

            {/* Painel de comandos de voz (apenas Reunião) */}
            {mode === "reuniao" && (
              <div className="absolute right-4 top-4 w-72 rounded-lg border border-white/15 bg-black/60 p-3 text-[11px] text-white/80 backdrop-blur">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-semibold text-white">Comandos de voz</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      meetingActive
                        ? "bg-emerald-500/20 text-emerald-300"
                        : "bg-white/10 text-white/70"
                    }`}
                  >
                    {meetingActive ? "● Ativo (respondendo)" : "○ Dormindo (só ouvindo)"}
                  </span>
                </div>
                <div className="space-y-1.5 leading-snug">
                  <div>
                    <span className="text-emerald-300">Ativar:</span>{" "}
                    <span className="text-white/70">"oi Renante", "olá Renan", "ei Dante" ou só o nome</span>
                  </div>
                  <div>
                    <span className="text-white/60">Desativar:</span>{" "}
                    <span className="text-white/70">"desligar Renante", "tchau Renan", "valeu Dante" ou "pode parar"</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Text fallback */}
          <div className="flex items-center gap-2 border-t border-white/10 bg-black/60 px-4 py-2">
            <input
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setLiveTranscript(e.target.value);
              }}
              onKeyDown={(e) => { if (e.key === "Enter") void handleSend(); }}
              placeholder="Digite uma mensagem (fallback)…"
              className="min-w-0 flex-1 rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40"
            />
            <button
              onClick={() => void handleSend()}
              disabled={!connected || !text.trim()}
              className="rounded-md bg-white px-3 py-2 text-sm font-medium text-black disabled:opacity-40"
            >
              Enviar
            </button>
          </div>

          {/* Control bar */}
          <div className="flex items-center justify-center gap-3 border-t border-white/10 bg-black/80 px-4 py-4">
            <button
              onClick={toggleMute}
              disabled={!speechSupported}
              title={muted ? "Ativar microfone" : "Mutar microfone"}
              className={`flex h-12 w-12 items-center justify-center rounded-full text-xl transition-colors ${
                muted ? "bg-destructive text-destructive-foreground" : "bg-white/15 text-white hover:bg-white/25"
              } disabled:opacity-40`}
            >
              {muted ? "🎙️" : "🎤"}
            </button>
            <button
              onClick={toggleCamera}
              title={camOn ? "Desligar câmera" : "Ligar câmera"}
              className={`flex h-12 w-12 items-center justify-center rounded-full text-xl transition-colors ${
                camOn ? "bg-white/15 text-white hover:bg-white/25" : "bg-destructive text-destructive-foreground"
              }`}
            >
              {camOn ? "📹" : "📷"}
            </button>
            <button
              onClick={interruptAvatar}
              disabled={!connected}
              title="Interromper fala (espaço)"
              className="flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-xl text-white hover:bg-white/25 disabled:opacity-40"
            >
              ⏹
            </button>
            <button
              onClick={toggleFullscreen}
              title={isFullscreen ? "Sair de tela cheia" : "Tela cheia"}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-xl text-white hover:bg-white/25"
            >
              {isFullscreen ? "🗗" : "⛶"}
            </button>
            <button
              onClick={() => setMeetOpen(false)}
              title="Minimizar"
              className="flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-xl text-white hover:bg-white/25"
            >
              ⤓
            </button>
            <button
              onClick={() => { void stopSession(); }}
              title="Sair da reunião"
              className="ml-2 flex h-12 items-center justify-center gap-2 rounded-full bg-destructive px-5 text-sm font-semibold text-destructive-foreground hover:opacity-90"
            >
              ☎ Sair
            </button>
          </div>
        </div>
      )}



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

      {diagOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 p-4 backdrop-blur">
          <div className="my-8 w-full max-w-3xl rounded-lg border border-border bg-card p-6 text-card-foreground shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">🩺 Diagnóstico</h2>
              <button
                onClick={() => setDiagOpen(false)}
                className="rounded-md border border-border px-3 py-1 text-sm hover:bg-muted"
              >
                Fechar
              </button>
            </div>

            <div className="mb-4 flex items-center gap-3">
              <button
                onClick={() => void runDiagnostic()}
                disabled={diagRunning}
                className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {diagRunning ? "Rodando..." : "Rodar diagnóstico"}
              </button>
              <p className="text-xs text-muted-foreground">
                Não dispara avatar nem microfone — apenas checa config, navegador, sessão e webhooks.
              </p>
            </div>

            {diagResults.length > 0 && (
              <div className="mb-4 space-y-2">
                {diagResults.map((r) => {
                  const color =
                    r.status === "ok"
                      ? "border-status-ok"
                      : r.status === "fail"
                        ? "border-destructive"
                        : "border-status-waiting";
                  const label =
                    r.status === "ok"
                      ? "✅ OK"
                      : r.status === "fail"
                        ? "❌ FALHOU"
                        : r.status === "warn"
                          ? "⚠️ AVISO"
                          : "ℹ️ INFO";
                  return (
                    <div key={r.id} className={`rounded-md border-l-4 ${color} border-y border-r border-border bg-background p-3`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-semibold">{label} — {r.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.httpStatus !== undefined && <>HTTP {r.httpStatus} · </>}
                          {r.durationMs !== undefined && <>{r.durationMs} ms</>}
                        </div>
                      </div>
                      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-muted-foreground">
                        {r.detail}
                      </pre>
                    </div>
                  );
                })}
              </div>
            )}

            {diagReport && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">Relatório (markdown)</div>
                  <button
                    onClick={() => void copyDiagReport()}
                    className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted"
                  >
                    {diagCopied ? "Copiado!" : "📋 Copiar relatório"}
                  </button>
                </div>
                <textarea
                  readOnly
                  value={diagReport}
                  onFocus={(e) => e.currentTarget.select()}
                  className="h-80 w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-xs"
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>


  );
}
