# Handoff: RenAnte Avatar AI — Console & Live Session

## Overview
Two screens for **RenAnte Avatar AI**, a diagnostic + control surface for a HeyGen LiveAvatar / n8n pipeline (pt-BR UI):

1. **Avatar Console** (`Avatar Console.html`) — a light-themed engineering dashboard ("console de diagnóstico"). Real diagnostic panels (session status, verbose log, config readiness, hot-swap, voice/STT, device tests, modes) laid out on a **free-form, draggable canvas** with a Settings popover that gates an edit mode.
2. **Avatar Live Session** (`Avatar Session.html`) — a dark, full-bleed "in-call" screen: avatar video feed, live SDK event log, status sidebar, fallback message bar, and a Google-Meet-style control bar.

The two screens are linked: the **Sair** (leave) button on the Session screen navigates back to `Avatar Console.html`.

## About the Design Files
The files in this bundle are **design references created in HTML/CSS/vanilla JS** — prototypes that demonstrate the intended look, layout, and behavior. They are **not** production code to ship as-is.

The task is to **recreate these screens inside the target codebase** using its established stack and conventions (React/Vue/Svelte/etc., its component library, its state and data-fetching patterns). If no front-end environment exists yet, pick the most appropriate framework for the project and implement there. Treat the HTML/CSS as the source of truth for **visuals and interaction**, and wire the data to the real HeyGen SDK / n8n webhooks / WebRTC stats in place of the mocked values.

## Fidelity
**High-fidelity (hifi).** Final colors, typography, spacing, and interactions are all specified here and in the CSS. Recreate pixel-for-pixel using the codebase's libraries, then replace mock data with live data.

---

## Design Tokens

Both screens use **IBM Plex Sans** (UI) and **IBM Plex Mono** (data/log/labels), loaded from Google Fonts (weights 400/500/600).

### Console (light theme) — from `dash.css :root`
| Token | Value | Use |
|---|---|---|
| `--bg` | `#e9ebef` | app background |
| `--panel` | `#ffffff` | panel surface |
| `--panel-2` | `#f6f7f9` | inset / secondary surface |
| `--head` | `#fbfcfd` | panel header bar |
| `--border` | `#e3e6ea` | hairline borders |
| `--border-2` | `#d4d9df` | stronger borders |
| `--ink` | `#1a1f27` | primary text |
| `--ink-2` | `#586170` | secondary text |
| `--ink-3` | `#8b94a0` | tertiary / labels |
| `--accent` | `#cf7a1f` | amber — dev / caution accent |
| `--accent-ink` | `#90520c` | accent text |
| `--accent-bg` | `#fbf1e3` | accent fill |
| `--blue` | `#2f62d8` / `--blue-bg` `#ecf1fd` | info |
| `--green` | `#1f9d63` / `--green-bg` `#e7f5ee` | ok |
| `--amber` | `#c9971a` | warn |
| `--red` | `#d8463c` / `--red-bg` `#fbecea` | error |
| `--off` | `#c2c8d0` | inactive LED |
| `--shadow` | `0 1px 2px rgba(16,24,40,.05), 0 1px 3px rgba(16,24,40,.04)` | panel shadow |
| `--r` | `8px` | panel radius |
| `--cell` | `20px` (configurable 8–48) | canvas grid / snap step |
| `--grid-line` | `rgba(90,103,122,.12)` | minor grid line |
| `--grid-line-strong` | `rgba(90,103,122,.22)` | every-5th grid line |

Base body font-size: **13px**. Custom scrollbars (11px, `#c7ccd3` thumb).

### Session (dark theme) — from inline `:root` in `Avatar Session.html`
| Token | Value |
|---|---|
| `--bg` | `#0a0c0f` (page is pure `#000` behind it) |
| `--panel` | `rgba(17,20,25,.64)` (glass, `backdrop-filter: blur(8–10px)`) |
| `--panel-2` | `rgba(30,34,41,.7)` |
| `--border` | `rgba(255,255,255,.12)` |
| `--border-2` | `rgba(255,255,255,.18)` |
| `--ink` / `--ink-2` / `--ink-3` | `#eef1f5` / `#aeb6c1` / `#7b838f` |
| `--green` | `#22c55e` · `--amber` `#f5b133` · `--red` `#ea4335` · `--blue` `#3b82f6` |
| `--accent` | `#cf7a1f` (shared with Console) |

Radius: panels `12px`, control buttons `50%` (round) / `25px` (pill leave button). Glass panels use `box-shadow: 0 8px 30px rgba(0,0,0,.4)`.

---

## Screen 1 — Avatar Console (`Avatar Console.html`)

### Purpose
Operator's pre-flight / diagnostic dashboard. Surfaces the live state of every part of the avatar pipeline and lets the operator arrange the panels into a personal layout.

