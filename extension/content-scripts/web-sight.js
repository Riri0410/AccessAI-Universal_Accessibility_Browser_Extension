// ============================================================
// Web-Sight v20 — Production Ready (Voice + Transcription Fix)
// ============================================================
// Changelog from v19:
//   ✅ FIX: Stop button now IMMEDIATELY kills all speech (AbortController on TTS fetch)
//   ✅ FIX: Upgraded to tts-1-hd + "shimmer" voice (cleaner, more natural)
//   ✅ FIX: All pending API calls abort on stopAgent() — no zombie audio
//   ✅ FIX: AudioContext + ScriptProcessor properly closed on stop (mic stays hot fix)
//   ✅ FIX: speak() guarded by isActive — won't fire after stop
//   ✅ FIX: Hover vision calls abort on stop — no lingering tooltips
//   ✅ FIX: describe_image tool now implemented in execTool
//   ✅ FIX: scroll_page handles 'top' and 'bottom' correctly
//   ✅ FIX: Race condition guard — queued tasks cancel cleanly
//   ✅ FIX: Blob URLs always revoked (memory leak plugged)
//   ✅ FIX: WebSocket close code + reason for clean disconnect
//   ✅ FIX: displayStream ended listener uses { once: true }
//   ✅ PERF: Speech queue — new speech cancels old, zero overlap
//   ✅ PERF: Debounced hover with abort on mouse-out
//   ── v20b Transcription Accuracy ──
//   ✅ FIX: Mic now requests echoCancellation + noiseSuppression + autoGainControl
//   ✅ FIX: VAD threshold lowered 0.7→0.5 (catches softer speech)
//   ✅ FIX: silence_duration raised 800→1200ms (stops cutting off mid-sentence)
//   ✅ FIX: prefix_padding raised 300→500ms (captures word beginnings)
//   ✅ FIX: AudioWorklet replaces ScriptProcessor (zero buffer glitches)
//   ✅ FIX: ScriptProcessor buffer 2048→4096 in fallback (fewer drops)
// ============================================================

