# AccessAI — Universal Accessibility Browser Extension

An AI-powered Chrome extension providing three real-time voice accessibility tools backed by OpenAI's GPT-4o and Realtime API.

---

## Features

| Mode | Description |
|------|-------------|
| **Social Cue Coach** | Passive observer that whispers real-time social intelligence during meetings and conversations |
| **Web-Sight Navigator** | Voice-controlled agentic browser automation for hands-free browsing |
| **ClearContext Buddy** | Live lecture assistant that extracts jargon, defines terms, and builds a concept map |

---

## Project Structure

```
BrowserExtension/
├── extension/                    # Chrome Extension (Manifest v3)
│   ├── manifest.json
│   ├── background.js             # Service worker & API gateway
│   ├── content-scripts/
│   │   ├── sidebar.js            # Unified sidebar UI shell
│   │   ├── social-cue.js         # Social Cue Coach
│   │   ├── web-sight.js          # Web-Sight Navigator
│   │   └── clear-context.js      # ClearContext Education Buddy
│   ├── styles/
│   │   └── sidebar.css
│   └── icons/
├── proxy-server/                 # [Optional] Secure Node.js proxy
│   ├── server.js
│   ├── package.json
│   ├── .env.example
│   └── .gitignore
└── generate-icons.js             # Icon generation utility
```

---

## Prerequisites

- Google Chrome (or any Chromium-based browser)
- An [OpenAI API key](https://platform.openai.com/api-keys) with access to GPT-4o and the Realtime API
- Node.js 14+ _(only required if using the optional proxy server)_

---

## Quick Start (Direct API Key Mode)

This is the simplest setup — the API key lives inside the extension itself.

> **Note:** This embeds your key in browser memory. Use the proxy server for a more secure setup.

### 1. Add your API key

Open `extension/background.js` and set your key on line 4:

```js
const OPENAI_API_KEY = 'sk-your-key-here';
```

### 2. Load the extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder

### 3. Use the extension

- Click the AccessAI icon in the toolbar **or** press `Alt+A` on any page
- Switch between the three modes using the tab bar in the sidebar
- Click the animated orb in any mode to start a session

---

## Optional: Proxy Server (Recommended for Production)

The proxy server keeps your OpenAI API key on a backend instead of inside the extension. It also adds rate limiting and enforces CORS restrictions.

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

To find your extension ID, go to `chrome://extensions/` after loading the extension.

### 3. Start the server

```bash
npm start
```

Expected output:

```
AccessAI proxy running on port 3001
HTTP:      http://localhost:3001
WebSocket: ws://localhost:3001/api/realtime
```

Verify it's running:

```bash
curl http://localhost:3001/health
# {"status":"healthy"}
```

### 4. Point the extension to the proxy

Update `extension/background.js` to route requests through your proxy URL instead of calling OpenAI directly. Leave `OPENAI_API_KEY` empty and update the endpoint constants to point at `http://localhost:3001/api/openai` (HTTP) and `ws://localhost:3001/api/realtime` (WebSocket).

### Production deployment

Deploy `proxy-server/` to any Node.js host (Render, Railway, Fly.io, etc.). Set environment variables on the platform and update endpoint constants in the extension to use your deployed URL with `https://` and `wss://`.

---

## Extension Modes

### Social Cue Coach

Passively listens to live audio and surfaces brief insights about social dynamics.

- Connects to the OpenAI Realtime API via WebSocket
- Outputs 3–7 word insights tagged as `Insight:`, `Action:`, or `Vibe:`
- Insights are spoken quietly via Chrome's TTS API and displayed in a live feed
- Does not participate in the conversation — observation only

### Web-Sight Navigator

Hands-free, voice-controlled browser agent using GPT-4o function calling.

- Speak a command; the agent plans and executes a multi-step sequence (up to 12 steps)
- Available browser actions: click, type, scroll, navigate, read page, find elements, press key, select dropdown
- Purchase safety guard: actions containing "buy", "checkout", or "pay" require explicit voice confirmation
- Falls back to typed commands if voice input is unavailable

### ClearContext Education Buddy

Real-time lecture companion that listens continuously and builds a personal glossary.

- Extracts terms and definitions from what you hear and shows them as cards
- Builds a canvas-based concept map linking terms by category
- Three sub-tabs: **Terms** (glossary cards), **Concept Map** (visual graph), **Live Feed** (transcript)
- Tap any term card to hear its definition again via TTS
- Falls back to typed questions via GPT-4o Chat Completions if the WebSocket closes

---

## Icon Generation

To regenerate the extension icons (16×16, 48×48, 128×128):

```bash
node generate-icons.js
```

Icons are written to `extension/icons/`.

---

## Permissions

The extension requests the following Chrome permissions:

| Permission | Reason |
|------------|--------|
| `activeTab` | Access the current tab's DOM for Web-Sight actions |
| `storage` | Persist sidebar state and active mode across page loads |
| `scripting` | Inject content scripts into already-open tabs on install |
| `tts` | Speak AI responses using Chrome's native text-to-speech |
| `https://api.openai.com/*` | Direct OpenAI API access (only used without proxy) |
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

---

## Security Notes

- **Direct mode**: The API key is stored in `background.js` and accessible in browser memory. Suitable for personal/development use only.
- **Proxy mode**: The API key never leaves the server. The proxy enforces rate limiting (60 req/min per IP) and CORS allowlisting. Recommended for any shared or production deployment.
- Never commit a real API key to version control. The `proxy-server/.env` file is already git-ignored.
