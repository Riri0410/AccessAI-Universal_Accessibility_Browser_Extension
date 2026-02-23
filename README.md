# AccessAI — Universal Accessibility Browser Extension

An AI-powered Chrome extension providing three real-time intelligent tools built on OpenAI's GPT-4o, Whisper, Realtime API, and TTS — all surfaced through a unified sidebar that works on any website.

---

# AccessAI — Quick Setup

> **You will need an OpenAI API key** to use this extension. Get one at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). Your key needs access to GPT-4o, Whisper, and TTS.

---

## Install in Chrome

**1. Add your API key**

Open `extension/background.js` and replace the placeholder with your key:

```js
const OPENAI_API_KEY = 'sk-your-key-here';
```

**2. Load the extension**

1. Go to `chrome://extensions/` in your browser
2. Turn on **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `extension/` folder from this project

**3. Open the extension**

> ⚠️ The extension **does not work on a blank new tab**. You must have a real website open first.

1. Open a new tab and go to any website (e.g. `google.com`)
2. Click the **AccessAI icon** in your Chrome toolbar — or press `Alt+A`
3. The sidebar will appear on the right side of the page

---

## Problem statement

Many modern websites remain difficult to perceive, understand, and navigate for people with sensory, cognitive, or motor impairments. Complex layouts, visually dense content, ambiguous icons, and multi-step interactions often limit independent access to online information and services.

AccessAI addresses these challenges by functioning as an on-page accessibility assistant embedded directly within the browser. It targets three core issues: <br>
(1) difficulty locating relevant information on content-heavy or poorly structured pages, <br>
(2) challenges in interpreting visual or social cues such as images, icons, or interface states, and <br>
(3) barriers to completing multi-step interactions caused by limited fine motor control or cognitive overload.

AccessAI improves accessibility through features such as text-to-speech, content summarisation, and DOM-based highlighting. It enhances cognitive accessibility by simplifying language, and explaining interface elements. By combining multimodal interaction with contextual understanding of web pages, AccessAI enables more inclusive and independent web access for users with diverse abilities.

---

## Motivation

Many websites remain difficult to perceive, understand, and navigate for people with sensory, cognitive, or motor impairments. While existing assistive technologies such as screen readers, browser zoom, and built-in accessibility tools provide essential support, they often struggle with complex modern web pages and offer limited contextual or task-level guidance.

This project is motivated by the need for a lightweight, page-integrated accessibility assistant that complements existing tools rather than replacing them. By combining DOM-aware techniques with AI-assisted summarisation and interpretation, the system makes intent, ambiguity or social content more immediately accessible.

The key motivations are to empower users to complete common tasks such as reading content, following links, or filling forms independently to:<br>
(i) reduce cognitive load;<br>
(ii) interpret visual or social cues that may otherwise be missed; and <br>
(iii) provide multimodal interaction with users.

A browser extension is chosen as a practical solution, as it can augment content in-place without requiring website modifications and can enable context-aware assistance than generic assistive tools alone.

---

## Solution overview

AccessAI is a browser extension composed of three specialised tools designed to support users with diverse accessibility needs.

(i) **Social-Cue:** This assists users during live conversations or meetings by interpreting flow who find it difficult to interpret tone, intent, or social dynamics participate more confidently. It suggests appropriate pauses or moments to speak, identifies when a question is directed at the user, etc.

(ii) **Web-Sight:** This supports navigation on information-dense or cluttered web pages. It helps users understand what to focus on first by surfacing contextual text bubbles, alt-text explanations on hover, and interpretations of images or interface elements. It also assists with form filling by explaining blank fields on hover and performing safe DOM actions such as focusing, filling, or clicking elements in response to user requests.

(iii) **Clear-Context:** This supports cognitive accessibility by capturing and synthesising ongoing audio or textual context into persistent topic cards. These cards provide structured summaries, timestamps, and searchable notes, helping users retain and revisit information across meetings, lectures, or extended browsing sessions.