### Page chrome (fixed, top to bottom)
- **Dev strip** (`.devbar`, height 30px, dark `#1c2128`, mono 11px): build/commit/branch/env chips + node/sdk versions. A pulsing amber dot + "EM DESENVOLVIMENTO".
- **Top bar** (`.topbar`): brand lockup (🎭 mark + "RenAnte **Avatar** AI" / "console de diagnóstico · by GZero"), a WebRTC status pill, and right-aligned actions. **Right actions order: `⚙ Configurações` then `🩺 Diagnóstico`.**
- **Bento canvas** (`#bento`): the panel workspace (see Layout Engine below).

### Panels (12)
Each panel is a `.panel` = header (`.ph`) + body (`.pb`). Header = optional LED, icon chip (`.ico`, 20×20, rounded 5px), mono uppercase title (`.tt`, 11px, letter-spacing .06em) with a lighter `<small>` subtitle, optional badge, optional right-side controls. Body padding 12px (or `flush` for the log).

Panels and their stable ids (the `c-*` class → `data-pid`):
1. **Sessão do avatar** (`c-avatar`) — video preview tile ("AVATAR DESCONECTADO" placeholder, 720×540), mode select, session destination segmented control (Local / Google Meet), device toggles (Câmera/Microfone), primary **Conectar avatar** button + Testar/Interromper, status line, message composer. Badge: `OFFLINE`.
2. **Log verboso** (`c-log`, flush) — filter input + level chips (INFO/WARN/ERR/DEBUG) + pause; streaming mono log feed; footer with line count/rate/level/buffer + blinking cursor. Badge: `AO VIVO`.
3. **Status da sessão** (`c-status`) — LED rows from `DASH.status`.
4. **Prontidão da config** (`c-ready`) — LED rows from `DASH.ready` (4 config tabs).
5. **Hot-swap** (`c-hotswap`) — circular SVG countdown ring, "renova a sessão a cada 270s". Badge: `T-270s`.
6. **Diagnóstico de voz** (`c-voice`) — STT state rows + live transcription block. Badge: `DIAG`.
7. **Teste de transcrição** (`c-trans`) — WebSocket STT tester: start/stop, VU meter, interim/FINAL output. Badge: `STT`.
8. **Teste de dispositivos** (`c-devices`) — camera + mic test with device selects + permission line. Badge: `MÍDIA`.
9. Plus the **Modos** panel and any others appended in `dash.js` `buildBento()`.

> Exact strings/values for all status rows live in `dash-data.js` (`window.DASH`). Use them verbatim — they mirror the real app (pt-BR).

### LEDs / badges
- LED = 9px dot. Classes map to tokens: green=`--green`, amber=`--amber`, red=`--red`, off=`--off`. `blink` class = 1.4s ease-in-out opacity pulse, staggered by `animationDelay`.
- Badge = mono 9.5px uppercase, rounded 4px, hairline border. Variants `.wip` (amber), `.beta` (blue).

### Layout Engine (the core of this screen) — `reorder.js`
The bento is a **free-form absolute-positioned canvas**, not a CSS grid. This was a deliberate change so panel heights are **independent** (resizing one panel never reflows its neighbors).

**Behavior:**
- On first load, panel positions are **seeded** from a default grid render, then each panel becomes `position:absolute` with explicit `left/top/width/height`.
- **Snap grid:** positions/sizes snap to a configurable cell (`--cell`, default 20px, range 8–48px). Min panel size = `max(180, 6·cell)` wide × `max(96, 4·cell)` tall.
- **Edit mode (off by default):**
  - When **off**: panels are locked — no move, no resize; grips/handles hidden; the grid background is **invisible** (canvas background + border are transparent).
  - When **on**: the snap-grid background becomes visible (minor lines `--grid-line`, every-5th line `--grid-strong`); each panel shows a **⠿ move handle** (inserted as first child of `.ph`), a **right-edge grip** (width only), a **bottom-edge grip** (height only), and a **corner grip** (both axes). A dashed "ghost" previews the snapped landing rect while dragging.
- **Settings popover** (opened by the top-bar `⚙ Configurações` button; `.setpop`, 248px, anchored below the button with a little caret): 
  - **Entrar / Sair do modo de edição** toggle (primary accent button).
  - **Tamanho da grade** slider (8–48px, live value) — dimmed/disabled until edit mode is on.
  - **Encaixar painéis** snap toggle.
  - **Organizar** (shelf auto-pack) / **Padrão** (reset to seeded grid layout) actions.
  - Contextual hint line.
  - Closes on outside-click or `Esc`.
- **Persistence:** all of `{ rects, cell, snap, edit }` is saved to `localStorage` under key **`avatarConsole.freeform.v1`** on every change, and restored on load. Newly added panels without a saved rect are auto-seeded. Canvas height auto-grows to fit the lowest panel + 2 cells.

**Public hooks exposed on `window`:** `resetBentoLayout()`, `packBentoLayout()`.

### Other interactions
- `dash.js` also builds a separate **Ajustes** dock (bottom-right `.tweaks`) — a collapsible tweak panel (speed/accent/density). This is a prototype affordance; in production, fold these into your real settings if relevant, or drop it.
- Log feed streams mocked lines on a timer — replace with the real SDK event stream.

