
(function () {
  'use strict';

  const SAMPLE_RATE   = 24000;
  const BUFFER_SIZE   = 4096;
  const REALTIME_URL  = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

  let paneEl      = null;
  let feedEl      = null;
  let initialized = false;
  let isActive    = false;

  let ws            = null;
  let micStream     = null;
  let audioCtx      = null;
  let processorNode = null;
  let apiKey        = null;
  let cardCount     = 0;
  let currentText   = '';

  // ─── Init pane ────────────────────────────────────────────
  function initPane() {
    if (initialized) return;
    const pane = window.__accessai?.getSidebarPane('clear-context');
    if (!pane) { setTimeout(initPane, 200); return; }

    initialized = true;
    paneEl = pane;

    paneEl.innerHTML = `
      <div class="acc-hero-wrap" id="acc-hero">
        <div class="aai-start-hero">
          <button class="aai-start-orb aai-start-orb-cc" id="acc-start-orb" aria-label="Start ClearContext">
            <span class="aai-orb-ring aai-orb-ring-1"></span>
            <span class="aai-orb-ring aai-orb-ring-2"></span>
            <span class="aai-orb-ring aai-orb-ring-3"></span>
            <span class="aai-orb-core">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
              </svg>
            </span>
          </button>
          <div class="aai-start-label">Start ClearContext</div>
          <div class="aai-start-sublabel">Listens and shows simple explanations of what's being taught</div>
        </div>
      </div>

      <div class="acc-feed" id="acc-feed" role="log" aria-live="polite" style="display:none;"></div>

      <div class="acc-footer" id="acc-footer" style="display:none;">
        <button class="acc-clear-btn" id="acc-clear">Clear</button>
      </div>

      <style>
        .aai-start-orb-cc .aai-orb-core { background: linear-gradient(135deg, #059669, #10b981); }
        .aai-start-orb-cc .aai-orb-ring-1 { border-color: rgba(16,185,129,0.5); }
        .aai-start-orb-cc .aai-orb-ring-2 { border-color: rgba(16,185,129,0.3); }
        .aai-start-orb-cc .aai-orb-ring-3 { border-color: rgba(16,185,129,0.15); }

        .acc-feed {
          flex: 1;
          overflow-y: auto;
          padding: 10px 14px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          scrollbar-width: thin;
          scrollbar-color: rgba(16,185,129,0.3) transparent;
        }
        .acc-feed::-webkit-scrollbar { width: 3px; }
        .acc-feed::-webkit-scrollbar-thumb { background: rgba(16,185,129,0.3); border-radius: 2px; }

        .acc-card {
          background: rgba(16,185,129,0.06);
          border: 1px solid rgba(16,185,129,0.18);
          border-radius: 10px;
          padding: 10px 13px;
          animation: acc-pop 0.25s cubic-bezier(0.16,1,0.3,1);
          flex-shrink: 0;
        }
        @keyframes acc-pop {
          from { opacity: 0; transform: translateY(6px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .acc-card-text {
          font-size: 13px;
          font-weight: 500;
          color: #e2faf2;
          line-height: 1.5;
        }
        .acc-card-meta {
          margin-top: 5px;
          font-size: 9px;
          color: #374151;
          font-family: monospace;
          letter-spacing: 0.04em;
        }

        .acc-footer {
          padding: 10px 14px;
          border-top: 1px solid rgba(255,255,255,0.04);
          flex-shrink: 0;
        }
        .acc-clear-btn {
          width: 100%;
          background: transparent;
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 8px;
          padding: 7px;
          color: #374151;
          font-family: monospace;
          font-size: 10px;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          cursor: pointer;
          transition: all 0.2s;
        }
        .acc-clear-btn:hover {
          border-color: rgba(239,68,68,0.3);
          color: #f87171;
        }
      </style>
    `;

    feedEl = document.getElementById('acc-feed');
    document.getElementById('acc-start-orb').addEventListener('click', toggleAssistant);
    document.getElementById('acc-clear').addEventListener('click', () => {
      if (feedEl) feedEl.innerHTML = '';
      cardCount = 0;
      window.__accessai?.setFooterStatus('');
    });
  }

  // ─── Toggle ───────────────────────────────────────────────
  async function toggleAssistant() { isActive ? stop() : await start(); }

  // ─── Start ────────────────────────────────────────────────
  async function start() {
    const orb   = document.getElementById('acc-start-orb');
    const label = paneEl?.querySelector('.aai-start-label');
    const sub   = paneEl?.querySelector('.aai-start-sublabel');
    orb.classList.add('aai-orb-connecting');
    if (label) label.textContent = 'Connecting…';

    // API key
    const keyResp = await msg({ type: 'API_REALTIME_SESSION' });
    if (!keyResp?.success) {
      orb.classList.remove('aai-orb-connecting');
      if (label) label.textContent = 'Start ClearContext';
      addCard('⚠ No API key — open extension popup');
      return;
    }
    apiKey = keyResp.apiKey;

    // Mic
    if (label) label.textContent = 'Requesting mic…';
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: SAMPLE_RATE, channelCount: 1 }
      });
    } catch (e) {
      orb.classList.remove('aai-orb-connecting');
      if (label) label.textContent = 'Start ClearContext';
      addCard('⚠ Microphone access denied');
      return;
    }

    // WebSocket
    if (label) label.textContent = 'Connecting to AI…';
    try { await connectWS(); } catch (e) {
      cleanup();
      orb.classList.remove('aai-orb-connecting');
      if (label) label.textContent = 'Start ClearContext';
      addCard('⚠ Connection failed — check API key');
      return;
    }

    setupAudio();

    isActive = true;
    orb.classList.remove('aai-orb-connecting');
    orb.classList.add('aai-orb-active');
    if (label) label.textContent = 'Listening…';
    if (sub)   sub.textContent = 'Tap to stop';
    document.getElementById('acc-hero')?.classList.add('aai-hero-compact');
    feedEl.style.display = '';
    document.getElementById('acc-footer').style.display = '';
    window.__accessai?.setFooterStatus('ClearContext: Listening…');
  }

  // ─── Stop ─────────────────────────────────────────────────
  function stop() {
    isActive = false;
    cleanup();
    const orb   = document.getElementById('acc-start-orb');
    const label = paneEl?.querySelector('.aai-start-label');
    const sub   = paneEl?.querySelector('.aai-start-sublabel');
    orb?.classList.remove('aai-orb-connecting', 'aai-orb-active');
    if (label) label.textContent = 'Start ClearContext';
    if (sub)   sub.textContent = 'Listens and shows simple explanations of what\'s being taught';
    document.getElementById('acc-hero')?.classList.remove('aai-hero-compact');
    window.__accessai?.setFooterStatus('ClearContext stopped');
  }

  function cleanup() {
    if (ws)            { try { ws.close(); }              catch(e){} ws = null; }
    if (processorNode) { try { processorNode.disconnect();} catch(e){} processorNode = null; }
    if (audioCtx)      { try { audioCtx.close(); }        catch(e){} audioCtx = null; }
    if (micStream)     { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  }

  // ─── WebSocket ────────────────────────────────────────────
  function connectWS() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { try { ws?.close(); } catch(e){} reject(); }, 12000);

      ws = new WebSocket(REALTIME_URL,
        ['realtime', `openai-insecure-api-key.${apiKey}`, 'openai-beta.realtime-v1']
      );

      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text'],   // TEXT ONLY — no audio output, no speaking
            instructions: buildPrompt(),
            input_audio_format: 'pcm16',
            turn_detection: {
              type: 'server_vad',
              threshold: 0.4,
              prefix_padding_ms: 300,
              silence_duration_ms: 1200,  // wait for a full sentence/thought
            },
            temperature: 0.5,
            max_response_output_tokens: 60,  // short cards only
          }
        }));
        resolve();
      });

      ws.addEventListener('error', () => { clearTimeout(timeout); reject(); });
      ws.addEventListener('message', handleWS);

      // Reconnect on unexpected close (don't kill the session)
      ws.addEventListener('close', () => {
        if (!isActive) return;
        setTimeout(async () => {
          if (!isActive) return;
          try {
            await connectWS();
            rebuildAudio();
          } catch(e) { stop(); }
        }, 2000);
      });
    });
  }

  function buildPrompt() {
    return `You are ClearContext, a silent educational assistant.

You listen to a lecture, class, meeting, or video lesson through the microphone.

YOUR ONLY JOB:
When you hear a concept, topic, term, or explanation being taught, output ONE short simplified phrase (max 20 words, plain simple English, grade 5 reading level) that captures the key idea in the simplest possible way.

FORMAT: Just the plain phrase. No bullet points. No labels. No markdown. No quotes.

RULES:
- Max 20 words. Hard limit.
- Plain everyday English only. No jargon.
- One phrase per topic/concept heard.
- If the speaker is just saying filler words, chatting casually, or nothing educational is happening — output exactly: SKIP
- Never speak. Never ask questions. Only output simplified phrases or SKIP.

GOOD EXAMPLES (for what you'd hear in class):
"Photosynthesis is how plants turn sunlight into food they can use to grow."
"A function is a reusable block of code that does one specific job."
"Supply and demand means prices go up when something is rare and wanted."
"The mitochondria makes energy the cell needs to stay alive and work."

Output SKIP for filler, greetings, off-topic chat, or silence.`;
  }

  // ─── WS message handler ───────────────────────────────────
  function handleWS(event) {
    let data; try { data = JSON.parse(event.data); } catch { return; }

    switch (data.type) {
      case 'response.text.delta':
        currentText += data.delta || '';
        break;

      case 'response.text.done':
      case 'response.done': {
        const text = currentText.trim();
        currentText = '';
        if (!text || text === 'SKIP' || text.toUpperCase() === 'SKIP') break;
        // Extra guard: skip if AI accidentally output "SKIP" in a sentence
        if (text.length < 4) break;
        addCard(text);
        break;
      }

      case 'input_audio_buffer.speech_started':
        window.__accessai?.setFooterStatus('ClearContext: Listening…');
        document.getElementById('acc-start-orb')?.classList.add('aai-orb-speaking');
        break;

      case 'input_audio_buffer.speech_stopped':
        document.getElementById('acc-start-orb')?.classList.remove('aai-orb-speaking');
        break;

      case 'error':
        // Non-fatal — just log to console, don't show to user
        console.warn('[ClearContext] API error:', data.error?.code || data.error?.message);
        break;
    }
  }

  // ─── Audio pipeline ───────────────────────────────────────
  function setupAudio() {
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = audioCtx.createMediaStreamSource(micStream);
    processorNode = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
    processorNode.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const f32 = e.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      const bytes = new Uint8Array(pcm.buffer); let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(bin) }));
    };
    source.connect(processorNode);
    processorNode.connect(audioCtx.destination);
  }

  function rebuildAudio() {
    if (processorNode) { try { processorNode.disconnect(); } catch(e){} processorNode = null; }
    if (audioCtx)      { try { audioCtx.close(); }          catch(e){} audioCtx = null; }
    if (micStream) setupAudio();
  }

  // ─── Render card ──────────────────────────────────────────
  function addCard(text) {
    if (!feedEl) return;
    cardCount++;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const card = document.createElement('div');
    card.className = 'acc-card';
    card.innerHTML = `
      <div class="acc-card-text">${escHtml(text)}</div>
      <div class="acc-card-meta">${time}</div>
    `;
    feedEl.appendChild(card);
    feedEl.scrollTop = feedEl.scrollHeight;

    // Cap at 60 cards
    while (feedEl.children.length > 60) feedEl.removeChild(feedEl.firstChild);

    window.__accessai?.setFooterStatus(`${cardCount} concept${cardCount !== 1 ? 's' : ''} captured`);
  }

  // ─── Helpers ──────────────────────────────────────────────
  function escHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
  function msg(m) { return new Promise(r => chrome.runtime.sendMessage(m, r)); }

  // ─── Lifecycle ────────────────────────────────────────────
  window.addEventListener('accessai-mode-changed', (e) => {
    if (e.detail.mode === 'clear-context') initPane();
    else if (isActive) stop();
  });

  chrome.storage.local.get('activeMode', (r) => {
    if (r.activeMode === 'clear-context') setTimeout(initPane, 500);
  });

})();