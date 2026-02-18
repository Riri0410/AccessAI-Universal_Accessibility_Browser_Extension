// ============================================================
// Social Cue Assistant — renders inside the AccessAI sidebar
// Real-time social intelligence via OpenAI Realtime API
// ============================================================

(function () {
  'use strict';

  const SYSTEM_PROMPT = `Role: You are a passive, real-time Social Intelligence Coach. Your job is to observe the audio stream and provide short, high-impact "whisper" insights to the user. You are NOT a participant in the conversation.

Rules of Engagement:
1. Never Speak for the User: Do not suggest scripts or say "You should say..." Instead, describe the social state.
2. Passivity: Remain silent if the conversation is flowing normally. Only speak when you detect a significant social cue, emotional shift, or turn-taking gap.
3. Extreme Brevity: Use 3-7 words per insight.
4. Objective Analysis: Focus on tone, volume, pacing, and implied emotion.

Insight Categories:
- Emotional State: Detect anger, sarcasm, confusion, or boredom. (e.g., "Insight: Growing frustration detected.")
- Turn-Taking: Identify when someone is expecting a response. (e.g., "Action: Expectant silence.")
- Vibe Check: Summarize the room's energy. (e.g., "Vibe: Tense" or "Vibe: Highly engaged.")

Output format: Always prefix with the category. Keep it under 7 words after the prefix.`;

  let isActive = false;
  let paneEl = null;
  let insightsEl = null;
  let wsConnection = null;
  let mediaStream = null;
  let audioContext = null;
  let processor = null;
  let initialized = false;

  function initPane() {
    if (initialized) return;

    const pane = window.__accessai?.getSidebarPane('social-cue');
    if (!pane) {
      setTimeout(initPane, 200);
      return;
    }

    initialized = true;
    paneEl = pane;
    paneEl.innerHTML = `
      <div class="aai-sc-hero-wrap" id="aai-sc-hero">
        <div class="aai-start-hero">
          <button class="aai-start-orb aai-start-orb-sc" id="aai-sc-start-orb" aria-label="Start Social Cue Assistant">
            <span class="aai-orb-ring aai-orb-ring-1"></span>
            <span class="aai-orb-ring aai-orb-ring-2"></span>
            <span class="aai-orb-ring aai-orb-ring-3"></span>
            <span class="aai-orb-core">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="23"/>
                <line x1="8" y1="23" x2="16" y2="23"/>
              </svg>
            </span>
          </button>
          <div class="aai-start-label">Start Social Cue</div>
          <div class="aai-start-sublabel">Real-time whisper insights during conversations and meetings</div>
        </div>
      </div>
      <div class="aai-sc-insights" id="aai-sc-insights" role="log" aria-live="polite" aria-label="Social cue insights" style="display:none;">
      </div>
    `;

    insightsEl = document.getElementById('aai-sc-insights');
    document.getElementById('aai-sc-start-orb').addEventListener('click', toggleAssistant);
  }

  async function toggleAssistant() {
    if (isActive) {
      stopAssistant();
    } else {
      await startAssistant();
    }
  }

  async function startAssistant() {
    const orb = document.getElementById('aai-sc-start-orb');
    const label = paneEl?.querySelector('.aai-start-label');

    orb.classList.add('aai-orb-connecting');
    if (label) label.textContent = 'Connecting...';

    isActive = true;

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 24000 }
      });

      const sessionInfo = await sendMessage({ type: 'API_REALTIME_SESSION' });
      if (!sessionInfo.success) throw new Error('Failed to get session info');

      await connectRealtime(sessionInfo.apiKey);
      startAudioStreaming();

      orb.classList.remove('aai-orb-connecting');
      orb.classList.add('aai-orb-active');
      if (label) label.textContent = 'Listening...';
      const sublabel = paneEl?.querySelector('.aai-start-sublabel');
      if (sublabel) sublabel.textContent = 'Tap to stop';

      // Show insights list, hide hero (but keep orb small at top)
      const hero = document.getElementById('aai-sc-hero');
      if (hero) hero.classList.add('aai-hero-compact');
      insightsEl.style.display = '';

      addInsight('system', 'Social Cue Assistant active');
      setStatus('Listening...');
    } catch (err) {
      setStatus('Error: ' + err.message);
      isActive = false;
      const orb2 = document.getElementById('aai-sc-start-orb');
      if (orb2) orb2.classList.remove('aai-orb-connecting', 'aai-orb-active');
      if (label) label.textContent = 'Start Social Cue';
    }
  }

  async function connectRealtime(apiKey) {
    return new Promise((resolve, reject) => {
      wsConnection = new WebSocket(
        'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
        ['realtime', `openai-insecure-api-key.${apiKey}`, 'openai-beta.realtime-v1']
      );

      wsConnection.onopen = () => {
        wsConnection.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text'],
            instructions: SYSTEM_PROMPT,
            input_audio_format: 'pcm16',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500
            },
            temperature: 0.3,
            max_response_output_tokens: 60
          }
        }));
        resolve();
      };

      wsConnection.onmessage = (event) => handleRealtimeMessage(JSON.parse(event.data));
      wsConnection.onerror = () => reject(new Error('WebSocket connection failed'));
      wsConnection.onclose = () => {
        if (isActive) {
          setStatus('Reconnecting...');
          setTimeout(() => connectRealtime(apiKey), 3000);
        }
      };
    });
  }

  function startAudioStreaming() {
    audioContext = new AudioContext({ sampleRate: 24000 });
    const source = audioContext.createMediaStreamSource(mediaStream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
      if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) return;
      const inputData = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
      wsConnection.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64 }));
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
  }

  let currentResponseText = '';

  function handleRealtimeMessage(msg) {
    switch (msg.type) {
      case 'response.text.delta':
        currentResponseText += msg.delta;
        break;
      case 'response.text.done':
      case 'response.done':
        if (currentResponseText.trim()) {
          parseAndDisplayInsight(currentResponseText.trim());
          currentResponseText = '';
        }
        break;
      case 'input_audio_buffer.speech_started': {
        setStatus('Hearing speech...');
        const orb = document.getElementById('aai-sc-start-orb');
        if (orb) orb.classList.add('aai-orb-speaking');
        break;
      }
      case 'input_audio_buffer.speech_stopped': {
        setStatus('Processing...');
        const orb = document.getElementById('aai-sc-start-orb');
        if (orb) orb.classList.remove('aai-orb-speaking');
        break;
      }
      case 'error':
        setStatus('Error: ' + (msg.error?.message || 'Unknown'));
        break;
    }
  }

  function parseAndDisplayInsight(text) {
    let category = 'insight';
    const lower = text.toLowerCase();
    if (lower.startsWith('insight:')) category = 'emotion';
    else if (lower.startsWith('action:')) category = 'action';
    else if (lower.startsWith('vibe:')) category = 'vibe';

    addInsight(category, text);
    sendMessage({ type: 'TTS_SPEAK', text, rate: 0.85, pitch: 0.7, volume: 0.3 });
  }

  function addInsight(category, text) {
    if (!insightsEl) return;

    const el = document.createElement('div');
    el.className = `aai-sc-insight aai-sc-insight-${category}`;
    el.setAttribute('role', 'status');
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `
      <span class="aai-sc-insight-time">${time}</span>
      <span class="aai-sc-insight-badge">${category}</span>
      <span class="aai-sc-insight-text">${escapeHtml(text)}</span>
    `;
    insightsEl.appendChild(el);
    insightsEl.scrollTop = insightsEl.scrollHeight;
    while (insightsEl.children.length > 30) insightsEl.removeChild(insightsEl.firstChild);
  }

  function stopAssistant() {
    isActive = false;
    if (wsConnection) { wsConnection.close(); wsConnection = null; }
    if (processor) { processor.disconnect(); processor = null; }
    if (audioContext) { audioContext.close(); audioContext = null; }
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }

    const orb = document.getElementById('aai-sc-start-orb');
    const label = paneEl?.querySelector('.aai-start-label');
    const sublabel = paneEl?.querySelector('.aai-start-sublabel');
    const hero = document.getElementById('aai-sc-hero');

    if (orb) orb.classList.remove('aai-orb-connecting', 'aai-orb-active', 'aai-orb-speaking');
    if (label) label.textContent = 'Start Social Cue';
    if (sublabel) sublabel.textContent = 'Real-time whisper insights during conversations and meetings';
    if (hero) hero.classList.remove('aai-hero-compact');

    setStatus('Stopped');
    addInsight('system', 'Assistant stopped');
  }

  function setStatus(text) {
    window.__accessai?.setFooterStatus(text);
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  function sendMessage(msg) {
    return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
  }

  // Listen for mode switches
  window.addEventListener('accessai-mode-changed', (e) => {
    if (e.detail.mode === 'social-cue') {
      initPane();
    } else {
      if (isActive) stopAssistant();
    }
  });

  chrome.storage.local.get('activeMode', (result) => {
    if (result.activeMode === 'social-cue') {
      setTimeout(initPane, 500);
    }
  });
})();
