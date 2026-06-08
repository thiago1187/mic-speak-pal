import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentEventsEnum, LiveAvatarSession, SessionEvent } from "@heygen/liveavatar-web-sdk";
import {
  getSessionToken,
  getDeepgramToken,
  getEnvStatus,
  listAvatars,
  listVoices,
  type AvatarOption,
  type VoiceOption,
} from "@/lib/heygen.functions";
import { recallCreateBot, recallGetTranscript, recallLeaveBot } from "@/lib/recall.functions";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "RenAnte Avatar AI — by GZero" },
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
// Entrevistador: pausa de silêncio (s) antes de considerar que a pessoa terminou.
// Fallback caso a config não esteja salva. Ajustável na UI (entrevistadorSilenceSec).
const ENTREVISTADOR_SILENCE_SEC_DEFAULT = 3;
// Hot-swap: tempo após (re)conectar para pré-aquecer uma NOVA sessão e trocar,
// driblando o limite de duração por sessão do plano (Starter = 5 min, até 5 sessões
// simultâneas). O "cérebro" (n8n) é independente da sessão HeyGen, então o contexto
// é preservado. TESTE: 30s. PRODUÇÃO: trocar para 270_000 (4:30, folga antes dos 5 min).
// Intervalo padrão (s) entre reconexões do hot-swap (configurável na UI em "Modos").
// Cap do plano Starter = 5 min, então 270s (4:30) deixa folga. Mínimo aplicado abaixo.
const HOT_SWAP_AFTER_SEC_DEFAULT = 270;
const HOT_SWAP_MIN_SEC = 20; // tempo mínimo p/ dar conta de pré-aquecer a nova sessão
// Quanto tempo, no máximo, esperar o avatar terminar a frase antes de forçar a troca.
// Em produção (gatilho 4:30) isso ainda cabe antes do cap de 5 min (4:30 + 20s = 4:50).
const HOT_SWAP_MAX_DEFER_MS = 20_000;

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
  avatarBaseUrl: string;
  posterUrl: string; // imagem de preview do avatar (poster no quadro de vídeo antes de conectar)
  captionsEnabled: boolean; // exibir legendas da transcrição ao vivo na tela
  // Comportamento do avatar DENTRO do Google Meet (Camada 3). No Meet não há
  // botões/atalhos, então tudo é configurado aqui e embutido no bot ao entrar.
  // Há uma config independente POR MODO (Conversa/Reunião/Entrevistador), e você
  // escolhe com qual subir. Cada modo usa o webhook n8n do seu próprio modo.
  meetLaunchMode: Mode; // qual modo usar ao entrar no Meet
  meetConfigs: Record<Mode, MeetModeConfig>;
  meetDebug: boolean; // mostra diagnóstico (status do WebSocket) na câmera do bot
  meetSilenceSec: number; // pausa de silêncio (s) no Meet antes de mandar a fala pro n8n
  entrevistadorSilenceSec: number; // pausa de silêncio (s) antes de fechar a fala no Entrevistador
  hotSwapAfterSec: number; // intervalo (s) entre reconexões automáticas (hot-swap)
  sttEngine: "webspeech" | "deepgram"; // motor de transcrição da fala do usuário
  deepgramApiKey: string; // API key do Deepgram (usada só p/ gerar token temporário no servidor)
};

type MeetModeConfig = {
  greeting: string; // fala inicial ao entrar/conectar (vazio = não fala nada)
  reconnectGreeting: string; // fala ao reconectar no hot-swap (vazio = não fala nada)
  behavior: "wake" | "always"; // "wake" = só responde após o nome; "always" = responde tudo
  bargeIn: boolean; // permitir interromper a fala dele falando por cima
};

const DEFAULT_SETTINGS: Settings = {
  webhookConversa: "https://n8n.srv1435894.hstgr.cloud/webhook/c32e3b52-1d99-483f-8da7-c2b2f981687b",
  webhookReuniao: "https://n8n.srv1435894.hstgr.cloud/webhook/renante-reuniao",
  webhookEntrevistador: "https://n8n.srv1435894.hstgr.cloud/webhook/renante-entrevistador",
  webhookFiller: "https://n8n.srv1435894.hstgr.cloud/webhook/filler",
  apiKey: "", // vem do servidor (HEYGEN_API_KEY no .env / Vercel); vazio aqui = usa a env
  avatarId: "f79bd86d-ec79-4ff6-85e9-2eee714eaa0e",
  voiceId: "ef51b5eb-5b39-4e6d-84e8-8b49a1b2e098",
  contextId: "620eb98d-45ae-4a6c-9971-2c0915b4c279",
  language: "pt",
  meetLink: "",
  recallApiKey: "",
  avatarBaseUrl: "",
  posterUrl: "",
  captionsEnabled: true,
  meetLaunchMode: "reuniao",
  meetConfigs: {
    conversa: {
      greeting: "Olá! Eu sou o Renante, da Gravidade Zero. Podem falar comigo à vontade.",
      reconnectGreeting: "",
      behavior: "always",
      bargeIn: false,
    },
    reuniao: {
      greeting: "Olá pessoal! Eu sou o Renante, da Gravidade Zero. É só me chamar pelo nome quando precisarem.",
      reconnectGreeting: "",
      behavior: "wake",
      bargeIn: false,
    },
    entrevistador: {
      greeting: "Oi! Eu sou o Renante e vou conduzir essa conversa. Podem responder quando quiserem.",
      reconnectGreeting: "",
      behavior: "always",
      bargeIn: false,
    },
  },
  meetDebug: false,
  meetSilenceSec: 0.5,
  entrevistadorSilenceSec: ENTREVISTADOR_SILENCE_SEC_DEFAULT,
  hotSwapAfterSec: HOT_SWAP_AFTER_SEC_DEFAULT,
  sttEngine: "webspeech",
  deepgramApiKey: "",
};

function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    const merged: Settings = { ...DEFAULT_SETTINGS, ...parsed };
    // Garante que meetConfigs tenha os 3 modos (compat com configs antigas).
    const pc = parsed?.meetConfigs ?? {};
    merged.meetConfigs = {
      conversa: { ...DEFAULT_SETTINGS.meetConfigs.conversa, ...(pc.conversa ?? {}) },
      reuniao: { ...DEFAULT_SETTINGS.meetConfigs.reuniao, ...(pc.reuniao ?? {}) },
      entrevistador: { ...DEFAULT_SETTINGS.meetConfigs.entrevistador, ...(pc.entrevistador ?? {}) },
    };
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadMode(): Mode {
  if (typeof window === "undefined") return "conversa";
  const v = window.localStorage.getItem(MODE_KEY) as Mode | null;
  return v === "conversa" || v === "reuniao" || v === "entrevistador" ? v : "conversa";
}

// Monta a URL pública /meet com a config do MODO escolhido pra subir no Meet.
// Cada modo usa o webhook n8n do seu próprio modo; o filler é global.
function buildMeetUrl(s: Settings, debug: boolean): string {
  const m = s.meetLaunchMode;
  const cfg = s.meetConfigs[m];
  const wr =
    m === "conversa"
      ? s.webhookConversa
      : m === "entrevistador"
        ? s.webhookEntrevistador
        : s.webhookReuniao;
  const base = s.avatarBaseUrl.replace(/\/+$/, "");
  const qs = new URLSearchParams({
    apiKey: s.apiKey,
    avatarId: s.avatarId,
    voiceId: s.voiceId,
    contextId: s.contextId,
    language: s.language,
    wr,
    wf: s.webhookFiller,
    sid: m,
    greeting: cfg.greeting,
    mmode: cfg.behavior,
    barge: cfg.bargeIn ? "1" : "0",
    sil: String(s.meetSilenceSec ?? 0.5),
    debug: debug ? "1" : "0",
  });
  return `${base}/meet?${qs.toString()}`;
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
  return (
    <span className="relative mt-0.5 flex h-4 w-4 shrink-0">
      <span
        className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-90 ${color}`}
      />
      <span className={`relative inline-flex h-4 w-4 animate-pulse rounded-full ${color}`} />
    </span>
  );
}

// Logo da GZero. Usa /gzero-logo.gif (arquivo em public/); se a imagem não
// carregar, cai num fallback textual "GZero" pra nunca quebrar o layout.
function GZeroLogo({
  variant,
  className,
  imgClassName,
}: {
  variant: "white" | "black";
  className?: string;
  imgClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-1 ${
        variant === "white" ? "bg-white" : "bg-black"
      } ${className ?? ""}`}
    >
      {failed ? (
        <span className="font-extrabold tracking-tight text-pink-600">GZero</span>
      ) : (
        <img
          src="/Logo-Rosa-GZero-2.gif"
          alt="GZero"
          onError={() => setFailed(true)}
          className={imgClassName ?? "h-5 w-auto"}
        />
      )}
    </span>
  );
}

