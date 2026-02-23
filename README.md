# AccessAI — Universal Accessibility Browser Extension

An AI-powered Chrome extension providing three real-time intelligent tools built on OpenAI's GPT-4o, Whisper, Realtime API, and TTS — all surfaced through a unified sidebar that works on any website.

---

## Modes at a Glance

| Mode | What it does |
|------|-------------|
| **Social Cue Coach** | Passively observes live conversations and whispers real-time social intelligence |
| **Web-Sight Navigator** | Voice-controlled agentic browser automation — speak a goal, AI handles the clicks |
| **ClearContext** | Watches your screen + listens to your lecture/video and auto-builds AI knowledge cards |

---

## Project Structure

```
BrowserExtension/
├── extension/                     # Chrome Extension. (Manifest v3)
│   ├── manifest.json
│   ├── background.js              # Service worker & API gateway
│   ├── content-scripts/
│   │   ├── sidebar.js             # Unified sidebar UI shell
│   │   ├── social-cue.js          # Social Cue Coach
│   │   ├── web-sight.js           # Web-Sight Navigator
│   │   └── clear-context.js       # ClearContext v5 — Intelligent Card Engine
│   ├── styles/
│   │   └── sidebar.css
│   └── icons/
├── proxy-server/                  # Optional secure Node.js API proxy
│   ├── server.js
│   ├── package.json
│   ├── .env.example
│   └── .gitignore
└── generate-icons.js              # Icon generation utility
```

---

## Prerequisites

- Google Chrome (or any Chromium-based browser)
- An [OpenAI API key](https://platform.openai.com/api-keys) with access to GPT-4o, Whisper, TTS, and the Realtime API
- Node.js 14+ _(only required if using the optional proxy server)_

---

## Quick Start (Direct API Key Mode)

The simplest setup — your API key lives inside the extension itself.

> **Note:** This embeds your key in browser memory. Use the proxy server for a more secure setup.

### 1. Add your API key

Open `extension/background.js` and set your key:

```js
const OPENAI_API_KEY = 'sk-your-key-here';
```

### 2. Load the extension

1. Navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked** and select the `extension/` folder

### 3. Use the extension

- Click the AccessAI toolbar icon **or** press `Alt+A` on any page
- Switch between modes using the tab bar in the sidebar
- Click the animated orb in any mode to start a session

---

## Optional: Proxy Server (Recommended for Production)

The proxy server keeps your OpenAI API key on a backend. It also adds rate limiting and CORS enforcement.

### 1. Install dependencies

```bash
cd proxy-server
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
OPENAI_API_KEY=sk-your-key-here
PORT=3001
ALLOWED_ORIGINS=chrome-extension://your-extension-id-here
```

Find your extension ID at `chrome://extensions/` after loading.

### 3. Start the server

```bash
npm start
```

```
AccessAI proxy running on port 3001
HTTP:      http://localhost:3001
WebSocket: ws://localhost:3001/api/realtime
```

Verify:

```bash
curl http://localhost:3001/health
# {"status":"healthy"}
```

### 4. Point the extension at the proxy

Update `extension/background.js` to route requests through `http://localhost:3001/api/openai` (HTTP) and `ws://localhost:3001/api/realtime` (WebSocket), leaving `OPENAI_API_KEY` empty in the extension file.

### Production deployment

Deploy `proxy-server/` to any Node.js host (Render, Railway, Fly.io, etc.). Set environment variables on the platform and update the endpoint constants in the extension to use `https://` and `wss://` URLs.

---

## Extension Modes — Detailed

---

### Social Cue Coach

A silent observer that surfaces real-time social intelligence during conversations and meetings.

**How it works:**
- Connects to the OpenAI Realtime API via WebSocket
- Passively listens to live audio without participating in the conversation
- Generates brief 3–7 word insights tagged as one of three types:
  - `Insight:` — observations about group dynamics or subtext
  - `Action:` — suggested next moves for the user
  - `Vibe:` — overall emotional temperature of the conversation
- Insights are spoken quietly via Chrome's native TTS and shown in a live feed panel

**Key behaviours:**
- Observation only — does not speak into the conversation
- Continuous session until manually stopped
- Low-latency responses via the Realtime WebSocket

---

### Web-Sight Navigator

A hands-free, voice-controlled browser agent powered by GPT-4o function calling and semantic page understanding.

**How it works:**
- Speak a natural language goal (e.g. "Find machine learning courses on this site")
- GPT-4o plans a multi-step sequence of browser actions to fulfil the goal
- Executes up to 18 steps autonomously, re-reading the page between steps
- Falls back to typed commands if voice input is unavailable

**Available browser actions:**

| Action | What it does |
|--------|-------------|
| `click` | Clicks any element by CSS selector |
| `type` | Types text into an input field |
| `navigate` | Goes to a URL |
| `scroll` | Scrolls the page or an element |
| `read_page` | Reads visible text content (3000 char limit) |
| `find_elements` | Finds elements matching a description |
| `press_key` | Presses a keyboard key |
| `select_option` | Selects a dropdown option |

**Semantic search intelligence:**
- Before searching, the agent reads the page and navigation to understand the site's own vocabulary
- Never types literal user words into a search on a specialised site — it maps the intent to the site's taxonomy (e.g. user says "business courses", site calls it "Business Administration", agent searches the site's term)
- Prefers clicking nav links over searching when possible