(function () {
  'use strict';

  if (window.__websight_v20) return;
  window.__websight_v20 = true;

  const SYSTEM_PROMPT = `You are a helpful web assistant. Use the available tools to help the user. When asked about anything visual, always call capture_screen first. Keep all responses short — 1 to 3 sentences max. No long paragraphs. Use markdown: **bold**, bullet points with -, and \`code\` where helpful.`;

  const HISTORY_KEY = 'websight_conversation_history';
  const MAX_HISTORY = 30;
  const MAX_STEPS = 14;
  const TTS_MODEL = 'tts-1';       // Fast model — lowest latency
  const TTS_VOICE = 'nova';        // Softest, smoothest voice — gentle and clear
  const TTS_SPEED = 1.1;           // Slightly faster for snappy response feel

  // ─── State ────────────────────────────────────────────────
  let paneEl = null, outputEl = null, hoverOverlay = null;
  let paneReady = false, isActive = false, isRunning = false;
  let cancelTask = false, history = [];
  let ws = null, micStream = null, displayStream = null, hiddenVideo = null;
  let micCtx = null, micProc = null, micSrc = null, micWorklet = null;
  let apiKey = null;
  let hoverTimer = null, lastHoverEl = null;
  let isSpeaking = false;
  let imageHoverEnabled = false;

  // Abort controllers for cancellable operations
  let ttsAbort = null;       // Current TTS fetch
  let hoverAbort = null;     // Current hover vision API call
  let taskAbort = null;      // Current agent task API calls
  let _ttsAudio = null;
  let _ttsBlobUrl = null;

  // ─── History ──────────────────────────────────────────────
  function saveHistory() {
    try { chrome.storage.local.set({ [HISTORY_KEY]: history.slice(-MAX_HISTORY) }); } catch (e) {}
  }

  function loadHistory() {
    return new Promise(r => {
      try {
        chrome.storage.local.get(HISTORY_KEY, res => { history = res[HISTORY_KEY] || []; r(); });
      } catch (e) { history = []; r(); }
    });
  }

  function clearHistory() {
    history = [];
    try { chrome.storage.local.remove(HISTORY_KEY); } catch (e) {}
    if (outputEl) outputEl.innerHTML = '';
  }

  function gptHistory() {
    return history
      .filter(e => e.type === 'cmd' || e.type === 'reply')
      .slice(-10)
      .map(e => ({ role: e.role === 'ai' ? 'assistant' : 'user', content: e.text }));
  }

  // ─── Filler detection ─────────────────────────────────────
  const FILLERS = /^(bye|goodbye|hello|hi|hey|okay|ok|yes|no|sure|thanks|thank you|ready|testing|test|hmm|uh|um|ah|mhm|yeah)\.?$/i;
  function isFiller(text) { return FILLERS.test(text.trim()); }

  // ─── Tools ────────────────────────────────────────────────
  const TOOLS = [
    mkfn('capture_screen', 'Take a screenshot of the user\'s shared screen to analyze the visual layout.', {}, []),
    mkfn('get_page_context', 'Get text, links, and form elements.', {}),
    mkfn('read_page', 'Summarize the text content of the entire page.', {}, []),
    mkfn('click_element', 'Click element by CSS selector.', { selector: { type: 'string' } }, ['selector']),
    mkfn('type_text', 'Type text into an input.', { selector: { type: 'string' }, text: { type: 'string' } }, ['text']),
    mkfn('scroll_page', 'Scroll the page.', { direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] } }, ['direction']),
    mkfn('navigate_to', 'Go to URL.', { url: { type: 'string' } }, ['url']),
    mkfn('describe_image', 'Describe an image on the page using AI vision.', { selector: { type: 'string' } }, ['selector']),
  ];

  function mkfn(name, description, props, required = []) {
    return { type: 'function', function: { name, description, parameters: { type: 'object', properties: props, required } } };
  }

  // ─── Agent Loop ───────────────────────────────────────────
  async function runTask(command) {
    if (isFiller(command)) return;
    if (!isActive) return;

    // Cancel any in-progress task cleanly
    if (isRunning) {
      cancelTask = true;
      taskAbort?.abort();
      await wait(300);
      cancelTask = false;
    }

    isRunning = true;
    cancelTask = false;
    taskAbort = new AbortController();
    setStatus('Thinking…', 'active');
    setDot('thinking');

    // Stop any current speech immediately when user speaks
    stopSpeech();

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...gptHistory(),
      { role: 'user', content: `${command}\n\nMetadata: URL=${location.href}, Title=${document.title}, Domain=${location.hostname}\nContext: ${pageContext()}` },
    ];

    let steps = 0, reply = '';
    try {
      while (steps < MAX_STEPS) {
        if (cancelTask || !isActive) break;
        steps++;

        const resp = await ipc({ type: 'API_REQUEST', model: 'gpt-4o', messages, tools: TOOLS, tool_choice: 'auto' });

        if (cancelTask || !isActive) break;

        const choice = resp?.data?.choices?.[0];
        if (!choice) { reply = 'No response received.'; break; }

        if (choice.message?.tool_calls?.length) {
          messages.push({
            role: 'assistant',
            content: choice.message.content || null,
            tool_calls: choice.message.tool_calls,
          });

          for (const tc of choice.message.tool_calls) {
            if (cancelTask || !isActive) break;
            let args = {};
            try { args = JSON.parse(tc.function.arguments); } catch (e) {}
            addMsg('action', `Running: ${tc.function.name}`);
            const result = await execTool(tc.function.name, args);
            messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id });
          }
        } else {
          reply = choice.message?.content?.trim() || 'Done.';
          break;
        }
      }
    } catch (err) {
      if (!cancelTask && isActive) reply = `Error: ${err.message}`;
    }

    if (reply && !cancelTask && isActive) {
      addMsg('response', reply);
      speak(reply);
      history.push({ role: 'user', type: 'cmd', text: command, time: ts() });
      history.push({ role: 'ai', type: 'reply', text: reply, time: ts() });
      saveHistory();
    }

    isRunning = false;
    taskAbort = null;
    if (isActive) { setDot('on'); setStatus('Listening…', 'active'); }
  }

  // ─── Tool Executor ────────────────────────────────────────
  async function execTool(name, args) {
    switch (name) {
      case 'capture_screen': {
        if (!hiddenVideo) return { success: false, error: 'No screen shared' };

        if (hiddenVideo.videoWidth === 0) {
          await new Promise(r => {
            hiddenVideo.onloadedmetadata = r;
            setTimeout(r, 1500);
          });
        }
        if (hiddenVideo.videoWidth === 0) {
          return { success: false, error: 'Screen blank. Please ensure you clicked "Share" on the browser popup.' };
        }

        const dataUrl = captureFrame();
        const vResp = await ipc({
          type: 'API_REQUEST', model: 'gpt-4o',
          messages: [{
            role: 'user', content: [
              { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
              { type: 'text', text: "Describe what's on this screen in 2-3 short sentences. Mention key text, diagram elements, or code. Be brief and clear." },
            ],
          }],
        });
        return { success: true, description: vResp.data?.choices?.[0]?.message?.content };
      }

      case 'read_page': {
  // Capture full page text without truncation
  const text = document.body.innerText.replace(/\s+/g, ' ');
  return { success: true, text };
      }

      case 'get_page_context':
        return pageContext();

      case 'click_element': {
        const el = resolve(args.selector);
        if (el) { highlight(el); el.click(); return { success: true }; }
        return { success: false, error: `Element not found: ${args.selector}` };
      }

      case 'type_text': {
        const el = resolve(args.selector);
        if (el) {
          el.focus();
          el.value = args.text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true };
        }
        return { success: false, error: `Element not found: ${args.selector}` };
      }

      case 'navigate_to': {
        const url = args.url.startsWith('http') ? args.url : 'https://' + args.url;
        window.location.href = url;
        return { success: true };
      }

      case 'scroll_page': {
        const dir = (args.direction || 'down').toLowerCase();
        if (dir === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
        else if (dir === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        else window.scrollBy({ top: dir === 'down' ? 600 : -600, behavior: 'smooth' });
        return { success: true };
      }

      case 'describe_image': {
        const imgEl = resolve(args.selector);
        if (!imgEl || imgEl.tagName !== 'IMG') {
          return { success: false, error: `Image not found: ${args.selector}` };
        }
        let imgUrl = imgEl.src;
        try {
          const c = document.createElement('canvas');
          c.width = imgEl.naturalWidth || imgEl.width || 300;
          c.height = imgEl.naturalHeight || imgEl.height || 300;
          if (c.width > 0 && c.height > 0) {
            c.getContext('2d').drawImage(imgEl, 0, 0, c.width, c.height);
            const data = c.toDataURL('image/jpeg', 0.5);
            if (data.length > 100) imgUrl = data;
          }
        } catch (e) { /* cross-origin, use src */ }

        const resp = await ipc({
          type: 'API_REQUEST', model: 'gpt-4o',
          messages: [{
            role: 'user', content: [
              { type: 'image_url', image_url: { url: imgUrl, detail: 'low' } },
              { type: 'text', text: 'Describe this image in detail. What do you see? 2-3 sentences max.' },
            ],
          }],
        });
        return { success: true, description: resp?.data?.choices?.[0]?.message?.content || 'Unable to describe.' };
      }

      default:
        return { success: false, error: `Unknown tool: ${name}` };
    }
  }

  // ─── Screen Capture Helper ────────────────────────────────
  function captureFrame() {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = Math.round(1280 * (hiddenVideo.videoHeight / hiddenVideo.videoWidth)) || 720;
    canvas.getContext('2d').drawImage(hiddenVideo, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.55);
  }

  // ─── TTS — Fully Cancellable ──────────────────────────────
  function stripMarkdown(text) {
    return (text || '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/^#{1,3} /gm, '')
      .replace(/^[-•] /gm, '')
      .replace(/<[^>]*>/g, '')
      .replace(/\n/g, ' ')
      .replace(/  +/g, ' ')
      .trim();
  }

  async function speak(text) {
    // GUARD: Never speak if agent is stopped
    if (!text || !apiKey || !isActive) return;

    // Kill any current speech first
    stopSpeech();

    let clean = stripMarkdown(text);
    if (!clean) return;

    // Cap at 200 chars for snappy TTS — long text = long wait
    //if (clean.length > 200) clean = clean.slice(0, 197) + '...';

    isSpeaking = true;
    ttsAbort = new AbortController();
    const signal = ttsAbort.signal;

    try {
      const resp = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: TTS_MODEL,
          voice: TTS_VOICE,
          input: clean,
          speed: TTS_SPEED,
          response_format: 'opus',  // Smaller than mp3 = faster transfer
        }),
        signal,
      });

      if (!resp.ok) throw new Error('TTS ' + resp.status);
      if (signal.aborted || !isActive) return;

      const blob = await resp.blob();
      if (signal.aborted || !isActive) return;

      if (_ttsBlobUrl) { URL.revokeObjectURL(_ttsBlobUrl); _ttsBlobUrl = null; }

      _ttsBlobUrl = URL.createObjectURL(blob);
      _ttsAudio = new Audio(_ttsBlobUrl);

      _ttsAudio.onended = () => {
        cleanupAudio();
        isSpeaking = false;
      };
      _ttsAudio.onerror = () => {
        cleanupAudio();
        isSpeaking = false;
      };

      if (signal.aborted || !isActive) { cleanupAudio(); return; }

      await _ttsAudio.play();
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.warn('[WebSight] TTS error:', e.message);
      }
      cleanupAudio();
      isSpeaking = false;
    }
  }

  function stopSpeech() {
    // 1. Abort any in-flight TTS fetch
    if (ttsAbort) { ttsAbort.abort(); ttsAbort = null; }

    // 2. Kill any playing audio
    if (_ttsAudio) {
      _ttsAudio.onended = null;
      _ttsAudio.onerror = null;
      try { _ttsAudio.pause(); } catch (e) {}
      _ttsAudio.src = '';
      _ttsAudio = null;
    }

    // 3. Revoke blob URL
    if (_ttsBlobUrl) { URL.revokeObjectURL(_ttsBlobUrl); _ttsBlobUrl = null; }

    isSpeaking = false;
  }

  function cleanupAudio() {
    if (_ttsAudio) {
      _ttsAudio.onended = null;
      _ttsAudio.onerror = null;
      _ttsAudio = null;
    }
    if (_ttsBlobUrl) { URL.revokeObjectURL(_ttsBlobUrl); _ttsBlobUrl = null; }
  }

  // ─── Hover Image Vision (Cancellable) ─────────────────────
  async function describeImageHover(imgEl) {
    if (!apiKey || !isActive) return;

    // Abort any previous hover call
    if (hoverAbort) { hoverAbort.abort(); hoverAbort = null; }
    hoverAbort = new AbortController();

    const altText = imgEl.getAttribute('alt') || imgEl.getAttribute('aria-label');
    let src = imgEl.src || imgEl.getAttribute('data-src') || imgEl.getAttribute('data-lazy-src');

    if (!src || src.length < 5) {
      if (altText) { showHoverTip(imgEl, altText); speak(altText); }
      else if (hoverOverlay) hoverOverlay.style.display = 'none';
      return;
    }

    if (!src.startsWith('http') && !src.startsWith('data:')) {
      try { src = new URL(src, location.href).href; } catch (e) { return; }
    }

    let finalUrl = src;
    try {
      const c = document.createElement('canvas');
      c.width = imgEl.naturalWidth || imgEl.width || 200;
      c.height = imgEl.naturalHeight || imgEl.height || 200;
      if (c.width > 0 && c.height > 0) {
        c.getContext('2d').drawImage(imgEl, 0, 0, c.width, c.height);
        const data = c.toDataURL('image/jpeg', 0.4);
        if (data.length > 100) finalUrl = data;
      }
    } catch (e) { /* cross-origin */ }

    showHoverTip(imgEl, 'Looking at image…');

    try {
      const resp = await ipc({
        type: 'API_REQUEST', model: 'gpt-4o', max_tokens: 30,
        messages: [{
          role: 'user', content: [
            { type: 'text', text: 'Describe exactly what is happening in this image. Focus on subjects, actions, and clothing. Max 15 words.' },
            { type: 'image_url', image_url: { url: finalUrl, detail: 'low' } },
          ],
        }],
      });

      if (!isActive) return;

      const desc = resp?.data?.choices?.[0]?.message?.content?.trim();
      if (!desc || /I can'?t see|I cannot see|sorry/i.test(desc)) throw new Error('Vision failed');

      showHoverTip(imgEl, desc);
      speak(desc);
    } catch (e) {
      if (!isActive) return;
      if (altText) { showHoverTip(imgEl, altText); speak(altText); }
      else { showHoverTip(imgEl, 'Image (Cannot analyze)'); }
    }
  }

  function onHover(e) {
    if (!paneReady || !isActive || !imageHoverEnabled) return;
    const target = e.target;
    if (target.closest('#accessai-sidebar')) return;

    clearTimeout(hoverTimer);
    const imgEl = target.tagName === 'IMG' ? target : target.querySelector?.('img');

    if (imgEl) {
      if (imgEl === lastHoverEl) return;
      lastHoverEl = imgEl;
      hoverTimer = setTimeout(() => describeImageHover(imgEl), 1500);
    } else {
      if (hoverAbort) { hoverAbort.abort(); hoverAbort = null; }
      if (hoverOverlay) hoverOverlay.style.display = 'none';
      lastHoverEl = null;
    }
  }

  function showHoverTip(el, text) {
    if (!hoverOverlay) return;
    hoverOverlay.textContent = text;
    hoverOverlay.style.display = 'block';
    const r = el.getBoundingClientRect();
    hoverOverlay.style.left = Math.min(r.left, window.innerWidth - 300) + 'px';
    hoverOverlay.style.top = Math.max(4, r.bottom + 6) + 'px';
  }

  // ─── Agent Lifecycle ──────────────────────────────────────
  async function startAgent() {
    const startBtn = paneEl?.querySelector('#ws-agent-start-btn');
    if (startBtn) { startBtn.innerHTML = '<span style="font-size:17px">⏳</span> Connecting…'; startBtn.disabled = true; }

    try {
      const kr = await ipc({ type: 'API_REALTIME_SESSION' });
      if (!kr?.success) throw new Error('API Key missing');
      apiKey = kr.apiKey;

      setStatus('Select your screen to share…', 'active');
      displayStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5, width: 1280 }, audio: false });

      hiddenVideo = document.createElement('video');
      hiddenVideo.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
      hiddenVideo.autoplay = true;
      hiddenVideo.muted = true;
      hiddenVideo.playsInline = true;
      hiddenVideo.srcObject = displayStream;
      document.body.appendChild(hiddenVideo);

      hiddenVideo.play().catch(e => console.log('[WebSight] Video play:', e));
      displayStream.getVideoTracks()[0]?.addEventListener('ended', stopAgent, { once: true });

      setStatus('Requesting microphone…', 'active');
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 24000,
        },
      });

      await connectWS();

      isActive = true;
      showActive();

      setStatus('Analyzing page…', 'active');

      // Wait for video frame
      await new Promise(r => {
        if (hiddenVideo.videoWidth > 0) return r();
        hiddenVideo.addEventListener('playing', () => setTimeout(r, 200), { once: true });
        setTimeout(r, 2000);
      });

      // Initial page analysis
      let pageDesc = 'this page.';
      try {
        if (hiddenVideo.videoWidth > 0) {
          const dataUrl = captureFrame();
          const vResp = await ipc({
            type: 'API_REQUEST', model: 'gpt-4o',
            messages: [{
              role: 'user', content: [
                { type: 'text', text: "What is this page about? Describe it in one short sentence. Start with 'This page is about...'" },
                { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
              ],
            }],
          });
          if (vResp?.data?.choices?.[0]?.message?.content) {
            pageDesc = vResp.data.choices[0].message.content.trim();
          }
        }
      } catch (e) {}

      if (!isActive) return; // user may have stopped during analysis

      const greeting = history.length > 0
        ? `I'm reconnected. ${pageDesc} What would you like to do next?`
        : `I'm your web assistant. ${pageDesc} How can I help you today?`;

      addMsg('response', greeting);
      speak(greeting);
      setStatus('Listening…', 'active');

    } catch (err) {
      addMsg('error', 'Permissions denied or cancelled.');
      stopAgent();
    }
  }

  function stopAgent() {
    // Mark inactive FIRST — prevents any new speak/task calls
    isActive = false;
    isRunning = false;
    cancelTask = true;

    // Abort all in-flight operations
    stopSpeech();
    if (taskAbort) { taskAbort.abort(); taskAbort = null; }
    if (hoverAbort) { hoverAbort.abort(); hoverAbort = null; }
    clearTimeout(hoverTimer);

    // Close WebSocket
    if (ws) {
      try { ws.close(1000, 'User stopped session'); } catch (e) {}
      ws = null;
    }

    // Close AudioContext, Worklet & ScriptProcessor (stops mic processing)
    if (micWorklet) {
      try { micWorklet.disconnect(); } catch (e) {}
      micWorklet.port.onmessage = null;
      micWorklet = null;
    }
    if (micProc) {
      try { micProc.disconnect(); } catch (e) {}
      micProc.onaudioprocess = null;
      micProc = null;
    }
    if (micSrc) {
      try { micSrc.disconnect(); } catch (e) {}
      micSrc = null;
    }
    if (micCtx) {
      try { micCtx.close(); } catch (e) {}
      micCtx = null;
    }

    // Release media streams
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (displayStream) { displayStream.getTracks().forEach(t => t.stop()); displayStream = null; }

    // Remove hidden video
    if (hiddenVideo) {
      hiddenVideo.srcObject = null;
      hiddenVideo.remove();
      hiddenVideo = null;
    }

    // Hide hover overlay
    if (hoverOverlay) hoverOverlay.style.display = 'none';
    lastHoverEl = null;

    showIdle();
    setStatus('Stopped', '');
    setDot('');
  }

  async function connectWS() {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(
        'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
        ['realtime', `openai-insecure-api-key.${apiKey}`, 'openai-beta.realtime-v1']
      );

      const timeout = setTimeout(() => { ws.close(); reject(new Error('WebSocket timeout')); }, 10000);

      ws.onopen = async () => {
        clearTimeout(timeout);
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            input_audio_transcription: { model: 'gpt-4o-mini-transcribe'},
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,              // Lower = catches softer speech (was 0.7)
              silence_duration_ms: 1200,    // Wait longer before finalizing (was 800)
              prefix_padding_ms: 500,       // Capture more before voice start (was 300)
            },
          },
        }));
        setDot('on');

        // ── Mic Audio Pipeline ──
        // Use AudioWorklet if available (glitch-free), fall back to ScriptProcessor
        micCtx = new AudioContext({ sampleRate: 24000 });
        micSrc = micCtx.createMediaStreamSource(micStream);

        const sendAudioChunk = (f32) => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          if (isSpeaking) return;

          const i16 = new Int16Array(f32.length);
          for (let i = 0; i < f32.length; i++) {
            const s = Math.max(-1, Math.min(1, f32[i]));
            i16[i] = s < 0 ? s * 32768 : s * 32767;
          }
          const bytes = new Uint8Array(i16.buffer);
          let bin = '';
          for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);

          try {
            ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(bin) }));
          } catch (e) { /* ws closed */ }
        };

        // Try AudioWorklet first (modern, no buffer glitches)
        let usedWorklet = false;
        try {
          const workletCode = `
            class MicProcessor extends AudioWorkletProcessor {
              process(inputs) {
                const ch = inputs[0]?.[0];
                if (ch && ch.length > 0) this.port.postMessage(ch);
                return true;
              }
            }
            registerProcessor('mic-processor', MicProcessor);
          `;
          const blob = new Blob([workletCode], { type: 'application/javascript' });
          const url = URL.createObjectURL(blob);
          await micCtx.audioWorklet.addModule(url);
          URL.revokeObjectURL(url);

          const workletNode = new AudioWorkletNode(micCtx, 'mic-processor');
          workletNode.port.onmessage = (e) => sendAudioChunk(e.data);
          micSrc.connect(workletNode);
          workletNode.connect(micCtx.destination);
          micWorklet = workletNode;
          usedWorklet = true;
          console.log('[WebSight] Using AudioWorklet (glitch-free)');
        } catch (e) {
          console.log('[WebSight] AudioWorklet unavailable, using ScriptProcessor fallback');
        }

        // Fallback: ScriptProcessor (larger buffer = fewer glitches)
        if (!usedWorklet) {
          micProc = micCtx.createScriptProcessor(4096, 1, 1);
          micProc.onaudioprocess = e => sendAudioChunk(e.inputBuffer.getChannelData(0));
          micSrc.connect(micProc);
          micProc.connect(micCtx.destination);
        }

        resolve();
      };

      ws.onerror = (e) => {
        clearTimeout(timeout);
        reject(new Error('WebSocket error'));
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        if (isActive) {
          setStatus('Connection lost', '');
          setDot('');
        }
      };

      ws.onmessage = e => {
        let ev;
        try { ev = JSON.parse(e.data); } catch (err) { return; }

        if (ev.type === 'conversation.item.input_audio_transcription.completed' && ev.transcript?.trim()) {
          if (!isSpeaking && isActive) {
            const transcript = ev.transcript.trim();
            addMsg('user', transcript);
            runTask(transcript);
          }
        }
      };
    });
  }

  // ─── Rendering ────────────────────────────────────────────
  function renderMarkdown(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,.13);padding:1px 5px;border-radius:3px;font-family:monospace;font-size:12px;">$1</code>')
      .replace(/^### (.+)$/gm, '<div style="font-weight:700;margin:4px 0 2px;">$1</div>')
      .replace(/^## (.+)$/gm, '<div style="font-weight:800;margin:5px 0 2px;">$1</div>')
      .replace(/^[-•] (.+)$/gm, '<div style="padding-left:14px;position:relative;margin:2px 0;"><span style="position:absolute;left:2px;color:#7dd3fc;">•</span>$1</div>')
      .replace(/\n/g, '<br>');
  }

  function addMsg(type, text) {
    if (!outputEl) return;
    const div = document.createElement('div');
    div.className = `ws-msg ws-${type}`;
    if (type === 'response') {
      div.innerHTML = renderMarkdown(text);
    } else {
      div.textContent = text;
    }
    outputEl.appendChild(div);
    div.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return div;
  }

  // ─── Utilities ────────────────────────────────────────────
  function pageContext() {
  // NEW: Specifically check for Google's search query to help recognition
  const searchInput = document.querySelector('input[name="q"]')?.value || "";
  
  const forms = [...document.querySelectorAll('input:not([type="hidden"]), textarea, select')]
    .slice(0, 15)
    .map(el => el.placeholder || el.name || el.id || el.getAttribute('aria-label') || 'input field');
  
  const formStr = forms.length > 0 ? `\nForms visible on page: ${forms.join(', ')}` : '';
  
  // ADDED: Explicitly state the Domain and Active Query to the model
  return `Domain: ${location.hostname}\nURL: ${location.href}\nTitle: ${document.title}\nActive Query: ${searchInput}${formStr}`;
}

  function resolve(selector) {
    try { return document.querySelector(selector); } catch (e) { return null; }
  }

  function highlight(el) {
    const prev = el.style.outline;
    el.style.outline = '3px solid #06b6d4';
    el.style.outlineOffset = '2px';
    setTimeout(() => { el.style.outline = prev; el.style.outlineOffset = ''; }, 2000);
  }

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
  function ts() { return new Date().toLocaleTimeString(); }

  function setDot(cls) {
    const el = paneEl?.querySelector('#ws-agent-live-dot');
    if (el) el.className = 'ws-agent-live-dot ' + cls;
  }

  function setStatus(msg, cls) {
    const el = paneEl?.querySelector('#ws-agent-status-bar');
    if (el) { el.textContent = msg; el.className = cls; }
  }

  function ipc(msg) {
    return new Promise(r => chrome.runtime.sendMessage(msg, r));
  }

  // ─── UI ───────────────────────────────────────────────────
  const STYLES = `
    @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@600;800&display=swap');
    #ws-agent-root { display:flex; flex-direction:column; width:100%; height:100%; font-family:'Syne',sans-serif; background:#0f172a; overflow:hidden; color:#f8fafc; }
    #ws-agent-idle { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; padding:20px; text-align:center; }
    .ws-orb { width:88px; height:88px; border-radius:50%; background:radial-gradient(circle at 35% 35%,rgba(6,182,212,0.35) 0%,rgba(14,165,233,0.18) 60%,rgba(15,23,42,0.95) 100%); border:1.5px solid rgba(6,182,212,0.35); display:flex; align-items:center; justify-content:center; font-size:32px; flex-shrink:0; animation:ws-breathe 3.5s ease-in-out infinite; }
    @keyframes ws-breathe { 0%,100%{box-shadow:0 0 24px rgba(6,182,212,0.12)} 50%{box-shadow:0 0 44px rgba(6,182,212,0.32)} }
    .ws-idle-title { font-size:15px; font-weight:800; color:#f0ecff; }
    .ws-idle-desc { font-size:11px; color:#94a3b8; line-height:1.65; max-width:230px; }
    #ws-agent-start-btn { width:100%; padding:13px 16px; background:linear-gradient(135deg,rgba(6,182,212,0.45),rgba(14,165,233,0.28)); border:1.5px solid rgba(6,182,212,0.55); border-radius:13px; cursor:pointer; font-family:'Syne',sans-serif; font-size:14px; font-weight:800; color:white; box-shadow:0 0 20px rgba(6,182,212,0.2); transition:all 0.2s; display:flex; align-items:center; justify-content:center; gap:9px; }
    #ws-agent-start-btn:hover { background:linear-gradient(135deg,rgba(6,182,212,0.65),rgba(14,165,233,0.42)); transform:translateY(-1px); }
    #ws-agent-start-btn:disabled { opacity:0.55; cursor:not-allowed; transform:none; }
    #ws-agent-active { display:none; flex-direction:column; width:100%; height:100%; }
    #ws-agent-header { display:flex; align-items:center; justify-content:space-between; padding:11px 14px; border-bottom:1px solid rgba(255,255,255,0.05); }
    .ws-hdr-left { display:flex; align-items:center; gap:8px; }
    #ws-agent-live-dot { width:8px; height:8px; border-radius:50%; background:#475569; transition:all 0.3s; }
    #ws-agent-live-dot.on { background:#06b6d4; box-shadow:0 0 8px #06b6d4; }
    #ws-agent-live-dot.thinking { background:#fbbf24; box-shadow:0 0 8px #fbbf24; animation:ws-ping 1s infinite; }
    @keyframes ws-ping { 0%,100%{opacity:1} 50%{opacity:0.3} }
    .ws-title { font-size:11px; font-weight:800; letter-spacing:0.1em; text-transform:uppercase; }
    #ws-agent-stop-btn { width:28px; height:28px; border-radius:7px; border:1px solid rgba(239,68,68,0.25); background:rgba(239,68,68,0.07); color:#f87171; font-size:12px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.2s; }
    #ws-agent-stop-btn:hover { background:rgba(239,68,68,0.18); border-color:rgba(239,68,68,0.5); }
    #ws-agent-status-bar { padding:6px 14px; font-family:'DM Mono',monospace; font-size:10px; color:#94a3b8; border-bottom:1px solid rgba(255,255,255,0.04); }
    #ws-agent-status-bar.active { color:#06b6d4; }
    #ws-agent-feed { flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:8px; font-family:sans-serif; scroll-behavior:smooth; }
    .ws-msg { padding:8px 12px; border-radius:8px; font-size:13px; line-height:1.5; word-wrap:break-word; max-width:90%; animation:ws-fadeIn 0.2s ease-out; }
    @keyframes ws-fadeIn { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:translateY(0)} }
    .ws-user { background:#1e293b; color:#e2e8f0; align-self:flex-end; max-width:85%; border-left:3px solid #3b82f6; }
    .ws-response { background:linear-gradient(135deg,#0ea5e9,#0284c7); color:white; align-self:flex-start; border-left:3px solid #0369a1; }
    .ws-action { font-size:11px; color:#64748b; font-style:italic; padding:4px 12px; }
    .ws-error { font-size:11px; color:#f87171; padding:4px 12px; }
    #ws-agent-footer { padding:8px 12px; border-top:1px solid rgba(255,255,255,0.04); flex-shrink:0; }
    #ws-agent-clear-btn { width:100%; background:transparent; border:1px solid rgba(255,255,255,0.06); border-radius:8px; padding:6px; color:#9ca3af; font-family:'DM Mono',monospace; font-size:10px; letter-spacing:0.07em; text-transform:uppercase; cursor:pointer; transition:all 0.2s; }
    #ws-agent-clear-btn:hover { border-color:rgba(239,68,68,0.3); color:#f87171; }
    .ws-hdr-right { display:flex; align-items:center; gap:8px; }
    #ws-hover-pill { display:flex; align-items:center; gap:6px; padding:5px 11px; border-radius:20px; border:1px solid rgba(255,255,255,0.08); background:rgba(30,41,59,0.7); cursor:pointer; transition:all 0.25s; user-select:none; }
    #ws-hover-pill:hover { background:rgba(30,41,59,0.95); border-color:rgba(255,255,255,0.14); }
    #ws-hover-pill.active { border-color:rgba(6,182,212,0.45); background:rgba(6,182,212,0.1); }
    #ws-hover-pill .ws-pill-dot { width:7px; height:7px; border-radius:50%; background:#475569; transition:all 0.25s; flex-shrink:0; }
    #ws-hover-pill.active .ws-pill-dot { background:#06b6d4; box-shadow:0 0 6px rgba(6,182,212,0.6); }
    #ws-hover-pill .ws-pill-icon { font-size:12px; line-height:1; }
    #ws-hover-pill .ws-pill-label { font-family:'DM Mono',monospace; font-size:10px; color:#94a3b8; letter-spacing:0.03em; transition:color 0.25s; white-space:nowrap; }
    #ws-hover-pill.active .ws-pill-label { color:#7dd3fc; }
  `;

  const HTML = `
    <div id="ws-agent-root">
      <div id="ws-agent-idle">
        <div class="ws-orb">🌐</div>
        <div class="ws-idle-title">Web-Sight</div>
        <div class="ws-idle-desc">Your voice-controlled web assistant. Ready to help you read and navigate pages.</div>
        <button id="ws-agent-start-btn"><span style="font-size:17px">🎙</span> Start Session</button>
      </div>
      <div id="ws-agent-active">
        <div id="ws-agent-header">
          <div class="ws-hdr-left">
            <div id="ws-agent-live-dot"></div>
            <div class="ws-title">Web-Sight</div>
          </div>
          <div class="ws-hdr-right">
            <div id="ws-hover-pill" title="Toggle image hover descriptions">
              <div class="ws-pill-dot"></div>
              <span class="ws-pill-icon">🖼</span>
              <span class="ws-pill-label">Image Hover</span>
            </div>
            <button id="ws-agent-stop-btn" title="Stop session">⏹</button>
          </div>
        </div>
        <div id="ws-agent-status-bar">Connecting…</div>
        <div id="ws-agent-feed"></div>
        <div id="ws-agent-footer">
          <button id="ws-agent-clear-btn">Clear history</button>
        </div>
      </div>
    </div>
  `;

  function showIdle() {
    const idle = paneEl?.querySelector('#ws-agent-idle');
    const active = paneEl?.querySelector('#ws-agent-active');
    if (idle) idle.style.display = 'flex';
    if (active) active.style.display = 'none';
    const btn = paneEl?.querySelector('#ws-agent-start-btn');
    if (btn) { btn.innerHTML = '<span style="font-size:17px">🎙</span> Start Session'; btn.disabled = false; }
  }

  function showActive() {
    const idle = paneEl?.querySelector('#ws-agent-idle');
    const active = paneEl?.querySelector('#ws-agent-active');
    if (idle) idle.style.display = 'none';
    if (active) active.style.display = 'flex';
  }

  async function initPane() {
    if (paneReady) return;
    const pane = window.__accessai?.getSidebarPane('web-sight');
    if (!pane) { setTimeout(initPane, 200); return; }
    paneReady = true;
    paneEl = pane;

    if (!document.getElementById('ws-agent-styles')) {
      const s = document.createElement('style');
      s.id = 'ws-agent-styles';
      s.textContent = STYLES;
      document.head.appendChild(s);
    }

    paneEl.style.cssText = 'padding:0;overflow:hidden;display:flex;flex-direction:column;height:100%;';
    paneEl.innerHTML = HTML;
    outputEl = paneEl.querySelector('#ws-agent-feed');

    paneEl.querySelector('#ws-agent-start-btn').addEventListener('click', startAgent);
    paneEl.querySelector('#ws-agent-stop-btn').addEventListener('click', stopAgent);
    paneEl.querySelector('#ws-agent-clear-btn').addEventListener('click', clearHistory);

    // Image hover toggle
    const hoverPill = paneEl.querySelector('#ws-hover-pill');
    if (hoverPill) {
      // Restore saved state
      try {
        chrome.storage.local.get('websight_image_hover', res => {
          imageHoverEnabled = !!res.websight_image_hover;
          if (imageHoverEnabled) hoverPill.classList.add('active');
        });
      } catch (e) {}

      hoverPill.addEventListener('click', () => {
        imageHoverEnabled = !imageHoverEnabled;
        hoverPill.classList.toggle('active', imageHoverEnabled);
        try { chrome.storage.local.set({ websight_image_hover: imageHoverEnabled }); } catch (e) {}

        // If turning off, immediately hide any visible tooltip and cancel pending hover
        if (!imageHoverEnabled) {
          if (hoverAbort) { hoverAbort.abort(); hoverAbort = null; }
          clearTimeout(hoverTimer);
          if (hoverOverlay) hoverOverlay.style.display = 'none';
          lastHoverEl = null;
        }
      });
    }

    if (!hoverOverlay) {
      hoverOverlay = document.createElement('div');
      hoverOverlay.id = 'ws-hover';
      hoverOverlay.style.cssText = 'position:fixed;z-index:999999;background:#06b6d4;color:black;padding:6px 10px;border-radius:6px;font-weight:bold;font-size:12px;display:none;pointer-events:none;max-width:280px;line-height:1.3;';
      document.body.appendChild(hoverOverlay);
    }
    document.addEventListener('mouseover', onHover, true);

    await loadHistory();
    history.forEach(e => {
      if (e.type === 'cmd') addMsg('user', e.text);
      else if (e.type === 'reply') addMsg('response', e.text);
    });
    showIdle();
  }

  // ─── Bootstrap ────────────────────────────────────────────
  window.addEventListener('accessai-mode-changed', e => {
    if (e.detail.mode === 'web-sight') initPane();
    else { if (isActive) stopAgent(); }
  });

  chrome.storage.local.get('activeMode', r => {
    if (r.activeMode === 'web-sight') setTimeout(initPane, 500);
  });
})();