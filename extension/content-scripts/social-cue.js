/**
 * Social Cue Assistant v4 - Content Script
 * - Big start CTA fills idle space, disappears on start
 * - Compact "Stop" button pinned at top while listening
 * - Cards fill the remaining space and scroll up as new ones arrive
 * - Intent-based card coloring (gratitude=amber, stress=red, etc.)
 * - Participant name detection
 * - Noise filtering (no "Output nothing" cards)
 */

(function () {
  'use strict';

  // ─── Config ───────────────────────────────────────────────────────────────
  const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';
  const VISION_MODEL = 'gpt-4o';
  const SAMPLE_RATE = 24000;
  const BUFFER_SIZE = 4096;
  const VISION_INTERVAL_MS = 8000;

  // ─── State ────────────────────────────────────────────────────────────────
  let ws = null;
  let audioCtx = null;
  let displayStream = null;
  let micStream = null;
  let processorNode = null;
  let visionInterval = null;
  let hiddenVideo = null;
  let isListening = false;
  let userName = 'You';
  let apiKey = null;
  let insightCount = 0;
  let currentResponseText = '';

  // ─── Inject panel ─────────────────────────────────────────────────────────
  function injectPanel() {
    if (document.getElementById('sca-root')) return;

    const style = document.createElement('style');
    style.id = 'sca-styles';
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@600;800&display=swap');

      #sca-root {
        position: relative;
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        font-family: 'Syne', sans-serif;
        background: transparent;
        overflow: hidden;
      }

      /* ── Header ── */
      #sca-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 14px 10px;
        border-bottom: 1px solid rgba(255,255,255,0.05);
        flex-shrink: 0;
        background: linear-gradient(180deg, rgba(124,58,237,0.08) 0%, transparent 100%);
      }
      .sca-header-left { display: flex; align-items: center; gap: 10px; }
      #sca-live-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #374151; flex-shrink: 0;
        transition: background 0.3s, box-shadow 0.3s;
      }
      #sca-live-dot.audio-active {
        background: #06b6d4;
        box-shadow: 0 0 8px #06b6d4, 0 0 20px rgba(6,182,212,0.4);
        animation: sca-ping 2s ease-in-out infinite;
      }
      #sca-live-dot.vision-flash {
        background: #a78bfa;
        box-shadow: 0 0 8px #a78bfa, 0 0 20px rgba(167,139,250,0.5);
      }
      @keyframes sca-ping {
        0%,100% { box-shadow: 0 0 6px #06b6d4, 0 0 12px rgba(6,182,212,0.3); }
        50%      { box-shadow: 0 0 12px #06b6d4, 0 0 28px rgba(6,182,212,0.6); }
      }
      .sca-wordmark { display: flex; flex-direction: column; gap: 1px; }
      .sca-title { font-size: 12px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: #f0ecff; }
      .sca-subtitle { font-size: 9px; font-family: 'DM Mono', monospace; color: #4b5563; letter-spacing: 0.06em; }

      /* ── Compact stop button — pinned at top while listening ── */
      #sca-stop-bar {
        display: none;
        flex-shrink: 0;
        padding: 8px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        background: rgba(0,0,0,0.15);
      }
      #sca-stop-btn {
        display: flex; align-items: center; justify-content: center; gap: 8px;
        width: 100%; padding: 8px 14px;
        background: rgba(239,68,68,0.12);
        border: 1px solid rgba(239,68,68,0.35);
        border-radius: 10px; cursor: pointer;
        font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700;
        color: #fca5a5; letter-spacing: 0.04em;
        transition: all 0.2s;
      }
      #sca-stop-btn:hover { background: rgba(239,68,68,0.22); border-color: rgba(239,68,68,0.6); }

      /* ── Listening status + waveform + badges ── */
      #sca-listening-ui { display: none; flex-direction: column; flex-shrink: 0; }
      #sca-status-bar {
        padding: 6px 14px; font-family: 'DM Mono', monospace;
        font-size: 10px; color: #374151;
        border-bottom: 1px solid rgba(255,255,255,0.04);
        flex-shrink: 0; display: flex; align-items: center; gap: 6px;
        min-height: 28px; transition: color 0.3s;
      }
      #sca-status-bar.active { color: #06b6d4; }
      #sca-status-bar.error  { color: #f87171; }
      #sca-wave {
        display: flex; align-items: center; justify-content: center;
        gap: 3px; padding: 8px 16px 4px; height: 30px; flex-shrink: 0;
      }
      .sca-bar { width: 3px; background: #1f1f2e; border-radius: 2px; height: 4px; transition: height 0.08s, background 0.3s; }
      #sca-wave.active .sca-bar { background: #7c3aed; animation: sca-wave-anim 1.4s ease-in-out infinite; }
      .sca-bar:nth-child(1) { animation-delay: 0s; }
      .sca-bar:nth-child(2) { animation-delay: 0.1s; }
      .sca-bar:nth-child(3) { animation-delay: 0.2s; }
      .sca-bar:nth-child(4) { animation-delay: 0.3s; }
      .sca-bar:nth-child(5) { animation-delay: 0.4s; }
      .sca-bar:nth-child(6) { animation-delay: 0.3s; }
      .sca-bar:nth-child(7) { animation-delay: 0.2s; }
      .sca-bar:nth-child(8) { animation-delay: 0.1s; }
      .sca-bar:nth-child(9) { animation-delay: 0s; }
      @keyframes sca-wave-anim { 0%,100% { height: 3px; } 50% { height: 16px; } }
      #sca-sources { display: flex; gap: 6px; padding: 0 14px 8px; flex-shrink: 0; }
      .sca-badge {
        font-family: 'DM Mono', monospace; font-size: 9px; letter-spacing: 0.07em;
        text-transform: uppercase; padding: 3px 7px; border-radius: 4px;
        border: 1px solid rgba(255,255,255,0.06); color: #374151;
        background: rgba(255,255,255,0.02); transition: all 0.3s;
      }
      .sca-badge.on { border-color: rgba(6,182,212,0.4); color: #06b6d4; background: rgba(6,182,212,0.06); }
      .sca-badge.vision-on { border-color: rgba(167,139,250,0.4); color: #a78bfa; background: rgba(167,139,250,0.06); }

      /* ── Big start CTA ── */
      #sca-start-cta {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        padding: 24px 16px;
      }
      #sca-start-btn {
        display: flex; align-items: center; justify-content: center; gap: 10px;
        width: 100%; padding: 16px 18px;
        background: linear-gradient(135deg, rgba(124,58,237,0.35), rgba(6,182,212,0.25));
        border: 1.5px solid rgba(124,58,237,0.5);
        border-radius: 14px; cursor: pointer;
        font-family: 'Syne', sans-serif; font-size: 15px; font-weight: 800;
        color: #e0d7ff; letter-spacing: 0.03em;
        box-shadow: 0 0 24px rgba(124,58,237,0.2);
        transition: all 0.2s;
      }
      #sca-start-btn:hover {
        background: linear-gradient(135deg, rgba(124,58,237,0.5), rgba(6,182,212,0.35));
        box-shadow: 0 0 36px rgba(124,58,237,0.35);
        transform: translateY(-1px);
      }
      .sca-cta-hint {
        font-size: 10px; color: #4b5563; font-family: 'DM Mono', monospace;
        text-align: center; line-height: 1.6; max-width: 220px;
      }

      /* ── Cards feed ── */
      #sca-feed {
        flex: 1; overflow-y: auto; padding: 8px 12px 12px;
        display: none;
        flex-direction: column; gap: 8px;
  scroll-behavior: smooth;
  scrollbar-width: thin; scrollbar-color: rgba(124,58,237,0.3) transparent;
        scrollbar-width: thin; 
      }
      #sca-feed.visible { display: flex; }
      #sca-feed::-webkit-scrollbar { width: 3px; }
      #sca-feed::-webkit-scrollbar-thumb { background: rgba(124,58,237,0.35); border-radius: 2px; }

      .sca-empty {
        flex: 1; display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        color: #1f2937; font-family: 'DM Mono', monospace;
        font-size: 11px; line-height: 1.7; text-align: center; padding: 20px; gap: 8px;
      }
      .sca-empty-eye { font-size: 28px; opacity: 0.25; filter: grayscale(1); }

      /* ── Base card ── */
      .sca-card {
        border-radius: 10px; padding: 10px 12px;
        animation: sca-appear 0.3s cubic-bezier(0.16,1,0.3,1);
        flex-shrink: 0;
      }
      @keyframes sca-appear {
        from { opacity:0; transform: translateX(12px) scale(0.97); }
        to   { opacity:1; transform: translateX(0) scale(1); }
      }

      /* Directed to YOU — bright blue, high attention */
      .sca-card.directed {
        background: rgba(96,165,250,0.12);
        border: 1px solid rgba(96,165,250,0.45);
        box-shadow: 0 0 16px rgba(96,165,250,0.12);
      }
      .sca-card.directed .sca-card-tag { color: #60a5fa; font-weight: 800; }
      .sca-card.directed .sca-card-text { color: #bfdbfe; font-weight: 600; }

      /* Directed to another person — soft purple */
      .sca-card.directed_other {
        background: rgba(139,92,246,0.08);
        border: 1px solid rgba(139,92,246,0.3);
      }
      .sca-card.directed_other .sca-card-tag { color: #a78bfa; font-weight: 700; }
      .sca-card.directed_other .sca-card-text { color: #ddd6fe; }

      /* Group invite — teal */
      .sca-card.group {
        background: rgba(52,211,153,0.07);
        border: 1px solid rgba(52,211,153,0.3);
      }
      .sca-card.group .sca-card-tag { color: #34d399; }
      .sca-card.group .sca-card-text { color: #a7f3d0; }

      /* Gratitude — warm amber, never red */
      .sca-card.gratitude {
        background: rgba(251,191,36,0.07);
        border: 1px solid rgba(251,191,36,0.3);
      }
      .sca-card.gratitude .sca-card-tag { color: #fbbf24; }
      .sca-card.gratitude .sca-card-text { color: #fde68a; }

      /* Stress — red, pulses 3 times */
      .sca-card.stress {
        background: rgba(239,68,68,0.1);
        border: 1px solid rgba(239,68,68,0.5);
        box-shadow: 0 0 14px rgba(239,68,68,0.15);
        animation: sca-appear 0.3s cubic-bezier(0.16,1,0.3,1),
                   sca-stress-pulse 2s ease-in-out 0.3s 3;
      }
      .sca-card.stress .sca-card-tag { color: #ef4444; font-weight: 800; }
      .sca-card.stress .sca-card-text { color: #fca5a5; font-weight: 600; }
      @keyframes sca-stress-pulse {
        0%, 100% { box-shadow: 0 0 14px rgba(239,68,68,0.15); }
        50%       { box-shadow: 0 0 28px rgba(239,68,68,0.45); }
      }

      /* Turn — soft purple */
      .sca-card.turn {
        background: rgba(124,58,237,0.08);
        border: 1px solid rgba(124,58,237,0.22);
      }
      .sca-card.turn .sca-card-tag { color: #a78bfa; }
      .sca-card.turn .sca-card-text { color: #ddd6fe; }

      /* Vibe — cyan */
      .sca-card.vibe {
        background: rgba(6,182,212,0.06);
        border: 1px solid rgba(6,182,212,0.2);
      }
      .sca-card.vibe .sca-card-tag { color: #22d3ee; }
      .sca-card.vibe .sca-card-text { color: #cffafe; }

      /* Visual — lavender */
      .sca-card.visual {
        background: rgba(167,139,250,0.07);
        border: 1px solid rgba(167,139,250,0.2);
      }
      .sca-card.visual .sca-card-tag { color: #c4b5fd; }
      .sca-card.visual .sca-card-text { color: #ede9fe; }

      /* Note — neutral */
      .sca-card.note {
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.07);
      }
      .sca-card.note .sca-card-tag { color: #6b7280; }
      .sca-card.note .sca-card-text { color: #9ca3af; }

      .sca-card-tag {
        font-size: 9px; font-weight: 600; letter-spacing: 0.12em;
        text-transform: uppercase; font-family: 'DM Mono', monospace; margin-bottom: 5px;
      }
      .sca-card-text { font-size: 13px; font-weight: 600; color: #f0ecff; line-height: 1.45; }
      .sca-card-meta { display: flex; align-items: center; gap: 6px; margin-top: 5px; }
      .sca-card-time { font-family: 'DM Mono', monospace; font-size: 9px; color: #2d2d3d; }
      .sca-card-source { font-family: 'DM Mono', monospace; font-size: 9px; color: #2d2d3d; }

      /* ── Footer ── */
      #sca-footer { display: none; padding: 8px 12px; border-top: 1px solid rgba(255,255,255,0.04); flex-shrink: 0; }
      #sca-clear-btn {
        width: 100%; background: transparent;
        border: 1px solid rgba(255,255,255,0.06); border-radius: 8px;
        padding: 6px; color: #2d2d3d; font-family: 'DM Mono', monospace;
        font-size: 10px; letter-spacing: 0.07em; text-transform: uppercase;
        cursor: pointer; transition: all 0.2s;
      }
      #sca-clear-btn:hover { border-color: rgba(239,68,68,0.3); color: #f87171; }
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'sca-root';
    root.innerHTML = `
      <div id="sca-header">
        <div class="sca-header-left">
          <div id="sca-live-dot"></div>
          <div class="sca-wordmark">
            <div class="sca-title">Social Cue</div>
            <div class="sca-subtitle">AI Coach · Meet</div>
          </div>
        </div>
      </div>

      <!-- Compact stop button — pinned at top, only visible while listening -->
      <div id="sca-stop-bar">
        <button id="sca-stop-btn">
          <span style="font-size:14px;">⏹</span>
          <span>Stop</span>
        </button>
      </div>

      <!-- Status + waveform + badges — only visible while listening -->
      <div id="sca-listening-ui">
        <div id="sca-status-bar">Listening…</div>
        <div id="sca-wave">${Array(9).fill('<div class="sca-bar"></div>').join('')}</div>
        <div id="sca-sources">
          <span class="sca-badge" id="sca-badge-mic">🎤 Mic</span>
          <span class="sca-badge" id="sca-badge-tab">🔊 Tab</span>
          <span class="sca-badge vision-on" id="sca-badge-vision">👁 Vision</span>
        </div>
      </div>

      <!-- Big start CTA — fills space before listening, hidden once active -->
      <div id="sca-start-cta">
        <button id="sca-start-btn">
          <span style="font-size:24px;">🎙</span>
          <span>Tap to Start</span>
        </button>
        <div class="sca-cta-hint">Listens to your call · surfaces social insights · never speaks into the meeting</div>
      </div>

      <!-- Cards feed — shown once listening starts -->
      <div id="sca-feed">
        <div class="sca-empty">
          <div class="sca-empty-eye">👁</div>
          Insights will appear here as<br>the conversation unfolds.
        </div>
      </div>

      <div id="sca-footer">
        <button id="sca-clear-btn">Clear history</button>
      </div>
    `;

    const pane = window.__accessai?.getSidebarPane('social-cue');
if (pane) {
  pane.innerHTML = '';
  pane.style.padding = '0';
  pane.style.overflow = 'hidden';
  pane.style.display = 'flex';
  pane.style.flexDirection = 'column';
  pane.style.height = '100%';
  pane.appendChild(root);
} else {
      root.style.cssText = 'position:fixed;top:0;right:0;width:300px;height:100vh;z-index:2147483647;background:#0c0c14;display:flex;flex-direction:column;';
      document.body.appendChild(root);
    }

    bindUI();
  }

  // ─── Bind UI ──────────────────────────────────────────────────────────────
  function bindUI() {
    document.getElementById('sca-start-btn').addEventListener('click', toggleListening);
    document.getElementById('sca-stop-btn').addEventListener('click', toggleListening);
    document.getElementById('sca-clear-btn').addEventListener('click', () => {
      const feed = document.getElementById('sca-feed');
      feed.innerHTML = `<div class="sca-empty"><div class="sca-empty-eye">👁</div>Insights will appear here as<br>the conversation unfolds.</div>`;
      insightCount = 0;
    });
  }

  // ─── Toggle ───────────────────────────────────────────────────────────────
  async function toggleListening() {
    if (isListening) { stopAll(); return; }
    await startAll();
  }

  // ─── Start everything ─────────────────────────────────────────────────────
  async function startAll() {
    apiKey = await getApiKey();
    if (!apiKey) { updateCtaHint('⚠ No API key — check extension settings'); return; }
    userName = await getUserName();

    updateCtaHint('Select your Meet window to share…');
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 5, width: 1280 },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
    } catch (err) {
      updateCtaHint('Screen share cancelled — tap to try again');
      return;
    }

    displayStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (isListening) stopAll();
    });

    updateCtaHint('Requesting microphone…');
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (err) {
      updateCtaHint('Microphone denied — tap to try again');
      displayStream.getTracks().forEach(t => t.stop());
      return;
    }

    updateCtaHint('Connecting to OpenAI…');
    try {
      await connectWebSocket();
    } catch (err) {
      updateCtaHint('Connection failed — tap to try again');
      cleanup();
      return;
    }

    setupAudioMixer();
    setupVisionCapture();

    isListening = true;

    // Switch layout: hide CTA, show stop button + listening UI + feed
    document.getElementById('sca-start-cta').style.display = 'none';
    document.getElementById('sca-stop-bar').style.display = 'block';
    document.getElementById('sca-listening-ui').style.display = 'flex';
    document.getElementById('sca-feed').classList.add('visible');
    document.getElementById('sca-footer').style.display = 'block';

    document.getElementById('sca-live-dot').classList.add('audio-active');
    document.getElementById('sca-wave').classList.add('active');
    document.getElementById('sca-badge-mic').classList.add('on');
    document.getElementById('sca-badge-tab').classList.add('on');
    setStatus('Listening to all participants…', 'active');
  }

  // ─── Stop everything ──────────────────────────────────────────────────────
  function stopAll() {
    cleanup();
    isListening = false;

    // Switch layout back: show CTA, hide everything else
    document.getElementById('sca-start-cta').style.display = 'flex';
    document.getElementById('sca-stop-bar').style.display = 'none';
    document.getElementById('sca-listening-ui').style.display = 'none';
    document.getElementById('sca-feed').classList.remove('visible');
    document.getElementById('sca-footer').style.display = 'none';

    updateCtaHint('Listens to your call · surfaces social insights · never speaks into the meeting');

    const dot = document.getElementById('sca-live-dot');
    if (dot) dot.classList.remove('audio-active', 'vision-flash');
    const wave = document.getElementById('sca-wave');
    if (wave) wave.classList.remove('active');
    document.getElementById('sca-badge-mic')?.classList.remove('on');
    document.getElementById('sca-badge-tab')?.classList.remove('on');
  }

  function cleanup() {
    if (ws) { try { ws.close(); } catch(e){} ws = null; }
    if (visionInterval) { clearInterval(visionInterval); visionInterval = null; }
    if (processorNode) { try { processorNode.disconnect(); } catch(e){} processorNode = null; }
    if (audioCtx) { try { audioCtx.close(); } catch(e){} audioCtx = null; }
    if (displayStream) { displayStream.getTracks().forEach(t => t.stop()); displayStream = null; }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (hiddenVideo) { hiddenVideo.srcObject = null; hiddenVideo.remove(); hiddenVideo = null; }
  }

  // ─── Status helpers ───────────────────────────────────────────────────────
  function updateCtaHint(msg) {
    const hint = document.querySelector('.sca-cta-hint');
    if (hint) hint.textContent = msg;
  }

  function setStatus(msg, cls) {
    const el = document.getElementById('sca-status-bar');
    if (!el) return;
    el.textContent = msg;
    el.className = cls || '';
  }

  // ─── WebSocket ────────────────────────────────────────────────────────────
  function connectWebSocket() {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(
        REALTIME_URL,
        ['realtime', `openai-insecure-api-key.${apiKey}`, 'openai-beta.realtime-v1']
      );

      const timeout = setTimeout(() => { ws.close(); reject(new Error('Timeout')); }, 10000);

      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text'],
            instructions: buildAudioPrompt(),
            input_audio_format: 'pcm16',
            turn_detection: {
              type: 'server_vad',
              threshold: 0.45,
              prefix_padding_ms: 200,
              silence_duration_ms: 700,
            },
            temperature: 0.6,
            max_response_output_tokens: 80,
          }
        }));
        resolve();
      });

      ws.addEventListener('error', (e) => { clearTimeout(timeout); reject(e); });
      ws.addEventListener('message', handleWSMessage);
      ws.addEventListener('close', (e) => {
        if (isListening) { setStatus(`Disconnected (${e.code})`, 'error'); stopAll(); }
      });
    });
  }

  // ─── Audio prompt ─────────────────────────────────────────────────────────
  function buildAudioPrompt() {
    return `You are a silent Social Intelligence Coach in ${userName}'s Google Meet call.

You passively listen to ALL participants. There may be multiple people speaking.

RESPONSE FORMAT — STRICTLY FOLLOW:
- When something significant happens: ONE line starting with a tag, max 10 words after the tag.
- When conversation is completely normal: respond with a single hyphen: -
- NEVER write "Output nothing", "Nothing to report", or any explanation. Just: -

PARTICIPANT NAME DETECTION — CRITICAL:
- If someone addresses a specific person by name (e.g. "Ram, what do you think?" or "Sarah, your turn"):
  → Extract the name and use it in your response.
  → Example: [DIRECTED] Ram — being asked for their opinion.
  → Example: [DIRECTED] Sarah — invited to share her thoughts.
- If that named person is ${userName}, use [DIRECTED_TO_YOU] instead.
- If no name is mentioned but someone is clearly being singled out: [DIRECTED] Someone — being put on the spot.

TAGS — choose the most accurate one:
[DIRECTED_TO_YOU] — ${userName} is specifically being asked to respond
[DIRECTED] — a specific named participant is being addressed (include their name)
[GROUP_INVITE] — open floor, whole group invited to speak
[TURN] — crosstalk, awkward silence, or turn-taking gap
[GRATITUDE] — thanks, appreciation, or praise expressed
[STRESS] — frustration, anger, urgency, raised voice, tension
[VIBE] — notable mood or energy shift in the room
[NOTE] — anything else worth flagging

EXAMPLES:
[DIRECTED_TO_YOU] ${userName} — asked for opinion directly.
[DIRECTED] Ram — opportunity to speak, question directed at him.
[DIRECTED] Sarah — being asked to present her findings.
[GROUP_INVITE] Open floor — anyone can jump in now.
[STRESS] Frustration rising, voices getting sharp.
[GRATITUDE] Appreciation expressed warmly to the team.
[TURN] Silence after question — someone should respond.
[VIBE] Energy lifted noticeably after that update.
-`;
  }

  // ─── Handle Realtime WS messages ─────────────────────────────────────────
  function handleWSMessage(event) {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    switch (data.type) {
      case 'response.text.delta':
        currentResponseText += data.delta || '';
        break;
      case 'response.text.done':
      case 'response.done':
        if (currentResponseText.trim()) {
          const cleaned = currentResponseText.trim();
          const isNoise = /^[-–—]+$/.test(cleaned)
            || /^(output nothing|nothing to report|no insight|normal conversation|nothing significant)/i.test(cleaned);
          if (!isNoise) addCard(cleaned, 'audio');
          currentResponseText = '';
        }
        break;
      case 'error':
        console.error('[SCA]', data.error);
        setStatus(`OpenAI error: ${data.error?.code || 'unknown'}`, 'error');
        break;
      case 'input_audio_buffer.speech_started':
        setStatus('Speech detected…', 'active');
        break;
      case 'input_audio_buffer.speech_stopped':
        setStatus('Analysing…', 'active');
        break;
    }
  }

  // ─── Audio mixer ─────────────────────────────────────────────────────────
  function setupAudioMixer() {
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const destination = audioCtx.createChannelMerger(1);
    const gainMic = audioCtx.createGain();
    const gainTab = audioCtx.createGain();
    gainMic.gain.value = 1.0;
    gainTab.gain.value = 1.0;

    const micSource = audioCtx.createMediaStreamSource(micStream);
    micSource.connect(gainMic);

    const tabAudioTracks = displayStream.getAudioTracks();
    if (tabAudioTracks.length > 0) {
      const tabSource = audioCtx.createMediaStreamSource(new MediaStream(tabAudioTracks));
      tabSource.connect(gainTab);
      gainTab.connect(destination, 0, 0);
    } else {
      setStatus('⚠ No tab audio — share with audio enabled', 'error');
    }

    gainMic.connect(destination, 0, 0);

    processorNode = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
    processorNode.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const f32 = e.inputBuffer.getChannelData(0);
      const pcm = f32ToPCM16(f32);
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: bufToBase64(pcm.buffer) }));
    };

    destination.connect(processorNode);
    processorNode.connect(audioCtx.destination);
  }

  // ─── Vision capture ───────────────────────────────────────────────────────
  function setupVisionCapture() {
    const videoTrack = displayStream.getVideoTracks()[0];
    if (!videoTrack) return;

    hiddenVideo = document.createElement('video');
    hiddenVideo.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    hiddenVideo.autoplay = true;
    hiddenVideo.muted = true;
    hiddenVideo.playsInline = true;
    hiddenVideo.srcObject = new MediaStream([videoTrack]);
    document.body.appendChild(hiddenVideo);
    hiddenVideo.play().catch(() => {});

    setTimeout(() => {
      captureAndAnalyse();
      visionInterval = setInterval(captureAndAnalyse, VISION_INTERVAL_MS);
    }, 3000);
  }

  async function captureAndAnalyse() {
    if (!hiddenVideo || hiddenVideo.readyState < 2) return;
    if (!apiKey) return;

    const W = 1280;
    const H = Math.round(1280 * (hiddenVideo.videoHeight / (hiddenVideo.videoWidth || 1280)));
    const canvas = document.createElement('canvas');
    canvas.width = W || 1280;
    canvas.height = H || 720;
    const ctx2d = canvas.getContext('2d');
    ctx2d.drawImage(hiddenVideo, 0, 0, canvas.width, canvas.height);
    const base64 = canvas.toDataURL('image/jpeg', 0.55).split(',')[1];

    const dot = document.getElementById('sca-live-dot');
    if (dot) {
      dot.classList.remove('audio-active');
      dot.classList.add('vision-flash');
      setTimeout(() => {
        dot.classList.remove('vision-flash');
        if (isListening) dot.classList.add('audio-active');
      }, 600);
    }

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: VISION_MODEL,
          max_tokens: 60,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: `You are observing ${userName}'s Google Meet call screenshot.

Describe ONLY significant social/visual cues:
- Someone looks disengaged or distracted
- Visible frustration or confusion on faces
- Someone has their hand raised or is trying to speak
- Significant body language shift

If everything looks normal, respond with a single hyphen: -
Never write "Output nothing", "NONE", or any explanation.

Otherwise respond with ONE insight, max 7 words, starting with [VISUAL].
Example: [VISUAL] Someone appears confused or zoned out.`
              },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'low' } }
            ]
          }]
        })
      });

      const json = await res.json();
      const text = json.choices?.[0]?.message?.content?.trim();
      const isNoise = !text
        || /^[-–—]+$/.test(text)
        || text === 'NONE'
        || /^(output nothing|nothing to report|no insight|normal)/i.test(text);
      if (!isNoise) addCard(text, 'vision');
      setStatus(`${insightCount} insight${insightCount !== 1 ? 's' : ''} captured`, 'active');
    } catch (err) {
      console.error('[SCA Vision]', err);
    }
  }

  // ─── Render insight card ──────────────────────────────────────────────────
  function addCard(text, source) {
    const feed = document.getElementById('sca-feed');
    if (!feed) return;

    feed.querySelector('.sca-empty')?.remove();

    let type = 'note', tag = 'Note', body = text;
    const tagMatch = text.match(/^\[(DIRECTED_TO_YOU|DIRECTED|GROUP_INVITE|GRATITUDE|STRESS|TURN|VIBE|NOTE|VISUAL|EMOTION)\]\s*/i);

    if (tagMatch) {
      const t = tagMatch[1].toUpperCase();
      body = text.slice(tagMatch[0].length).trim();
      switch (t) {
        case 'DIRECTED_TO_YOU': type = 'directed';       tag = '🎯 You — Speak Up!'; break;
        case 'DIRECTED':        type = 'directed_other'; tag = '🎯 Directed';         break;
        case 'GROUP_INVITE':    type = 'group';           tag = '🙋 Group Invite';    break;
        case 'GRATITUDE':       type = 'gratitude';       tag = '🙏 Gratitude';       break;
        case 'STRESS':          type = 'stress';          tag = '⚠️ Stress';          break;
        case 'TURN':            type = 'turn';            tag = '↩ Turn';             break;
        case 'VIBE':            type = 'vibe';            tag = '〜 Vibe';            break;
        case 'VISUAL':          type = 'visual';          tag = '👁 Visual';          break;
        case 'EMOTION':         type = 'turn';            tag = '↩ Turn';             break;
        default:                type = 'note';            tag = '· Note';             break;
      }
    } else if (source === 'vision') {
      type = 'visual'; tag = '👁 Visual';
    }

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const srcLabel = source === 'vision' ? '👁 vision' : '🎙 audio';
    insightCount++;

    const card = document.createElement('div');
    card.className = `sca-card ${type}`;
    card.innerHTML = `
      <div class="sca-card-tag">${tag}</div>
      <div class="sca-card-text">${esc(body)}</div>
      <div class="sca-card-meta">
        <span class="sca-card-time">${time}</span>
        <span class="sca-card-source">· ${srcLabel}</span>
      </div>
    `;

    feed.appendChild(card);
card.scrollIntoView({ behavior: 'smooth', block: 'end' });
const all = feed.querySelectorAll('.sca-card');
if (all.length > 30) all[0].remove();

    // Flash dot for urgent types
    if (type === 'directed' || type === 'directed_other' || type === 'stress') {
      const dot = document.getElementById('sca-live-dot');
      if (dot) {
        dot.classList.add('vision-flash');
        setTimeout(() => { if (isListening) dot.classList.remove('vision-flash'); }, 1200);
      }
    }

    setStatus(`${insightCount} insight${insightCount !== 1 ? 's' : ''} captured`, 'active');
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function f32ToPCM16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
  }

  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function getApiKey() {
    return new Promise(r => chrome.runtime.sendMessage({ type: 'GET_API_KEY' }, res => r(res?.key || null)));
  }

  function getUserName() {
    return Promise.resolve('You');
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  function boot() {
    const check = () => {
      const ready = document.querySelector('[data-call-ended]') !== undefined
                 || document.querySelector('c-wiz')
                 || document.querySelector('[jscontroller]');
      if (ready && document.body) {
        injectPanel();
      } else {
        setTimeout(check, 800);
      }
    };
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      check();
    } else {
      document.addEventListener('DOMContentLoaded', check);
    }
  }

  // ─── AccessAI lifecycle ───────────────────────────────────────────────────
  let panelBooted = false;
  function maybeBootPanel() {
    if (panelBooted) return;
    panelBooted = true;
    boot();
  }

  window.addEventListener('accessai-mode-changed', (e) => {
    if (e.detail.mode === 'social-cue') maybeBootPanel();
    else if (isListening) stopAll();
  });

  chrome.storage.local.get('activeMode', (result) => {
    if (result.activeMode === 'social-cue') setTimeout(maybeBootPanel, 600);
  });

})();