**Safety:**
- Actions containing "buy", "checkout", or "pay" require explicit voice confirmation before proceeding

---

### ClearContext — Intelligent Topic Card Engine

ClearContext watches your screen and listens to your lecture or video, then uses AI to automatically build structured, markdown-rich knowledge cards organised into named workspaces.

**Pipeline:**
1. You share your screen or a browser tab — both audio and video are captured
2. Audio is split into 8-second chunks and transcribed by **OpenAI Whisper**
3. Every 3 transcripts, **GPT-4o Vision** analyses the rolling transcript *alongside a live screenshot* of your screen
4. AI decides whether to create a new card, update an existing one, or skip
5. Cards are immediately saved to Chrome storage under your workspace name

**No microphone required** — only system/tab audio is used.

---

#### Workspace Management

- **Named workspaces** — give each session a name (e.g. `CS101`, `CrewAI Deep Dive`) before starting; all cards are saved under that name
- **Workspace dropdown** — a dropdown on the hero screen lists all previously saved workspaces; select any to resume it instantly
- **New workspace input** — selecting "＋ New workspace…" shows a text field; the Start button stays disabled until a name is entered (prevents accidental unnamed sessions)
- **Persistent storage** — workspaces and all cards survive page reloads and browser restarts via `chrome.storage.local`

---

#### Live Tab

- **Real-time transcript stream** — every Whisper-transcribed chunk appears timestamped as it arrives
- **Processing indicators** — animated status lines show `⟳ Transcribing…` and `🧠 AI analysing content…` as they happen
- **Vision confirmation** — on session start, the Live tab confirms whether screenshot capture is active

---

#### AI Card Engine

Cards are generated by GPT-4o with a screen screenshot attached to every analysis call — not just audio.

| AI decision | When it happens |
|-------------|----------------|
| **New card** | A new concept, tool, library, person, or project is introduced |
| **Code card** | Code is visible on screen — extracted verbatim with a fenced code block and explanation |
| **Table card** | A data schema or table is visible — rendered as a markdown table |
| **Update card** | More detail emerges about the exact same topic as an existing card — content is merged |
| **Skip** | Filler, repeated content, or nothing new — no card created |

**Multi-card philosophy:** multiple focused cards are always better than one bloated card. The AI creates a separate card for each distinct topic, example, or code snippet it sees — it never forces everything into one card.

**Vision-corrected names:** if Whisper mishears a brand or product name (e.g. "CREO AI" for "CrewAI"), the screenshot overrides the audio — on-screen text always wins.

---

#### Cards Tab

