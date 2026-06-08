/* ============================================================
   dash-data.js — REAL data from the RenAnte Avatar AI app
   Source: live page + Configurações modal (Avatar&Voz, Webhooks,
   Modos, Google Meet). pt-BR.
   ============================================================ */
window.DASH = (function () {

  // ---- live status pillars (exact strings from the app) ----
  const status = [
    { id: 'token', nm: 'Token de sessão', sub: 'heygen', led: 'amber', blink: true, vl: 'aguardando “Conectar avatar”', cls: 'warn' },
    { id: 'sess',  nm: 'Sessão LiveAvatar', sub: 'realtime', led: 'off', blink: false, vl: 'não iniciada', cls: '' },
    { id: 'video', nm: 'Vídeo do avatar', sub: 'rtc.video', led: 'red', blink: true, vl: 'sem stream', cls: 'err' },
    { id: 'mic',   nm: 'Microfone', sub: 'getUserMedia', led: 'amber', blink: true, vl: 'detectando suporte do navegador', cls: 'warn' },
  ];

  // ---- config readiness (mirrors the 4 tab status dots) ----
  const ready = [
    { nm: 'Avatar & Voz', sub: 'heygen liveavatar', led: 'red', blink: true, vl: 'API key obrigatória', cls: 'err' },
    { nm: 'Webhooks n8n', sub: '4 endpoints', led: 'green', vl: '4 / 4 configurados', cls: 'ok' },
    { nm: 'Modos', sub: 'comportamento', led: 'green', vl: 'ok', cls: 'ok' },
    { nm: 'Recall', sub: 'camada 3 (opcional)', led: 'green', vl: 'opcional', cls: '' },
  ];

  // ---- live voice diagnostics (exact) ----
  const voice = [
    { nm: 'estado', vl: 'desligado', led: 'off' },
    { nm: 'parcial (interim)', vl: '—', led: 'off' },
    { nm: 'último FINAL', vl: '—', led: 'off' },
    { nm: 'último erro', vl: '—', led: 'off' },
  ];

  // ---- live WebRTC session stats (getStats — simulated while offline) ----
  const stats = [
    { id: 'lat', lab: 'Latência', unit: 'ms', base: 0, amp: 0, dec: 0, invert: true, idle: '—' },
    { id: 'jit', lab: 'Jitter', unit: 'ms', base: 0, amp: 0, dec: 0, invert: true, idle: '—' },
    { id: 'loss', lab: 'Perda', unit: '%', base: 0, amp: 0, dec: 1, invert: true, idle: '—' },
    { id: 'bit', lab: 'Bitrate', unit: 'kbps', base: 0, amp: 0, dec: 0, invert: false, idle: '0' },
    { id: 'fps', lab: 'FPS vídeo', unit: 'fps', base: 0, amp: 0, dec: 0, invert: false, idle: '0' },
    { id: 'ping', lab: 'Ping n8n', unit: 'ms', base: 42, amp: 16, dec: 0, invert: true },
  ];

  // ---- health radials ----
  const radials = [
    { id: 'sig', lab: 'Sinal', unit: '%', val: 0, max: 100, color: 'var(--red)' },
    { id: 'cfg', lab: 'Config', unit: '%', val: 75, max: 100, color: 'var(--accent)' },
    { id: 'buf', lab: 'Buffer', unit: 'ms', val: 0, max: 120, color: 'var(--blue)' },
  ];

  // ---- hot-swap + Meet "Camada 3" (real values) ----
  const session = { hotswap: 270, meetPause: 0.5, meetDiag: false };

  // ============================================================
  //  CONFIGURATION — exact fields & values from the modal
  // ============================================================

  // Tab 1 · Avatar & Voz (HeyGen LiveAvatar)
  const avatarVoz = {
    id: 'avatarvoz', cls: 'c-avatarvoz', icon: '🎭', title: 'Avatar & Voz', sub: 'HeyGen LiveAvatar',
    led: 'red', blink: true, badge: 'API KEY', badgeCls: 'err',
    note: 'Credenciais e identificadores do avatar. Campos com * são obrigatórios para conectar.',
    fields: [
      { k: 'api_key', t: 'pass', label: 'Chave da API HeyGen', hint: 'api_key', val: '', req: true, wide: true },
      { k: 'avatar_id', t: 'text', label: 'ID do Avatar', hint: 'avatar_id', val: 'f79bd86d-ec79-4ff6-85e9-2eee714eaa0e', req: true, wide: true },
      { k: 'voice_id', t: 'text', label: 'ID da Voz', hint: 'voice_id', val: 'ef51b5eb-5b39-4e6d-84e8-8b49a1b2e098', req: true, wide: true },
      { k: 'context_id', t: 'text', label: 'ID do Contexto / Persona', hint: 'context_id', val: '620eb98d-45ae-4a6c-9971-2c0915b4c279', req: true, wide: true },
      { k: 'language', t: 'text', label: 'Idioma', hint: 'ex: pt', val: 'pt', req: true },
      { k: 'poster', t: 'text', label: 'Preview do avatar (poster)', hint: 'url', val: '', ph: 'https://…/preview.png' },
    ],
  };

  // Tab 2 · Webhooks n8n
  const webhooks = {
    id: 'webhooks', cls: 'c-webhooks', icon: '🔗', title: 'Webhooks', sub: 'n8n',
    led: 'green', badge: '4 / 4',
    note: 'Endpoints do n8n para cada modo. Todos são obrigatórios para o app funcionar.',
    fields: [
      { k: 'wh_conversa', t: 'text', label: 'Webhook Conversa', val: 'https://n8n.srv1435894.hstgr.cloud/webhook/c32e3b52-1d99-483f-8da7-c2b2f981687b', req: true, wide: true, url: true },
      { k: 'wh_reuniao', t: 'text', label: 'Webhook Reunião', val: 'https://n8n.srv1435894.hstgr.cloud/webhook/renante-reuniao', req: true, wide: true, url: true },
      { k: 'wh_entrev', t: 'text', label: 'Webhook Entrevistador', val: 'https://n8n.srv1435894.hstgr.cloud/webhook/renante-entrevistador', req: true, wide: true, url: true },
      { k: 'wh_filler', t: 'text', label: 'Webhook Filler', val: 'https://n8n.srv1435894.hstgr.cloud/webhook/filler', req: true, wide: true, url: true },
    ],
  };

  // Tab 4 · Recall (Camada 3 — bot que entra no Google Meet)
  const recall = {
    id: 'recall', cls: 'c-recall', icon: '🤖', title: 'Recall', sub: 'Camada 3 · opcional',
    led: 'green', badge: 'OPCIONAL',
    note: 'Bot do Recall que renderiza <base>/meet e transmite o avatar para dentro do Google Meet. O link do Meet fica na Sessão do avatar.',
    fields: [
      { k: 'recall_key', t: 'pass', label: 'Recall API Key', val: '', wide: true },
      { k: 'public_url', t: 'text', label: 'URL pública do avatar (Camada 3)', hint: 'base', val: '', ph: 'https://seu-app.lovableproject.com', wide: true },
    ],
    status: { led: 'off', txt: 'bot ocioso · nenhuma reunião ativa' },
    footer: [
      { label: '🔍 Testar página do avatar', cls: '' },
    ],
  };

  // Tab 3 · Modos & Comportamento (real greetings + behavior)
  const comportamentos = ['Sempre ativo (responde tudo)', 'Só quando chamado pelo nome (wake word)'];
  const modos = {
    id: 'modos', cls: 'c-modos', icon: '🎛', title: 'Modos', sub: 'Comportamento',
    led: 'green', badge: '3 MODOS',
    note: 'Cada modo tem sua saudação e comportamento. A “fala inicial” vale na tela principal e dentro do Google Meet (Camada 3).',
    modes: [
      { id: 'conversa', name: 'Conversa', tag: 'sempre ativo', tagCls: '',
        fala: 'Olá! Eu sou o Renante, da Gravidade Zero. Podem falar comigo à vontade.',
        comportamento: 'Sempre ativo (responde tudo)', bargein: false },
      { id: 'reuniao', name: 'Reunião', tag: 'wake word', tagCls: 'blue',
        fala: 'Olá pessoal! Eu sou o Renante, da Gravidade Zero. É só me chamar pelo nome quando precisarem.',
        comportamento: 'Só quando chamado pelo nome (wake word)', bargein: false },
      { id: 'entrevistador', name: 'Entrevistador', tag: 'sempre ativo', tagCls: '',
        fala: 'Oi! Eu sou o Renante e vou conduzir essa conversa. Podem responder quando quiserem.',
        comportamento: 'Sempre ativo (responde tudo)', bargein: false, tolerancia: '3' },
    ],
  };

  const configGroups = [avatarVoz, webhooks, recall]; // modos rendered separately

  const modes = ['Conversa', 'Reunião', 'Entrevistador'];

  // main-screen controls (exact)
  const controls = [
    { label: 'Interromper (espaço)', ic: '⏹', cls: '' },
    { label: 'Testar avatar (falar “oi”)', ic: '🔊', cls: '' },
    { label: 'Testar microfone (5s)', ic: '🎤', cls: '' },
  ];

  // ---- log verboso (events reference the REAL config/flow) ----
  const log = [
    ['info', 'heygen: aguardando clique em “Conectar avatar”'],
    ['warn', 'config: Chave da API HeyGen ausente — conexão bloqueada'],
    ['debug', 'avatar_id=f79bd86d…eaa0e voice_id=ef51b5eb…2e098'],
    ['info', 'n8n: resolvendo endpoints dos webhooks…'],
    ['debug', 'n8n: webhook Conversa → /webhook/c32e3b52…687b'],
    ['debug', 'n8n: webhook Reunião → /webhook/renante-reuniao'],
    ['info', 'n8n: 4/4 webhooks ok (conversa, reuniao, entrevistador, filler)'],
    ['info', 'hot-swap: renovação de sessão agendada a cada 270s'],
    ['debug', 'modo ativo: Conversa · comportamento=sempre ativo'],
    ['debug', 'transcrição: WebSocket aguardando sessão do avatar'],
    ['warn', 'mic: detectando suporte do navegador…'],
    ['debug', 'meet camada 3: pausa antes de enviar = 0.5s'],
    ['info', 'filler: webhook /webhook/filler pronto'],
    ['todo', 'TODO: preencher Chave da API HeyGen para conectar'],
    ['err', 'heygen: conexão não iniciada (api_key ausente)'],
    ['debug', 'recall: Google Meet opcional — não configurado'],
    ['info', 'avatar: usando poster placeholder padrão'],
    ['debug', 'context_id=620eb98d…b4c279 language=pt'],
    ['warn', 'reuniao: comportamento=wake word — só responde ao nome'],
    ['info', 'entrevistador: tolerância de silêncio = 3.0s'],
    ['debug', 'hot-swap: próximo ciclo em T-270s (driblar limite 5min)'],
    ['info', 'sessão pronta — aguardando “Conectar avatar”'],
  ];

  // transcript empty-state (exact)
  const transcript = [
    { who: 'sys', txt: 'Fale algo para ver a transcrição aqui em tempo real.' },
  ];

  return { status, ready, voice, stats, radials, session, configGroups, modos, modes, controls, log, transcript };
})();
