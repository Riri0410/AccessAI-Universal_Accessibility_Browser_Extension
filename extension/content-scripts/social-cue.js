/**
 * Social Cue Assistant v2 - Content Script
 * Embedded natively into Google Meet's right panel
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  AUDIO PIPELINE                                             │
 * │  getDisplayMedia (video+audio) ──┐                          │
 * │                                  ├─ AudioContext mixer      │
 * │  getUserMedia (mic) ─────────────┘   ↓                      │
 * │                              ScriptProcessor → PCM16 →      │
 * │                              base64 → OpenAI Realtime WS    │
 * ├─────────────────────────────────────────────────────────────┤
 * │  VISION PIPELINE                                            │
 * │  getDisplayMedia video track ──→ hidden <video>             │
 * │  Every 8s: drawImage to canvas → JPEG base64               │
 * │  POST /v1/chat/completions (gpt-4o) → [VISUAL] insight      │
 * ├─────────────────────────────────────────────────────────────┤
 * │  UI                                                         │
 * │  Meet layout shrunk via CSS → SCA panel injected right side │
 * └─────────────────────────────────────────────────────────────┘
 */

(function () {
  'use strict';

  // ─── Config ───────────────────────────────────────────────────────────────
  const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';
  const VISION_MODEL = 'gpt-4o';
  const SAMPLE_RATE = 24000;
  const BUFFER_SIZE = 4096;
  const VISION_INTERVAL_MS = 8000;
  const PANEL_WIDTH = 300;

  // ─── State ────────────────────────────────────────────────────────────────
  let ws = null;
  let audioCtx = null;
  let displayStream = null;   // getDisplayMedia stream (video + tab audio)
  let micStream = null;       // getUserMedia stream (mic)
  let processorNode = null;
  let visionInterval = null;
  let hiddenVideo = null;     // offscreen video element for frame capture
  let isListening = false;
  let userName = 'User';
  let apiKey = null;
  let insightCount = 0;
  let currentResponseText = '';

  // ─── Inject panel into Meet's layout ─────────────────────────────────────
  function injectPanel() {
    if (document.getElementById('sca-root')) return;

    // Wait for Meet's main container
    const meetRoot = document.querySelector('[jscontroller][data-use-native-client-navigation]')
                  || document.querySelector('c-wiz')
                  || document.body;

    // ── Styles (injected as a <style> tag so no separate CSS file needed) ──
    const style = document.createElement('style');
    style.id = 'sca-styles';
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@600;800&display=swap');

      /* ── Root panel — lives inside AccessAI sidebar pane ── */
      #sca-root {
        position: relative;
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        font-family: 'Syne', sans-serif;
        background: transparent;
      }

      /* ── Header ── */
      #sca-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.05);
        flex-shrink: 0;
        background: linear-gradient(180deg, rgba(124,58,237,0.08) 0%, transparent 100%);
      }

      .sca-header-left {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      #sca-live-dot {
        width: 8px; height: 8px;
        border-radius: 50%;
        background: #374151;
        flex-shrink: 0;
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

      .sca-wordmark {
        display: flex; flex-direction: column; gap: 1px;
      }
      .sca-title {
        font-size: 12px; font-weight: 800;
        letter-spacing: 0.1em; text-transform: uppercase;
        color: #f0ecff;
      }
      .sca-subtitle {
        font-size: 9px; font-family: 'DM Mono', monospace;
        color: #4b5563; letter-spacing: 0.06em;
      }

      .sca-header-actions { display: flex; gap: 6px; align-items: center; }

      .sca-icon-btn {
        width: 28px; height: 28px;
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.07);
        background: rgba(255,255,255,0.03);
        color: #6b7280; font-size: 13px;
        cursor: pointer; display: flex;
        align-items: center; justify-content: center;
        transition: all 0.18s; flex-shrink: 0;
      }
      .sca-icon-btn:hover {
        background: rgba(255,255,255,0.08);
        color: #e0d7ff;
        border-color: rgba(124,58,237,0.4);
      }
      .sca-icon-btn.sca-start-btn.active {
        background: rgba(124,58,237,0.18);
        border-color: #7c3aed;
        color: #c4b5fd;
      }

      /* ── Status bar ── */
      #sca-status-bar {
        padding: 8px 16px;
        font-family: 'DM Mono', monospace;
        font-size: 10px;
        color: #374151;
        border-bottom: 1px solid rgba(255,255,255,0.04);
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 32px;
        transition: color 0.3s;
      }
      #sca-status-bar.active { color: #06b6d4; }
      #sca-status-bar.error  { color: #f87171; }
      #sca-status-bar.vision { color: #a78bfa; }

      /* ── Waveform ── */
      #sca-wave {
        display: flex; align-items: center;
        justify-content: center; gap: 3px;
        padding: 10px 16px 6px;
        height: 36px; flex-shrink: 0;
      }
      .sca-bar {
        width: 3px; background: #1f1f2e;
        border-radius: 2px; height: 4px;
        transition: height 0.08s, background 0.3s;
      }
      #sca-wave.active .sca-bar {
        background: #7c3aed;
        animation: sca-wave 1.4s ease-in-out infinite;
      }
      .sca-bar:nth-child(1)  { animation-delay: 0s;    }
      .sca-bar:nth-child(2)  { animation-delay: 0.1s;  }
      .sca-bar:nth-child(3)  { animation-delay: 0.2s;  }
      .sca-bar:nth-child(4)  { animation-delay: 0.3s;  }
      .sca-bar:nth-child(5)  { animation-delay: 0.4s;  }
      .sca-bar:nth-child(6)  { animation-delay: 0.3s;  }
      .sca-bar:nth-child(7)  { animation-delay: 0.2s;  }
      .sca-bar:nth-child(8)  { animation-delay: 0.1s;  }
      .sca-bar:nth-child(9)  { animation-delay: 0s;    }

      @keyframes sca-wave {
        0%,100% { height: 3px; }
        50%      { height: 18px; }
      }

      /* ── Source badges ── */
      #sca-sources {
        display: flex; gap: 6px; padding: 0 16px 10px;
        flex-shrink: 0;
      }
      .sca-badge {
        font-family: 'DM Mono', monospace;
        font-size: 9px; letter-spacing: 0.07em;
        text-transform: uppercase;
        padding: 3px 7px; border-radius: 4px;
        border: 1px solid rgba(255,255,255,0.06);
        color: #374151; background: rgba(255,255,255,0.02);
        transition: all 0.3s;
      }
      .sca-badge.on {
        border-color: rgba(6,182,212,0.4);
        color: #06b6d4;
        background: rgba(6,182,212,0.06);
      }
      .sca-badge.vision-on {
        border-color: rgba(167,139,250,0.4);
        color: #a78bfa;
        background: rgba(167,139,250,0.06);
      }

      /* ── Feed ── */
      #sca-feed {
        flex: 1;
        overflow-y: auto;
        padding: 8px 12px 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        scrollbar-width: thin;
        scrollbar-color: rgba(124,58,237,0.3) transparent;
      }
      #sca-feed::-webkit-scrollbar { width: 3px; }
      #sca-feed::-webkit-scrollbar-thumb { background: rgba(124,58,237,0.35); border-radius: 2px; }

      /* ── Empty state ── */
      .sca-empty {
        flex: 1; display: flex;
        flex-direction: column;
        align-items: center; justify-content: center;
        color: #1f2937;
        font-family: 'DM Mono', monospace;
        font-size: 11px; line-height: 1.7;
        text-align: center; padding: 20px;
        gap: 8px;
      }
      .sca-empty-eye {
        font-size: 28px; opacity: 0.25;
        filter: grayscale(1);
      }

      /* ── Insight cards ── */
      .sca-card {
        border-radius: 10px;
        padding: 10px 12px;
        position: relative;
        overflow: hidden;
        animation: sca-appear 0.3s cubic-bezier(0.16,1,0.3,1);
        flex-shrink: 0;
      }
      @keyframes sca-appear {
        from { opacity:0; transform: translateX(12px) scale(0.97); }
        to   { opacity:1; transform: translateX(0) scale(1); }
      }

      .sca-card.emotion { background: rgba(239,68,68,0.07);   border: 1px solid rgba(239,68,68,0.15);   }
      .sca-card.turn    { background: rgba(124,58,237,0.08);  border: 1px solid rgba(124,58,237,0.2);   }
      .sca-card.vibe    { background: rgba(6,182,212,0.06);   border: 1px solid rgba(6,182,212,0.15);   }
      .sca-card.visual  { background: rgba(167,139,250,0.07); border: 1px solid rgba(167,139,250,0.18); }
      .sca-card.note    { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); }

      .sca-card-tag {
        font-size: 9px; font-weight: 600;
        letter-spacing: 0.12em; text-transform: uppercase;
        font-family: 'DM Mono', monospace;
        margin-bottom: 5px;
      }
      .emotion .sca-card-tag { color: #f87171; }
      .turn    .sca-card-tag { color: #a78bfa; }
      .vibe    .sca-card-tag { color: #22d3ee; }
      .visual  .sca-card-tag { color: #c4b5fd; }
      .note    .sca-card-tag { color: #6b7280; }

      .sca-card-text {
        font-size: 13px; font-weight: 600;
        color: #f0ecff; line-height: 1.45;
      }

      .sca-card-meta {
        display: flex; align-items: center;
        gap: 6px; margin-top: 5px;
      }
      .sca-card-time {
        font-family: 'DM Mono', monospace;
        font-size: 9px; color: #2d2d3d;
      }
      .sca-card-source {
        font-family: 'DM Mono', monospace;
        font-size: 9px; color: #2d2d3d;
      }

      /* ── Footer ── */
      #sca-footer {
        padding: 10px 12px;
        border-top: 1px solid rgba(255,255,255,0.04);
        flex-shrink: 0;
      }
      #sca-clear-btn {
        width: 100%;
        background: transparent;
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 8px;
        padding: 7px;
        color: #2d2d3d;
        font-family: 'DM Mono', monospace;
        font-size: 10px; letter-spacing: 0.07em;
        text-transform: uppercase;
        cursor: pointer;
        transition: all 0.2s;
      }
      #sca-clear-btn:hover {
        border-color: rgba(239,68,68,0.3);
        color: #f87171;
      }

      /* FAB removed — AccessAI sidebar handles panel visibility */
    `;
    document.head.appendChild(style);

    // ── Build panel DOM ──
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
        <div class="sca-header-actions">
          <button class="sca-icon-btn sca-start-btn" id="sca-start-btn" title="Start / Stop">🎙</button>
          <button class="sca-icon-btn" id="sca-hide-btn" title="Hide panel">✕</button>
        </div>
      </div>

      <div id="sca-status-bar">Ready — click 🎙 to begin</div>

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
          Observing your meeting.<br>
          Insights appear here.
        </div>
      </div>

      <div id="sca-footer">
        <button id="sca-clear-btn">Clear history</button>
      </div>
    `;

    // Mount inside AccessAI sidebar pane (not as a floating overlay)
    const pane = window.__accessai?.getSidebarPane('social-cue');
    if (pane) {
      pane.style.padding = '0';
      pane.style.overflow = 'hidden';
      pane.appendChild(root);
    } else {
      // Fallback: standalone mode
      root.style.cssText = 'position:fixed;top:0;right:0;width:300px;height:100vh;z-index:2147483647;background:#0c0c14;display:flex;flex-direction:column;font-family:Syne,sans-serif;';
      document.body.appendChild(root);
    }

    bindUI();
  }

  // ─── Bind UI ──────────────────────────────────────────────────────────────
  function bindUI() {
    document.getElementById('sca-start-btn').addEventListener('click', toggleListening);
    // Hide button: AccessAI sidebar manages its own open/close — just hide it
    const hideBtn = document.getElementById('sca-hide-btn');
    if (hideBtn) hideBtn.style.display = 'none';
    document.getElementById('sca-clear-btn').addEventListener('click', () => {
      const feed = document.getElementById('sca-feed');
      feed.innerHTML = `<div class="sca-empty"><div class="sca-empty-eye">👁</div>Observing your meeting.<br>Insights appear here.</div>`;
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
    if (!apiKey) { setStatus('⚠ No API key — open extension popup', 'error'); return; }
    userName = await getUserName();

    // ── 1. Screen + tab audio capture ──
    setStatus('Select your Meet window to share…', 'active');
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 5, width: 1280 },  // low framerate — we only need snapshots
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      });
    } catch (err) {
      setStatus('Screen share cancelled or denied', 'error');
      return;
    }

    // If user stops screenshare from browser UI
    displayStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (isListening) stopAll();
    });

    // ── 2. Mic capture ──
    setStatus('Requesting microphone…', 'active');
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });
    } catch (err) {
      setStatus('Microphone denied', 'error');
      displayStream.getTracks().forEach(t => t.stop());
      return;
    }

    // ── 3. Connect OpenAI Realtime ──
    setStatus('Connecting to OpenAI…', 'active');
    try {
      await connectWebSocket();
    } catch (err) {
      setStatus('WS connection failed', 'error');
      cleanup();
      return;
    }

    // ── 4. Set up audio mixer → Realtime stream ──
    setupAudioMixer();

    // ── 5. Start vision loop ──
    setupVisionCapture();

    // ── 6. Update UI ──
    isListening = true;
    document.getElementById('sca-start-btn').classList.add('active');
    document.getElementById('sca-start-btn').textContent = '⏹';
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

    const startBtn = document.getElementById('sca-start-btn');
    if (startBtn) { startBtn.classList.remove('active'); startBtn.textContent = '🎙'; }
    const dot = document.getElementById('sca-live-dot');
    if (dot) dot.classList.remove('audio-active', 'vision-flash');
    const wave = document.getElementById('sca-wave');
    if (wave) wave.classList.remove('active');
    document.getElementById('sca-badge-mic')?.classList.remove('on');
    document.getElementById('sca-badge-tab')?.classList.remove('on');
    setStatus('Stopped', '');
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

  // ─── WebSocket (OpenAI Realtime) ──────────────────────────────────────────
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

  function buildAudioPrompt() {
    return `You are a silent Social Intelligence Coach in ${userName}'s Google Meet call.

You hear ALL participants (their voices + ${userName}'s mic mixed together).

RULES:
- Stay completely silent during normal conversation.
- Only speak when you detect something significant: emotional shift, tension, awkward silence, crosstalk, sarcasm, disengagement, or a clear turn-taking gap.
- Max 6 words per insight. Non-negotiable.
- Start with ONE tag: [EMOTION], [TURN], [VIBE], or [NOTE].
- Never name ${userName}. Never suggest what to say.

EXAMPLES:
[TURN] Expectant silence — they're waiting.
[EMOTION] Frustration creeping in.
[VIBE] Energy dropped sharply.
[NOTE] Two voices overlapping.
[TURN] Natural opening to speak.
[EMOTION] Sarcasm detected.

Output nothing if conversation flows normally.`;
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
          addCard(currentResponseText.trim(), 'audio');
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
  // Merges tab audio + mic into one mono stream, resamples to 24kHz, sends PCM16
  function setupAudioMixer() {
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });

    const destination = audioCtx.createChannelMerger(1);
    const gainMic = audioCtx.createGain();
    const gainTab = audioCtx.createGain();
    gainMic.gain.value = 1.0;
    gainTab.gain.value = 1.0;

    // Mic source
    const micSource = audioCtx.createMediaStreamSource(micStream);
    micSource.connect(gainMic);

    // Tab audio source (from displayStream)
    const tabAudioTracks = displayStream.getAudioTracks();
    if (tabAudioTracks.length > 0) {
      const tabSource = audioCtx.createMediaStreamSource(
        new MediaStream(tabAudioTracks)
      );
      tabSource.connect(gainTab);
      gainTab.connect(destination, 0, 0);
    } else {
      setStatus('⚠ No tab audio — share with audio enabled', 'error');
    }

    gainMic.connect(destination, 0, 0);

    // ScriptProcessor reads mixed output
    processorNode = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
    processorNode.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const f32 = e.inputBuffer.getChannelData(0);
      const pcm = f32ToPCM16(f32);
      ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: bufToBase64(pcm.buffer)
      }));
    };

    destination.connect(processorNode);
    processorNode.connect(audioCtx.destination);
  }

  // ─── Vision: capture display frame → GPT-4o ──────────────────────────────
  function setupVisionCapture() {
    const videoTrack = displayStream.getVideoTracks()[0];
    if (!videoTrack) return;

    // Create a hidden video element to render the display stream
    hiddenVideo = document.createElement('video');
    hiddenVideo.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    hiddenVideo.autoplay = true;
    hiddenVideo.muted = true;
    hiddenVideo.playsInline = true;
    hiddenVideo.srcObject = new MediaStream([videoTrack]);
    document.body.appendChild(hiddenVideo);
    hiddenVideo.play().catch(() => {});

    // Fire immediately after a short delay, then every VISION_INTERVAL_MS
    setTimeout(() => {
      captureAndAnalyse();
      visionInterval = setInterval(captureAndAnalyse, VISION_INTERVAL_MS);
    }, 3000);
  }

  async function captureAndAnalyse() {
    if (!hiddenVideo || hiddenVideo.readyState < 2) return;
    if (!apiKey) return;

    // Draw current video frame to canvas
    const W = 1280, H = Math.round(1280 * (hiddenVideo.videoHeight / (hiddenVideo.videoWidth || 1280)));
    const canvas = document.createElement('canvas');
    canvas.width = W || 1280;
    canvas.height = H || 720;
    const ctx2d = canvas.getContext('2d');
    ctx2d.drawImage(hiddenVideo, 0, 0, canvas.width, canvas.height);
    const jpeg = canvas.toDataURL('image/jpeg', 0.55);
    const base64 = jpeg.split(',')[1];

    // Flash vision indicator
    const dot = document.getElementById('sca-live-dot');
    if (dot) {
      dot.classList.remove('audio-active');
      dot.classList.add('vision-flash');
      setTimeout(() => {
        dot.classList.remove('vision-flash');
        if (isListening) dot.classList.add('audio-active');
      }, 600);
    }

    // Send to GPT-4o Vision
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: VISION_MODEL,
          max_tokens: 60,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: `You are observing ${userName}'s Google Meet call. This is a screenshot of the full meeting window showing all participants and any screenshare.

Describe ONLY significant social/visual cues you see. Examples:
- Someone looks disengaged or distracted
- Visible frustration or confusion on faces  
- Screenshare showing key content worth noting
- Someone has their hand raised or is trying to speak
- Significant body language shift

If everything looks normal, respond with exactly: NONE

Otherwise respond with ONE insight, max 7 words, starting with [VISUAL].
Example: [VISUAL] Someone appears confused or zoned out.`
              },
              {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'low' }
              }
            ]
          }]
        })
      });

      const json = await res.json();
      const text = json.choices?.[0]?.message?.content?.trim();
      if (text && text !== 'NONE' && text.length > 0) {
        addCard(text, 'vision');
      }
      setStatus(`${insightCount} insight${insightCount !== 1 ? 's' : ''} captured`, 'active');
    } catch (err) {
      console.error('[SCA Vision]', err);
    }
  }

  // ─── Render insight card ──────────────────────────────────────────────────
  function addCard(text, source) {
    const feed = document.getElementById('sca-feed');
    if (!feed) return;

    // Remove empty state
    feed.querySelector('.sca-empty')?.remove();

    // Parse tag
    let type = 'note', tag = 'Note', body = text;
    const tagMatch = text.match(/^\[(EMOTION|TURN|VIBE|NOTE|VISUAL)\]\s*/i);
    if (tagMatch) {
      const t = tagMatch[1].toUpperCase();
      body = text.slice(tagMatch[0].length).trim();
      if (t === 'EMOTION') { type = 'emotion'; tag = 'Emotion'; }
      else if (t === 'TURN')    { type = 'turn';    tag = 'Turn';    }
      else if (t === 'VIBE')    { type = 'vibe';    tag = 'Vibe';    }
      else if (t === 'VISUAL')  { type = 'visual';  tag = 'Visual';  }
      else                      { type = 'note';    tag = 'Note';    }
    } else if (source === 'vision') {
      type = 'visual'; tag = 'Visual';
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

    feed.insertBefore(card, feed.firstChild);

    // Cap history at 30
    const all = feed.querySelectorAll('.sca-card');
    if (all.length > 30) all[all.length - 1].remove();

    setStatus(`${insightCount} insight${insightCount !== 1 ? 's' : ''} captured`, 'active');
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function setStatus(msg, cls) {
    const el = document.getElementById('sca-status-bar');
    if (!el) return;
    el.textContent = msg;
    el.className = cls ? `${cls}` : '';
  }

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

  // ─── Boot: wait for Meet to load ─────────────────────────────────────────
  function boot() {
    // Meet loads its UI dynamically; wait for the main video container
    const check = () => {
      // Meet is ready when it has its main layout element
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

  // ─── AccessAI lifecycle integration ──────────────────────────────────────
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
