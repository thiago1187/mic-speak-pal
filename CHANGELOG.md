# Changelog

## [Não lançado]

### 2026-06-21
- **Botão "Escuta ON/OFF":** único botão de controle de escuta no painel. Para a captura de áudio local (fecha Deepgram graciosamente + para Web Speech) sem interromper a transcrição já em andamento — a fala acumulada antes do corte ainda é enviada ao n8n normalmente.
- **Cortar escuta no Google Meet:** ao clicar "Escuta OFF" com o bot Recall.ai ativo, o estado é propagado para a página `/meet` via server function (`setMeetListenPaused`). A página `/meet` faz polling a cada 3s e para de processar novas transcrições do Recall.ai. Fala já no buffer continua e vai para o n8n.
- **Avatar no painel em modo Meet:** `joinMeetingWithAvatar` agora também chama `startSession()`, iniciando a sessão HeyGen localmente. O avatar aparece no painel da sessão e a escuta funciona igual ao modo local.
- **Botão "Remover avatar":** em modo Meet, o botão de desconexão passa de "Sair do Meet" para "Remover avatar" após conectar. `leaveMeetingWithBot` agora também encerra a sessão HeyGen local.
- **Fix:** `routeInterim` e `routeFinal` não bloqueiam mais o fluxo ao mutar — transcrição em andamento sempre vai para o n8n.

### 2026-06-19
- **Fix:** overlay da sessão (tela cheia do avatar) ficava atrás dos painéis do bento após arrastar/redimensionar — z-index elevado para `1000` para garantir que sempre fica na frente

### 2026-06-19
- **Painel Avatar & Voz:** adiciona campo `deepgramApiKey` + seção "Puxar da API HeyGen" com botão de carregamento, select de avatar (com preview de imagem) e select de voz
- **Painel Modos:** separa o campo `greeting` (fala na 1ª conexão) do `reconnectGreeting` (fala ao reconectar no hot-swap) — antes era um único campo
- **Painel Prontidão:** atualiza título para "Prontidão · 4 painéis", ícone ✓, e status com contadores exatos (ex: "3/4 configurados")
- Configura autor dos commits como `y-medeiros <yuritorresmedeiros@gmail.com>`

### 2026-06-19 — Redesign do console (bento livre)
- Migra layout do console para canvas bento com posicionamento absoluto
- Painéis arrastáveis (handle ⠿) e redimensionáveis (grips de canto/borda) com snap de grade
- Modo de edição: grade visível + grips habilitados; bloqueado por padrão
- Persistência de posição/tamanho no `localStorage` (`avatarConsole.freeform.v1`)
- Popover de configurações de canvas: tamanho da grade, snap, organizar e resetar
- Migra toda a configuração do modal "Configurações" para painéis inline:
  - **Painel Avatar & Voz** — credenciais HeyGen, avatar/voz/contexto/idioma/poster
  - **Painel Webhooks n8n** — 4 endpoints (Conversa/Reunião/Entrevistador/Filler)
  - **Painel Recall.ai** — API key e destino do Meet
  - **Painel Modos** — comportamento por modo + hot-swap
  - **Painel Prontidão** — status de configuração com LEDs e contadores
- 10 painéis no total no canvas

---

## 2026-06-09
- Atualiza `reconnectGreeting` padrão para todos os modos no hot-swap
- Atualiza `voiceId` padrão para `ca1b4b31-2951-4201-a697-297469c05baf`
- Atualiza site info para publicação

## 2026-06-08
- **Acúmulo de fala:** aguarda silêncio antes de enviar ao n8n (todos os modos)
- **Mute:** envia última fala ao n8n ao mutar (fecha Deepgram em 600ms)
- **Entrevistador:** silêncio padrão de 1s
- **Anti-duplicação:** rate limit de 1 `handleSend/seg` (≤2 chamadas/seg ao n8n)
- **Deepgram:** buffer das primeiras palavras + UI com logo destacada e overlay de erro removido
- **Deepgram:** não exige mais API key no cliente — usa `DEEPGRAM_API_KEY` do servidor
- **Diagnóstico:** log de variáveis de ambiente detectadas no servidor (HeyGen/Deepgram/Recall)
- **Tela de sessão:** estilo "live" com telemetria real + logo GZero na sidebar
- Integra transcrição Deepgram, seletor de avatares/vozes da API e chaves via `.env`

## 2026-06-07
- **Hot-swap:** reinício automático da sessão HeyGen preservando contexto no n8n
- UX da chamada e configuração: logo GZero, modo sapo, modos no site, status e salvamento
- UX: "Renante AI" + config em abas, layout responsivo, legendas toggle, preview e luzes animadas
- Define novo `avatar_id` padrão (`f79bd86d`)

## 2026-06-05
- Corrige `InvalidStateError` do `SpeechRecognition` (corrida `start/onstart`) sem poluir log
- Remove seletor Convidado/Renan — detecção migrou para o n8n

## 2026-06-04 — Camada 3: Recall.ai + modos
- **Camada 3 (`/meet`):** avatar fala dentro do Google Meet via Output Media do Recall.ai
- Transcrição via Deepgram streaming (PT rápido) substituindo a do Recall
- 3 modos (Conversa/Reunião/Entrevistador) com configuração própria e saudação
- **Entrevistador:** mic mais paciente com debounce de silêncio configurável
- Integra Recall.ai para bot no Meet (`src/routes/meet.tsx`)
- Diagnóstico de WebSocket de transcrição visível na câmera do bot (modo debug)
- Painel voz no Meet, overlay Meet, aba Diagnóstico, aba Configurações, mic contínuo + interrupt
- Fix: corrige 404 no Vercel (`serverDir __server.func`)
- Fix: só ativa Nitro quando `NITRO_PRESET` está setado
- Deploy Vercel: preset via `NITRO_PRESET` + `vercel.json`

## 2026-06-03 — Fundação
- Cria app HeyGen Avatar (sessão, microfone, envio ao n8n)
- Adiciona status, logs e testes
- Inicializa projeto com template TanStack Start TypeScript