---

## Lived-experience examples

<strong>Neurodivergent user (processing/social-cues): </strong><br>
<strong>Lived problem:</strong> “I struggle to interpret images, reaction icons, or ambiguous buttons on social sites.” <br>
<strong>How solved:</strong> the social-cue module generates short, neutral descriptions of images and explains reaction contexts (who reacted, tone), turning ambiguous visuals into clear text the user can read or hear.

<strong>Low-vision user (who prefers audio + large text): </strong><br>
<strong>Lived problem:</strong> “Tiny UI controls and dense layouts make scanning exhausting.” <br>
<strong>How solved:</strong> The web-sight module enlarges and highlights key regions in the sidebar, thus offers TTS for summaries or full-article narration, and exposes single-click actions (e.g., expand hidden content) so the user needs fewer precise pointer movements.

<strong>Cognitive or memory-impaired user (learning/attention):</strong> <br>
<strong>Lived problem:</strong> “I find it hard to keep up with online lectures, follow multiple instructions, and remember key points at the same time.” <br>
<strong>How solved:</strong> The Clear-Context module captures ongoing audio from lectures or meetings and continuously synthesises it into concise, structured topic cards with short summaries and timestamps, thereby, reducing cognitive overload and supporting sustained attention.

---

## Accessibility impact and generalisability

AccessAI has a strong accessibility impact by enabling independent and understandable interaction with modern web content. By surfacing plain-language summaries, contextual explanations, and guided actions directly within the page, it reduces reliance on human assistance and lowers cognitive load for neurodivergent users, older adults, and people with learning or memory difficulties. Users can understand what matters, what to do next, and why—without needing to interpret dense layouts or ambiguous cues.

The solution is also highly generalisable across contexts. Its DOM-aware approach allows it to work across news sites, social platforms, educational tools, and form-heavy services without requiring changes to the underlying websites. The same mechanisms that support lectures and meetings (Clear-Context), cluttered pages (Web-Sight), or conversations (Social-Cue) adapt naturally to different user groups and tasks. Importantly, AccessAI complements existing assistive technologies rather than replacing them, extending accessibility benefits across diverse environments and abilities.

## Modes at a Glance

| Mode | What it does |
|------|-------------|
| **Social Cue Coach** | Passively observes live conversations and whispers real-time social intelligence |
| **Web-Sight Navigator** | Voice-controlled agentic browser automation — speak a goal, AI handles the clicks |
| **ClearContext** | Watches your screen + listens to your lecture/video and auto-builds AI knowledge cards |

<p align="center">
  <img src="images/Social%20Cue.png" width="30%" alt="Social Cue" />
  &nbsp;
  <img src="images/Web%20Sight.png" width="30%" alt="Web Sight" />
  &nbsp;
  <img src="images/Clear%20Context.png" width="30%" alt="Clear Context" />
