# Tarefas

## Em andamento

### Redesign do console — migração completa para painéis inline
Todos os painéis do redesign (`Avatar_claude_design/`) estão implementados. A janela modal "Configurações" ainda existe como fallback mas toda configuração já está acessível nos painéis do canvas.

**Status dos painéis:**
- [x] Sessão do avatar (conectar, modo, destino, microfone, mute mic, cortar escuta)
- [x] Log verboso
- [x] Status da sessão
- [x] Hot-swap (anel de contagem regressiva)
- [x] Diagnóstico de voz
- [x] Modos (Conversa / Reunião / Entrevistador) — com `greeting` e `reconnectGreeting` separados
- [x] Avatar & Voz (credenciais HeyGen, puxar da API, deepgramApiKey)
- [x] Webhooks n8n
- [x] Recall.ai
- [x] Prontidão da config (LEDs com contadores exatos)

---

## Backlog

### Console
- [ ] Remover ou ocultar o modal "Configurações" antigo (já substituído pelos painéis inline)
- [ ] Implementar "Organizar" (shelf auto-pack) e "Padrão" (reset do layout) no popover do canvas
- [ ] Testar comportamento do canvas em telas menores / touch

### Tela de sessão (`meet.tsx` — Camada 3)
- [ ] Implementar tela de sessão "live" baseada no `Avatar Session.html` do redesign (dark, full-bleed, barra de controles estilo Meet)

### Qualidade
- [ ] Adicionar testes para os hooks de sessão HeyGen e hot-swap
- [ ] Revisar tratamento de erro quando a API HeyGen retorna status != 200

---

## Concluído

- [x] Mute suave do microfone (mantém pipeline STT ativo, ignora resultados)
- [x] Cortar escuta do avatar (hard-stop do STT, botão separado no painel da sessão)
- [x] Bento livre com drag/resize + persistência no localStorage
- [x] Migração de toda a config do modal para painéis inline
- [x] Hot-swap automático (reconexão antes de 5 min)
- [x] STT duplo: Web Speech API + Deepgram streaming
- [x] Acúmulo de fala (aguarda silêncio antes de enviar)
- [x] Barge-in (interromper o avatar falando por cima)
- [x] Filler (resposta instantânea enquanto n8n processa)
- [x] 3 modos de operação com configuração por modo
- [x] Camada 3: bot Recall.ai no Google Meet
- [x] Deploy no Vercel (SSR via Nitro)
