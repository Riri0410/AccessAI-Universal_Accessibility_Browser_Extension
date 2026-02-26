// ============================================================
// Web-Sight v19 — Chrome Restart History Wipe
// ============================================================

(function () {
  'use strict';

  if (window.__websight_v19) return;
  window.__websight_v19 = true;

  const SYSTEM_PROMPT = `You are a helpful web assistant. Use the available tools to help the user. When asked about anything visual, always call capture_screen first. Keep all responses short — 1 to 3 sentences max. No long paragraphs. Use markdown: **bold**, bullet points with -, and \`code\` where helpful.`;

  // FIX: Matching the exact key that background.js wipes on chrome.runtime.onStartup
  const HISTORY_KEY = 'websight_conversation_history'; 
  const MAX_HISTORY = 30;
  const MAX_STEPS = 14;

  let paneEl = null, outputEl = null, hoverOverlay = null;
  let paneReady = false, isActive = false, isRunning = false;
  let cancelTask = false, history = [];
  let ws = null, micStream = null, displayStream = null, hiddenVideo = null;
  let micCtx = null, micProc = null;
  let apiKey = null;
  let hoverTimer = null, lastHoverEl = null;
  let isSpeaking = false; 

  // ─── History ──────────────────────────────────────────────
  function saveHistory() { try { chrome.storage.local.set({ [HISTORY_KEY]: history.slice(-MAX_HISTORY) }); } catch (e) {} }
  function loadHistory() { return new Promise(r => { try { chrome.storage.local.get(HISTORY_KEY, res => { history = res[HISTORY_KEY] || []; r(); }); } catch (e) { history = []; r(); } }); }
  function clearHistory() { history = []; try { chrome.storage.local.remove(HISTORY_KEY); } catch (e) {} if (outputEl) outputEl.innerHTML = ''; }
  function gptHistory() { return history.filter(e => e.type === 'cmd' || e.type === 'reply').slice(-10).map(e => ({ role: e.role === 'ai' ? 'assistant' : 'user', content: e.text })); }

  // ─── Filler detection ────────────────────────
  const FILLERS = /^(bye|goodbye|hello|hi|hey|okay|ok|yes|no|sure|thanks|ready|testing|test|hmm|uh|um|ah)\.?$/i;
  function isFiller(text) { return FILLERS.test(text.trim()); }

  // ─── Tools ────────────────────────────────────────────────
  const TOOLS = [
    mkfn('capture_screen', 'Take a screenshot of the user\'s shared screen to analyze the visual layout.', {}, []),
    mkfn('get_page_context', 'Get text, links, and form elements.', {}),
    mkfn('read_page', 'Summarize the text content of the entire page.', {}, []),
    mkfn('click_element', 'Click element by CSS selector.', { selector: { type: 'string' } }, ['selector']),
    mkfn('type_text', 'Type text into an input.', { selector: { type: 'string' }, text: { type: 'string' } }, ['text']),
    mkfn('scroll_page', 'Scroll the page.', { direction: { type: 'string', enum: ['up','down','top','bottom'] } }, ['direction']),
    mkfn('navigate_to', 'Go to URL.', { url: { type: 'string' } }, ['url']),
    mkfn('describe_image', 'Describe an image using AI vision.', { selector: { type: 'string' } }, ['selector']),
  ];
  function mkfn(name, description, props, required = []) { return { type: 'function', function: { name, description, parameters: { type: 'object', properties: props, required } } }; }

  // ─── Agent ────────────────────────────────────────────────
  async function runTask(command) {
    if (isFiller(command)) return; 
    if (isRunning) { cancelTask = true; await wait(400); cancelTask = false; }
    
    isRunning = true; cancelTask = false;
    setStatus('Thinking…', 'active'); setDot('thinking');

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...gptHistory(),
      { role: 'user', content: `${command}\n\nPage: ${document.title} — ${location.href}\n${pageContext()}` },
    ];

    let steps = 0, reply = '';
    try {
      while (steps < MAX_STEPS) {
        if (cancelTask) break;
        steps++;

        const resp = await ipc({ type: 'API_REQUEST', model: 'gpt-4o', messages, tools: TOOLS, tool_choice: 'auto' });
        const choice = resp.data?.choices?.[0];

        if (choice?.message?.tool_calls?.length) {
          messages.push({ role: 'assistant', content: choice.message.content || null, tool_calls: choice.message.tool_calls });
          for (const tc of choice.message.tool_calls) {
            let args = {}; try { args = JSON.parse(tc.function.arguments); } catch (e) {}
            addMsg('action', `Running: ${tc.function.name}`);
            const result = await execTool(tc.function.name, args);
            messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id });
          }
        } else {
          reply = choice?.message?.content?.trim() || 'Done.'; break;
        }
      }
    } catch (err) { reply = `Error: ${err.message}`; }

    if (reply && !cancelTask) {
      addMsg('response', reply);
      speak(reply);
      history.push({ role: 'user', type: 'cmd', text: command, time: ts() });
      history.push({ role: 'ai', type: 'reply', text: reply, time: ts() });
      saveHistory();
    }
    isRunning = false; setDot('on'); setStatus('Listening…', 'active');
  }

  // ─── Tool executor ────────────────────────────────────────
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
        if (hiddenVideo.videoWidth === 0) return { success: false, error: 'Screen blank. Please ensure you clicked "Share" on the browser popup.' };

        const canvas = document.createElement('canvas');
        canvas.width = 1280; 
        canvas.height = Math.round(1280 * (hiddenVideo.videoHeight / hiddenVideo.videoWidth)) || 720;
        canvas.getContext('2d').drawImage(hiddenVideo, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.55);

        const vResp = await ipc({ type: 'API_REQUEST', model: 'gpt-4o', messages: [{
            role: 'user', content: [
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
            { type: 'text', text: "Describe what's on this screen in 2-3 short sentences. Mention key text, diagram elements, or code. Be brief and clear." }
            ]
        }]});
        return { success: true, description: vResp.data?.choices?.[0]?.message?.content };
      }
      case 'read_page': {
        const text = document.body.innerText.replace(/\s+/g, ' ').slice(0, 4000);
        return { success: true, text: text };
      }
      case 'get_page_context': return pageContext();
      case 'click_element': { const el = resolve(args.selector); if (el) { highlight(el); el.click(); return { success: true }; } return { success: false }; }
      case 'type_text': { const el = resolve(args.selector); if (el) { el.value = args.text; el.dispatchEvent(new Event('input', { bubbles: true })); return { success: true }; } return { success: false }; }
      case 'navigate_to': { window.location.href = args.url.startsWith('http') ? args.url : 'https://'+args.url; return { success: true }; }
      case 'scroll_page': window.scrollBy({ top: args.direction === 'down' ? 500 : -500, behavior: 'smooth' }); return { success: true };
      default: return { success: false };
    }
  }

  // ─── Hover Image Vision ───────────────────────────────────
  async function describeImageHover(imgEl) {
    if (!apiKey) return;
    const altText = imgEl.getAttribute('alt') || imgEl.getAttribute('aria-label');
    let src = imgEl.src || imgEl.getAttribute('data-src') || imgEl.getAttribute('data-lazy-src');
    
    if (!src || src.length < 5) {
        if (altText) {
            showHoverTip(imgEl, altText); speak(altText);
        } else {
            hoverOverlay.style.display = 'none';
        }
        return;
    }
    
    if (!src.startsWith('http') && !src.startsWith('data:')) {
        try { src = new URL(src, location.href).href; } catch(e) { return; }
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
    } catch(e) {}
    
    showHoverTip(imgEl, 'Looking at image…');
    try {
      const resp = await ipc({ type: 'API_REQUEST', model: 'gpt-4o', messages: [{ role: 'user', content: [
        { type: 'text', text: 'Describe exactly what is happening in this image. Focus on subjects, actions, and clothing (e.g. cat running, human wearing saree). Max 15 words.' },
        { type: 'image_url', image_url: { url: finalUrl, detail: 'low' } },
      ]}], max_tokens: 30 });
      
      const desc = resp?.data?.choices?.[0]?.message?.content?.trim();
      if (!desc || desc.includes("I can't see") || desc.includes("I cannot see") || desc.includes("sorry")) {
         throw new Error("Vision failed");
      }
      showHoverTip(imgEl, desc); 
      speak(desc); 
      
    } catch (e) { 
      if (altText) {
         showHoverTip(imgEl, altText); speak(altText);
      } else {
         showHoverTip(imgEl, 'Image (Cannot analyze)'); speak("Image cannot be analyzed.");
      }
    }
  }

  function onHover(e) {
    if (!paneReady || !isActive) return;
    const target = e.target;
    if (target.closest('#accessai-sidebar')) return;
    clearTimeout(hoverTimer);
    const imgEl = target.tagName === 'IMG' ? target : target.querySelector?.('img');
    if (imgEl) {
      if (imgEl === lastHoverEl) return;
      lastHoverEl = imgEl;
      hoverTimer = setTimeout(() => describeImageHover(imgEl), 800);
    } else { if (hoverOverlay) hoverOverlay.style.display = 'none'; lastHoverEl = null; }
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
      hiddenVideo.autoplay = true; hiddenVideo.muted = true; hiddenVideo.playsInline = true;
      hiddenVideo.srcObject = displayStream;
      document.body.appendChild(hiddenVideo);
      
      hiddenVideo.play().catch(e => console.log(e));
      displayStream.getVideoTracks()[0]?.addEventListener('ended', stopAgent);

      setStatus('Requesting microphone…', 'active');
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      await connectWS();

      isActive = true;
      showActive();
      
      speak("Let me look at this page...");
      setStatus('Analyzing page...', 'thinking');
      
      await new Promise(r => {
        if (hiddenVideo.videoWidth > 0) return r();
        hiddenVideo.addEventListener('playing', () => setTimeout(r, 200), { once: true });
        setTimeout(r, 2000); 
      });
      
      let pageDesc = "this page.";
      try {
        if (hiddenVideo.videoWidth > 0) {
            const canvas = document.createElement('canvas');
            canvas.width = 1280; 
            canvas.height = Math.round(1280 * (hiddenVideo.videoHeight / hiddenVideo.videoWidth)) || 720;
            canvas.getContext('2d').drawImage(hiddenVideo, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.55);

            const vResp = await ipc({ type: 'API_REQUEST', model: 'gpt-4o', messages: [{
                role: 'user', content: [
                { type: 'text', text: "What is this page about? Describe it in one short sentence. Start with 'This page is about...'" },
                { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
                ]
            }]});
            if (vResp?.data?.choices?.[0]?.message?.content) {
                pageDesc = vResp.data.choices[0].message.content.trim();
            }
        }
      } catch (e) {}

      // If history exists, user probably just refreshed/navigated, so welcome them back
      const finalGreeting = history.length > 0 
          ? `I am reconnected. ${pageDesc} What would you like to do next?`
          : `I am your web assistant. ${pageDesc} How can I help you today?`;
          
      speak(finalGreeting);
      addMsg('response', finalGreeting);
      setStatus('Listening…', 'active');
      
    } catch (err) {
      addMsg('error', 'Permissions denied or cancelled.');
      stopAgent();
    }
  }

  function stopAgent() {
    isActive = false; isRunning = false;
    
    if (ws) { ws.close(); ws = null; }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (displayStream) { displayStream.getTracks().forEach(t => t.stop()); displayStream = null; }
    if (hiddenVideo) { hiddenVideo.srcObject = null; hiddenVideo.remove(); hiddenVideo = null; }
    
    stopSpeech();
    showIdle();
    setStatus('Stopped', '');
    setDot('');
  }

  async function connectWS() {
    return new Promise((resolve, reject) => {
      ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', ['realtime', `openai-insecure-api-key.${apiKey}`, 'openai-beta.realtime-v1']);
      
      const timeout = setTimeout(() => { ws.close(); reject(new Error('Timeout')); }, 10000);

      ws.onopen = () => {
        clearTimeout(timeout);
        ws.send(JSON.stringify({ type: 'session.update', session: { 
            modalities: ['text','audio'],
            input_audio_transcription: { model: 'whisper-1', language: 'en' },
            turn_detection: { type: 'server_vad', threshold: 0.7, silence_duration_ms: 800, prefix_padding_ms: 300 }
        }}));
        setDot('on');
        
        micCtx = new AudioContext({ sampleRate: 24000 });
        const src = micCtx.createMediaStreamSource(micStream);
        micProc = micCtx.createScriptProcessor(2048, 1, 1);
        micProc.onaudioprocess = e => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (isSpeaking) return; 
          
          const f32 = e.inputBuffer.getChannelData(0); const i16 = new Int16Array(f32.length);
          for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); i16[i] = s < 0 ? s * 32768 : s * 32767; }
          const bytes = new Uint8Array(i16.buffer); let bin = ''; for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
          ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(bin) }));
        };
        src.connect(micProc); micProc.connect(micCtx.destination);
        resolve();
      };
      
      ws.onerror = () => reject();
      ws.onmessage = e => { 
        const ev = JSON.parse(e.data);
        if (ev.type === 'conversation.item.input_audio_transcription.completed' && ev.transcript?.trim()) {
            if (!isSpeaking) {
                addMsg('user', ev.transcript.trim()); 
                runTask(ev.transcript.trim());
            }
        }
      };
    });
  }

  // ─── Helpers ──────────────────────────────────────────────
  let _ttsAudio = null;

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
    if (!text || !apiKey) return;
    stopSpeech();
    const clean = stripMarkdown(text);
    if (!clean) return;
    isSpeaking = true;
    try {
      const resp = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'tts-1', voice: 'nova', input: clean, speed: 1.0 }),
      });
      if (!resp.ok) throw new Error('TTS ' + resp.status);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      _ttsAudio = new Audio(url);
      _ttsAudio.onended = () => { isSpeaking = false; URL.revokeObjectURL(url); _ttsAudio = null; };
      _ttsAudio.onerror = () => { isSpeaking = false; _ttsAudio = null; };
      _ttsAudio.play();
    } catch (e) {
      isSpeaking = false;
      console.warn('[WebSight] TTS error:', e.message);
    }
  }

  function stopSpeech() {
    if (_ttsAudio) { _ttsAudio.pause(); _ttsAudio = null; }
    isSpeaking = false;
  }
  function renderMarkdown(text) {
    if (!text) return '';
    return text
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
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
    const div = document.createElement('div'); div.className = `ws-msg ws-${type}`;
    if (type === 'response') {
      div.innerHTML = renderMarkdown(text);
    } else {
      div.textContent = text;
    }
    outputEl.appendChild(div); div.scrollIntoView();
    return div;
  }
  function pageContext() { 
      const forms = [...document.querySelectorAll('input:not([type="hidden"]), textarea, select')].slice(0, 15).map(el => el.placeholder || el.name || el.id || el.getAttribute('aria-label') || 'input field');
      const formStr = forms.length > 0 ? `\nForms visible on page: ${forms.join(', ')}` : '';
      return `URL: ${location.href}\nTitle: ${document.title}${formStr}`; 
  }
  function resolve(selector) { try { return document.querySelector(selector); } catch(e) { return null; } }
  function highlight(el) { el.style.outline = '3px solid #06b6d4'; setTimeout(() => el.style.outline = '', 2000); }
  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
  function ts() { return new Date().toLocaleTimeString(); }
  function setDot(cls) { const el = paneEl?.querySelector('#ws-agent-live-dot'); if(el) el.className = 'ws-agent-live-dot ' + cls; }
  function setStatus(msg, cls) { const el = paneEl?.querySelector('#ws-agent-status-bar'); if(el) { el.textContent = msg; el.className = cls; } }
  function ipc(msg) { return new Promise(r => chrome.runtime.sendMessage(msg, r)); }

  // ─── UI Management ──────────────────────────────────────────────
  const STYLES = `
    @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@600;800&display=swap');
    #ws-agent-root { display: flex; flex-direction: column; width: 100%; height: 100%; font-family: 'Syne', sans-serif; background: #0f172a; overflow: hidden; color: #f8fafc; }
    #ws-agent-idle { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 20px; text-align: center; }
    .ws-orb { width: 88px; height: 88px; border-radius: 50%; background: radial-gradient(circle at 35% 35%, rgba(6,182,212,0.35) 0%, rgba(14,165,233,0.18) 60%, rgba(15,23,42,0.95) 100%); border: 1.5px solid rgba(6,182,212,0.35); display: flex; align-items: center; justify-content: center; font-size: 32px; flex-shrink: 0; animation: ws-breathe 3.5s ease-in-out infinite; }
    @keyframes ws-breathe { 0%,100% { box-shadow: 0 0 24px rgba(6,182,212,0.12); } 50% { box-shadow: 0 0 44px rgba(6,182,212,0.32); } }
    .ws-idle-title { font-size: 15px; font-weight: 800; color: #f0ecff; }
    .ws-idle-desc { font-size: 11px; color: #94a3b8; line-height: 1.65; max-width: 230px; }
    #ws-agent-start-btn { width: 100%; padding: 13px 16px; background: linear-gradient(135deg, rgba(6,182,212,0.45), rgba(14,165,233,0.28)); border: 1.5px solid rgba(6,182,212,0.55); border-radius: 13px; cursor: pointer; font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 800; color: white; box-shadow: 0 0 20px rgba(6,182,212,0.2); transition: all 0.2s; display: flex; align-items: center; justify-content: center; gap: 9px; }
    #ws-agent-start-btn:hover { background: linear-gradient(135deg, rgba(6,182,212,0.65), rgba(14,165,233,0.42)); transform: translateY(-1px); }
    #ws-agent-start-btn:disabled { opacity: 0.55; cursor: not-allowed; }
    #ws-agent-active { display: none; flex-direction: column; width: 100%; height: 100%; }
    #ws-agent-header { display: flex; align-items: center; justify-content: space-between; padding: 11px 14px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .ws-hdr-left { display: flex; align-items: center; gap: 8px; }
    #ws-agent-live-dot { width: 8px; height: 8px; border-radius: 50%; background: #475569; transition: all 0.3s; }
    #ws-agent-live-dot.on { background: #06b6d4; box-shadow: 0 0 8px #06b6d4; }
    #ws-agent-live-dot.thinking { background: #fbbf24; box-shadow: 0 0 8px #fbbf24; animation: ws-ping 1s infinite; }
    @keyframes ws-ping { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
    .ws-title { font-size: 11px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; }
    #ws-agent-stop-btn { width: 28px; height: 28px; border-radius: 7px; border: 1px solid rgba(239,68,68,0.25); background: rgba(239,68,68,0.07); color: #f87171; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
    #ws-agent-stop-btn:hover { background: rgba(239,68,68,0.18); border-color: rgba(239,68,68,0.5); }
    #ws-agent-status-bar { padding: 6px 14px; font-family: 'DM Mono', monospace; font-size: 10px; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.04); }
    #ws-agent-status-bar.active { color: #06b6d4; }
    #ws-agent-feed { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; font-family: sans-serif; }
    .ws-msg { padding: 8px 12px; border-radius: 6px; font-size: 13px; line-height: 1.4; word-wrap: break-word; }
    .ws-user { background: #1e293b; color: #e2e8f0; align-self: flex-end; max-width: 85%; border-left: 3px solid #3b82f6; }
    .ws-response { background: #0ea5e9; color: white; align-self: flex-start; max-width: 90%; border-left: 3px solid #0284c7; }
    .ws-action { font-size: 11px; color: #64748b; font-style: italic; }
    #ws-agent-footer { padding: 8px 12px; border-top: 1px solid rgba(255,255,255,0.04); flex-shrink: 0; }
    #ws-agent-clear-btn { width: 100%; background: transparent; border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; padding: 6px; color: #9ca3af; font-family: 'DM Mono', monospace; font-size: 10px; letter-spacing: 0.07em; text-transform: uppercase; cursor: pointer; transition: all 0.2s; }
    #ws-agent-clear-btn:hover { border-color: rgba(239,68,68,0.3); color: #f87171; }
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
          <button id="ws-agent-stop-btn" title="Stop session">⏹</button>
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
    paneReady = true; paneEl = pane;
    
    if (!document.getElementById('ws-agent-styles')) {
      const s = document.createElement('style');
      s.id = 'ws-agent-styles'; s.textContent = STYLES;
      document.head.appendChild(s);
    }
    
    paneEl.style.cssText = 'padding:0;overflow:hidden;display:flex;flex-direction:column;height:100%;';
    paneEl.innerHTML = HTML;
    outputEl = paneEl.querySelector('#ws-agent-feed');

    paneEl.querySelector('#ws-agent-start-btn').addEventListener('click', startAgent);
    paneEl.querySelector('#ws-agent-stop-btn').addEventListener('click', stopAgent);
    paneEl.querySelector('#ws-agent-clear-btn').addEventListener('click', clearHistory);

    if (!hoverOverlay) {
      hoverOverlay = document.createElement('div');
      hoverOverlay.id = 'ws-hover';
      hoverOverlay.style.cssText = 'position:fixed;z-index:999999;background:#06b6d4;color:black;padding:6px 10px;border-radius:6px;font-weight:bold;font-size:12px;display:none;pointer-events:none;';
      document.body.appendChild(hoverOverlay);
    }
    document.addEventListener('mouseover', onHover, true);
    
    await loadHistory(); 
    history.forEach(e => { if(e.type==='cmd') addMsg('user', e.text); else if(e.type==='reply') addMsg('response', e.text); });
    showIdle();
  }

  window.addEventListener('accessai-mode-changed', e => { if (e.detail.mode === 'web-sight') initPane(); else { if (isActive) stopAgent(); } });
  chrome.storage.local.get('activeMode', r => { if (r.activeMode === 'web-sight') setTimeout(initPane, 500); });
})();