</p>

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
└── generate-icons.js              # Icon generation utility
```

---

## Prerequisites

- Google Chrome (or any Chromium-based browser)
- An [OpenAI API key](https://platform.openai.com/api-keys) with access to GPT-4o, Whisper, TTS, and the Realtime API
- Node.js 14+ _(only required if you plan to run local tooling such as the icon generator)_

---

## Quick Start (Direct API Key Mode)

The simplest setup — your API key lives inside the extension itself.

> **Note:** This embeds your key in browser memory. Do not commit real keys to version control.

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

## Extension Modes — Detailed

---

### Social Cue Coach

A silent, real-time social intelligence coach for video calls, designed for neurodivergent users who find it hard to read the room.

**How it works:**
- Captures both your **microphone** and **tab/screen audio** so it hears all participants
- Streams the mixed audio to the **OpenAI Realtime API** (WebSocket, text-only output)
- Every 8 seconds, takes a **screenshot** via GPT-4o Vision to detect visual events (screen shares, demos)
- Generates max 8-word insight cards tagged by type — shown in a live feed panel

**Insight tag types:**
| Tag | When it fires |
|-----|---------------|
| `[DIRECTED]` | Someone addresses you by name or gives a direct command/question |
| `[GREETING]` | A greeting you should acknowledge |
| `[HUMOR]` | Laughter or a joke — cue to react |
| `[CELEBRATE]` | Good news or achievement shared |
| `[STORY]` | Personal story being told — listen actively |
| `[SCREEN]` | Screen share or demo just started |
| `[EMOTION]` | Clear emotional tone — frustration, sarcasm |
| `[TURN]` | Natural pause — your turn to speak (opt-in only) |
| `[VIBE]` | Noticeable mood shift in the group |
| `[FAREWELL]` | The meeting is collectively winding down |
| `[NOTE]` | Something explicitly said that you should remember |

**Key behaviours:**
- Silent by default — outputs nothing during normal flowing conversation
- **My Turn** toggle — opt-in to receive `[TURN]` cues when there's a speaking gap
- Live audio waveform and RMS level meter confirm audio is flowing
- Source badges show which streams are active: 🎤 Mic, 🔊 Tab, 👁 Vision
- Observation only — never speaks into or interrupts the call

---

### Web-Sight Navigator

A hands-free, voice-controlled browser agent for users with dyslexia, powered by GPT-4o function calling and OpenAI Realtime voice.

**How it works:**
- You share your screen and microphone at session start
- Your speech is transcribed live using **OpenAI Whisper** (English, via Realtime WebSocket)
- On startup, a screenshot is taken and GPT-4o Vision describes the current page in one sentence
- Spoken commands are passed to a **GPT-4o agent** that plans and executes up to 14 steps
- AI replies are spoken back to you using **OpenAI's alloy voice** (PCM16 audio streamed via Realtime WebSocket), not browser TTS
- Microphone is muted while the AI is speaking to prevent echo

**Available browser actions:**

| Action | What it does |
|--------|-------------|
| `capture_screen` | Takes a JPEG screenshot and analyses it with GPT-4o Vision |
| `get_page_context` | Reads the current URL, title, and visible form fields |
| `read_page` | Reads up to 4000 characters of visible page text |
| `click_element` | Clicks any element by CSS selector |
| `type_text` | Types text into an input field |
| `navigate_to` | Goes to a URL |
| `scroll_page` | Scrolls up, down, to top, or to bottom |
| `describe_image` | Describes an image using GPT-4o Vision |

**Image hover descriptions:**
- Hovering over any image for 800 ms triggers an AI vision description shown in a tooltip
- Descriptions are also spoken aloud (max 15 words, focuses on subjects, actions, clothing)

**Conversation memory:**
- Last 30 exchanges are saved in `chrome.storage.local`
- History is automatically wiped when Chrome restarts
- "Clear history" button resets memory manually

**Safety:**
- Vague or unclear commands receive: *"Not clear, please elaborate."* — no guessing

---

### ClearContext — Intelligent Topic Card Engine

ClearContext watches your screen and listens to your lecture or video, then uses AI to automatically build structured, markdown-rich knowledge cards organised into named workspaces.

**Pipeline:**
1. You share your screen or a browser tab — video and audio are captured
2. Audio is split into **8-second chunks** and transcribed by **OpenAI Whisper**
3. Every **3 transcripts**, **GPT-4o Vision** analyses the rolling transcript *alongside a live screenshot* of your screen
4. AI decides whether to create a new card, update an existing one, or skip
5. Cards are immediately saved to `chrome.storage.local` under your workspace name

**No microphone required** — only system/tab audio is captured.

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
- **Supplemental knowledge** — when the cards don't fully cover a question, the AI can draw on its general knowledge and clearly flags it ("Beyond what's in your notes…")
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
| `https://api.openai.com/*` | Direct OpenAI API access |
| `https://*/*`, `http://*/*` | Run the sidebar on any website |

---

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
- Never commit a real API key to version control.

---