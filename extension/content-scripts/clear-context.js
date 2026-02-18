// ============================================================
// ClearContext: Live Education Buddy
// Uses OpenAI Realtime API for continuous two-way voice
// - Mic streams continuously (always listening to lectures)
// - AI extracts jargon, responds in AUDIO + TEXT simultaneously
// - Builds a live concept map and term cards
// ============================================================

(function () {
  'use strict';

  const SYSTEM_PROMPT = `You are ClearContext, a real-time Academic-to-Plain-English Translator. You help neurodivergent students understand complex lectures by extracting jargon and explaining it simply.

You receive a live audio stream from the user's lecture/class. Listen continuously.

RESPONSE RULES:
- When you hear a technical term, Latin phrase, or complex concept — explain it immediately.
- Always respond in spoken natural language first (this is what the user hears aloud).
- After your spoken explanation, append structured data on a new line for the frontend:
  TERM:{"term":"Mitosis","definition":"How a cell splits to make a copy of itself","parent":"Biology","visual":"cell splitting icon"}
- You can output multiple TERM blocks if multiple terms come up.
- Keep spoken responses SHORT (1-2 sentences). The student is listening to a lecture!
- Use plain English. Grade 5 level. Zero jargon in definitions.
- Filter out filler words (um, like, basically) from your understanding.
- Only explain "pivot point" terms that cause confusion. Don't summarize everything.
- If the student asks you a question, answer it simply and clearly.

CONCEPT MAP:
- Each TERM has a "parent" field for building a concept map.
- Common parents: the broader topic the term belongs to.

Be warm and encouraging. You are helping someone who processes information differently.`;

  // ------- State -------
  let paneEl = null;
  let termsListEl = null;
  let mapCanvasEl = null;
  let transcriptEl = null;
  let initialized = false;
  let isAgentActive = false;

  // WebSocket + Audio
  let ws = null;
  let micStream = null;
  let micContext = null;
  let micProcessor = null;
  let apiKey = null;

  // Audio playback for AI voice
  let playbackContext = null;
  let nextStartTime = 0;

  // Text streaming
  let currentAIText = '';
  let lastTranscriptEl = null;

  // Concept map data
  let terms = [];
  let mapNodes = [];

  // Active sub-tab
  let activeTab = 'terms';

  // ============================================================
  // INIT PANE
  // ============================================================
  function initPane() {
    if (initialized) return;
    const pane = window.__accessai?.getSidebarPane('clear-context');
    if (!pane) { setTimeout(initPane, 200); return; }

    initialized = true;
    paneEl = pane;
    paneEl.innerHTML = `
      <div class="aai-cc-tabs">
        <button class="aai-cc-tab aai-cc-tab-active" data-tab="terms">Terms</button>
        <button class="aai-cc-tab" data-tab="map">Concept Map</button>
        <button class="aai-cc-tab" data-tab="transcript">Live Feed</button>
      </div>

      <div class="aai-cc-pane aai-cc-pane-active" id="aai-cc-terms-pane">
        <div class="aai-cc-hero-wrap" id="aai-cc-hero">
          <div class="aai-start-hero">
            <button class="aai-start-orb aai-start-orb-cc" id="aai-cc-start-orb" aria-label="Start ClearContext AI">
              <span class="aai-orb-ring aai-orb-ring-1"></span>
              <span class="aai-orb-ring aai-orb-ring-2"></span>
              <span class="aai-orb-ring aai-orb-ring-3"></span>
              <span class="aai-orb-core">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                  <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
                </svg>
              </span>
            </button>
            <div class="aai-start-label">Start ClearContext</div>
            <div class="aai-start-sublabel">AI listens to your lecture and explains complex terms in real-time</div>
          </div>
        </div>
        <div class="aai-cc-terms-list" id="aai-cc-terms-list" style="display:none;"></div>
      </div>

      <div class="aai-cc-pane" id="aai-cc-map-pane">
        <canvas id="aai-cc-canvas" width="340" height="300"></canvas>
      </div>

      <div class="aai-cc-pane" id="aai-cc-transcript-pane">
        <div id="aai-cc-transcript" class="aai-cc-transcript-feed"></div>
      </div>

      <div class="aai-cc-input-row">
        <input type="text" id="aai-cc-text-input" class="aai-cc-text-field"
          placeholder="Ask a question..." aria-label="Ask a question" />
        <button class="aai-cc-send-btn" id="aai-cc-send" aria-label="Send">&#10148;</button>
      </div>
    `;

    termsListEl = document.getElementById('aai-cc-terms-list');
    mapCanvasEl = document.getElementById('aai-cc-canvas');
    transcriptEl = document.getElementById('aai-cc-transcript');

    // Tab switching
    paneEl.querySelectorAll('.aai-cc-tab').forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Start button
    document.getElementById('aai-cc-start-orb').addEventListener('click', toggleAgent);

    // Text input
    document.getElementById('aai-cc-send').addEventListener('click', handleTextInput);
    document.getElementById('aai-cc-text-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleTextInput();
    });
  }

  function switchTab(tab) {
    activeTab = tab;
    paneEl.querySelectorAll('.aai-cc-tab').forEach(t => t.classList.remove('aai-cc-tab-active'));
    paneEl.querySelectorAll('.aai-cc-pane').forEach(p => p.classList.remove('aai-cc-pane-active'));
    paneEl.querySelector(`[data-tab="${tab}"]`).classList.add('aai-cc-tab-active');

    const paneMap = { terms: 'aai-cc-terms-pane', map: 'aai-cc-map-pane', transcript: 'aai-cc-transcript-pane' };
    document.getElementById(paneMap[tab]).classList.add('aai-cc-pane-active');
    if (tab === 'map') drawConceptMap();
  }

  // ============================================================
  // AGENT TOGGLE
  // ============================================================
  async function toggleAgent() {
    if (isAgentActive) {
      stopAgent();
    } else {
      await startAgent();
    }
  }

  async function startAgent() {
    const orb = document.getElementById('aai-cc-start-orb');
    const label = paneEl.querySelector('.aai-start-label');

    orb.classList.add('aai-orb-connecting');
    if (label) label.textContent = 'Connecting...';

    try {
      // Get API key
      const keyResp = await sendMessage({ type: 'API_REALTIME_SESSION' });
      if (!keyResp.success) throw new Error('Could not get API key');
      apiKey = keyResp.apiKey;

      // Get mic
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 24000,
          channelCount: 1
        }
      });

      // Audio playback context
      playbackContext = new AudioContext({ sampleRate: 24000 });
      nextStartTime = 0;

      // Connect WebSocket
      await connectWebSocket();

    } catch (err) {
      orb.classList.remove('aai-orb-connecting');
      if (label) label.textContent = 'Start ClearContext';
      addTranscript('error', err.message);
      stopAgent(false);
    }
  }

  function stopAgent(showMsg = true) {
    isAgentActive = false;

    if (micProcessor) { try { micProcessor.disconnect(); } catch(e){} micProcessor = null; }
    if (micContext) { try { micContext.close(); } catch(e){} micContext = null; }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (ws) { try { ws.close(); } catch(e){} ws = null; }
    if (playbackContext) { try { playbackContext.close(); } catch(e){} playbackContext = null; }

    currentAIText = '';
    lastTranscriptEl = null;

    const orb = document.getElementById('aai-cc-start-orb');
    const label = paneEl?.querySelector('.aai-start-label');
    const hero = document.getElementById('aai-cc-hero');

    if (orb) {
      orb.classList.remove('aai-orb-connecting', 'aai-orb-active', 'aai-orb-speaking');
    }
    if (label) label.textContent = 'Start ClearContext';
    if (hero) hero.style.display = '';

    window.__accessai?.setFooterStatus('ClearContext stopped');
    if (showMsg) addTranscript('system', 'ClearContext stopped');
  }

  // ============================================================
  // WEBSOCKET: OpenAI Realtime API
  // ============================================================
  async function connectWebSocket() {
    return new Promise((resolve, reject) => {
      const url = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

      ws = new WebSocket(url, [
        'realtime',
        `openai-insecure-api-key.${apiKey}`,
        'openai-beta.realtime-v1'
      ]);

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: SYSTEM_PROMPT,
            voice: 'nova',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 800
            },
            temperature: 0.4,
            max_response_output_tokens: 400
          }
        }));

        isAgentActive = true;

        const orb = document.getElementById('aai-cc-start-orb');
        const label = paneEl?.querySelector('.aai-start-label');
        const sublabel = paneEl?.querySelector('.aai-start-sublabel');

        if (orb) {
          orb.classList.remove('aai-orb-connecting');
          orb.classList.add('aai-orb-active');
        }
        if (label) label.textContent = 'Listening...';
        if (sublabel) sublabel.textContent = 'Tap to stop';

        // Show terms list
        const termsList = document.getElementById('aai-cc-terms-list');
        if (termsList) termsList.style.display = '';

        startMicStreaming();
        addTranscript('system', 'ClearContext connected — listening to lecture');
        window.__accessai?.setFooterStatus('ClearContext: Listening...');
        resolve();
      };

      ws.onmessage = (event) => {
        try { handleRealtimeEvent(JSON.parse(event.data)); } catch (e) {}
      };

      ws.onerror = () => reject(new Error('WebSocket failed'));

      ws.onclose = () => {
        if (isAgentActive) {
          addTranscript('system', 'Reconnecting...');
          setTimeout(async () => {
            if (isAgentActive) {
              try { await connectWebSocket(); }
              catch (err) { stopAgent(); }
            }
          }, 2000);
        }
      };
    });
  }

  // ============================================================
  // MIC STREAMING
  // ============================================================
  function startMicStreaming() {
    micContext = new AudioContext({ sampleRate: 24000 });
    const source = micContext.createMediaStreamSource(micStream);
    micProcessor = micContext.createScriptProcessor(2048, 1, 1);

    micProcessor.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 32768 : s * 32767;
      }

      const bytes = new Uint8Array(int16.buffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const b64 = btoa(binary);

      ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: b64
      }));
    };

    source.connect(micProcessor);
    micProcessor.connect(micContext.destination);
  }

  // ============================================================
  // HANDLE REALTIME EVENTS
  // ============================================================
  function handleRealtimeEvent(event) {
    switch (event.type) {

      case 'input_audio_buffer.speech_started': {
        const orb = document.getElementById('aai-cc-start-orb');
        if (orb) orb.classList.add('aai-orb-speaking');
        stopAudioPlayback();
        break;
      }

      case 'input_audio_buffer.speech_stopped': {
        const orb = document.getElementById('aai-cc-start-orb');
        if (orb) orb.classList.remove('aai-orb-speaking');
        break;
      }

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript?.trim()) {
          addTranscript('user', event.transcript.trim());
        }
        break;

      case 'response.text.delta':
        appendAITextDelta(event.delta || '');
        break;

      case 'response.text.done':
        finalizeAIText(event.text || currentAIText);
        break;

      case 'response.audio.delta':
        if (event.delta) scheduleAudioChunk(event.delta);
        break;

      case 'response.done':
        window.__accessai?.setFooterStatus('ClearContext: Listening...');
        break;

      case 'error':
        addTranscript('error', event.error?.message || 'API error');
        break;
    }
  }

  // ============================================================
  // AI AUDIO PLAYBACK
  // ============================================================
  function scheduleAudioChunk(base64Audio) {
    if (!playbackContext) return;

    const binary = atob(base64Audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

    const audioBuffer = playbackContext.createBuffer(1, float32.length, 24000);
    audioBuffer.getChannelData(0).set(float32);

    const source = playbackContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(playbackContext.destination);

    const startAt = Math.max(playbackContext.currentTime, nextStartTime);
    source.start(startAt);
    nextStartTime = startAt + audioBuffer.duration;
  }

  function stopAudioPlayback() {
    if (playbackContext) nextStartTime = playbackContext.currentTime;
  }

  // ============================================================
  // AI TEXT STREAMING
  // ============================================================
  function appendAITextDelta(delta) {
    if (!lastTranscriptEl || !lastTranscriptEl.classList.contains('aai-cc-ai-streaming')) {
      currentAIText = '';
      lastTranscriptEl = document.createElement('div');
      lastTranscriptEl.className = 'aai-cc-ai-msg aai-cc-ai-streaming';
      lastTranscriptEl.innerHTML = '<span class="aai-cc-ai-label">ClearContext</span><span class="aai-cc-ai-text"></span>';
      transcriptEl.appendChild(lastTranscriptEl);
    }

    currentAIText += delta;
    const displayText = currentAIText.replace(/TERM:\{[\s\S]*?\}/g, '').trim();
    const textSpan = lastTranscriptEl.querySelector('.aai-cc-ai-text');
    if (textSpan) textSpan.textContent = displayText;
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  function finalizeAIText(fullText) {
    const text = fullText || currentAIText;

    if (lastTranscriptEl) {
      lastTranscriptEl.classList.remove('aai-cc-ai-streaming');
      const displayText = text.replace(/TERM:\{[\s\S]*?\}/g, '').trim();
      const textSpan = lastTranscriptEl.querySelector('.aai-cc-ai-text');
      if (textSpan) textSpan.textContent = displayText;
      lastTranscriptEl = null;
    }

    currentAIText = '';

    // Extract TERM blocks
    const termMatches = text.matchAll(/TERM:(\{[\s\S]*?\})/g);
    for (const match of termMatches) {
      try {
        const termData = JSON.parse(match[1]);
        addTermCard(termData);
      } catch (e) {}
    }
  }

  // ============================================================
  // TERM CARDS & CONCEPT MAP
  // ============================================================
  function addTermCard(data) {
    if (!termsListEl) return;
    terms.push(data);

    const card = document.createElement('div');
    card.className = 'aai-cc-term-card';
    card.setAttribute('role', 'article');
    card.innerHTML = `
      <div class="aai-cc-term-name">${escHtml(data.term)}</div>
      <div class="aai-cc-term-def">${escHtml(data.definition)}</div>
      <div class="aai-cc-term-meta">
        ${data.parent ? `<span class="aai-cc-term-parent">${escHtml(data.parent)}</span>` : ''}
        ${data.visual ? `<span class="aai-cc-term-visual">${escHtml(data.visual)}</span>` : ''}
      </div>
    `;

    card.addEventListener('click', () => {
      sendMessage({ type: 'TTS_SPEAK', text: `${data.term}: ${data.definition}`, rate: 0.9, volume: 0.7 });
    });

    termsListEl.prepend(card);

    addMapNode(data);
    if (activeTab === 'map') drawConceptMap();
  }

  function addMapNode(data) {
    const existing = mapNodes.find(n => n.term === data.term);
    if (existing) return;

    const angle = Math.random() * Math.PI * 2;
    const radius = 60 + Math.random() * 60;
    mapNodes.push({
      term: data.term,
      parent: data.parent || '',
      x: 170 + Math.cos(angle) * radius,
      y: 150 + Math.sin(angle) * radius,
      color: getTermColor(data.parent || '')
    });
  }

  function getTermColor(parent) {
    const colors = ['#f59e0b', '#60a5fa', '#a78bfa', '#34d399', '#f87171', '#fb923c', '#818cf8'];
    let hash = 0;
    for (let i = 0; i < parent.length; i++) hash = parent.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }

  function drawConceptMap() {
    if (!mapCanvasEl) return;
    const ctx = mapCanvasEl.getContext('2d');
    const w = mapCanvasEl.width;
    const h = mapCanvasEl.height;
    ctx.clearRect(0, 0, w, h);

    if (mapNodes.length === 0) {
      ctx.fillStyle = '#52525b';
      ctx.font = '13px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Concept map builds as terms are detected', w / 2, h / 2);
      return;
    }

    // Draw connections
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    mapNodes.forEach(node => {
      if (!node.parent) return;
      const parentNode = mapNodes.find(n => n.term.toLowerCase() === node.parent.toLowerCase());
      if (parentNode) {
        ctx.beginPath();
        ctx.moveTo(node.x, node.y);
        ctx.lineTo(parentNode.x, parentNode.y);
        ctx.stroke();
      }
    });

    // Draw nodes
    mapNodes.forEach(node => {
      ctx.shadowColor = node.color;
      ctx.shadowBlur = 12;
      ctx.fillStyle = node.color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.fillStyle = '#d4d4d8';
      ctx.font = '11px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(node.term, node.x, node.y - 12);
    });
  }

  // ============================================================
  // TEXT INPUT
  // ============================================================
  function handleTextInput() {
    const input = document.getElementById('aai-cc-text-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    addTranscript('user', text);

    if (!isAgentActive || !ws || ws.readyState !== WebSocket.OPEN) {
      processTextFallback(text);
      return;
    }

    ws.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `[STUDENT QUESTION]: ${text}` }]
      }
    }));
    ws.send(JSON.stringify({ type: 'response.create' }));
  }

  async function processTextFallback(text) {
    try {
      const resp = await sendMessage({
        type: 'API_REQUEST', model: 'gpt-4o',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text }
        ],
        max_tokens: 300, temperature: 0.4
      });
      if (!resp.success) throw new Error(resp.error);
      const reply = resp.data.choices?.[0]?.message?.content || '';
      addTranscript('ai', reply.replace(/TERM:\{[\s\S]*?\}/g, '').trim());
      sendMessage({ type: 'TTS_SPEAK', text: reply.replace(/TERM:\{[\s\S]*?\}/g, '').trim(), rate: 0.9, volume: 0.7 });

      const termMatches = reply.matchAll(/TERM:(\{[\s\S]*?\})/g);
      for (const match of termMatches) {
        try { addTermCard(JSON.parse(match[1])); } catch(e) {}
      }
    } catch (err) {
      addTranscript('error', err.message);
    }
  }

  // ============================================================
  // TRANSCRIPT FEED
  // ============================================================
  function addTranscript(type, text) {
    if (!transcriptEl) return;
    const el = document.createElement('div');
    el.className = `aai-cc-transcript-line aai-cc-transcript-${type}`;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    el.innerHTML = `<span class="aai-cc-time">${time}</span>${escHtml(text)}`;
    transcriptEl.appendChild(el);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    while (transcriptEl.children.length > 100) transcriptEl.removeChild(transcriptEl.firstChild);
  }

  // ============================================================
  // HELPERS
  // ============================================================
  function escHtml(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
  }

  function sendMessage(msg) {
    return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
  }

  // ============================================================
  // LIFECYCLE
  // ============================================================
  window.addEventListener('accessai-mode-changed', (e) => {
    if (e.detail.mode === 'clear-context') {
      initPane();
    } else {
      if (isAgentActive) stopAgent();
    }
  });

  chrome.storage.local.get('activeMode', (result) => {
    if (result.activeMode === 'clear-context') setTimeout(initPane, 500);
  });

})();