### State needed (Console)
- `editMode: boolean`, `cellSize: number (8–48)`, `snap: boolean`
- `layout: Record<panelId, {x,y,w,h}>` (persisted)
- Live data sources to replace mocks: session/token status, config readiness, WebRTC stats, STT interim/final, device enumeration, hot-swap countdown, log event stream.

---

## Screen 2 — Avatar Live Session (`Avatar Session.html`)

### Purpose
The live "on-call" view once the avatar is connected — what the operator watches during a running session.

### Layout (all absolutely positioned over a full-bleed feed)
- **Background stack:** `.fallbg` (radial gradient fallback) → `.avatarbg` (the avatar video; mocked here with `assets/avatar-frame.png`, `center 18% / cover`) → `.vignette` (left/right + top/bottom darkening gradients for legibility). In production, `.avatarbg` is the live WebRTC `<video>` track.
- **Top bar** (`.topbar`, 54px): who lockup (🎭 "Renante · {mode}"), WebRTC pill (`connected`, green glowing dot), running clock `mm:ss`, and a mode **pills** group on the right (Conversa / **Reunião** / Entrevistador; active pill = white fill).
- **Left log** (`.leftlog`, glass, 32vw, max 470 / min 280px): collapsible header ("log", live SDK badge) + mono feed of `avatar.transcription.chunk`, `avatar.state`, rtc `stats`, and n8n `webhook` events. Lines color-coded (`.ek` event key blue/amber, `.txt` green; `.warn`/`.err`/`.user` variants). New lines flash amber. Auto-trims to 80 lines, auto-scrolls.
- **Right status** (`.rightstatus`, glass, 264px): "status / ● LIVE" header + rows (Sessão LiveAvatar, Vídeo do avatar, Microfone, Transcrição, Webhook n8n) each with LED + name + mono subtitle + value; footer meta `lat / bitrate / hot-swap` with live hot-swap countdown.
- **GZero watermark** (`.gz`, rotated −6°, accent "Z").
- **Message fallback bar** (`.msgbar`, bottom ~86px): glass text input + Send (typed messages append to the log as `chat.message`).
- **Meet control bar** (`.controls`, bottom 18px, centered): round 50px glass buttons — **mic** (starts muted/red), **camera** (starts off/red), **present** (toggle blue), **chat**, **fullscreen** (real Fullscreen API), **raise hand**, a divider, then a red pill **Sair** (→ navigates to `Avatar Console.html`). Each button has a hover tooltip via `data-tip`. SVG icons are inline (1.8px stroke, round caps).

### Interactions (Session)
- Clock + hot-swap countdown tick every 1s.
- Mode pills: single-select, update the "· {mode}" label.
- Mic/Camera buttons: toggle `danger` (red) state + swap icon + tooltip.
- Present: toggles `active` (blue).
- Fullscreen: `requestFullscreen` / `exitFullscreen`.
- Send / Enter: append a `user fallback` line to the log.
- All log/status values are **mocked** — wire to the real SDK agent events, RTC stats, and n8n webhook responses.

### State needed (Session)
- `mode`, `micOn`, `camOn`, `presenting`, `elapsed`, `hotSwapRemaining`
- log buffer (cap 80), status rows, RTC stats (rtt/fps/bitrate), connection state.

---

## Assets
- `assets/avatar-frame.png` — placeholder still used for the Session avatar feed. **Replace** with the live avatar video track in production.
- Brand marks (🎭) and the "GZero" wordmark are rendered with text/emoji + CSS, not image assets.
- All icons are inline SVG (Session controls) or unicode glyphs (Console). No icon-font dependency.
- Fonts: IBM Plex Sans + IBM Plex Mono via Google Fonts.

## Files in this bundle
| File | Role |
|---|---|
| `Avatar Console.html` | Console screen markup + font/CSS/JS includes |
| `dash.css` | Console styles + design tokens (`:root`) |
| `dash-data.js` | `window.DASH` — exact pt-BR status/config/voice strings (real app data) |
| `dash.js` | Builds the 12 bento panels, log stream, Ajustes dock |
| `reorder.js` | Free-form canvas layout engine: edit mode, snap grid, move/resize, Settings popover, persistence |
| `Avatar Session.html` | Live session screen — fully self-contained (inline CSS + JS) |
| `assets/avatar-frame.png` | Placeholder avatar feed still |

### Load order (Console)
`dash-data.js` → `dash.js` → `reorder.js` (reorder runs after panels are mounted). Fonts + `dash.css` in `<head>`.

## Notes for implementation
- Keep panel `data-pid`s stable (`c-*` ids) — the saved layout keys off them.
- The grid is **invisible except in edit mode** by design; don't render grid lines in the default/locked view.
- Locked is the default state — a fresh user cannot accidentally move panels.
- Persisted layout key: `avatarConsole.freeform.v1`. Bump the suffix if your panel set changes incompatibly.
- pt-BR copy throughout — preserve exact strings (see `dash-data.js`).
