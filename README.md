# RenAnte Avatar AI — by GZero

Avatar AI interativo em Português Brasileiro. O usuário fala via microfone → n8n processa a resposta → o avatar HeyGen fala de volta. Pensado para apresentações, reuniões e entrevistas ao vivo.

---

## Stack

| Camada | Tecnologia |
|---|---|
| Framework | TanStack Start (React 19 + TanStack Router + SSR) |
| Build | Vite 7 + Bun |
| Estilo | Tailwind CSS v4 + design system `.cr` customizado |
| Deploy | Vercel (SSR via Nitro) |
| Linguagem | TypeScript |

## Serviços externos

| Serviço | Papel |
|---|---|
| **HeyGen LiveAvatar SDK** | Sessão de vídeo do avatar em tempo real |
| **Deepgram** | STT alternativo ao Web Speech API (streaming, mais robusto) |
| **n8n** | Orquestrador de IA — recebe a fala, devolve a resposta do avatar |
| **Recall.ai** | Bot que entra no Google Meet como participante com câmera/microfone |

---

## Arquitetura

```
src/routes/
  index.tsx   → Camada 1/2: console do operador + sessão do avatar
  meet.tsx    → Camada 3: página pública renderizada pelo bot Recall.ai no Google Meet
```

**Camada 1/2 (`index.tsx`)** — painel de controle com layout bento livre (arraste/redimensione). Gerencia a sessão HeyGen, STT, hot-swap automático, modos de operação e envio de fala ao n8n.

**Camada 3 (`meet.tsx`)** — página `/meet` que o browser do Recall.ai abre na nuvem. Exibe o avatar e transcreve a fala dos participantes via Deepgram streaming. Age como a câmera do bot no Meet.

---

## Modos de operação

| Modo | Comportamento |
|---|---|
| **Conversa** | Sempre ativo — responde tudo |
| **Reunião** | Wake-word — só responde quando chamado pelo nome |
| **Entrevistador** | Acumula a fala completa e espera silêncio (tempo configurável) |

---

## Funcionalidades principais

- **Hot-swap** — reconecta a sessão HeyGen antes do limite de 5 min do plano Starter
- **Barge-in** — usuário pode interromper o avatar falando por cima
- **Filler** — resposta instantânea enquanto o n8n processa
- **STT duplo** — Web Speech API (padrão) ou Deepgram (fallback universal)
- **Acúmulo de fala** — espera silêncio antes de enviar ao n8n (evita fala picada)
- **Legendas ao vivo** — transcrição exibida na tela em tempo real
- **Canvas bento** — painéis livres, arrastáveis e redimensionáveis com persistência no `localStorage`

---

## Como rodar

```bash
bun install
bun dev
```

A app sobe em `http://localhost:3000`.

## Variáveis de ambiente

Crie um `.env` na raiz (ou configure no Vercel):

```env
HEYGEN_API_KEY=      # obrigatório — cria sessões do avatar
DEEPGRAM_API_KEY=    # opcional no cliente, obrigatório para Deepgram no servidor
RECALL_API_KEY=      # opcional — só necessário para o bot no Google Meet
```

---

## Estrutura de pastas relevante

```
src/
  routes/
    index.tsx         # App principal
    meet.tsx          # Página da Camada 3 (Recall.ai)
  lib/
    heygen.functions.ts   # Funções server-side: criar sessão, listar avatares/vozes
    deepgram.functions.ts # Token Deepgram temporário
    recall.functions.ts   # Gerencia bots no Meet
  styles.css              # Design system .cr (console) + tokens CSS
Avatar_claude_design/     # Protótipos HTML de referência do redesign
```