// LED de status (tema dark da tela de sessão). Verde=ok, âmbar=aguardando/parcial,
// vermelho=erro real, cinza=desligado/sem dados. Nada fictício: a cor vem do estado real.
type LedTone = "green" | "amber" | "red" | "off";
function kindToTone(k: StatusKind): LedTone {
  return k === "ok" ? "green" : k === "err" ? "red" : "amber";
}
function rtcToTone(s: string): LedTone {
  const v = (s || "").toLowerCase();
  if (v === "connected") return "green";
  if (v.includes("erro") || v.includes("fail")) return "red";
  if (v === "conectando" || v.includes("connecting") || v.includes("reconnect")) return "amber";
  return "off";
}
function SessionLed({ tone, blink = false }: { tone: LedTone; blink?: boolean }) {
  const map: Record<LedTone, string> = {
    green: "bg-emerald-400 shadow-[0_0_8px_1px_rgba(52,211,153,.7)]",
    amber: "bg-amber-400 shadow-[0_0_8px_1px_rgba(251,191,36,.6)]",
    red: "bg-red-400 shadow-[0_0_8px_1px_rgba(248,113,113,.6)]",
    off: "bg-white/25",
  };
  return (
    <span
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${map[tone]} ${blink ? "animate-pulse" : ""}`}
    />
  );
}

// Wordmark "GZero" estilizado (texto nítido: G rosa + "Zero" branco) — encaixa em
// qualquer largura e fica baixo, igual à inspiração.
function GZeroWordmark({ className }: { className?: string }) {
  return (
    <span className={`font-extrabold leading-none tracking-tight ${className ?? "text-3xl"}`}>
      <span className="text-pink-500">G</span>Zero
    </span>
  );
}

// Logo da GZero (imagem real, larga e baixa) em /gzero-logo.png. Se faltar, cai na
// wordmark de texto pra não quebrar.
function SidebarLogo({ className }: { className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <GZeroWordmark className="text-3xl" />;
  return (
    <img
      src="/gzero-logo.png"
      alt="GZero"
      onError={() => setFailed(true)}
      className={`select-none ${className ?? "h-auto w-full object-contain"}`}
    />
  );
}

// Limpa as linhas de log pra tela de sessão: eventos do SDK viram só o nome
// (sem o JSON gigante); mensagens humanas e erros passam inteiros.
function prettySessionLine(msg: string): string {
  const m = msg.match(/^\[SDK(?: agent)? event\]\s+([^:]+):/);
  if (m) return m[1].trim();
  return msg;
}

// Linha de status da sidebar técnica: LED + nome + (valor real à direita).
function StatusRow({
  tone,
  name,
  value,
  blink,
}: {
  tone: LedTone;
  name: string;
  value: string;
  blink?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <SessionLed tone={tone} blink={blink} />
      <span className="flex-1 text-[12px] text-white/85">{name}</span>
      <span className="max-w-[55%] truncate font-mono text-[10px] text-white/55" title={value}>
        {value}
      </span>
    </div>
  );
}

function Index() {
  const fetchToken = useServerFn(getSessionToken);
  const callCreateBot = useServerFn(recallCreateBot);
  const callGetTranscript = useServerFn(recallGetTranscript);
  const callLeaveBot = useServerFn(recallLeaveBot);
  const callListAvatars = useServerFn(listAvatars);
  const callListVoices = useServerFn(listVoices);
  const callDeepgramToken = useServerFn(getDeepgramToken);
  const callEnvStatus = useServerFn(getEnvStatus);
  const videoRef = useRef<HTMLVideoElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const meetLogEndRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<LiveAvatarSession | null>(null);
  const recognitionRef = useRef<any>(null);
  const isRecognitionRunningRef = useRef(false);
  const recognitionModeRef = useRef<RecognitionMode>("chat");
  const resultSinceStartRef = useRef(false);
  const finalTranscriptRef = useRef("");
  const lastTranscriptRef = useRef("");
  // Entrevistador: buffer de trechos + timer de silêncio (paciência nas pausas).
  const interviewerBufferRef = useRef("");
  const interviewerSilenceTimerRef = useRef<number | null>(null);
  const handleSendRef = useRef<((rawText?: string) => Promise<void>) | null>(null);
  const handleVoiceUtteranceRef = useRef<((text: string) => Promise<void>) | null>(null);
  const isAvatarSpeakingRef = useRef(false);
  const isMutedRef = useRef(true);
  const shouldListenRef = useRef(false);
  const micPermissionGrantedRef = useRef(false);
  const bargeInRef = useRef(false);
  const meetingActiveRef = useRef(false);
  // Filler: histórico das últimas 3 respostas não-vazias da sessão (FIFO, em memória).
  const fillerHistoryRef = useRef<string[]>([]);
  // Hot-swap: reinício automático da sessão HeyGen preservando contexto (que vive no n8n).
  const sessionStartedAtRef = useRef(0);
  const swapInProgressRef = useRef(false);
  const hotSwapTimerRef = useRef<number | null>(null);
  const prewarmSwapRef = useRef<() => void>(() => {});
  // Última fala de CONTEÚDO em andamento (texto + início), p/ retomar se um hot-swap
  // forçado cortar no meio. Reconexão/saudações curtas não entram aqui.
  const currentUtteranceRef = useRef<{ text: string; startedAt: number } | null>(null);
  // Motor Deepgram (alternativa ao Web Speech): captura mic -> PCM -> WebSocket.
  const dgWsRef = useRef<WebSocket | null>(null);
  const dgCtxRef = useRef<AudioContext | null>(null);
  const dgProcRef = useRef<ScriptProcessorNode | null>(null);
  const dgSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const dgStreamRef = useRef<MediaStream | null>(null);
  const dgKeepAliveRef = useRef<number | null>(null);
  const dgStartRef = useRef<(mode: RecognitionMode, reason: string) => void>(() => {});

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [statuses, setStatuses] = useState<Record<StatusKey, StatusItem>>(initialStatuses);
  const [text, setText] = useState("");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [settingsTab, setSettingsTab] = useState<"avatar" | "webhooks" | "modos" | "meet">("avatar");
  // Listas puxadas da API HeyGen (avatares/vozes) pra preencher os selects.
  const [avatarOptions, setAvatarOptions] = useState<AvatarOption[]>([]);
  const [voiceOptions, setVoiceOptions] = useState<VoiceOption[]>([]);
  const [apiListLoading, setApiListLoading] = useState(false);
  const [apiListError, setApiListError] = useState<string | null>(null);
  // Telemetria real da sessão: relógio da chamada, tick por segundo e status do n8n.
  const [callStartTs, setCallStartTs] = useState<number | null>(null);
  const [nowTs, setNowTs] = useState(0);
  const [n8nStatus, setN8nStatus] = useState<{ state: "idle" | "waiting" | "ok" | "err"; detail: string }>({
    state: "idle",
    detail: "aguardando evento",
  });
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
    setLastSavedAt(
      new Date().toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    );
    setTimeout(() => setSettingsSaved(false), 1800);
  }, [settingsDraft]);

  // Puxa avatares (da conta + públicos) e vozes da API HeyGen pra preencher os selects.
  const loadAvatarVoiceLists = useCallback(async () => {
    const key = settingsDraft.apiKey.trim();
    if (!key) {
      setApiListError("Preencha a API Key primeiro (campo abaixo).");
      return;
    }
    setApiListLoading(true);
    setApiListError(null);
    try {
      const [av, vo] = await Promise.all([
        callListAvatars({ data: { apiKey: key } }),
        callListVoices({ data: { apiKey: key } }),
      ]);
      setAvatarOptions(av);
      setVoiceOptions(vo);
      if (!av.length && !vo.length) setApiListError("A API não retornou avatares/vozes.");
    } catch (e: any) {
      setApiListError(e?.message ?? String(e));
    } finally {
      setApiListLoading(false);
    }
  }, [callListAvatars, callListVoices, settingsDraft.apiKey]);

  // Define o motor de transcrição (Web Speech ou Deepgram) e persiste.
  const setSttEngine = useCallback((engine: "webspeech" | "deepgram") => {
    setSettings((s) => {
      const next = { ...s, sttEngine: engine };
      settingsRef.current = next;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      }
      return next;
    });
    setSettingsDraft((d) => ({ ...d, sttEngine: engine }));
  }, []);

  // Liga/desliga as legendas da transcrição ao vivo (persiste no localStorage).
  const toggleCaptions = useCallback(() => {
    setSettings((s) => {
      const next = { ...s, captionsEnabled: !s.captionsEnabled };
      settingsRef.current = next;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      }
      return next;
    });
  }, []);

  const [liveTranscript, setLiveTranscript] = useState("");
  const [connected, setConnected] = useState(false);
  const [starting, setStarting] = useState(false);
  const [listening, setListening] = useState(false);
  const [interviewerWaiting, setInterviewerWaiting] = useState(false); // Entrevistador: aguardando a pausa longa
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
  const [logCollapsed, setLogCollapsed] = useState(false);
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
  // CAMADA 3: quando o avatar está DENTRO do Meet, a página /meet fala por si;
  // aqui não falamos localmente (evita fala duplicada), só logamos a transcrição.
  const avatarInMeetRef = useRef(false);
  useEffect(() => { botIdRef.current = botId; }, [botId]);




  useEffect(() => {
    bargeInRef.current = bargeIn;
  }, [bargeIn]);

  // Aplica o barge-in configurado por modo também na chamada do próprio site.
  // Ao trocar de modo (ou salvar config), o barge-in padrão do modo é aplicado;
  // o usuário ainda pode sobrescrever manualmente no checkbox da tela.
  useEffect(() => {
    setBargeIn(settings.meetConfigs[mode]?.bargeIn ?? false);
  }, [mode, settings]);

  // Espelha estado da Reunião pra UI; meetingActiveRef é a fonte da verdade.
  useEffect(() => {
    const id = window.setInterval(() => {
      setMeetingActive((v) => (v !== meetingActiveRef.current ? meetingActiveRef.current : v));
    }, 400);
    return () => window.clearInterval(id);
  }, []);

  // Ao trocar de modo, reseta o estado DORMINDO da Reunião e o buffer do Entrevistador.
  useEffect(() => {
    meetingActiveRef.current = false;
    setMeetingActive(false);
    if (interviewerSilenceTimerRef.current !== null) {
      window.clearTimeout(interviewerSilenceTimerRef.current);
      interviewerSilenceTimerRef.current = null;
    }
    interviewerBufferRef.current = "";
    setInterviewerWaiting(false);
    // Nova sessão de modo: zera o histórico do filler.
    fillerHistoryRef.current = [];
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
      // No modo Deepgram o Web Speech fica desligado (o WS é contínuo).
      if (settingsRef.current.sttEngine === "deepgram") return;
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
        } catch (error: any) {
          // Corrida start()↔onstart: o reconhecimento já tinha começado. Não é erro
          // real — só sincroniza o estado (o onstart/onend mantêm o resto consistente).
          if (error?.name === "InvalidStateError") {
            isRecognitionRunningRef.current = true;
            setListening(true);
            log(`recognition já estava ativo (${reason}); estado sincronizado`);
          } else {
            logError(`recognition.start() falhou (${reason})`, error);
          }
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
    meetLogEndRef.current?.scrollIntoView({ block: "end" });
  }, [logs]);

  // Relógio real da chamada: marca o início na 1ª conexão; zera ao encerrar.
  useEffect(() => {
    if (connected) {
      setCallStartTs((prev) => prev ?? Date.now());
    } else {
      setCallStartTs(null);
    }
  }, [connected]);

  // Tick de 1s enquanto a sessão está aberta (relógio + contagem do hot-swap).
  useEffect(() => {
    if (!meetOpen) return;
    setNowTs(Date.now());
    const id = window.setInterval(() => setNowTs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [meetOpen]);

  // Diagnóstico: checa se o SERVIDOR enxerga as variáveis de ambiente (.env / Vercel).
  useEffect(() => {
    void (async () => {
      try {
        const st = await callEnvStatus();
        log(
          `[env servidor] HEYGEN=${st.heygen} DEEPGRAM=${st.deepgram} RECALL=${st.recall}`,
          st.heygen ? "ok" : "err",
        );
        if (!st.heygen) {
          log(
            "⚠️ O servidor NÃO está enxergando HEYGEN_API_KEY. Na Vercel: confirme a variável em Production e faça um Redeploy (sem cache).",
            "err",
          );
        }
      } catch (e) {
        logError("checagem de env do servidor falhou", e);
      }
    })();
  }, [callEnvStatus, log, logError]);

  // ===== Roteamento de transcrição (compartilhado entre Web Speech e Deepgram) =====
  // Entrevistador: acumula e só envia após silêncio longo.
  const flushInterviewer = useCallback(() => {
    if (interviewerSilenceTimerRef.current !== null) {
      window.clearTimeout(interviewerSilenceTimerRef.current);
      interviewerSilenceTimerRef.current = null;
    }
    const buffered = interviewerBufferRef.current.trim();
    interviewerBufferRef.current = "";
    setInterviewerWaiting(false);
    if (buffered) {
      log(`Entrevistador: pausa longa — enviando resposta completa: "${buffered}"`, "ok");
      void handleVoiceUtteranceRef.current?.(buffered);
    }
  }, [log]);

  const scheduleInterviewerFlush = useCallback(() => {
    setInterviewerWaiting(true);
    if (interviewerSilenceTimerRef.current !== null) {
      window.clearTimeout(interviewerSilenceTimerRef.current);
    }
    const sec = settingsRef.current.entrevistadorSilenceSec || ENTREVISTADOR_SILENCE_SEC_DEFAULT;
    interviewerSilenceTimerRef.current = window.setTimeout(flushInterviewer, Math.max(0.5, sec) * 1000);
  }, [flushInterviewer]);

  // Trecho parcial (interim): atualiza a transcrição ao vivo.
  const routeInterim = useCallback(
    (partial: string) => {
      if (!partial) return;
      if (isAvatarSpeakingRef.current && !bargeInRef.current) return;
      setText(partial);
      setLiveTranscript(partial);
      setMicLastInterim(partial);
      lastTranscriptRef.current = partial;
      if (modeRef.current === "entrevistador" && recognitionModeRef.current !== "test") {
        scheduleInterviewerFlush();
      }
    },
    [scheduleInterviewerFlush],
  );

  // Trecho final: aplica regra de barge-in, modo teste, entrevistador e envio normal.
  const routeFinal = useCallback(
    (done: string) => {
      if (!done) return;
      if (isAvatarSpeakingRef.current && !bargeInRef.current) {
        log(`(avatar falando, barge-in OFF) final ignorado: "${done}"`);
        return;
      }
      setText(done);
      setLiveTranscript(done);
      setMicLastFinal(done);
      setMicLastInterim("");
      lastTranscriptRef.current = done;
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
        return;
      }
      if (modeRef.current === "entrevistador") {
        interviewerBufferRef.current = `${interviewerBufferRef.current} ${done}`.trim();
        const sec =
          settingsRef.current.entrevistadorSilenceSec || ENTREVISTADOR_SILENCE_SEC_DEFAULT;
        log(`Entrevistador: trecho acumulado ("${done}") — aguardando ${sec}s de silêncio`);
        scheduleInterviewerFlush();
        return;
      }
      void handleVoiceUtteranceRef.current?.(done);
    },
    [log, logError, scheduleInterviewerFlush],
  );

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    log(
      `Detecção SpeechRecognition: SpeechRecognition=${Boolean((window as any).SpeechRecognition)} webkitSpeechRecognition=${Boolean((window as any).webkitSpeechRecognition)}`,
      SR ? "ok" : "err",
    );
    if (!SR) {
      setSpeechSupported(false);
      // Padrão inteligente: navegador sem Web Speech → usa Deepgram (universal).
      if (settingsRef.current.sttEngine !== "deepgram") {
        log("Navegador sem Web Speech → transcrição trocada para Deepgram", "ok");
        setSttEngine("deepgram");
      }
      const message =
        "Web Speech indisponível neste navegador — usando Deepgram (configure a API key).";
      setStatus("microphone", "waiting", message);
      log(message);
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

        if (partial) {
          log(`SpeechRecognition interim: "${partial}"`);
          routeInterim(partial);
        }
        for (const done of finals) {
          log(`SpeechRecognition FINAL: "${done}"`, "ok");
          routeFinal(done);
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
  }, [log, logError, maybeStartListening, routeFinal, routeInterim, setSttEngine, setStatus]);

  // ===== Motor Deepgram (alternativa universal ao Web Speech) =====
  // Captura o microfone, converte para PCM16 e envia por WebSocket ao Deepgram,
  // que devolve trechos parciais/finais — roteados pelos mesmos handlers.
  const stopDeepgram = useCallback(() => {
    if (dgKeepAliveRef.current !== null) {
      window.clearInterval(dgKeepAliveRef.current);
      dgKeepAliveRef.current = null;
    }
    try {
      if (dgWsRef.current?.readyState === WebSocket.OPEN) {
        dgWsRef.current.send(JSON.stringify({ type: "CloseStream" }));
      }
    } catch {}
    try {
      dgWsRef.current?.close();
    } catch {}
    dgWsRef.current = null;
    try {
      dgProcRef.current?.disconnect();
    } catch {}
    try {
      dgSourceRef.current?.disconnect();
    } catch {}
    try {
      dgStreamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {}
    try {
      void dgCtxRef.current?.close();
    } catch {}
    dgProcRef.current = null;
    dgSourceRef.current = null;
    dgStreamRef.current = null;
    dgCtxRef.current = null;
  }, []);

  const startDeepgram = useCallback(
    async (mode: RecognitionMode, reason: string) => {
      // A key pode estar vazia no cliente: o servidor usa a DEEPGRAM_API_KEY (.env / Vercel).
      const key = (settingsRef.current.deepgramApiKey || "").trim();
      recognitionModeRef.current = mode;
      shouldListenRef.current = true;
      isMutedRef.current = false;
      setMuted(false);
      setLiveTranscript("");
      setText("");
      stopDeepgram(); // limpa qualquer sessão anterior
      try {
        setMicState("pedindo permissão");
        setStatus("microphone", "waiting", "Deepgram: pedindo permissão do microfone…");
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        dgStreamRef.current = stream;
        micPermissionGrantedRef.current = true;

        const { token } = await callDeepgramToken({ data: { apiKey: key } });

        const AudioCtx =
          (window as any).AudioContext || (window as any).webkitAudioContext;
        const ctx: AudioContext = new AudioCtx();
        dgCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        dgSourceRef.current = source;
        const proc = ctx.createScriptProcessor(4096, 1, 1);
        dgProcRef.current = proc;

        const params = new URLSearchParams({
          model: "nova-2",
          language: "pt-BR",
          encoding: "linear16",
          sample_rate: String(Math.round(ctx.sampleRate)),
          channels: "1",
          interim_results: "true",
          smart_format: "true",
          punctuate: "true",
          endpointing: "300",
        });
        const ws = new WebSocket(
          `wss://api.deepgram.com/v1/listen?${params.toString()}`,
          ["token", token],
        );
        ws.binaryType = "arraybuffer";
        dgWsRef.current = ws;

        ws.onopen = () => {
          setListening(true);
          setMicState("ouvindo");
          setMicLastError("");
          setStatus("microphone", "ok", `Deepgram conectado; ouvindo… (${reason})`);
          log(`Deepgram WS aberto; ouvindo (modo=${mode})`, "ok");
          dgKeepAliveRef.current = window.setInterval(() => {
            try {
              if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
            } catch {}
          }, 8000);
        };
        ws.onmessage = (ev) => {
          try {
            if (typeof ev.data !== "string") return;
            const msg = JSON.parse(ev.data);
            if (msg?.type !== "Results") return;
            const txt = (msg.channel?.alternatives?.[0]?.transcript ?? "").trim();
            if (!txt) return;
            if (msg.is_final) routeFinal(txt);
            else routeInterim(txt);
          } catch {}
        };
        ws.onerror = (e) => {
          logError("Deepgram WS erro", e);
          setStatus("microphone", "err", "Erro no WebSocket do Deepgram");
        };
        ws.onclose = () => {
          if (dgKeepAliveRef.current !== null) {
            window.clearInterval(dgKeepAliveRef.current);
            dgKeepAliveRef.current = null;
          }
          setListening(false);
          log("Deepgram WS fechado");
          // Reconecta se o mic ainda deveria estar ligado (queda de rede etc.).
          if (shouldListenRef.current && !isMutedRef.current) {
            window.setTimeout(() => {
              if (shouldListenRef.current && !isMutedRef.current) {
                log("Deepgram: reconectando…");
                dgStartRef.current(recognitionModeRef.current, "reconexão");
              }
            }, 1000);
          }
        };

        proc.onaudioprocess = (e) => {
          const ws2 = dgWsRef.current;
          if (!ws2 || ws2.readyState !== WebSocket.OPEN) return;
          const input = e.inputBuffer.getChannelData(0);
          const pcm = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) {
            const x = Math.max(-1, Math.min(1, input[i]));
            pcm[i] = x < 0 ? x * 0x8000 : x * 0x7fff;
          }
          try {
            ws2.send(pcm.buffer);
          } catch {}
        };
        source.connect(proc);
        proc.connect(ctx.destination);
      } catch (e: any) {
        micPermissionGrantedRef.current = false;
        const msg = formatError(e);
        setStatus("microphone", "err", `Deepgram falhou: ${msg}`);
        setMicState("erro");
        setMicLastError(msg);
        logError("startDeepgram falhou", e);
        stopDeepgram();
      }
    },
    [callDeepgramToken, log, logError, routeFinal, routeInterim, setStatus, stopDeepgram],
  );

  useEffect(() => {
    dgStartRef.current = startDeepgram;
  }, [startDeepgram]);

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
    if (settingsRef.current.sttEngine === "deepgram") {
      void startDeepgram("chat", "botão principal/desmutar");
    } else {
      void startRecognition("chat", "botão principal/desmutar");
    }
  }, [startDeepgram, startRecognition]);

  const muteMic = useCallback(() => {
    isMutedRef.current = true;
    setMuted(true);
    shouldListenRef.current = false;
    if (micTestTimerRef.current !== null) {
      window.clearInterval(micTestTimerRef.current);
      micTestTimerRef.current = null;
      setMicTestRemaining(0);
    }
    // Entrevistador: descarta o timer/buffer de silêncio ao desligar o mic.
    if (interviewerSilenceTimerRef.current !== null) {
      window.clearTimeout(interviewerSilenceTimerRef.current);
      interviewerSilenceTimerRef.current = null;
    }
    interviewerBufferRef.current = "";
    setInterviewerWaiting(false);
    try {
      recognitionRef.current?.stop();
    } catch (error) {
      logError("recognition.stop() falhou ao mutar", error);
    }
    stopDeepgram(); // encerra o Deepgram se estiver ativo
    setMicState("desligado");
    setStatus(
      "microphone",
      "waiting",
      "Microfone desligado",
    );
    log("microfone mutado");
  }, [log, logError, setStatus, stopDeepgram]);

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
        // Durante o hot-swap a sessão antiga continua emitindo eventos: ignore-os
        // para não rebaixar a UI enquanto a nova sessão assume.
        if (session !== sessionRef.current) return;
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
        // Sessão antiga sendo descartada no hot-swap → não mexe na UI.
        if (session !== sessionRef.current) return;
        setConnected(false);
        setStatus("token", "waiting", "Sem sessão (clique em Conectar avatar)");
        setStatus("session", "waiting", `Desconectada: ${safeStringify(reason)}`);
        setStatus("video", "waiting", "Sem stream");
      });
      session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => {
        isAvatarSpeakingRef.current = true;
        setAvatarSpeaking(true);
        log("avatar começou a falar (mic permanece ligado; confiando em EC)", "ok");
      });
      session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
        isAvatarSpeakingRef.current = false;
        setAvatarSpeaking(false);
        if (session === sessionRef.current) currentUtteranceRef.current = null;
        log("avatar terminou de falar", "ok");
        if (modeRef.current === "entrevistador" && shouldListenRef.current && !isMutedRef.current) {
          maybeStartListening("entrevistador: pronto pra resposta");
        }
      });
      log(`Eventos SDK registrados: ${[...sessionEvents, ...agentEvents].join(", ")}`, "ok");
    },
    [attemptVideoPlay, log, logError, maybeStartListening, setStatus],
  );

  // ===== HOT-SWAP (driblar o limite de duração por sessão do plano HeyGen) =====
  // Como o "cérebro" (n8n) é independente da sessão HeyGen, trocar a sessão NÃO perde
  // contexto. Pré-aquecemos uma 2ª sessão e, quando o vídeo dela estiver pronto, fazemos
  // o swap do <video> e encerramos a antiga — com interrupção mínima.
  const scheduleHotSwap = useCallback(() => {
    if (hotSwapTimerRef.current !== null) window.clearTimeout(hotSwapTimerRef.current);
    const sec = Math.max(
      HOT_SWAP_MIN_SEC,
      settingsRef.current.hotSwapAfterSec || HOT_SWAP_AFTER_SEC_DEFAULT,
    );
    hotSwapTimerRef.current = window.setTimeout(() => {
      prewarmSwapRef.current?.();
    }, sec * 1000);
    log(`HOT-SWAP agendado para daqui a ${sec}s`);
  }, [log]);

  const prewarmAndSwap = useCallback(async () => {
    if (swapInProgressRef.current) return;
    const oldSession = sessionRef.current;
    if (!oldSession) return;
    swapInProgressRef.current = true;

    // Fala uma frase numa sessão específica e resolve quando ela termina (ou timeout).
    const speakOn = (sess: LiveAvatarSession, txt: string) =>
      new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          window.clearTimeout(timer);
          try {
            sess.off(AgentEventsEnum.AVATAR_SPEAK_ENDED, finish);
          } catch {}
          resolve();
        };
        const timer = window.setTimeout(finish, SPEAK_TIMEOUT_MS);
        sess.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, finish);
        try {
          sess.repeat(txt);
        } catch {
          finish();
        }
      });

    try {
      // 1) Se o avatar está falando, ESPERA terminar a frase (até um limite de segurança).
      //    Só corta no meio se estourar esse limite (perto do cap de 5 min em produção).
      let forcedCut = false;
      if (isAvatarSpeakingRef.current) {
        log("HOT-SWAP: avatar falando — aguardando ele terminar a frase…");
        const ended = await new Promise<boolean>((resolve) => {
          let done = false;
          const finish = (val: boolean) => {
            if (done) return;
            done = true;
            window.clearTimeout(timer);
            try {
              oldSession.off(AgentEventsEnum.AVATAR_SPEAK_ENDED, onEnd);
            } catch {}
            resolve(val);
          };
          const onEnd = () => finish(true);
          const timer = window.setTimeout(() => finish(false), HOT_SWAP_MAX_DEFER_MS);
          oldSession.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, onEnd);
        });
        if (ended) {
          log("HOT-SWAP: frase terminou — trocando em silêncio", "ok");
        } else {
          forcedCut = true;
          log("HOT-SWAP: limite de espera atingido — vai cortar e retomar de onde parou", "ok");
        }
      }

      // Guarda a fala em andamento p/ retomar SÓ se a troca cortar no meio.
      const pending = forcedCut ? currentUtteranceRef.current : null;

      log("HOT-SWAP: pré-aquecendo nova sessão (contexto preservado no n8n)…", "ok");
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
      const newSession = new LiveAvatarSession(tokenResult.session_token, { voiceChat: false });
      registerSdkEvents(newSession);
      attachRoomDiagnostics(newSession);

      // Quando o stream da NOVA sessão estiver pronto: promove e descarta a antiga.
      const promote = () => {
        newSession.off(SessionEvent.SESSION_STREAM_READY, promote);
        // Tempo de fala consumido até o momento do corte (p/ estimar o que faltou).
        const cutElapsedMs = pending ? Date.now() - pending.startedAt : 0;
        try {
          if (videoRef.current) newSession.attach(videoRef.current);
        } catch (e) {
          logError("HOT-SWAP: attach do vídeo falhou", e);
        }
        sessionRef.current = newSession;
        sessionStartedAtRef.current = Date.now();
        setStatus("token", "ok", `Renovada (hot-swap). session_id=${tokenResult.session_id}`);
        setStatus("session", "ok", "Sessão renovada (hot-swap)");
        log("HOT-SWAP: troca concluída ✅ (encerrando sessão antiga)", "ok");
        // O DISCONNECTED da antiga é ignorado pelo guard de sessão em registerSdkEvents.
        void oldSession.stop().catch((e) => logError("HOT-SWAP: stop da antiga falhou", e));
        swapInProgressRef.current = false;
        void attemptVideoPlay();
        scheduleHotSwap(); // reagenda o próximo ciclo

        // Suprime a saudação automática do HeyGen na NOVA sessão, fala a "fala ao
        // reconectar" (se configurada) e, se a troca cortou no meio, retoma de onde parou.
        void (async () => {
          for (let i = 0; i < 4; i++) {
            try {
              (newSession as any)?.interrupt?.();
            } catch {}
            await new Promise((r) => window.setTimeout(r, 250));
          }
          const reconnectMsg = (
            settingsRef.current.meetConfigs[modeRef.current]?.reconnectGreeting ?? ""
          ).trim();
          if (reconnectMsg) {
            log(`HOT-SWAP: fala ao reconectar: "${reconnectMsg}"`, "ok");
            await speakOn(newSession, reconnectMsg);
          }
          // Retomada: re-fala a parte que faltou da frase cortada (estimativa por tempo,
          // recuando ~2 palavras para emendar com naturalidade).
          if (pending?.text) {
            const words = pending.text.trim().split(/\s+/).filter(Boolean);
            const WORDS_PER_SEC = 2.7;
            let spoken = Math.floor((cutElapsedMs / 1000) * WORDS_PER_SEC) - 2;
            if (spoken < 0) spoken = 0;
            const remaining = spoken < words.length ? words.slice(spoken).join(" ") : "";
            if (remaining) {
              log(`HOT-SWAP: retomando de onde parou: "${remaining}"`, "ok");
              await speakOn(newSession, remaining);
            }
          }
        })();
      };
      newSession.on(SessionEvent.SESSION_STREAM_READY, promote);

      log("HOT-SWAP: start() da nova sessão…");
      await newSession.start();
    } catch (e) {
      logError("HOT-SWAP falhou; mantendo a sessão atual (tenta de novo no próximo ciclo)", e);
      swapInProgressRef.current = false;
      scheduleHotSwap();
    }
  }, [
    attachRoomDiagnostics,
    attemptVideoPlay,
    fetchToken,
    log,
    logError,
    registerSdkEvents,
    scheduleHotSwap,
    setStatus,
  ]);

  useEffect(() => {
    prewarmSwapRef.current = prewarmAndSwap;
  }, [prewarmAndSwap]);

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

      // Fala inicial (ao entrar): fala a saudação configurada PARA O MODO ATUAL.
      // O HeyGen pode iniciar uma saudação automática própria — então interrompemos
      // algumas vezes (igual à página /meet) e falamos a SUA frase por cima.
      const greeting = (s.meetConfigs[modeRef.current]?.greeting ?? "").trim();
      if (greeting) {
        for (let i = 0; i < 4; i++) {
          try {
            (session as any)?.interrupt?.();
          } catch {}
          await new Promise((r) => window.setTimeout(r, 250));
        }
        try {
          log(`fala inicial (substitui a do HeyGen): "${greeting}"`, "ok");
          session.repeat(greeting);
        } catch (e) {
          logError("fala inicial falhou", e);
        }
      }

      // Arma o hot-swap: pré-aquece e troca a sessão antes do limite do plano.
      sessionStartedAtRef.current = Date.now();
      swapInProgressRef.current = false;
      scheduleHotSwap();
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
  }, [attachRoomDiagnostics, fetchToken, log, logError, registerSdkEvents, scheduleHotSwap, setStatus]);

  const stopSession = useCallback(async () => {
    log("Encerrando sessão manualmente...");
    if (hotSwapTimerRef.current !== null) {
      window.clearTimeout(hotSwapTimerRef.current);
      hotSwapTimerRef.current = null;
    }
    swapInProgressRef.current = false;
    try {
      await sessionRef.current?.stop();
      log("session.stop(): ok", "ok");
    } catch (error) {
      logError("session.stop() falhou", error);
    }
    sessionRef.current = null;
    setConnected(false);
    setStatus("token", "waiting", "Sem sessão (clique em Conectar avatar)");
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
        currentUtteranceRef.current = { text: clean, startedAt: Date.now() };
        const eventId = session.repeat(clean);
        log(`speak_text enviado via repeat(): event_id=${eventId}`, "ok");
        await ended;
        currentUtteranceRef.current = null;
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

      setN8nStatus({ state: "waiting", detail: "enviando…" });
      const renanteP = fetch(renanteUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(async (response) => {
          const txt = await response.text();
          log(`Webhook Renante (${currentMode}): HTTP ${response.status} ${response.statusText}\n${txt}`);
          if (!response.ok) throw new Error(`Renante HTTP ${response.status}: ${txt}`);
          setN8nStatus({ state: "ok", detail: `respondeu · HTTP ${response.status}` });
          try {
            return JSON.parse(txt);
          } catch {
            return { output: txt };
          }
        })
        .catch((error) => {
          setN8nStatus({ state: "err", detail: "falhou" });
          logError("erro Renante", error);
          return { output: "" };
        });

      // AJUSTES 2 e 3 — filler com sessionId + histórico das últimas 3 (FIFO).
      const fillerHistorico = [...fillerHistoryRef.current];
      if (useFiller) {
        log(
          `filler enviado: question="${question}", sessionId="${currentMode}", historico_filler.length=${fillerHistorico.length}`,
        );
      }
      const fillerP = useFiller
        ? fetch(s.webhookFiller, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              question,
              sessionId: currentMode,
              historico_filler: fillerHistorico,
            }),
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
          // AJUSTE 2 — guarda no histórico (FIFO 3) só os fillers não-vazios.
          fillerHistoryRef.current = [...fillerHistoryRef.current, fillerText].slice(-3);
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

      // Comportamento por modo (vale também na chamada do próprio site, não só no Meet):
      // "wake" = só responde após ser chamado pelo nome; "always" = responde tudo.
      const modeCfg = settingsRef.current.meetConfigs[currentMode];
      const useWake = modeCfg?.behavior === "wake";

      if (useWake) {
        // ===== REGRA DE OURO: classifica LOCALMENTE antes de chamar qualquer webhook. =====
        // `low` já está normalizado (minúsculas, sem acento). 2 estados: DORMINDO/ATIVO.
        const isActive = meetingActiveRef.current;

        // Wake word tolerante às variações do reconhecimento de voz.
        const wakeRe = /\b(renante|renan|renando|renato|render|dante|dante)\b/;
        const hasWake = wakeRe.test(low);

        // Comando de desligar: correspondência FLEXÍVEL (a fala CONTÉM algo disto),
        // com ou sem o nome. Palavras curtas usam limite de palavra p/ evitar falso
        // positivo (ex.: "chegamos" não vira "chega").
        const endRe =
          /\b(desligar|desliga|pode desligar|pode parar|pode encerrar|encerra|encerrar|para (renante|renan|renato|render|dante)|chega|tchau|pode ir|era so isso|obrigado por enquanto|dispensar|ja chega|ja deu)\b/;
        let hasEnd = endRe.test(low);
        // "valeu"/"obrigado" sozinhos só contam como desligar quando ATIVO.
        if (!hasEnd && isActive && /\b(valeu|vlw|obrigado|obrigada|brigado)\b/.test(low)) {
          hasEnd = true;
        }

        // CASO 2 — ATIVO + desligar → DORMINDO + despedida FIXA do app.
        // NÃO chama filler, NÃO chama agente, NÃO chama webhook nenhum.
        if (isActive && hasEnd) {
          meetingActiveRef.current = false;
          setMeetingActive(false);
          log(`Reunião: → DORMINDO (comando de desligar: "${t}")`, "ok");
          try {
            await speakAndWait("Beleza, tô saindo. É só me chamar.");
          } catch (e) {
            logError("despedida (desligar)", e);
          }
          return;
        }

        // CASO 1 — DORMINDO + wake word (e não é um adeus a outra pessoa) → ATIVO.
        if (!isActive && hasWake && !hasEnd) {
          meetingActiveRef.current = true;
          setMeetingActive(true);
          log(`Reunião: → ATIVO (wake word detectada: "${t}")`, "ok");
          // Veio pergunta junto com o nome? Tira saudação/nome e vê se sobra conteúdo.
          const resto = low
            .replace(/\b(ola|oi|ei|hey|alo|e ai|eai|opa|fala)\b/g, " ")
            .replace(/\b(renante|renan|renando|renato|render|dante|dante)\b/g, " ")
            .replace(/[^a-z0-9]+/g, " ")
            .trim();
          if (resto.length >= 4) {
            // Tem pergunta junto com o nome → manda pro agente (filler + agente).
            await handleSend(t, { responder: true });
          } else {
            // Só chamou o nome → saudação FIXA do app, sem n8n.
            try {
              await speakAndWait("Oi, tô aqui!");
            } catch (e) {
              logError("saudação (wake)", e);
            }
          }
          return;
        }

        // CASO 3 — ATIVO + fala normal → filler + agente em paralelo (responder:true).
        if (isActive) {
          await handleSend(t, { responder: true });
          return;
        }

        // CASO 4 — DORMINDO + fala normal → grava contexto (responder:false), sem filler/fala.
        await handleSend(t, { responder: false });
        return;
      }

      // Modo "always" (responde tudo): fluxo padrão.
      await handleSend(t);
    },
    [handleSend, log, speakAndWait, logError],
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
    // recallApiKey pode estar vazia: o servidor usa RECALL_API_KEY (.env / Vercel).
    if (!s.meetLink) { log("Recall: Link do Google Meet vazio (Configurações)", "err"); return; }
    if (botIdRef.current) { log(`Recall: bot já ativo (${botIdRef.current})`, "info"); return; }
    setBotJoining(true);
    setBotStatus("entrando…");
    avatarInMeetRef.current = false; // Camada 1/2: só escuta; fala sai pelo avatar local
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
      log(`[CAMADA 2] (avatar fala na SUA tela) Para o avatar falar DENTRO do Meet, use o botão "Entrar com avatar no Meet (Camada 3)".`, "info");
    } catch (e) {
      logError("Recall createBot falhou", e);
      setBotStatus("erro");
    } finally {
      setBotJoining(false);
    }
  }, [callCreateBot, log, logError]);

  // CAMADA 3 — cria o bot com output_media apontando pra página pública /meet,
  // que faz o avatar aparecer e falar DENTRO da reunião. Não toca nas Camadas 1/2.
  const joinMeetingWithAvatar = useCallback(async () => {
    const s = settingsRef.current;
    // recallApiKey pode estar vazia: o servidor usa RECALL_API_KEY (.env / Vercel).
    if (!s.meetLink) { log("Recall: Link do Google Meet vazio (Configurações)", "err"); return; }
    if (!s.avatarBaseUrl) { log('Camada 3: "URL pública do avatar" vazia. Publique no Lovable e cole a URL base em Configurações.', "err"); return; }
    if (botIdRef.current) { log(`Recall: bot já ativo (${botIdRef.current})`, "info"); return; }
    setBotJoining(true);
    const launchMode = s.meetLaunchMode;
    setBotStatus(`entrando (${launchMode})…`);
    avatarInMeetRef.current = true; // a página /meet fala por si; suprime fala local
    const outputMediaUrl = buildMeetUrl(s, s.meetDebug);
    log(`[CAMADA 3] Recall POST /bot/ (modo=${launchMode}) com output_media → ${s.avatarBaseUrl.replace(/\/+$/, "")}/meet`);
    try {
      const r: any = await callCreateBot({
        data: { apiKey: s.recallApiKey, meetingUrl: s.meetLink, botName: "Renante", outputMediaUrl },
      });
      log(`[CAMADA 3] Recall resposta HTTP ${r.status}\n${r.body}`, r.ok ? "ok" : "err");
      if (!r.ok || !r.bot?.id) {
        setBotStatus(`erro ${r.status}`);
        avatarInMeetRef.current = false;
        log(`[CAMADA 3] ⚠ Se o erro citar "output_media", o plano do Recall pode não ter o recurso habilitado. Camadas 1 e 2 continuam funcionando.`, "err");
        return;
      }
      const id = String(r.bot.id);
      setBotId(id);
      botIdRef.current = id;
      recallSeenCountRef.current = 0;
      setBotStatus(`avatar no Meet (${id.slice(0, 8)}…)`);
      log(`[CAMADA 3] ✅ Bot criado id=${id}. O avatar deve APARECER e FALAR dentro da reunião. Fala local suprimida (a página /meet responde por si).`, "ok");
    } catch (e) {
      logError("Recall createBot (avatar) falhou", e);
      setBotStatus("erro");
      avatarInMeetRef.current = false;
    } finally {
      setBotJoining(false);
    }
  }, [callCreateBot, log, logError]);

  // Abre a MESMA página /meet (com ?debug=1) no navegador do usuário, pra conferir
  // visualmente se o avatar carrega — diagnóstico da tela preta na Camada 3.
  const openAvatarPageTest = useCallback(() => {
    const s = settingsRef.current;
    if (!s.avatarBaseUrl) {
      log('Teste: "URL pública do avatar" vazia (Configurações).', "err");
      return;
    }
    const url = buildMeetUrl(s, true); // sempre com debug no teste visual
    log(`Teste: abrindo página do avatar (modo=${s.meetLaunchMode}) em nova aba (?debug=1)`);
    window.open(url, "_blank", "noopener");
  }, [log]);

  // Troca o modo de entrada no Meet IMEDIATAMENTE (salvo), pra o botão de entrar usar.
  const setLaunchModeNow = useCallback((m: Mode) => {
    setSettings((prev) => {
      const next = { ...prev, meetLaunchMode: m };
      settingsRef.current = next;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      }
      return next;
    });
    setSettingsDraft((d) => ({ ...d, meetLaunchMode: m }));
  }, []);

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
    avatarInMeetRef.current = false;
    setBotStatus("");
  }, [callLeaveBot, log, logError]);

  // Polling do transcript do Recall (CAMADA 2)
  useEffect(() => {
    if (!botId) return;
    // CAMADA 3: o avatar está DENTRO do Meet e a página /meet cuida da transcrição
    // pelo WebSocket do Recall. O polling local aqui é desnecessário (e ainda bate
    // num endpoint legado do Recall = HTTP 400 repetido). Então não roda nesse modo.
    if (avatarInMeetRef.current) {
      log("[CAMADA 3] polling local de transcript desativado (a página /meet usa o WebSocket do Recall).");
      return;
    }
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
              if (avatarInMeetRef.current) {
                log(`[CAMADA 3] transcript "${speaker}": "${text}" (a página /meet responde por si; fala local suprimida)`);
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
        <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <h1 className="flex items-center gap-2.5 text-xl font-semibold md:text-2xl">
              <span className="relative flex h-4 w-4">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-90" />
                <span className="relative inline-flex h-4 w-4 animate-pulse rounded-full bg-primary shadow-[0_0_10px_3px] shadow-primary/70" />
              </span>
              RenAnte Avatar AI
              <span className="ml-1 flex items-center gap-1.5 text-sm font-bold text-pink-500">
                by
                <GZeroLogo variant="white" imgClassName="h-4 w-auto md:h-5" />
              </span>
            </h1>
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

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
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

      <main className="mx-auto flex w-full max-w-[1800px] flex-col gap-4 p-3 sm:p-4 md:p-6 lg:p-8">
        {!speechSupported && settings.sttEngine !== "deepgram" && (
          <div className="rounded-md border border-destructive bg-card p-4 text-lg font-semibold text-destructive">
            Este navegador não tem reconhecimento de voz (Web Speech). Abra no Google Chrome no
            computador — ou troque a transcrição para <strong>Deepgram</strong> (funciona em
            todos os navegadores) no seletor abaixo / nas Configurações.
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
                poster={settings.posterUrl || undefined}
                className="h-full w-full object-cover"
              />
              {!connected && !settings.posterUrl && (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                  <span className="text-4xl">🎭</span>
                  <span className="text-sm">Avatar desconectado — clique em "Conectar avatar"</span>
                </div>
              )}
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
                disabled={!speechSupported && settings.sttEngine !== "deepgram"}
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
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium">Transcrição ao vivo</div>
                  <button
                    type="button"
                    onClick={toggleCaptions}
                    aria-pressed={settings.captionsEnabled}
                    title={settings.captionsEnabled ? "Desativar legendas" : "Ativar legendas"}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      settings.captionsEnabled
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {settings.captionsEnabled ? "💬 Legendas ON" : "💬 Legendas OFF"}
                  </button>
                </div>
                {settings.captionsEnabled && (
                  <div className="mt-2 min-h-16 rounded-md border border-border bg-background p-3 text-lg font-semibold">
                    {liveTranscript || text || "Fale algo para ver a transcrição aqui em tempo real."}
                  </div>
                )}
                {mode === "entrevistador" && !muted && interviewerWaiting && (
                  <div className="mt-2 flex items-center gap-2 rounded-md border border-status-ok bg-card px-3 py-2 text-sm font-medium text-status-ok">
                    <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-status-ok" />
                    🎧 Ouvindo… pode pausar pra pensar (só envio depois de{" "}
                    {settings.entrevistadorSilenceSec || ENTREVISTADOR_SILENCE_SEC_DEFAULT}s de silêncio)
                  </div>
                )}
                <div className="mt-2 text-sm text-muted-foreground">
                  {!speechSupported
                    ? "Sem suporte a voz"
                    : muted
                      ? "Mic desligado"
                      : avatarSpeaking
                        ? "Avatar falando"
                        : settings.meetConfigs[mode]?.behavior === "wake" && !meetingActive
                          ? 'Dormindo (diga "Renante")'
                          : settings.meetConfigs[mode]?.behavior === "wake" && meetingActive
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
            <div className="rounded-md border border-border bg-card p-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">Transcrição da voz</span>
                {!speechSupported && (
                  <span className="text-[10px] text-destructive">Web Speech indisponível neste navegador</span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  onClick={() => setSttEngine("webspeech")}
                  title="Reconhecimento do navegador (grátis, só Chrome/Edge)"
                  className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                    settings.sttEngine === "webspeech"
                      ? "bg-primary text-primary-foreground"
                      : "border border-border bg-card text-foreground hover:bg-muted"
                  }`}
                >
                  Web Speech
                  <span className="block text-[9px] font-normal opacity-80">Chrome/Edge · grátis</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSttEngine("deepgram")}
                  title="Deepgram (funciona em todos os navegadores; requer API key nas Configurações)"
                  className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                    settings.sttEngine === "deepgram"
                      ? "bg-primary text-primary-foreground"
                      : "border border-border bg-card text-foreground hover:bg-muted"
                  }`}
                >
                  Deepgram
                  <span className="block text-[9px] font-normal opacity-80">todos os navegadores</span>
                </button>
              </div>
              {settings.sttEngine === "deepgram" && (
                <span className="mt-1 block text-[10px] text-muted-foreground">
                  Usa a chave do Deepgram do servidor (.env / Vercel).
                </span>
              )}
            </div>

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

      {meetOpen && (() => {
        const modeLabel = MODES.find((m) => m.id === mode)?.label ?? mode;
        const mmss = (sec: number) =>
          `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
        const elapsed = callStartTs ? mmss(Math.max(0, (nowTs - callStartTs) / 1000)) : "00:00";
        const swapTotal = settings.hotSwapAfterSec || HOT_SWAP_AFTER_SEC_DEFAULT;
        const swapLeft =
          connected && sessionStartedAtRef.current
            ? Math.max(0, swapTotal - Math.floor((nowTs - sessionStartedAtRef.current) / 1000))
            : null;
        const sttEngineLabel = settings.sttEngine === "deepgram" ? "Deepgram" : "Web Speech";
        const sttTone: LedTone = muted
          ? "off"
          : micLastError
            ? "red"
            : listening
              ? "green"
              : "amber";
        const sttValue = muted ? "desligado" : micLastError ? "erro" : listening ? `ouvindo · ${sttEngineLabel}` : "iniciando";
        const n8nTone: LedTone =
          n8nStatus.state === "ok"
            ? "green"
            : n8nStatus.state === "err"
              ? "red"
              : n8nStatus.state === "waiting"
                ? "amber"
                : "off";
        return (
        <div className="fixed inset-0 z-40 select-none bg-black text-white">
          {/* Avatar feed em tela cheia (fundo) */}
          <video
            ref={meetVideoRef}
            autoPlay
            playsInline
            className="absolute inset-0 h-full w-full bg-black object-contain"
          />
          {/* Vignette p/ legibilidade dos painéis glass, sem cobrir o rosto */}
          <div
            className="pointer-events-none absolute inset-0 z-[1]"
            style={{
              background:
                "linear-gradient(90deg, rgba(0,0,0,.55) 0%, rgba(0,0,0,0) 22%, rgba(0,0,0,0) 74%, rgba(0,0,0,.6) 100%), linear-gradient(180deg, rgba(0,0,0,.5) 0%, rgba(0,0,0,0) 18%, rgba(0,0,0,0) 78%, rgba(0,0,0,.7) 100%)",
            }}
          />

          {/* ===== Top bar ===== */}
          <div className="absolute inset-x-0 top-0 z-20 flex h-14 items-center justify-between gap-3 px-4">
            <div className="flex items-center gap-3">
              <span className="flex items-baseline gap-2 text-sm">
                <span className="text-lg font-extrabold tracking-tight">
                  <span className="text-pink-500">G</span>Zero
                </span>
                <span className="text-white/40">·</span>
                <span className="font-semibold">Renante</span>
                <span className="text-white/40">·</span>
                <span className="text-white/80">{modeLabel}</span>
              </span>
              <span className="flex items-center gap-1.5 rounded-full border border-white/12 bg-white/5 px-2.5 py-1 font-mono text-[10px] text-white/75 backdrop-blur">
                <SessionLed tone={rtcToTone(webrtcState)} blink={rtcToTone(webrtcState) === "amber"} />
                WebRTC: {webrtcState}
              </span>
              <span className="rounded-full border border-white/12 bg-white/5 px-2.5 py-1 font-mono text-[10px] text-white/75 backdrop-blur">
                ⏱ {elapsed}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    mode === m.id ? "bg-white text-black" : "bg-white/10 text-white hover:bg-white/20"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* ===== Left: log técnico (glass, recolhível) — preenche até embaixo ===== */}
          <div
            className={`absolute left-3 top-16 z-20 flex w-[32vw] min-w-[260px] max-w-[440px] flex-col ${
              logCollapsed ? "" : "bottom-[150px]"
            }`}
          >
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/10 bg-[rgba(8,10,14,.82)] shadow-[0_8px_30px_rgba(0,0,0,.5)] backdrop-blur-md">
              <button
                onClick={() => setLogCollapsed((v) => !v)}
                className="flex w-full shrink-0 items-center justify-between px-3 py-2 text-left hover:bg-white/5"
              >
                <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-white/70">
                  {logCollapsed ? "▸" : "▾"} log
                </span>
                <span className="flex items-center gap-1.5 rounded-full bg-emerald-400/15 px-2 py-0.5 font-mono text-[9px] text-emerald-300">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> ao vivo
                </span>
              </button>
              {!logCollapsed && (
                <div className="min-h-0 flex-1 overflow-y-auto border-t border-white/10 px-3 py-2 font-mono text-[10px] leading-relaxed [scrollbar-color:rgba(255,255,255,.18)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-1.5">
                  {logs.length === 0 ? (
                    <div className="text-white/40">sem eventos ainda…</div>
                  ) : (
                    logs.slice(-200).map((entry, i) => {
                      const line = prettySessionLine(entry.msg);
                      return (
                      <div
                        key={`${entry.t}-${i}`}
                        className={`truncate ${
                          entry.kind === "err"
                            ? "text-red-300"
                            : entry.kind === "ok"
                              ? "text-emerald-300/90"
                              : "text-white/55"
                        }`}
                        title={line}
                      >
                        <span className="text-white/30">
                          {new Date(entry.t).toLocaleTimeString()}
                        </span>{" "}
                        {line}
                      </div>
                      );
                    })
                  )}
                  <div ref={meetLogEndRef} />
                </div>
              )}
            </div>
          </div>

          {/* ===== Right: sidebar técnica (glass) com logo, selo e LEDs reais ===== */}
          <aside className="absolute right-3 top-16 z-20 flex w-64 flex-col gap-3">
            <div className="rounded-xl border border-white/12 bg-[rgba(17,20,25,.64)] p-3 shadow-[0_8px_30px_rgba(0,0,0,.4)] backdrop-blur-md">
              {/* Header: logo GZero real (larga e baixa) preenchendo a largura + ALPHA */}
              <div className="relative mb-3">
                <SidebarLogo className="h-auto w-full object-contain" />
                <span className="absolute -bottom-1 right-0 rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase text-amber-300">
                  Alpha
                </span>
              </div>
              <div className="mb-2 flex items-center justify-between border-t border-white/10 pt-2">
                <span className="font-mono text-[10px] uppercase tracking-wider text-white/55">status</span>
                <span className="flex items-center gap-1.5 font-mono text-[9px] text-emerald-300">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> live
                </span>
              </div>
              <div className="divide-y divide-white/5">
                <StatusRow tone={rtcToTone(webrtcState)} name="WebRTC" value={webrtcState} blink={rtcToTone(webrtcState) === "amber"} />
                <StatusRow tone={kindToTone(statuses.session.state)} name="Sessão LiveAvatar" value={connected ? "conectada" : "—"} />
                <StatusRow tone={kindToTone(statuses.video.state)} name="Vídeo do avatar" value={avatarSpeaking ? "falando" : statuses.video.state === "ok" ? "recebendo" : "—"} />
                <StatusRow tone={muted ? "off" : kindToTone(statuses.microphone.state)} name="Microfone" value={micState} />
                <StatusRow tone={sttTone} name="Transcrição (STT)" value={sttValue} blink={sttTone === "amber"} />
                <StatusRow tone={n8nTone} name="Webhook n8n" value={n8nStatus.detail} blink={n8nTone === "amber"} />
                <StatusRow tone="green" name="Fallback (texto)" value="disponível" />
              </div>
              {/* Footer meta: hot-swap real; métricas não medidas = não expostas */}
              <div className="mt-2 grid grid-cols-3 gap-1 border-t border-white/10 pt-2 text-center font-mono text-[9px] text-white/50">
                <div>
                  <div className="text-white/30">hot-swap</div>
                  <div className="text-white/80">{swapLeft !== null ? `${swapLeft}s` : "—"}</div>
                </div>
                <div>
                  <div className="text-white/30">latência</div>
                  <div className="text-white/50">não exposta</div>
                </div>
                <div>
                  <div className="text-white/30">bitrate</div>
                  <div className="text-white/50">não exposto</div>
                </div>
              </div>
            </div>

            {/* Estado de voz (Reunião) — real (wake/dormindo) */}
            {mode === "reuniao" && (
              <div className="rounded-xl border border-white/12 bg-[rgba(17,20,25,.64)] p-3 shadow-[0_8px_30px_rgba(0,0,0,.4)] backdrop-blur-md">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-white/55">comandos de voz</span>
                  <span className={`flex items-center gap-1.5 font-mono text-[9px] ${meetingActive ? "text-emerald-300" : "text-white/50"}`}>
                    <SessionLed tone={meetingActive ? "green" : "off"} /> {meetingActive ? "ativo" : "dormindo"}
                  </span>
                </div>
                <div className="space-y-1 text-[10px] leading-snug text-white/60">
                  <div><span className="text-emerald-300/90">Ativar:</span> "oi Renante" / só o nome</div>
                  <div><span className="text-white/50">Desativar:</span> "tchau Renante" / "pode parar"</div>
                </div>
              </div>
            )}
          </aside>

          {/* Local camera PiP */}
          {camOn && (
            <div className="absolute bottom-[150px] right-3 z-20 h-28 w-44 overflow-hidden rounded-lg border border-white/20 bg-black shadow-xl md:h-32 md:w-52">
              <video
                ref={camVideoRef}
                autoPlay
                playsInline
                muted
                className="h-full w-full object-cover [transform:scaleX(-1)]"
              />
              <div className="absolute bottom-1 left-2 font-mono text-[10px] text-white/80">Você</div>
            </div>
          )}

          {camError && (
            <div className="absolute left-3 bottom-[150px] z-20 max-w-xs rounded-md border border-red-400/40 bg-red-500/15 px-3 py-2 text-xs text-red-200 backdrop-blur">
              Câmera indisponível: {camError}
            </div>
          )}

          {/* Legenda ao vivo */}
          {settings.captionsEnabled && (liveTranscript || micLastInterim) && (
            <div className="pointer-events-none absolute bottom-[150px] left-1/2 z-10 max-w-2xl -translate-x-1/2 rounded-md bg-black/60 px-4 py-2 text-center text-base text-white backdrop-blur">
              {liveTranscript || micLastInterim}
            </div>
          )}

          {/* ===== Barra de fallback por texto ===== */}
          <div className="absolute inset-x-0 bottom-[84px] z-20 px-4">
            <div className="mx-auto flex max-w-2xl items-center gap-2 rounded-xl border border-white/12 bg-[rgba(17,20,25,.64)] px-3 py-2 shadow-[0_8px_30px_rgba(0,0,0,.4)] backdrop-blur-md">
              <input
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setLiveTranscript(e.target.value);
                }}
                onKeyDown={(e) => { if (e.key === "Enter") void handleSend(); }}
                placeholder="Digite uma mensagem (fallback)…"
                className="min-w-0 flex-1 bg-transparent px-1 py-1 text-sm text-white placeholder:text-white/40 focus:outline-none"
              />
              <button
                onClick={() => void handleSend()}
                disabled={!connected || !text.trim()}
                className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-black disabled:opacity-40"
              >
                Enviar
              </button>
            </div>
          </div>

          {/* ===== Control bar ===== */}
          <div className="absolute inset-x-0 bottom-4 z-20 flex items-center justify-center gap-2.5 px-4">
            <button
              onClick={toggleMute}
              disabled={!speechSupported && settings.sttEngine !== "deepgram"}
              title={muted ? "Ativar microfone" : "Mutar microfone"}
              className={`flex h-12 w-12 items-center justify-center rounded-full border border-white/12 text-xl backdrop-blur transition-colors ${
                muted ? "bg-destructive text-destructive-foreground" : "bg-white/12 text-white hover:bg-white/25"
              } disabled:opacity-40`}
            >
              {muted ? "🎙️" : "🎤"}
            </button>
            <button
              onClick={toggleCamera}
              title={camOn ? "Desligar câmera" : "Ligar câmera"}
              className={`flex h-12 w-12 items-center justify-center rounded-full border border-white/12 text-xl backdrop-blur transition-colors ${
                camOn ? "bg-white/12 text-white hover:bg-white/25" : "bg-destructive text-destructive-foreground"
              }`}
            >
              {camOn ? "📹" : "📷"}
            </button>
            <button
              onClick={interruptAvatar}
              disabled={!connected}
              title="Interromper fala (espaço)"
              className="flex h-12 w-12 items-center justify-center rounded-full border border-white/12 bg-white/12 text-xl text-white backdrop-blur hover:bg-white/25 disabled:opacity-40"
            >
              ⏹
            </button>
            <button
              onClick={toggleCaptions}
              title={settings.captionsEnabled ? "Desativar legendas" : "Ativar legendas"}
              className={`flex h-12 w-12 items-center justify-center rounded-full border border-white/12 text-xl backdrop-blur transition-colors ${
                settings.captionsEnabled ? "bg-white/12 text-white hover:bg-white/25" : "bg-destructive text-destructive-foreground"
              }`}
            >
              💬
            </button>
            <button
              onClick={toggleFullscreen}
              title={isFullscreen ? "Sair de tela cheia" : "Tela cheia"}
              className="flex h-12 w-12 items-center justify-center rounded-full border border-white/12 bg-white/12 text-xl text-white backdrop-blur hover:bg-white/25"
            >
              {isFullscreen ? "🗗" : "⛶"}
            </button>
            <button
              onClick={() => setMeetOpen(false)}
              title="Minimizar"
              className="flex h-12 w-12 items-center justify-center rounded-full border border-white/12 bg-white/12 text-xl text-white backdrop-blur hover:bg-white/25"
            >
              ⤓
            </button>
            <button
              onClick={() => { void stopSession(); }}
              title="Encerrar sessão"
              className="ml-1 flex h-12 items-center justify-center gap-2 rounded-full bg-destructive px-5 text-sm font-semibold text-destructive-foreground hover:opacity-90"
            >
              ☎ Sair
            </button>
          </div>
        </div>
        );
      })()}



      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 p-4 backdrop-blur">
          <div className="my-4 flex max-h-[92vh] w-full max-w-3xl flex-col rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xl sm:my-8 sm:p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">⚙️ Configurações</h2>
              <button
                onClick={() => setSettingsOpen(false)}
                className="rounded-md border border-border px-3 py-1 text-sm hover:bg-muted"
              >
                Fechar
              </button>
            </div>

            {(() => {
              const req = (v: string) => (v ?? "").trim() !== "";
              const avatarOk = (["avatarId", "voiceId", "contextId", "language"] as (keyof Settings)[]).every(
                (k) => req(settingsDraft[k] as string),
              );
              const webhooksOk = (["webhookConversa", "webhookReuniao", "webhookEntrevistador", "webhookFiller"] as (keyof Settings)[]).every(
                (k) => req(settingsDraft[k] as string),
              );
              const tabs = [
                { id: "avatar" as const, label: "🎭 Avatar & Voz", ok: avatarOk },
                { id: "webhooks" as const, label: "🔗 Webhooks", ok: webhooksOk },
                { id: "modos" as const, label: "🎙️ Modos", ok: true },
                { id: "meet" as const, label: "📹 Google Meet", ok: true },
              ];
              return (
                <div className="mb-4 flex flex-wrap gap-2 border-b border-border pb-3">
                  {tabs.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setSettingsTab(t.id)}
                      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                        settingsTab === t.id
                          ? "bg-primary text-primary-foreground"
                          : "border border-border bg-card text-foreground hover:bg-muted"
                      }`}
                    >
                      <span className={`h-2 w-2 rounded-full ${t.ok ? "bg-status-ok" : "bg-destructive"}`} />
                      {t.label}
                    </button>
                  ))}
                </div>
              );
            })()}

            <div className="flex-1 space-y-5 overflow-y-auto pr-1">
              {settingsTab === "webhooks" && (
              <fieldset className="space-y-3">
                <legend className="text-sm font-semibold uppercase text-muted-foreground">
                  Webhooks n8n
                </legend>
                <p className="text-xs text-muted-foreground">
                  Endpoints do n8n para cada modo. Todos são obrigatórios para o app
                  funcionar corretamente.
                </p>
                {(
                  [
                    ["webhookConversa", "Webhook Conversa"],
                    ["webhookReuniao", "Webhook Reunião"],
                    ["webhookEntrevistador", "Webhook Entrevistador"],
                    ["webhookFiller", "Webhook Filler"],
                  ] as [keyof Settings, string][]
                ).map(([key, label]) => {
                  const missing = (settingsDraft[key] as string).trim() === "";
                  return (
                  <label key={key} className="block text-sm">
                    <span className="mb-1 flex items-center gap-1 font-medium">
                      {label} <span className="text-destructive">*</span>
                    </span>
                    <input
                      value={settingsDraft[key] as string}
                      onChange={(e) =>
                        setSettingsDraft((d) => ({ ...d, [key]: e.target.value }))
                      }
                      className={`w-full rounded-md border bg-input px-3 py-2 text-sm ${
                        missing ? "border-destructive ring-1 ring-destructive" : "border-border"
                      }`}
                    />
                    {missing && <span className="mt-1 block text-xs text-destructive">Obrigatório</span>}
                  </label>
                  );
                })}
              </fieldset>
              )}

              {settingsTab === "avatar" && (
              <fieldset className="space-y-3">
                <legend className="text-sm font-semibold uppercase text-muted-foreground">
                  Avatar & Voz (HeyGen LiveAvatar)
                </legend>
                <p className="text-xs text-muted-foreground">
                  Credenciais e identificadores do avatar. Campos com{" "}
                  <span className="text-destructive">*</span> são obrigatórios para conectar.
                </p>

                <div className="space-y-2 rounded-md border border-border bg-background/40 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase text-muted-foreground">
                      Puxar da API HeyGen
                    </span>
                    <button
                      type="button"
                      onClick={() => void loadAvatarVoiceLists()}
                      disabled={apiListLoading}
                      className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
                    >
                      {apiListLoading ? "Carregando…" : "🔄 Carregar avatares e vozes"}
                    </button>
                  </div>
                  {apiListError && (
                    <span className="block text-xs text-destructive">{apiListError}</span>
                  )}
                  {avatarOptions.length > 0 && (
                    <label className="block text-sm">
                      <span className="mb-1 block text-xs font-medium">Avatar</span>
                      <div className="flex items-center gap-2">
                        {(() => {
                          const sel = avatarOptions.find((o) => o.id === settingsDraft.avatarId);
                          return sel?.previewUrl ? (
                            <img
                              src={sel.previewUrl}
                              alt={sel.name}
                              className="h-12 w-12 shrink-0 rounded-md border border-border object-cover"
                            />
                          ) : null;
                        })()}
                        <select
                          value={settingsDraft.avatarId}
                          onChange={(e) => {
                            const opt = avatarOptions.find((o) => o.id === e.target.value);
                            setSettingsDraft((d) => ({
                              ...d,
                              avatarId: e.target.value,
                              posterUrl: opt?.previewUrl || d.posterUrl,
                              voiceId: opt?.defaultVoiceId || d.voiceId,
                            }));
                          }}
                          className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                        >
                          <option value="">— selecione —</option>
                          <optgroup label="Meus avatares">
                            {avatarOptions
                              .filter((o) => o.owned)
                              .map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.name}
                                </option>
                              ))}
                          </optgroup>
                          <optgroup label="Públicos">
                            {avatarOptions
                              .filter((o) => !o.owned)
                              .map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.name}
                                </option>
                              ))}
                          </optgroup>
                        </select>
                      </div>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        Ao escolher, preenche o ID do avatar, o preview e a voz padrão dele
                        automaticamente.
                      </span>
                    </label>
                  )}
                  {voiceOptions.length > 0 && (
                    <label className="block text-sm">
                      <span className="mb-1 block text-xs font-medium">Voz (presets da API)</span>
                      <select
                        value={settingsDraft.voiceId}
                        onChange={(e) =>
                          setSettingsDraft((d) => ({ ...d, voiceId: e.target.value }))
                        }
                        className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                      >
                        <option value="">— selecione —</option>
                        {voiceOptions.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                            {o.language ? ` (${o.language})` : ""}
                            {o.gender ? ` · ${o.gender}` : ""}
                          </option>
                        ))}
                      </select>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        ⚠️ A API só lista vozes em inglês. Para a voz em português (custom), use
                        o campo <strong>ID da Voz</strong> manual abaixo.
                      </span>
                    </label>
                  )}
                </div>

                {(
                  [
                    ["apiKey", "Chave da API HeyGen", "api_key", false],
                    ["avatarId", "ID do Avatar", "avatar_id", true],
                    ["voiceId", "ID da Voz", "voice_id", true],
                    ["contextId", "ID do Contexto/Persona", "context_id", true],
                    ["language", "Idioma", "language (ex: pt)", true],
                  ] as [keyof Settings, string, string, boolean][]
                ).map(([key, label, hint, required]) => {
                  const missing = required && (settingsDraft[key] as string).trim() === "";
                  return (
                  <label key={key} className="block text-sm">
                    <span className="mb-1 flex items-center gap-1 font-medium">
                      {label} {required && <span className="text-destructive">*</span>}
                      <span className="font-mono text-[10px] font-normal text-muted-foreground">({hint})</span>
                    </span>
                    <input
                      value={settingsDraft[key] as string}
                      onChange={(e) =>
                        setSettingsDraft((d) => ({ ...d, [key]: e.target.value }))
                      }
                      placeholder={key === "apiKey" ? "(usa a variável de ambiente do servidor)" : undefined}
                      className={`w-full rounded-md border bg-input px-3 py-2 font-mono text-xs ${
                        missing ? "border-destructive ring-1 ring-destructive" : "border-border"
                      }`}
                    />
                    {missing && <span className="mt-1 block text-xs text-destructive">Obrigatório</span>}
                    {key === "apiKey" && (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        Opcional: deixe vazio para usar a <strong>HEYGEN_API_KEY</strong> do
                        servidor (.env / Vercel). Preencha só para sobrescrever.
                      </span>
                    )}
                  </label>
                  );
                })}
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">
                    Imagem de preview do avatar (poster)
                  </span>
                  <input
                    value={settingsDraft.posterUrl}
                    onChange={(e) =>
                      setSettingsDraft((d) => ({ ...d, posterUrl: e.target.value }))
                    }
                    placeholder="https://.../preview.png"
                    className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                  />
                  <span className="mt-1 block text-xs text-muted-foreground">
                    URL de uma imagem mostrada no quadro de vídeo antes de conectar o avatar
                    (opcional). Deixe vazio para mostrar o placeholder padrão.
                  </span>
                  {settingsDraft.posterUrl && (
                    <img
                      src={settingsDraft.posterUrl}
                      alt="Preview do avatar"
                      className="mt-2 h-32 w-auto rounded-md border border-border object-cover"
                    />
                  )}
                </label>

                <label className="block text-sm">
                  <span className="mb-1 block font-medium">
                    Deepgram API Key (opcional — sobrescreve a do servidor)
                  </span>
                  <input
                    value={settingsDraft.deepgramApiKey}
                    onChange={(e) =>
                      setSettingsDraft((d) => ({ ...d, deepgramApiKey: e.target.value }))
                    }
                    placeholder="(usa a DEEPGRAM_API_KEY do servidor)"
                    className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-xs"
                  />
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Deixe vazio para usar a <strong>DEEPGRAM_API_KEY</strong> do servidor (.env /
                    Vercel) — recomendado. A key é usada no servidor pra gerar um token
                    temporário; o navegador nunca recebe a key crua.
                  </span>
                </label>
              </fieldset>
              )}

              {settingsTab === "modos" && (
              <fieldset className="space-y-4">
                <legend className="text-sm font-semibold uppercase text-muted-foreground">
                  Modos & Comportamento
                </legend>
                <p className="text-xs text-muted-foreground">
                  Cada modo tem sua própria saudação e comportamento. A <strong>fala inicial</strong>{" "}
                  vale tanto na tela principal (ao conectar o avatar) quanto dentro do Google Meet
                  (Camada 3). Clique em cada modo para expandir.
                </p>

                <Accordion
                  type="single"
                  collapsible
                  defaultValue={mode}
                  className="rounded-md border border-border px-3"
                >
                  {MODES.map((mm) => {
                    const c = settingsDraft.meetConfigs[mm.id];
                    const upd = (patch: Partial<MeetModeConfig>) =>
                      setSettingsDraft((d) => ({
                        ...d,
                        meetConfigs: {
                          ...d.meetConfigs,
                          [mm.id]: { ...d.meetConfigs[mm.id], ...patch },
                        },
                      }));
                    return (
                      <AccordionItem key={mm.id} value={mm.id} className="last:border-b-0">
                        <AccordionTrigger>
                          <span className="flex items-center gap-2">
                            <span className="font-semibold">{mm.label}</span>
                            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-normal text-muted-foreground">
                              {c.behavior === "always" ? "sempre ativo" : "wake word"}
                              {c.bargeIn ? " · barge-in" : ""}
                            </span>
                          </span>
                        </AccordionTrigger>
                        <AccordionContent className="space-y-3">
                          <label className="block text-sm">
                            <span className="mb-1 block text-xs font-medium">
                              Fala inicial (ao entrar / ao conectar)
                            </span>
                            <textarea
                              value={c.greeting}
                              onChange={(e) => upd({ greeting: e.target.value })}
                              rows={2}
                              placeholder="Deixe vazio para não falar nada ao entrar"
                              className="w-full resize-y rounded-md border border-border bg-input px-3 py-2 text-sm"
                            />
                          </label>
                          <label className="block text-sm">
                            <span className="mb-1 block text-xs font-medium">
                              Fala ao reconectar (hot-swap)
                            </span>
                            <textarea
                              value={c.reconnectGreeting}
                              onChange={(e) => upd({ reconnectGreeting: e.target.value })}
                              rows={2}
                              placeholder="Deixe vazio para não falar nada ao reconectar"
                              className="w-full resize-y rounded-md border border-border bg-input px-3 py-2 text-sm"
                            />
                            <span className="mt-1 block text-xs text-muted-foreground">
                              Dita quando a sessão é renovada automaticamente (a cada ciclo do
                              hot-swap). Diferente da fala inicial. Vazio = continua a conversa
                              sem falar nada.
                            </span>
                          </label>
                          <label className="block text-sm">
                            <span className="mb-1 block text-xs font-medium">Comportamento</span>
                            <select
                              value={c.behavior}
                              onChange={(e) =>
                                upd({ behavior: e.target.value === "always" ? "always" : "wake" })
                              }
                              className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                            >
                              <option value="wake">Só quando chamado pelo nome (wake word)</option>
                              <option value="always">Sempre ativo (responde tudo)</option>
                            </select>
                          </label>
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={c.bargeIn}
                              onChange={(e) => upd({ bargeIn: e.target.checked })}
                            />
                            Permitir interromper falando (barge-in)
                          </label>
                          {mm.id === "entrevistador" && (
                            <label className="block text-sm">
                              <span className="mb-1 block text-xs font-medium">
                                Tolerância de silêncio (segundos)
                              </span>
                              <input
                                type="number"
                                min={0.5}
                                step={0.5}
                                value={settingsDraft.entrevistadorSilenceSec}
                                onChange={(e) =>
                                  setSettingsDraft((d) => ({
                                    ...d,
                                    entrevistadorSilenceSec:
                                      Number(e.target.value) || ENTREVISTADOR_SILENCE_SEC_DEFAULT,
                                  }))
                                }
                                className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                              />
                              <span className="mt-1 block text-xs text-muted-foreground">
                                Quanto tempo de silêncio aguardar antes de considerar que a pessoa
                                terminou de responder (acumula as pausas pra pensar). Sugerido 2,5–3,5s.
                              </span>
                            </label>
                          )}
                        </AccordionContent>
                      </AccordionItem>
                    );
                  })}
                </Accordion>

                <div className="space-y-3 rounded-md border border-border bg-background/40 p-3">
                  <div className="text-xs font-semibold uppercase text-muted-foreground">
                    🔄 Reconexão automática (hot-swap)
                  </div>
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium">
                      Reconectar a cada (segundos)
                    </span>
                    <input
                      type="number"
                      min={HOT_SWAP_MIN_SEC}
                      step={5}
                      value={settingsDraft.hotSwapAfterSec}
                      onChange={(e) =>
                        setSettingsDraft((d) => ({
                          ...d,
                          hotSwapAfterSec: Number(e.target.value) || HOT_SWAP_AFTER_SEC_DEFAULT,
                        }))
                      }
                      className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                    />
                    <span className="mt-1 block text-xs text-muted-foreground">
                      De quanto em quanto tempo a sessão do HeyGen é renovada (pra driblar o
                      limite por sessão do plano — Starter = 5&nbsp;min). Use <strong>270</strong>{" "}
                      (4:30) em produção, com folga antes dos 5&nbsp;min. Mínimo {HOT_SWAP_MIN_SEC}s
                      (tempo de pré-aquecer a nova sessão). Vale ao (re)conectar o avatar.
                    </span>
                  </label>
                </div>

                <div className="space-y-3 rounded-md border border-border bg-background/40 p-3">
                  <div className="text-xs font-semibold uppercase text-muted-foreground">
                    Geral — dentro do Google Meet (Camada 3)
                  </div>
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium">Pausa antes de enviar (segundos)</span>
                    <input
                      type="number"
                      min={0.2}
                      step={0.1}
                      value={settingsDraft.meetSilenceSec}
                      onChange={(e) =>
                        setSettingsDraft((d) => ({
                          ...d,
                          meetSilenceSec: Number(e.target.value) || 0.5,
                        }))
                      }
                      className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                    />
                    <span className="mt-1 block text-xs text-muted-foreground">
                      No Meet ele acumula sua fala e só manda pro n8n após esse silêncio
                      (evita engolir/cortar). Vale pros 3 modos. Padrão 0,5s.
                    </span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={settingsDraft.meetDebug}
                      onChange={(e) =>
                        setSettingsDraft((d) => ({ ...d, meetDebug: e.target.checked }))
                      }
                    />
                    Modo diagnóstico no Meet (mostra status na câmera do bot)
                  </label>
                  <span className="block text-xs text-muted-foreground">
                    Use pra depurar: a câmera do Renante mostra se o WebSocket de transcrição
                    conectou e o que está chegando. Desligue na demo real.
                  </span>
                </div>
              </fieldset>
              )}

              {settingsTab === "meet" && (
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
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">
                    URL pública do avatar (Camada 3)
                  </span>
                  <input
                    value={settingsDraft.avatarBaseUrl}
                    onChange={(e) =>
                      setSettingsDraft((d) => ({ ...d, avatarBaseUrl: e.target.value }))
                    }
                    placeholder="https://seu-app.lovableproject.com"
                    className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                  />
                  <span className="mt-1 block text-xs text-muted-foreground">
                    URL base do app publicado (sem barra final). O bot do Recall vai
                    renderizar <code>{"<base>/meet"}</code> e transmitir o avatar para
                    dentro do Meet.
                  </span>
                </label>

                <p className="rounded-md border border-border bg-background/40 p-3 text-xs text-muted-foreground">
                  💡 A saudação e o comportamento de cada modo (fala inicial, wake word,
                  barge-in, pausas) agora ficam na aba <strong>🎙️ Modos</strong>. Aqui você só
                  configura a conexão com o Meet e entra na reunião.
                </p>
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <label className="flex items-center gap-2 text-sm">
                    <span className="font-medium">Entrar como:</span>
                    <select
                      value={settings.meetLaunchMode}
                      onChange={(e) => setLaunchModeNow(e.target.value as Mode)}
                      disabled={botJoining || !!botId}
                      className="rounded-md border border-border bg-input px-2 py-2 text-sm disabled:opacity-50"
                    >
                      {MODES.map((mm) => (
                        <option key={mm.id} value={mm.id}>
                          {mm.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => void joinMeetingWithAvatar()}
                    disabled={botJoining || !!botId}
                    title="Coloca o avatar Renante como participante (câmera + voz) dentro do Meet"
                    className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                  >
                    {botJoining ? "Entrando…" : botId ? "Avatar na reunião" : `Entrar na reunião (${settings.meetLaunchMode})`}
                  </button>
                  <button
                    type="button"
                    onClick={openAvatarPageTest}
                    title="Abre a página /meet no seu navegador (com logs) pra testar se o avatar carrega"
                    className="rounded-md border border-border px-4 py-2 text-sm"
                  >
                    🔍 Testar página do avatar
                  </button>
                  {botId && (
                    <button
                      type="button"
                      onClick={() => void leaveMeetingWithBot()}
                      className="rounded-md border border-border px-4 py-2 text-sm"
                    >
                      Remover bot
                    </button>
                  )}
                  {botStatus && (
                    <span className="text-xs text-muted-foreground">{botStatus}</span>
                  )}
                </div>
              </fieldset>
              )}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4">
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
              {lastSavedAt ? (
                <span
                  className={`text-sm font-medium ${
                    settingsSaved ? "text-status-ok" : "text-muted-foreground"
                  }`}
                >
                  {settingsSaved ? "✅ Salvo" : "Último salvamento"} em {lastSavedAt}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">Nenhuma alteração salva ainda</span>
              )}
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
