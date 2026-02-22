/**
 * Social Cue Assistant — Sidebar Edition
 *
 * PURPOSE: Help neurodivergent people (autism spectrum / social anxiety)
 * "read the room" during video calls in real time. A private social
 * dashboard that silently flags: directed questions, greetings, jokes,
 * emotional tone, turn gaps, celebrations, farewells — everything.
 *
 * ENGINE: Preserved verbatim from the original working content.js (v2).
 *   getDisplayMedia (video+audio) ──┐
 *                                   ├─ AudioContext mixer
 *   getUserMedia (mic) ─────────────┘      ↓
 *                          ScriptProcessor → PCM16 → OpenAI Realtime WS
 *   Every 2s: canvas frame → GPT-4o Vision → [VISUAL] card
 *
 * PROMPT PHILOSOPHY (kept from v2, extended):
 *   - Silent by default — output NOTHING during normal conversation
 *   - Max 8 words per insight, non-negotiable
 *   - Single tag prefix: [DIRECTED] [GREETING] [HUMOR] [CELEBRATE]
 *     [STORY] [SCREEN] [EMOTION] [TURN] [VIBE] [FAREWELL] [NOTE]
 *   - Concrete examples for every tag — no vague coaching language
 */

(function () {
  'use strict';

  if (window.__sca_sidebar) return;
  window.__sca_sidebar = true;

  // ─── Config ───────────────────────────────────────────────────────────────
  const REALTIME_URL     = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';
  const VISION_MODEL     = 'gpt-4o';
  const SAMPLE_RATE      = 24000;
  const BUFFER_SIZE      = 4096;
  const VISION_INTERVAL  = 8000;   // 8s — only flag genuinely NEW visual events

  // ─── State ────────────────────────────────────────────────────────────────
  let ws                 = null;
  let audioCtx           = null;
  let displayStream      = null;
  let micStream          = null;
  let processorNode      = null;
  let visionInterval     = null;
  let hiddenVideo        = null;
  let isListening        = false;
  let userName           = 'User';
  let apiKey             = null;
  let insightCount       = 0;
  let currentResponseText = '';
  let visionBusy         = false;
  let lastVisionText     = '';
  let visionSeenSet      = new Set();   // dedup similar insights for ~30s window
  let turnMode           = false;        // user must opt-in for [TURN] cues
  let pane               = null;   // the sidebar pane DOM element

  // ─── Styles ───────────────────────────────────────────────────────────────
  const STYLES = `
    @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@600;800&display=swap');

    #sca-root {
      display: flex; flex-direction: column;
      width: 100%; height: 100%;
      font-family: 'Syne', sans-serif;
      background: transparent; overflow: hidden;
    }

    /* ══════════════ IDLE SCREEN ══════════════ */
    #sca-idle {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 16px; padding: 20px 18px; text-align: center;
    }
    .sca-orb {
      width: 88px; height: 88px; border-radius: 50%;
      background: radial-gradient(circle at 35% 35%,
        rgba(124,58,237,0.35) 0%, rgba(6,182,212,0.18) 60%, rgba(10,10,20,0.95) 100%);
      border: 1.5px solid rgba(124,58,237,0.35);
      display: flex; align-items: center; justify-content: center;
      font-size: 32px; flex-shrink: 0;
      animation: sca-breathe 3.5s ease-in-out infinite;
    }
    @keyframes sca-breathe {
      0%,100% { box-shadow: 0 0 24px rgba(124,58,237,0.12); }
      50%      { box-shadow: 0 0 44px rgba(124,58,237,0.32); }
    }
    .sca-idle-title {
      font-size: 15px; font-weight: 800; color: #f0ecff; letter-spacing: -0.2px;
    }
    .sca-idle-desc {
      font-size: 11px; color: #6b7280; line-height: 1.65; max-width: 230px;
    }
    #sca-start-btn {
      width: 100%; padding: 13px 16px;
      background: linear-gradient(135deg, rgba(124,58,237,0.45), rgba(6,182,212,0.28));
      border: 1.5px solid rgba(124,58,237,0.55);
      border-radius: 13px; cursor: pointer;
      font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 800;
      color: #e0d7ff; letter-spacing: 0.02em;
      box-shadow: 0 0 20px rgba(124,58,237,0.2);
      transition: all 0.2s;
      display: flex; align-items: center; justify-content: center; gap: 9px;
    }
    #sca-start-btn:hover {
      background: linear-gradient(135deg, rgba(124,58,237,0.65), rgba(6,182,212,0.42));
      transform: translateY(-1px);
      box-shadow: 0 0 32px rgba(124,58,237,0.35);
    }
    #sca-start-btn:active  { transform: scale(0.97); }
    #sca-start-btn:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }
    .sca-privacy {
      font-size: 9px; color: #374151;
      font-family: 'DM Mono', monospace; line-height: 1.5;
    }

    /* ══════════════ ACTIVE SCREEN ══════════════ */
    #sca-active {
      display: none; flex-direction: column;
      width: 100%; height: 100%;
    }

    /* Header */
    #sca-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 11px 14px 9px; flex-shrink: 0;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      background: linear-gradient(180deg, rgba(124,58,237,0.08) 0%, transparent 100%);
    }
    .sca-hdr-left { display: flex; align-items: center; gap: 8px; }
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
    .sca-title    { font-size: 11px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: #f0ecff; }
    .sca-sub      { font-size: 9px; font-family: 'DM Mono', monospace; color: #4b5563; letter-spacing: 0.06em; }
    #sca-stop-btn {
      width: 26px; height: 26px; border-radius: 7px;
      border: 1px solid rgba(239,68,68,0.25);
      background: rgba(239,68,68,0.07); color: #f87171;
      font-size: 11px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.18s; flex-shrink: 0;
    }
    #sca-stop-btn:hover { background: rgba(239,68,68,0.18); border-color: rgba(239,68,68,0.5); }

    #sca-turn-btn {
      height: 26px; padding: 0 9px; border-radius: 7px;
      border: 1px solid rgba(124,58,237,0.25);
      background: rgba(124,58,237,0.07); color: #6b7280;
      font-size: 10px; font-family: 'DM Mono', monospace;
      letter-spacing: 0.04em; cursor: pointer;
      display: flex; align-items: center; gap: 5px;
      transition: all 0.18s; flex-shrink: 0; white-space: nowrap;
    }
    #sca-turn-btn:hover { background: rgba(124,58,237,0.15); color: #a78bfa; border-color: rgba(124,58,237,0.5); }
    #sca-turn-btn.on {
      background: rgba(124,58,237,0.22); color: #c4b5fd;
      border-color: rgba(124,58,237,0.7);
      box-shadow: 0 0 10px rgba(124,58,237,0.2);
    }
    .sca-turn-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: currentColor; flex-shrink: 0;
    }

    /* Status */
    #sca-status-bar {
      padding: 6px 14px; font-family: 'DM Mono', monospace;
      font-size: 10px; color: #374151;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      flex-shrink: 0; display: flex; align-items: center;
      gap: 6px; min-height: 28px; transition: color 0.3s;
    }
    #sca-status-bar.active { color: #06b6d4; }
    #sca-status-bar.error  { color: #f87171; }

    /* Waveform */
    #sca-wave {
      display: flex; align-items: center; justify-content: center;
      gap: 3px; padding: 7px 16px 4px; height: 28px; flex-shrink: 0;
    }
    .sca-bar {
      width: 3px; background: #1f1f2e; border-radius: 2px; height: 4px;
      transition: height 0.08s, background 0.3s;
    }
    #sca-wave.active .sca-bar {
      background: #7c3aed;
      animation: sca-wave-anim 1.4s ease-in-out infinite;
    }
    .sca-bar:nth-child(1) { animation-delay: 0s;   }
    .sca-bar:nth-child(2) { animation-delay: 0.1s; }
    .sca-bar:nth-child(3) { animation-delay: 0.2s; }
    .sca-bar:nth-child(4) { animation-delay: 0.3s; }
    .sca-bar:nth-child(5) { animation-delay: 0.4s; }
    .sca-bar:nth-child(6) { animation-delay: 0.3s; }
    .sca-bar:nth-child(7) { animation-delay: 0.2s; }
    .sca-bar:nth-child(8) { animation-delay: 0.1s; }
    .sca-bar:nth-child(9) { animation-delay: 0s;   }
    @keyframes sca-wave-anim { 0%,100% { height: 3px; } 50% { height: 16px; } }

    /* Source badges */
    #sca-sources {
      display: flex; gap: 6px; padding: 0 14px 8px; flex-shrink: 0;
    }
    .sca-badge {
      font-family: 'DM Mono', monospace; font-size: 9px; letter-spacing: 0.07em;
      text-transform: uppercase; padding: 2px 7px; border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.06); color: #374151;
      background: rgba(255,255,255,0.02); transition: all 0.3s;
    }
    .sca-badge.on        { border-color: rgba(6,182,212,0.4);   color: #06b6d4; background: rgba(6,182,212,0.06); }
    .sca-badge.vision-on { border-color: rgba(167,139,250,0.4); color: #a78bfa; background: rgba(167,139,250,0.06); }

    /* Feed */
    #sca-feed {
      flex: 1; overflow-y: auto; padding: 8px 12px 12px;
      display: flex; flex-direction: column; gap: 7px;
      scrollbar-width: thin; scrollbar-color: rgba(124,58,237,0.3) transparent;
    }
    #sca-feed::-webkit-scrollbar { width: 3px; }
    #sca-feed::-webkit-scrollbar-thumb { background: rgba(124,58,237,0.35); border-radius: 2px; }

    .sca-empty {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      color: #1f2937; font-family: 'DM Mono', monospace;
      font-size: 11px; line-height: 1.7;
      text-align: center; padding: 20px; gap: 8px;
    }
    .sca-empty-eye { font-size: 28px; opacity: 0.25; filter: grayscale(1); }

    /* Cards */
    .sca-card {
      border-radius: 10px; padding: 10px 12px;
      animation: sca-appear 0.3s cubic-bezier(0.16,1,0.3,1); flex-shrink: 0;
    }
    @keyframes sca-appear {
      from { opacity:0; transform: translateX(12px) scale(0.97); }
      to   { opacity:1; transform: translateX(0) scale(1); }
    }

    /* Card colours — one per tag type */
    .sca-card.directed  { background: rgba(96,165,250,0.11);  border: 1px solid rgba(96,165,250,0.40);  box-shadow: 0 0 12px rgba(96,165,250,0.08); }
    .sca-card.greeting  { background: rgba(52,211,153,0.07);  border: 1px solid rgba(52,211,153,0.22);  }
    .sca-card.humor     { background: rgba(251,191,36,0.07);  border: 1px solid rgba(251,191,36,0.28);  }
    .sca-card.celebrate { background: rgba(249,115,22,0.08);  border: 1px solid rgba(249,115,22,0.28);  }
    .sca-card.story     { background: rgba(139,92,246,0.07);  border: 1px solid rgba(139,92,246,0.22);  }
    .sca-card.screen    { background: rgba(167,139,250,0.07); border: 1px solid rgba(167,139,250,0.22); }
    .sca-card.emotion   { background: rgba(239,68,68,0.07);   border: 1px solid rgba(239,68,68,0.18);   }
    .sca-card.turn      { background: rgba(124,58,237,0.08);  border: 1px solid rgba(124,58,237,0.22);  }
    .sca-card.vibe      { background: rgba(6,182,212,0.06);   border: 1px solid rgba(6,182,212,0.18);   }
    .sca-card.farewell  { background: rgba(107,114,128,0.07); border: 1px solid rgba(107,114,128,0.22); }
    .sca-card.visual    { background: rgba(167,139,250,0.07); border: 1px solid rgba(167,139,250,0.18); }
    .sca-card.face      { background: rgba(251,191,36,0.06);  border: 1px solid rgba(251,191,36,0.22);  }
    .sca-card.note      { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); }

    .sca-card-tag {
      font-size: 9px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;
      font-family: 'DM Mono', monospace; margin-bottom: 5px;
    }
    .sca-card.directed  .sca-card-tag { color: #60a5fa; }
    .sca-card.greeting  .sca-card-tag { color: #34d399; }
    .sca-card.humor     .sca-card-tag { color: #fbbf24; }
    .sca-card.celebrate .sca-card-tag { color: #fb923c; }
    .sca-card.story     .sca-card-tag { color: #a78bfa; }
    .sca-card.screen    .sca-card-tag { color: #c4b5fd; }
    .sca-card.emotion   .sca-card-tag { color: #f87171; }
    .sca-card.turn      .sca-card-tag { color: #a78bfa; }
    .sca-card.vibe      .sca-card-tag { color: #22d3ee; }
    .sca-card.farewell  .sca-card-tag { color: #9ca3af; }
    .sca-card.visual    .sca-card-tag { color: #c4b5fd; }
    .sca-card.face      .sca-card-tag { color: #fbbf24; }
    .sca-card.note      .sca-card-tag { color: #6b7280; }

    .sca-card-text { font-size: 13px; font-weight: 600; color: #f0ecff; line-height: 1.45; }
    .sca-card-meta { display: flex; align-items: center; gap: 6px; margin-top: 5px; }
    .sca-card-time   { font-family: 'DM Mono', monospace; font-size: 9px; color: #2d2d3d; }
    .sca-card-source { font-family: 'DM Mono', monospace; font-size: 9px; color: #2d2d3d; }

    /* Footer */
    #sca-footer { padding: 8px 12px; border-top: 1px solid rgba(255,255,255,0.04); flex-shrink: 0; }
    #sca-clear-btn {
      width: 100%; background: transparent; border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px; padding: 6px; color: #2d2d3d;
      font-family: 'DM Mono', monospace; font-size: 9px;
      letter-spacing: 0.08em; text-transform: uppercase; cursor: pointer; transition: all 0.2s;
    }
    #sca-clear-btn:hover { border-color: rgba(239,68,68,0.3); color: #f87171; }
  `;

  // ─── HTML ─────────────────────────────────────────────────────────────────
  const HTML = `
    <div id="sca-root">

      <!-- IDLE -->
      <div id="sca-idle">
        <div class="sca-orb">🧠</div>
        <div class="sca-idle-title">Social Cue</div>
        <div class="sca-idle-desc">
          Your private social coach for video calls.
          Tells YOU when someone's talking to you,
          when it's your turn, and how the room feels.
        </div>
        <button id="sca-start-btn">
          <span style="font-size:17px">🎙</span>
          Start Session
        </button>
        <div class="sca-privacy">🔒 Private · No recording stored · Analysis only</div>
      </div>

      <!-- ACTIVE -->
      <div id="sca-active">
        <div id="sca-header">
          <div class="sca-hdr-left">
            <div id="sca-live-dot"></div>
            <div class="sca-wordmark">
              <div class="sca-title">Social Cue</div>
              <div class="sca-sub">AI · Live</div>
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <button id="sca-turn-btn" title="Toggle: alert me when it's my turn to speak">
              <span class="sca-turn-dot"></span>↩ My Turn
            </button>
            <button id="sca-stop-btn" title="Stop session">⏹</button>
          </div>
        </div>

        <div id="sca-status-bar">Connecting…</div>

        <div id="sca-wave">
          ${Array(9).fill('<div class="sca-bar"></div>').join('')}
        </div>

        <div id="sca-sources">
          <span class="sca-badge" id="sca-badge-mic">🎤 Mic</span>
          <span class="sca-badge" id="sca-badge-tab">🔊 Tab</span>
          <span class="sca-badge vision-on" id="sca-badge-vision">👁 Vision</span>
        </div>

        <div id="sca-feed">
          <div class="sca-empty">
            <div class="sca-empty-eye">👁</div>
            Observing your meeting.<br>Insights appear here.
          </div>
        </div>

        <div id="sca-footer">
          <button id="sca-clear-btn">Clear history</button>
        </div>
      </div>

    </div>
  `;

  // ─── Inject into sidebar pane ─────────────────────────────────────────────
  function inject() {
    pane = window.__accessai?.getSidebarPane('social-cue');
    if (!pane) { setTimeout(inject, 300); return; }
    if (pane.querySelector('#sca-root')) return;

    if (!document.getElementById('sca-sidebar-styles')) {
      const s = document.createElement('style');
      s.id = 'sca-sidebar-styles'; s.textContent = STYLES;
      document.head.appendChild(s);
    }

    pane.style.cssText = 'padding:0;overflow:hidden;display:flex;flex-direction:column;height:100%;';
    pane.innerHTML = HTML;

    pane.querySelector('#sca-start-btn').addEventListener('click', startAll);
    pane.querySelector('#sca-stop-btn').addEventListener('click', stopAll);
    pane.querySelector('#sca-clear-btn').addEventListener('click', clearFeed);
    pane.querySelector('#sca-turn-btn').addEventListener('click', () => {
      turnMode = !turnMode;
      const btn = pane.querySelector('#sca-turn-btn');
      btn.classList.toggle('on', turnMode);
      btn.title = turnMode
        ? 'Turn cues ON — click to disable'
        : 'Turn cues OFF — click to enable when you want to know when to speak';
    });
  }

  // ─── UI helpers ───────────────────────────────────────────────────────────
  function $(id)      { return pane?.querySelector('#' + id); }

  function showIdle() {
    const idle   = $('sca-idle');
    const active = $('sca-active');
    if (idle)   idle.style.display   = '';
    if (active) active.style.display = 'none';
    const btn = $('sca-start-btn');
    if (btn) { btn.innerHTML = '<span style="font-size:17px">🎙</span> Start Session'; btn.disabled = false; }
  }

  function showActive() {
    const idle   = $('sca-idle');
    const active = $('sca-active');
    if (idle)   idle.style.display   = 'none';
    if (active) active.style.display = 'flex';
  }

  function setStatus(msg, cls) {
    const el = $('sca-status-bar');
    if (!el) return;
    el.textContent = msg;
    el.className   = cls || '';
  }

  function clearFeed() {
    const feed = $('sca-feed');
    if (feed) {
      feed.innerHTML = '<div class="sca-empty"><div class="sca-empty-eye">👁</div>Observing your meeting.<br>Insights appear here.</div>';
      insightCount = 0;
    }
  }

  function resetToIdle(msg) {
    cleanup();
    showIdle();
    if (msg) {
      const desc = pane?.querySelector('.sca-idle-desc');
      if (desc) {
        desc.textContent = msg;
        setTimeout(() => { if (desc) desc.textContent = 'Real-time social intelligence for your call. Catches greetings, jokes, directed questions, your turn, emotional shifts — everything.'; }, 5000);
      }
    }
  }

  // ─── Start — identical flow to original content.js ────────────────────────
  async function startAll() {
    const btn = $('sca-start-btn');
    if (btn) { btn.innerHTML = '<span style="font-size:17px">⏳</span> Connecting…'; btn.disabled = true; }

    // 1. API key
    apiKey = await getApiKey();
    if (!apiKey) { resetToIdle('⚠ No API key — add it to background.js'); return; }

    userName = await getUserName();

    // 2. Screen + tab audio
    setStatus('Select your call window to share…', 'active');
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 5, width: 1280 },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (_) {
      resetToIdle('Screen share cancelled — tap Start to try again');
      return;
    }
    displayStream.getVideoTracks()[0]?.addEventListener('ended', () => { if (isListening) stopAll(); });

    // 3. Mic
    setStatus('Requesting microphone…', 'active');
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (_) {
      resetToIdle('Microphone denied — tap Start to try again');
      displayStream.getTracks().forEach(t => t.stop()); displayStream = null;
      return;
    }

    // 4. OpenAI Realtime WS
    setStatus('Connecting to OpenAI…', 'active');
    try { await connectWebSocket(); }
    catch (_) { resetToIdle('Connection failed — check your API key'); cleanup(); return; }

    // 5. Audio mixer
    setupAudioMixer();

    // 6. Vision loop
    setupVisionCapture();

    // 7. Update UI
    isListening = true;
    showActive();
    $('sca-live-dot')?.classList.add('audio-active');
    $('sca-wave')?.classList.add('active');
    $('sca-badge-mic')?.classList.add('on');
    $('sca-badge-tab')?.classList.add('on');
    $('sca-badge-vision')?.classList.add('on');
    setStatus('Listening to all participants…', 'active');
    window.__accessai?.setFooterStatus('Social Cue: live');
  }

  // ─── Stop ─────────────────────────────────────────────────────────────────
  function stopAll() {
    cleanup();
    isListening = false;
    showIdle();
    setStatus('Stopped', '');
    window.__accessai?.setFooterStatus('Social Cue: stopped');
  }

  function cleanup() {
    if (ws)           { try { ws.close(); }              catch(_){} ws = null; }
    if (visionInterval){ clearInterval(visionInterval);  visionInterval = null; }
    if (processorNode){ try { processorNode.disconnect();}catch(_){} processorNode = null; }
    if (audioCtx)     { try { audioCtx.close(); }        catch(_){} audioCtx = null; }
    if (displayStream){ displayStream.getTracks().forEach(t => t.stop()); displayStream = null; }
    if (micStream)    { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (hiddenVideo)  { hiddenVideo.srcObject = null; hiddenVideo.remove(); hiddenVideo = null; }
    currentResponseText = '';
    visionBusy = false;
    visionSeenSet.clear();
    turnMode = false;
  }

  // ─── WebSocket — verbatim from original content.js ────────────────────────
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
              threshold: 0.30,            // lower = more sensitive to quiet voices
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
            temperature: 0.6,
            max_response_output_tokens: 80,  // enough for complete 8-word insights
          },
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

  // ─── THE PROMPT ───────────────────────────────────────────────────────────
  function buildAudioPrompt() {
    return `You are a silent social coach whispering in ${userName}'s ear on a video call.

You hear ALL participants. Your ONLY job: flag moments that matter to ${userName} personally.

STRICT RULES:
- Stay completely silent during normal flowing conversation.
- NEVER infer or assume things you cannot hear — only flag what was clearly spoken.
- Only speak when something was ACTUALLY SAID that requires ${userName}'s attention.
- Max 8 words after the tag. Non-negotiable.
- Start with ONE tag: [DIRECTED], [TURN], [EMOTION], [VIBE], [GREETING], [HUMOR], [CELEBRATE], [STORY], [SCREEN], [FAREWELL], or [NOTE].

[DIRECTED] — someone addresses ${userName} by name, OR gives a direct instruction/command/question to anyone in the call that ${userName} should act on. This includes: "do the execution", "go back", "don't do that", "can you show me", "what do you think", "your turn".
[DIRECTED] Command given — "do the execution."
[DIRECTED] Instruction: "go back to the previous step."
[DIRECTED] Direct question — they want a response.
[DIRECTED] ${userName} addressed by name — respond.

[GREETING] Group or personal greeting ${userName} should acknowledge.
[GREETING] They greeted you — good time to respond.

[HUMOR] Clear laughter or joke — ${userName} should react.
[HUMOR] Room laughing — okay to smile and react.

[CELEBRATE] Achievement or congrats worth acknowledging.
[CELEBRATE] Good news shared — react positively.

[STORY] Personal story being shared — listen actively.
[STORY] Personal story — listen, don't interrupt.

[SCREEN] Screen share or demo just started.
[SCREEN] Screen share started — pay attention now.

[EMOTION] Clear emotional tone in voices that ${userName} must be aware of.
[EMOTION] Frustration in their voice — stay calm.
[EMOTION] Sarcasm detected — take it lightly.

[TURN] (Only shown if user enabled) — clear speaking gap for ${userName}.
[TURN] Natural pause — your turn to speak.
[TURN] They finished — space to respond now.

[VIBE] Noticeable mood shift in the whole group.
[VIBE] Energy dropped — check in gently.

[FAREWELL] ONLY when MULTIPLE people are collectively signing off and the meeting is clearly ending. NOT for one person saying bye casually.
[FAREWELL] Everyone signing off — time to say bye.

[NOTE] Only for things that were CLEARLY AND EXPLICITLY said — never guess or infer.
[NOTE] Someone explicitly said they'll follow up with you.
[NOTE] You were explicitly mentioned or talked over.

DO NOT use [NOTE] for silences, pauses, or anything you are inferring. Only flag spoken words.
Output NOTHING when conversation flows normally.`;
  }

  // ─── Handle Realtime messages — verbatim from original ────────────────────
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
          const txt = currentResponseText.trim();
          currentResponseText = '';
          // Filter out the model narrating silence
          if (!/^[-–—\s]+$/.test(txt) &&
              !/^(output nothing|silence|normal conversation|nothing|no insight)/i.test(txt) &&
              !/^\[NOTE\]\s*(uncomfortable silence|awkward silence|silence after|pause after)/i.test(txt)) {
            addCard(txt, 'audio');
          }
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

  // ─── Audio mixer — fixed channel routing + live level meter ─────────────
  function setupAudioMixer() {
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });

    // Master gain bus — everything feeds into this
    const masterGain = audioCtx.createGain();
    masterGain.gain.value = 1.0;

    // Mic source
    const micSource = audioCtx.createMediaStreamSource(micStream);
    const micGain   = audioCtx.createGain();
    micGain.gain.value = 1.0;
    micSource.connect(micGain);
    micGain.connect(masterGain);

    // Tab/speaker audio source
    const tabAudioTracks = displayStream.getAudioTracks();
    if (tabAudioTracks.length > 0) {
      const tabSource = audioCtx.createMediaStreamSource(new MediaStream(tabAudioTracks));
      const tabGain   = audioCtx.createGain();
      tabGain.gain.value = 1.0;
      tabSource.connect(tabGain);
      tabGain.connect(masterGain);
      $('sca-badge-tab')?.classList.add('on');
    } else {
      setStatus('⚠ No tab audio — share with audio enabled', 'error');
    }

    // ── Live audio level meter in status bar ──────────────────────────────
    // Shows actual RMS so user knows audio is flowing
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    masterGain.connect(analyser);
    const levelBuf = new Uint8Array(analyser.frequencyBinCount);
    let lastLevelUpdate = 0;
    const levelInterval = setInterval(() => {
      if (!isListening) { clearInterval(levelInterval); return; }
      analyser.getByteFrequencyData(levelBuf);
      const rms = Math.round(levelBuf.reduce((s, v) => s + v, 0) / levelBuf.length);
      const now = Date.now();
      if (now - lastLevelUpdate > 500) {
        lastLevelUpdate = now;
        const bars = Math.min(8, Math.floor(rms / 8));
        const meter = '▮'.repeat(bars) + '▯'.repeat(8 - bars);
        const statusEl = $('sca-status-bar');
        // Only update if not showing an important message
        if (statusEl && (statusEl.textContent.includes('insight') || statusEl.textContent.includes('Listening') || statusEl.textContent.includes('level'))) {
          const insightPart = insightCount > 0 ? `${insightCount} insight${insightCount !== 1 ? 's' : ''} · ` : '';
          statusEl.textContent = `${insightPart}audio: ${meter}`;
          statusEl.className = rms > 5 ? 'active' : '';
        }
      }
    }, 300);

    // ── Silent audio detector — warns if no real audio after 4s ─────────────
    // Teams desktop app on Windows often gives a silent audio track
    setTimeout(() => {
      if (!isListening) return;
      analyser.getByteFrequencyData(levelBuf);
      const avg = levelBuf.reduce((s, v) => s + v, 0) / levelBuf.length;
      if (avg < 1) {
        // Audio track connected but completely silent
        addCard('[NOTE] ⚠ No audio detected — if using Teams app, share the browser tab instead of the window, or check system audio settings.', 'audio');
        setStatus('⚠ Audio silent — see note below', 'error');
      }
    }, 4000);

    // ── PCM16 encoder → WebSocket ─────────────────────────────────────────
    processorNode = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
    processorNode.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const f32 = e.inputBuffer.getChannelData(0);
      const pcm = f32ToPCM16(f32);
      ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: bufToBase64(pcm.buffer),
      }));
    };

    masterGain.connect(processorNode);
    processorNode.connect(audioCtx.destination);
  }

  // ─── Vision: 2s snapshots → GPT-4o ────────────────────────────────────────
  function setupVisionCapture() {
    const videoTrack = displayStream.getVideoTracks()[0];
    if (!videoTrack) return;

    hiddenVideo = document.createElement('video');
    hiddenVideo.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    hiddenVideo.autoplay = true;
    hiddenVideo.muted    = true;
    hiddenVideo.playsInline = true;
    hiddenVideo.srcObject = new MediaStream([videoTrack]);
    document.body.appendChild(hiddenVideo);
    hiddenVideo.play().catch(() => {});

    setTimeout(() => {
      if (isListening) captureAndAnalyse();
      visionInterval = setInterval(() => { if (isListening) captureAndAnalyse(); }, VISION_INTERVAL);
    }, 3000);
  }

  async function captureAndAnalyse() {
    if (visionBusy || !hiddenVideo || hiddenVideo.readyState < 2 || hiddenVideo.videoWidth === 0) return;
    visionBusy = true;

    const W = 1280;
    const H = Math.round(1280 * (hiddenVideo.videoHeight / (hiddenVideo.videoWidth || 1280)));
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H || 720;
    canvas.getContext('2d').drawImage(hiddenVideo, 0, 0, canvas.width, canvas.height);
    const base64 = canvas.toDataURL('image/jpeg', 0.55).split(',')[1];

    // Flash vision dot — same as original
    const dot = $('sca-live-dot');
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
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: VISION_MODEL,
          max_tokens: 60,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: `You are observing a video call to help ${userName} read the room visually.

CRITICAL: The person named "${userName}" is the user you are helping — IGNORE their tile completely. Only observe OTHER participants.
If only "${userName}" is visible and no other people have cameras on: respond NONE.

For each OTHER participant you can see, assess:
- Looking away, on phone, eyes wandering → disengaged
- Yawning, eyes drooping, slouching → tired/sleepy
- Furrowed brow, tilting head → confused
- Frowning, tight jaw → frustrated/stressed
- Blank stare, glazed → bored/dull
- Smiling, leaning in, nodding → engaged/happy

Also flag UI events: hand raised icon, reaction emojis, muted person with mouth moving, new screen share.

If nothing notable or only ${userName} visible: NONE

ONE line, max 8 words:
[FACE] for another person's expression
[VISUAL] for UI events only

Examples:
[FACE] Other person looks away — disengaged.
[FACE] Participant appears confused — may need clarification.
[FACE] They're smiling — good energy.
[FACE] Someone yawning — looks tired.
[VISUAL] Hand raised — wants to speak.`,
              },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'low' } },
            ],
          }],
        }),
      });

      if (!res.ok) return;
      const json = await res.json();
      const text = (json.choices?.[0]?.message?.content || '').trim();
      if (!text || text === 'NONE') return;

      // Semantic dedup: normalise to a short key (first 4 words lowercased)
      const key = text.replace(/^\[(VISUAL|FACE)\]\s*/i, '').toLowerCase().split(/\s+/).slice(0, 4).join(' ');
      if (visionSeenSet.has(key)) return;

      // FACE reads expire after 20s (faces change), UI events after 30s
      const isFace = /^\[FACE\]/i.test(text);
      visionSeenSet.add(key);
      setTimeout(() => visionSeenSet.delete(key), isFace ? 20000 : 30000);

      lastVisionText = text;
      addCard(text, 'vision');
    } catch (e) {
      console.warn('[SCA Vision]', e.message);
    } finally {
      visionBusy = false;
    }
  }

  // ─── Add card — extended tag map, [TURN] gated behind turnMode ───────────
  function addCard(text, source) {
    const feed = $('sca-feed');
    if (!feed) return;
    feed.querySelector('.sca-empty')?.remove();

    const TAG_MAP = {
      'DIRECTED':  ['directed',  '🎯 Directed'],
      'GREETING':  ['greeting',  '👋 Greeting'],
      'HUMOR':     ['humor',     '😂 Humor'],
      'CELEBRATE': ['celebrate', '🎉 Celebrate'],
      'STORY':     ['story',     '📖 Story'],
      'SCREEN':    ['screen',    '🖥 Screen'],
      'EMOTION':   ['emotion',   '⚡ Emotion'],
      'TURN':      ['turn',      '↩ Your Turn'],
      'VIBE':      ['vibe',      '〜 Vibe'],
      'FAREWELL':  ['farewell',  '👋 Farewell'],
      'VISUAL':    ['visual',    '👁 Visual'],
      'FACE':      ['face',      '👤 Face Read'],
      'NOTE':      ['note',      '· Note'],
    };

    // Drop malformed/partial tags like "[DIRECT" or "[NOTE" without closing bracket
    if (/^\[[A-Z]+$/.test(text.trim()) || /^\[[A-Z]+\s*$/.test(text.trim())) return;

    let cssClass = 'note', tagLabel = '· Note', body = text;
    const match = text.match(/^\[([A-Z]+)\]\s*/i);
    if (match) {
      const key    = match[1].toUpperCase();
      body         = text.slice(match[0].length).trim();
      const mapped = TAG_MAP[key];
      if (mapped) { cssClass = mapped[0]; tagLabel = mapped[1]; }
      else        { cssClass = 'note'; tagLabel = '· ' + key; }
    } else if (source === 'vision') {
      cssClass = 'visual'; tagLabel = '👁 Visual';
    }

    // FAREWELL cooldown — can't fire more than once per 2 minutes
    if (cssClass === 'farewell') {
      const now = Date.now();
      if (addCard._lastFarewell && now - addCard._lastFarewell < 120000) return;
      addCard._lastFarewell = now;
    }

    // TURN cues only show when the user has opted in via the toggle
    if (cssClass === 'turn' && !turnMode) return;

    const time     = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const srcLabel = source === 'vision' ? '👁 vision' : '🎙 audio';
    insightCount++;

    const card = document.createElement('div');
    card.className = `sca-card ${cssClass}`;
    card.innerHTML =
      `<div class="sca-card-tag">${tagLabel}</div>` +
      `<div class="sca-card-text">${esc(body)}</div>` +
      `<div class="sca-card-meta">` +
        `<span class="sca-card-time">${time}</span>` +
        `<span class="sca-card-source">· ${srcLabel}</span>` +
      `</div>`;

    // Insert newest at top — same as original
    feed.insertBefore(card, feed.firstChild);

    const all = feed.querySelectorAll('.sca-card');
    if (all.length > 40) all[all.length - 1].remove();

    setStatus(`${insightCount} insight${insightCount !== 1 ? 's' : ''} captured`, 'active');
    window.__accessai?.setFooterStatus(`Social Cue: ${insightCount} insight${insightCount !== 1 ? 's' : ''}`);
  }

  // ─── Helpers — verbatim from original ─────────────────────────────────────
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

  function esc(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function getApiKey() {
    return new Promise(r => {
      try { chrome.runtime.sendMessage({ type: 'GET_API_KEY' }, res => {
        if (chrome.runtime.lastError) { r(null); return; }
        r(res?.key || null);
      }); } catch(_) { r(null); }
    });
  }

  function getUserName() {
    return new Promise(r => {
      try { chrome.runtime.sendMessage({ type: 'GET_USER_NAME' }, res => {
        if (chrome.runtime.lastError) { r('User'); return; }
        r(res?.name || 'User');
      }); } catch(_) { r('User'); }
    });
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────
  function tryInject() {
    // Re-inject if pane was cleared by a mode switch
    const p = window.__accessai?.getSidebarPane('social-cue');
    if (p && !p.querySelector('#sca-root')) pane = null;
    if (!pane || !pane.querySelector('#sca-root')) inject();
  }

  window.addEventListener('accessai-mode-changed', (e) => {
    if (e.detail.mode === 'social-cue') tryInject();
    else if (isListening) stopAll();
  });

  chrome.storage.local.get('activeMode', (r) => {
    if (!chrome.runtime.lastError && r.activeMode === 'social-cue') setTimeout(tryInject, 600);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'RESTORE_STATE' && msg.mode === 'social-cue') setTimeout(tryInject, 400);
  });

})();