- **In-tab workspace browser** — a small dropdown inside the Cards tab lets you switch between saved workspaces to browse their cards freely, even mid-recording
- **Live lock badge** — while recording, a `🔴 Live` badge appears next to the Cards dropdown; switching the display workspace **does not** stop or affect the active recording
- **Animated card entrance** — new cards pop in with a smooth scale-up animation
- **Update highlight** — updated cards flash with a brighter border for 2.5 s to signal new content
- **Card count badge** — the Cards tab label shows a live count

---

#### Card Content Rendering (built-in, no external libraries)

| Syntax | Rendered as |
|--------|------------|
| `**bold**` | **bold** |
| `*italic*` | *italic* |
| `` `code` `` | inline code block |
| `## Heading` | section heading |
| `### Subheading` | sub-section heading |
| `- bullet` | bullet list item |
| `1. numbered` | numbered list item |
| ` ```python ... ``` ` | dark scrollable `<pre>` block with coloured text |
| `\| col \| col \|` tables | styled HTML table with coloured header |

---

#### Per-Card Actions

Each card has three action buttons:

| Button | What it does |
|--------|-------------|
| **▶ Play** | Calls OpenAI TTS (`tts-1`, alloy voice) and plays the card aloud in-browser. Markdown/code syntax is stripped before speech so it reads naturally. Clicking again stops playback. |
| **⬇ .md** | Downloads the card as a `.md` Markdown file |
| **⬇ .mp3** | Generates TTS audio via OpenAI and downloads it as an `.mp3` file |

---

#### Chat Tab

- **Card-grounded answers** — the AI primarily answers from your saved cards
- **Supplemental knowledge** — when the cards don't fully cover a question, the AI can draw on its general knowledge and clearly flags it (`"Beyond what's in your notes…"`)
- **Works without recording** — chat fetches an API key on demand, so it works even when not actively listening
- **Send button + Enter key** — both submit the message

---

#### Browse Mode

- **No recording required** — click **Browse Cards** on the hero screen to load any saved workspace read-only, without capturing audio or video
- **Read-only indicator** — a "browse mode" strip is shown at the top of the panel
- **Back button** — the Stop button becomes "← Back" to return to the workspace picker

---

#### AI Models Used by ClearContext

| Task | Model |
|------|-------|
| Audio transcription | `whisper-1` |
| Card analysis (text + screenshot) | `gpt-4o` (vision) |
| Chat assistant | `gpt-4o` |
| Text-to-speech (play + download) | `tts-1` — alloy voice |

---

## Icon Generation

To regenerate extension icons (16×16, 48×48, 128×128):

```bash
node generate-icons.js
```

Icons are written to `extension/icons/`.

---

## Permissions

| Permission | Reason |
|------------|--------|
| `activeTab` | Access the current tab's DOM for Web-Sight actions |
| `storage` | Persist workspaces, cards, sidebar state, and active mode |
| `scripting` | Inject content scripts into already-open tabs on install |
| `tts` | Speak Social Cue insights via Chrome's native TTS |
| `https://api.openai.com/*` | Direct OpenAI API access (used without proxy) |
| `https://*/*`, `http://*/*` | Run the sidebar on any website |

---

## Configuration Reference

### Proxy Server (`proxy-server/.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | — | OpenAI secret key |
| `PORT` | No | `3001` | Server port |
| `ALLOWED_ORIGINS` | No | — | Comma-separated extra CORS origins |

### Extension (`chrome.storage.local`)

| Key | Type | Description |
|-----|------|-------------|
| `activeMode` | string | Currently selected mode (`social-cue`, `web-sight`, `clear-context`) |
| `sidebarOpen` | boolean | Whether the sidebar is visible |
| `cc_workspace_list` | string[] | Ordered list of all saved ClearContext workspace names |
| `cc_ws_<name>` | Card[] | Array of cards saved for a given workspace |

---

## Security Notes

- **Direct mode:** The API key is stored in `background.js` and accessible in browser memory. Suitable for personal/development use only.
- **Proxy mode:** The API key never leaves the server. The proxy enforces rate limiting (60 req/min per IP) and CORS allowlisting. Recommended for any shared or production deployment.
- Never commit a real API key to version control. `proxy-server/.env` is already git-ignored.


---
