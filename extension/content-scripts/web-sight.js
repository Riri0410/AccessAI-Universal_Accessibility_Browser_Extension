// ============================================================
// Web-Sight v7 — Agentic Accessibility Browser Agent
// Fixes in v7:
//   - Start button ALWAYS appears after Stop (even with history)
//   - "Bye", "hello", casual words ignored — no accidental actions
//   - Image hover works through <a> wrappers
//   - Google search: clicks submit button as fallback after Enter
//   - TTS speaks every response
//   - switch_tab, read_aloud, describe_image working
// ============================================================

(function () {
  'use strict';

  if (window.__websight_v7) return;
  window.__websight_v7 = true;

  const SYSTEM_PROMPT = `You are Web-Sight, a voice-controlled AI browser agent for accessibility.

CRITICAL RULES:
1. Only act on CLEAR browser commands. Ignore greetings and casual speech.
2. "bye", "hello", "okay", "yes", "no", "thanks", "ready", "testing", "website ready" = NOT commands. Reply: "Ready for your command."
3. NEVER close a tab or navigate away unless user EXPLICITLY says so.
4. NEVER loop. If a tool fails twice, stop and report.
5. Keep responses to 1 sentence.
6. Use read_aloud to speak results back to the user.

WHAT COUNTS AS A COMMAND:
- "search for cats" → type in search box + Enter
- "go to youtube" → navigate_to
- "open amazon in new tab" → open_new_tab
- "switch to Amazon tab" → switch_tab
- "click sign in" → click_element
- "scroll down" → scroll_page
- "read this page" → read_page then read_aloud
- "go back" → go_back

WHAT IS NOT A COMMAND — reply "Ready for your command.":
- "bye", "goodbye", "hello", "hi", "okay", "yes", "no", "sure", "thanks", "ready", "website ready", "testing", "test"

TYPING WORKFLOW (exact order):
1. get_page_context — find the input selector
2. click_element — click the input
3. type_text — type the text
4. press_key "Enter" — submit

ORDINAL SELECTION:
- get_page_context first
- "first"=[0], "second"=[1], "third"=[2]
- Use EXACT selector shown

TAB COMMANDS:
- "open X in new tab" → open_new_tab
- "switch to X tab" → switch_tab("x")
- "go back" → go_back()
- "close tab" → close_tab() ONLY if user explicitly says close

SAFETY: Only ask confirm for: buy, purchase, checkout, pay, place order.`;

  const HISTORY_KEY = 'websight_v7_history';
  const MAX_HISTORY = 30;
  const MAX_STEPS = 14;
  const MAX_RECONNECT = 3;

  let paneEl = null, outputEl = null, hoverOverlay = null;
  let paneReady = false, isActive = false, isRunning = false;
  let cancelTask = false, pendingConfirm = null, reconnectCount = 0;
  let history = [];
  let ws = null, micStream = null, micCtx = null, micProc = null;
  let apiKey = null, pbCtx = null, pbNext = 0, shouldReconnect = false;
  let ttsQueue = [], ttsPlaying = false;
  let hoverTimer = null, lastHoverEl = null;

  // ─── History ──────────────────────────────────────────────
  function saveHistory() {
    try { chrome.storage.local.set({ [HISTORY_KEY]: history.slice(-MAX_HISTORY) }); } catch (e) {}
  }
  function loadHistory() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(HISTORY_KEY, r => {
          history = (chrome.runtime.lastError ? [] : r[HISTORY_KEY]) || [];
          resolve(history);
        });
      } catch (e) { history = []; resolve([]); }
    });
  }
  function clearHistory() { history = []; try { chrome.storage.local.remove(HISTORY_KEY); } catch (e) {} }
  function gptHistory() {
    const out = [];
    for (const e of history) {
      if (e.role === 'user' && e.type === 'cmd') out.push({ role: 'user', content: e.text });
      else if (e.role === 'ai' && e.type === 'reply') out.push({ role: 'assistant', content: e.text });
    }
    return out.slice(-14);
  }

  // ─── Filler detection ─────────────────────────────────────
  const FILLERS = /^(bye|goodbye|good bye|hello|hi|hey|okay|ok|yes|no|sure|thanks|thank you|ready|website ready|testing|test|done|great|cool|nice|hmm|uh|um|ah|yep|nope)\.?$/i;
  function isFiller(text) {
    return FILLERS.test(text.trim()) || (text.trim().split(/\s+/).length <= 2 && text.trim().length < 8);
  }

  // ─── Tools ────────────────────────────────────────────────
  const TOOLS = [
    mkfn('get_page_context', 'Get URL, title, headings, ALL interactive elements as [0],[1],[2]... Call BEFORE clicking anything.', {}),
    mkfn('find_elements', 'Find elements matching a description.', { description: { type: 'string' } }, ['description']),
    mkfn('click_element', 'Click element by CSS selector.', { selector: { type: 'string' }, description: { type: 'string' } }, ['selector', 'description']),
    mkfn('type_text', 'Type text into focused input. ALWAYS click_element the input first.', { selector: { type: 'string' }, text: { type: 'string' }, clear_first: { type: 'boolean' } }, ['text']),
    mkfn('press_key', 'Press a keyboard key.', { key: { type: 'string', enum: ['Enter','Escape','Tab','Space','Backspace','ArrowDown','ArrowUp','ArrowLeft','ArrowRight'] }, selector: { type: 'string' } }, ['key']),
    mkfn('scroll_page', 'Scroll the page.', { direction: { type: 'string', enum: ['up','down','top','bottom'] }, amount: { type: 'number' } }, ['direction']),
    mkfn('navigate_to', 'Navigate current tab to URL.', { url: { type: 'string' } }, ['url']),
    mkfn('open_new_tab', 'Open URL in a new browser tab.', { url: { type: 'string' } }, ['url']),
    mkfn('switch_tab', 'Switch to an open tab by name/URL e.g. "amazon", "youtube".', { query: { type: 'string' } }, ['query']),
    mkfn('go_back', 'Go back to previous page.', {}, []),
    mkfn('close_tab', 'Close current tab. ONLY use when user explicitly says "close tab".', {}, []),
    mkfn('read_page', 'Read and speak aloud page content.', { selector: { type: 'string' } }, []),
    mkfn('read_aloud', 'Speak text to the user via TTS.', { text: { type: 'string' } }, ['text']),
    mkfn('select_option', 'Select a dropdown value.', { selector: { type: 'string' }, value: { type: 'string' } }, ['selector', 'value']),
    mkfn('describe_image', 'Describe an image in ≤10 words using AI vision.', { selector: { type: 'string' } }, ['selector']),
  ];
  function mkfn(name, description, props, required = []) {
    return { type: 'function', function: { name, description, parameters: { type: 'object', properties: props, required } } };
  }

  // ─── Agent ────────────────────────────────────────────────
  async function runTask(command) {
    if (isFiller(command)) {
      addMsg('response', 'Ready for your command.');
      speak('Ready for your command.');
      return;
    }
    if (isRunning) { cancelTask = true; await wait(400); cancelTask = false; }

    const buyWords = ['buy ','purchase','checkout','pay ','place order'];
    if (buyWords.some(w => command.toLowerCase().includes(w))) {
      pendingConfirm = command;
      addMsg('confirm', `Say "confirm" to proceed: "${command.slice(0,60)}" — or say anything else to cancel.`);
      speak('Safety check. Say confirm to proceed.');
      return;
    }

    isRunning = true; cancelTask = false;
    setStatus('Working…', 'thinking'); setDot('thinking');

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...gptHistory(),
      { role: 'user', content: `Command: "${command}"\n\nCurrent page:\n${pageContext()}` },
    ];

    let steps = 0, reply = '';
    const recentCalls = [];

    try {
      while (steps < MAX_STEPS) {
        if (cancelTask) { reply = 'Task cancelled.'; break; }
        steps++;

        const resp = await ipc({ type: 'API_REQUEST', model: 'gpt-4o', messages, tools: TOOLS, tool_choice: 'auto', max_tokens: 700, temperature: 0.05 });
        if (!resp?.success) { reply = `API error: ${resp?.error || 'unknown'}`; break; }
        const choice = resp.data?.choices?.[0];
        if (!choice) { reply = 'No response from AI.'; break; }

        if (choice.finish_reason === 'tool_calls' && choice.message?.tool_calls?.length) {
          messages.push({ role: 'assistant', content: choice.message.content || null, tool_calls: choice.message.tool_calls });

          for (const tc of choice.message.tool_calls) {
            if (cancelTask) break;
            let args = {};
            try { args = JSON.parse(tc.function.arguments); } catch (e) {}

            const sig = `${tc.function.name}:${JSON.stringify(args)}`;
            recentCalls.push(sig);
            if (recentCalls.length > 8) recentCalls.shift();
            if (recentCalls.filter(c => c === sig).length >= 3) {
              messages.push({ role: 'tool', content: JSON.stringify({ error: 'Loop aborted.' }), tool_call_id: tc.id });
              reply = `I got stuck on "${tc.function.name.replace(/_/g,' ')}". Please try rephrasing.`;
              isRunning = false; setDot('on'); setStatus('Listening…', 'on');
              addMsg('response', reply); speak(reply); return;
            }

            addMsg('action', toolLabel(tc.function.name, args));
            let result;
            try { result = await execTool(tc.function.name, args); }
            catch (e) { result = { success: false, error: e.message }; }

            messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id });
            if (messages.length > 30 && messages[1]?.role === 'user') messages.splice(1, 1);
          }

          if (cancelTask) { reply = 'Task cancelled.'; break; }
          await wait(250);
          messages.push({ role: 'user', content: `Page now:\n${pageContext()}` });
        } else {
          reply = choice.message?.content?.trim() || 'Done.';
          break;
        }
      }
      if (steps >= MAX_STEPS && !reply) reply = 'Reached step limit. Task may be incomplete.';
    } catch (err) {
      reply = `Error: ${err.message}`;
    }

    if (reply) {
      addMsg('response', reply);
      speak(reply);
      const t = ts();
      history.push({ role: 'user', type: 'cmd', text: command, time: t });
      history.push({ role: 'ai', type: 'reply', text: reply, time: t });
      saveHistory();
    }
    isRunning = false;
    setDot('on'); setStatus('Listening… Speak your command!', 'on');
  }

  function toolLabel(name, args) {
    return ({ click_element:`Clicking: ${args.description||args.selector||''}`, type_text:`Typing: "${(args.text||'').slice(0,50)}"`, press_key:`Key: ${args.key}`, navigate_to:`Going to: ${args.url}`, open_new_tab:`New tab: ${args.url}`, switch_tab:`Switching to: ${args.query}`, close_tab:'Closing tab', go_back:'Going back', scroll_page:`Scrolling ${args.direction}`, find_elements:`Finding: ${args.description}`, get_page_context:'Reading page', read_page:'Reading content', read_aloud:`Speaking: "${(args.text||'').slice(0,40)}"`, select_option:`Selecting: ${args.value}`, describe_image:'Describing image' })[name] || name;
  }

  // ─── Tool executor ────────────────────────────────────────
  async function execTool(name, args) {
    switch (name) {
      case 'get_page_context': return pageContext();
      case 'find_elements': return findEls(args.description || '');

      case 'click_element': {
        let el = resolve(args.selector);
        if (!el && args.description) { const f = findEls(args.description); if (f.elements?.length) el = resolve(f.elements[0].selector); }
        if (!el) return { success: false, error: `Not found: ${args.selector || args.description}` };
        highlight(el);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await wait(200); el.click(); el.focus(); await wait(400);
        return { success: true, clicked: args.description || args.selector };
      }

      case 'type_text': {
        let el = args.selector ? resolve(args.selector) : null;
        if (!el) el = document.querySelector('input:focus,textarea:focus,[contenteditable]:focus');
        if (!el) {
          for (const inp of document.querySelectorAll('input[type="text"],input[type="search"],input[type="email"],input[type="url"],input:not([type]),textarea,[contenteditable="true"]')) {
            if (inp.closest('#accessai-sidebar')) continue;
            const cs = window.getComputedStyle(inp);
            if (cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0) { el = inp; break; }
          }
        }
        if (!el) return { success: false, error: 'No input found. Use click_element first.' };
        const text = args.text || '';
        highlight(el); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus(); await wait(100);
        if (el.isContentEditable) {
          if (args.clear_first !== false) { document.execCommand('selectAll'); document.execCommand('delete'); }
          document.execCommand('insertText', false, text);
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        } else {
          if (args.clear_first !== false) {
            const s = (Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value') || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value'))?.set;
            if (s) s.call(el, ''); else el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true })); await wait(30);
          }
          el.focus();
          let worked = false;
          try { worked = document.execCommand('insertText', false, text); } catch (_) {}
          if (!worked || !el.value.includes(text.slice(0,3))) {
            const s = (Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value') || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value'))?.set;
            if (s) s.call(el, text); else el.value = text;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text, cancelable: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        await wait(300);
        const actual = el.isContentEditable ? el.textContent : el.value;
        return { success: true, typed: text, actual_value: actual?.slice(0,60) };
      }

      case 'press_key': {
        const target = args.selector ? resolve(args.selector) : document.activeElement;
        if (target) target.focus();
        const km = { Enter:{key:'Enter',code:'Enter',keyCode:13}, Escape:{key:'Escape',code:'Escape',keyCode:27}, Tab:{key:'Tab',code:'Tab',keyCode:9}, Space:{key:' ',code:'Space',keyCode:32}, Backspace:{key:'Backspace',code:'Backspace',keyCode:8}, ArrowDown:{key:'ArrowDown',code:'ArrowDown',keyCode:40}, ArrowUp:{key:'ArrowUp',code:'ArrowUp',keyCode:38}, ArrowLeft:{key:'ArrowLeft',code:'ArrowLeft',keyCode:37}, ArrowRight:{key:'ArrowRight',code:'ArrowRight',keyCode:39} };
        const k = km[args.key] || { key: args.key, code: args.key, keyCode: 0 };
        const el = target || document.body;
        ['keydown','keypress','keyup'].forEach(t => el.dispatchEvent(new KeyboardEvent(t, { ...k, bubbles: true, cancelable: true })));
        if (args.key === 'Enter') {
          if (el.tagName === 'INPUT' && el.form) { try { el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit(); } catch (e) {} }
          // Fallback: click search/submit button (fixes Google and many others)
          await wait(80);
          const btn = document.querySelector('input[type="submit"]:not([style*="display:none"]),button[type="submit"]:not([style*="display:none"]),button[aria-label*="Search"]:not([style*="display:none"]),button[aria-label*="search"]:not([style*="display:none"])');
          if (btn && !btn.closest('#accessai-sidebar')) btn.click();
        }
        await wait(600);
        return { success: true, key: args.key };
      }

      case 'navigate_to': {
        let url = (args.url || '').trim();
        if (!url) return { success: false, error: 'No URL' };
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        history.push({ role: 'ai', type: 'action', text: `Navigated to ${url}`, time: ts() });
        saveHistory(); shouldReconnect = true;
        await new Promise(r => chrome.storage.local.set({ ws_reconnect: true }, r));
        addMsg('info', `Going to ${url}…`);
        const r = await ipc({ type: 'WEBSIGHT_NAVIGATE', url });
        if (r?.success) return { success: true, url };
        try { window.location.href = url; return { success: true, url }; } catch (e) { return { success: false, error: e.message }; }
      }

      case 'open_new_tab': {
        let url = (args.url || '').trim();
        if (!url) return { success: false, error: 'No URL' };
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        addMsg('info', `Opening: ${url}…`);
        const r = await ipc({ type: 'WEBSIGHT_OPEN_TAB', url });
        if (r?.success) return { success: true, url };
        const w = window.open(url, '_blank');
        return w ? { success: true, url } : { success: false, error: 'Popup blocked' };
      }

      case 'switch_tab': {
        const r = await ipc({ type: 'WEBSIGHT_SWITCH_TAB', query: args.query });
        return r?.success ? { success: true, switched_to: r.title } : { success: false, error: `No tab found: ${args.query}` };
      }

      case 'close_tab': {
        const r = await ipc({ type: 'WEBSIGHT_CLOSE_TAB' });
        return r?.success ? { success: true } : { success: false, error: 'Failed' };
      }

      case 'go_back':
        window.history.back(); await wait(900);
        return { success: true };

      case 'scroll_page': {
        const amt = args.amount || 500;
        if (args.direction === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
        else if (args.direction === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        else if (args.direction === 'up') window.scrollBy({ top: -amt, behavior: 'smooth' });
        else window.scrollBy({ top: amt, behavior: 'smooth' });
        await wait(400);
        return { success: true };
      }

      case 'read_page': {
        const el = args.selector ? resolve(args.selector) : (document.querySelector('main,[role="main"],article') || document.body);
        const content = (el || document.body).innerText.trim().replace(/\s+/g,' ').slice(0, 2000);
        speak(content.slice(0, 400));
        return { success: true, content };
      }

      case 'read_aloud': {
        const text = (args.text || '').trim();
        if (!text) return { success: false, error: 'No text' };
        speak(text); return { success: true };
      }

      case 'select_option': {
        const el = resolve(args.selector);
        if (!el || el.tagName !== 'SELECT') return { success: false, error: 'No dropdown found' };
        const opt = Array.from(el.options).find(o => o.text.toLowerCase().includes((args.value||'').toLowerCase()) || o.value.toLowerCase() === (args.value||'').toLowerCase());
        if (!opt) return { success: false, error: `Option not found: ${args.value}` };
        el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, selected: opt.text };
      }

      case 'describe_image': {
        const el = resolve(args.selector);
        const alt = el?.getAttribute('alt');
        if (alt && alt.length > 3) { speak(alt.slice(0,80)); return { success: true, description: alt }; }
        let src = el?.src || el?.getAttribute('data-src');
        if (!src) return { success: false, error: 'No image source' };
        if (!src.startsWith('http')) src = location.origin + src;
        try {
          const resp = await ipc({ type: 'API_REQUEST', model: 'gpt-4o', messages: [{ role: 'user', content: [
            { type: 'text', text: 'Describe this image in 10 words or fewer.' },
            { type: 'image_url', image_url: { url: src, detail: 'low' } },
          ]}], max_tokens: 25, temperature: 0.3 });
          const desc = resp?.data?.choices?.[0]?.message?.content?.trim() || 'Image';
          speak(desc); showHoverTip(el, desc);
          return { success: true, description: desc };
        } catch (e) { return { success: false, error: e.message }; }
      }

      default: return { success: false, error: `Unknown: ${name}` };
    }
  }

  // ─── TTS ──────────────────────────────────────────────────
  function speak(text) {
    if (!text || !window.speechSynthesis) return;
    const clean = text.replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim().slice(0,500);
    if (!clean) return;
    if (ttsQueue.length > 2) { window.speechSynthesis.cancel(); ttsQueue = []; ttsPlaying = false; }
    ttsQueue.push(clean);
    if (!ttsPlaying) drainTTS();
  }
  function drainTTS() {
    if (!ttsQueue.length) { ttsPlaying = false; return; }
    ttsPlaying = true;
    const utt = new SpeechSynthesisUtterance(ttsQueue.shift());
    utt.rate = 1.05; utt.pitch = 1.0; utt.volume = 1.0;
    const voices = window.speechSynthesis.getVoices();
    const v = voices.find(v => v.lang.startsWith('en') && v.name.toLowerCase().includes('google')) ||
              voices.find(v => v.lang.startsWith('en-') && !v.localService) ||
              voices.find(v => v.lang.startsWith('en'));
    if (v) utt.voice = v;
    utt.onend = drainTTS; utt.onerror = drainTTS;
    window.speechSynthesis.speak(utt);
  }
  function stopSpeech() { if (window.speechSynthesis) window.speechSynthesis.cancel(); ttsQueue = []; ttsPlaying = false; }

  // ─── Page helpers ─────────────────────────────────────────
  function pageContext() {
    const lines = [`URL: ${location.href}`, `Title: ${document.title}`];
    const headings = [...document.querySelectorAll('h1,h2,h3')].slice(0,8).map(h => `[${h.tagName}] ${h.textContent.trim().slice(0,60)}`);
    if (headings.length) lines.push('Headings: ' + headings.join(' | '));
    const els = []; let i = 0;
    document.querySelectorAll('a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="combobox"]').forEach(el => {
      if (i >= 80 || el.closest('#accessai-sidebar')) return;
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const d = descEl(el); if (!d) return;
      els.push(`[${i}] ${d} → ${genSel(el)}`); i++;
    });
    lines.push(`\nElements (${i}):\n` + els.join('\n'));
    return lines.join('\n');
  }

  function findEls(description) {
    const words = description.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const results = [], seen = new Set();
    document.querySelectorAll('a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"]').forEach((el, idx) => {
      if (el.closest('#accessai-sidebar')) return;
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const s = genSel(el); if (seen.has(s)) return;
      const d = descEl(el); if (!d) return;
      const searchable = [d, el.textContent, el.getAttribute('aria-label'), el.getAttribute('placeholder')].filter(Boolean).join(' ').toLowerCase();
      const score = words.filter(w => searchable.includes(w)).length;
      if (score > 0) { seen.add(s); results.push({ description: d, selector: s, score, idx }); }
    });
    results.sort((a, b) => b.score - a.score || a.idx - b.idx);
    return { count: results.length, elements: results.slice(0, 10) };
  }

  function resolve(selector) {
    if (!selector) return null;
    if (selector.startsWith('//') || selector.startsWith('xpath:')) {
      try { const r = document.evaluate(selector.replace(/^xpath:/,''), document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); if (r.singleNodeValue) return r.singleNodeValue; } catch (e) {}
    }
    try { const el = document.querySelector(selector); if (el && !el.closest('#accessai-sidebar')) return el; } catch (e) {}
    try { const el = document.querySelector(`[aria-label="${selector}"]`); if (el && !el.closest('#accessai-sidebar')) return el; } catch (e) {}
    return findByText(selector);
  }

  function findByText(text) {
    if (!text) return null;
    const lower = text.toLowerCase().trim();
    let best = null, bestScore = 0;
    document.querySelectorAll('button,a,[role="button"],[role="link"]').forEach(el => {
      if (el.closest('#accessai-sidebar')) return;
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const t = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase().trim();
      if (!t) return;
      const score = t === lower ? 100 : t.includes(lower) ? 80 : lower.includes(t) && t.length > 3 ? 60 : lower.split(/\s+/).filter(w => w.length > 2 && t.includes(w)).length * 15;
      if (score > bestScore) { bestScore = score; best = el; }
    });
    return bestScore >= 15 ? best : null;
  }

  function genSel(el) {
    if (el.id && !/^\d/.test(el.id) && el.id.length < 50 && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const tag = el.tagName.toLowerCase();
    const aria = el.getAttribute('aria-label'); if (aria && aria.length < 80) return `${tag}[aria-label="${aria.replace(/"/g,"'")}"]`;
    const name = el.getAttribute('name'); if (name && ['input','textarea','select'].includes(tag)) return `${tag}[name="${name}"]`;
    const ph = el.getAttribute('placeholder'); if (ph && ph.length < 60) return `${tag}[placeholder="${ph.replace(/"/g,"'")}"]`;
    if (tag === 'a') { const href = el.getAttribute('href'); if (href && href.length < 80 && !href.startsWith('javascript:')) return `a[href="${href.replace(/"/g,"'")}"]`; }
    const text = el.textContent?.trim().slice(0,40); if (text && el.children.length === 0 && text.length > 1) return `xpath://${tag}[normalize-space()="${text.replace(/"/g,"'")}"]`;
    return tag;
  }

  function descEl(el) {
    const tag = el.tagName?.toLowerCase();
    if (!tag || ['hr','br','script','style','svg','path'].includes(tag)) return null;
    if (el.getAttribute('aria-hidden') === 'true') return null;
    const aria = el.getAttribute('aria-label'), text = el.textContent?.trim().slice(0,80), title = el.getAttribute('title'), role = el.getAttribute('role');
    if (tag === 'a') return `Link: ${text || aria || title || 'unknown'}`;
    if (tag === 'button' || role === 'button') return `Button: ${text || aria || title || 'unnamed'}`;
    if (tag === 'input') return `Input(${el.type||'text'}): ${aria || el.placeholder || el.name || ''}`;
    if (tag === 'select') return `Dropdown: ${aria || el.name || ''}`;
    if (tag === 'textarea') return `Textarea: ${aria || el.placeholder || ''}`;
    if (/^h[1-4]$/.test(tag)) return `Heading: ${text}`;
    if (role === 'menuitem') return `MenuItem: ${text || aria || ''}`;
    if (role === 'tab') return `Tab: ${text || aria || ''}`;
    if (role === 'link') return `Link: ${text || aria || ''}`;
    if (['div','span'].includes(tag) && !text && !aria) return null;
    return aria || title || null;
  }

  // ─── Confirm ──────────────────────────────────────────────
  function checkConfirm(text) {
    if (!pendingConfirm) return false;
    if (/\bconfirm\b/i.test(text)) { const cmd = pendingConfirm; pendingConfirm = null; runTask(cmd + ' (confirmed)'); }
    else { pendingConfirm = null; addMsg('system', 'Cancelled.'); speak('Cancelled.'); }
    return true;
  }

  // ─── Hover ────────────────────────────────────────────────
  function showHoverTip(el, text) {
    if (!hoverOverlay) return;
    hoverOverlay.textContent = text;
    hoverOverlay.style.display = 'block';
    const r = el.getBoundingClientRect();
    hoverOverlay.style.left = Math.min(r.left, window.innerWidth - 320) + 'px';
    hoverOverlay.style.top = Math.max(4, r.bottom + 6) + 'px';
  }

  async function describeImageHover(imgEl) {
    if (!apiKey) return;
    const alt = imgEl.getAttribute('alt');
    if (alt && alt.length > 3) { showHoverTip(imgEl, alt.slice(0,80)); speak(alt.slice(0,80)); return; }
    let src = imgEl.src || imgEl.getAttribute('data-src') || imgEl.getAttribute('data-lazy-src');
    if (!src || src.startsWith('data:') || src.length < 10) return;
    if (!src.startsWith('http')) src = location.origin + (src.startsWith('/') ? '' : '/') + src;
    showHoverTip(imgEl, 'Describing image…');
    try {
      const resp = await ipc({ type: 'API_REQUEST', model: 'gpt-4o', messages: [{ role: 'user', content: [
        { type: 'text', text: 'Describe this image in 10 words or fewer. State main subject and purpose.' },
        { type: 'image_url', image_url: { url: src, detail: 'low' } },
      ]}], max_tokens: 25, temperature: 0.3 });
      const desc = resp?.data?.choices?.[0]?.message?.content?.trim() || alt || 'Image';
      showHoverTip(imgEl, desc); speak(desc);
    } catch (e) { if (alt) showHoverTip(imgEl, alt); else hoverOverlay.style.display = 'none'; }
  }

  function onHover(e) {
    if (!paneReady) return;
    const target = e.target;
    if (!target || target.closest('#accessai-sidebar') || target.id === 'ws7-hover') return;
    clearTimeout(hoverTimer);

    // FIX: find <img> inside the hovered element tree
    const imgEl = target.tagName === 'IMG' ? target :
                  target.querySelector?.('img') ||
                  target.closest('a,figure,div')?.querySelector('img');

    if (imgEl && isActive) {
      if (imgEl === lastHoverEl) return;
      lastHoverEl = imgEl;
      const linkText = target.closest('a')?.getAttribute('title') || target.closest('a')?.textContent?.trim().slice(0,60);
      if (linkText) showHoverTip(imgEl, linkText);
      hoverTimer = setTimeout(() => describeImageHover(imgEl), 800);
      return;
    }

    // Non-image elements
    const d = makeContextualDesc(target);
    if (!d) { if (hoverOverlay) hoverOverlay.style.display = 'none'; return; }
    showHoverTip(target, d);
  }

  function makeContextualDesc(el) {
    const tag = el.tagName?.toLowerCase();
    if (!tag) return null;
    const aria = el.getAttribute('aria-label');
    const text = el.textContent?.trim().slice(0,60);
    const href = el.getAttribute('href');
    const role = el.getAttribute('role');
    if (tag === 'a' || role === 'link') {
      if (href?.includes('cart')) return 'Link: Shopping cart';
      if (href?.includes('account') || href?.includes('profile')) return 'Link: Your account';
      if (href?.includes('search')) return 'Link: Search page';
      return text || aria ? `Link: ${(text||aria).slice(0,60)}` : null;
    }
    if (tag === 'button' || role === 'button') return `Button: ${text || aria || 'click to activate'}`;
    if (tag === 'input') {
      if (el.type === 'search') return `Search box: ${el.getAttribute('placeholder') || 'type to search'}`;
      return `Input (${el.type||'text'}): ${aria || el.getAttribute('placeholder') || el.name || ''}`;
    }
    if (tag === 'select') return `Dropdown: ${aria || el.name || 'select an option'}`;
    if (/^h[1-4]$/.test(tag)) return `Heading: ${text}`;
    return descEl(el);
  }

  // ─── Init pane ────────────────────────────────────────────
  async function initPane() {
    if (paneReady) return;
    const pane = window.__accessai?.getSidebarPane('web-sight');
    if (!pane) { setTimeout(initPane, 200); return; }
    paneReady = true; paneEl = pane;
    paneEl.innerHTML = '';
    paneEl.style.cssText = 'padding:0;overflow:hidden;display:flex;flex-direction:column;height:100%;';

    const style = document.createElement('style');
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@700;800&display=swap');
      .ws7{display:flex;flex-direction:column;height:100%;overflow:hidden;font-family:'Syne',sans-serif;}
      .ws7-hdr{display:flex;align-items:center;gap:10px;padding:12px 14px 10px;flex-shrink:0;border-bottom:1px solid rgba(255,255,255,.05);background:linear-gradient(180deg,rgba(6,182,212,.07) 0%,transparent 100%);}
      .ws7-dot{width:8px;height:8px;border-radius:50%;background:#374151;flex-shrink:0;transition:all .3s;}
      .ws7-dot.on{background:#06b6d4;box-shadow:0 0 8px #06b6d4;animation:ws7p 2s infinite;}
      .ws7-dot.thinking{background:#f59e0b;box-shadow:0 0 8px #f59e0b;animation:ws7p .5s infinite;}
      @keyframes ws7p{0%,100%{opacity:1}50%{opacity:.4}}
      .ws7-title{font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#f0ecff;}
      .ws7-sub{font-size:9px;font-family:'DM Mono',monospace;color:#4b5563;}
      .ws7-stopbar{display:none;flex-shrink:0;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.06);}
      .ws7-stopbar.show{display:block;}
      .ws7-stopbtn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:9px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);border-radius:10px;cursor:pointer;font-family:'Syne',sans-serif;font-size:12px;font-weight:700;color:#fca5a5;transition:all .2s;}
      .ws7-stopbtn:hover{background:rgba(239,68,68,.22);}
      .ws7-restartbar{display:none;flex-shrink:0;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.06);}
      .ws7-restartbar.show{display:block;}
      .ws7-restartbtn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:9px;background:linear-gradient(135deg,rgba(6,182,212,.2),rgba(124,58,237,.16));border:1px solid rgba(6,182,212,.35);border-radius:10px;cursor:pointer;font-family:'Syne',sans-serif;font-size:12px;font-weight:700;color:#cffafe;transition:all .2s;}
      .ws7-restartbtn:hover{background:linear-gradient(135deg,rgba(6,182,212,.32),rgba(124,58,237,.25));}
      .ws7-status{display:none;flex-shrink:0;padding:5px 14px;font-family:'DM Mono',monospace;font-size:10px;color:#4b5563;border-bottom:1px solid rgba(255,255,255,.04);min-height:26px;align-items:center;}
      .ws7-status.show{display:flex;}
      .ws7-status.on{color:#06b6d4;}
      .ws7-status.thinking{color:#f59e0b;}
      .ws7-cta{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px 16px;}
      .ws7-startbtn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:16px;background:linear-gradient(135deg,rgba(6,182,212,.28),rgba(124,58,237,.22));border:1.5px solid rgba(6,182,212,.42);border-radius:14px;cursor:pointer;font-family:'Syne',sans-serif;font-size:16px;font-weight:800;color:#cffafe;box-shadow:0 0 24px rgba(6,182,212,.12);transition:all .2s;}
      .ws7-startbtn:hover{background:linear-gradient(135deg,rgba(6,182,212,.42),rgba(124,58,237,.32));transform:translateY(-1px);}
      .ws7-hint{font-size:10px;color:#374151;font-family:'DM Mono',monospace;text-align:center;line-height:1.7;max-width:220px;}
      .ws7-feed{display:none;flex:1;flex-direction:column;overflow-y:auto;scroll-behavior:smooth;scrollbar-width:thin;scrollbar-color:rgba(6,182,212,.25) transparent;}
      .ws7-feed.show{display:flex;}
      .ws7-feed::-webkit-scrollbar{width:3px;}
      .ws7-feed::-webkit-scrollbar-thumb{background:rgba(6,182,212,.25);border-radius:2px;}
      .ws7-msg{padding:9px 14px;font-size:12px;line-height:1.5;border-bottom:1px solid rgba(255,255,255,.025);flex-shrink:0;}
      .ws7-user{background:rgba(96,165,250,.07);border-left:3px solid rgba(96,165,250,.55);}
      .ws7-user .lbl{display:block;font-size:9px;font-family:'DM Mono',monospace;color:#60a5fa;letter-spacing:.1em;text-transform:uppercase;margin-bottom:3px;}
      .ws7-user .body{color:#bfdbfe;font-weight:600;}
      .ws7-response{background:rgba(6,182,212,.06);border-left:3px solid rgba(6,182,212,.45);}
      .ws7-response .lbl{display:block;font-size:9px;font-family:'DM Mono',monospace;color:#22d3ee;letter-spacing:.1em;text-transform:uppercase;margin-bottom:3px;}
      .ws7-response .body{color:#cffafe;}
      .ws7-action{font-family:'DM Mono',monospace;font-size:10px;color:#2d3748;padding:4px 14px;}
      .ws7-system{font-family:'DM Mono',monospace;font-size:10px;color:#374151;font-style:italic;text-align:center;}
      .ws7-error{font-family:'DM Mono',monospace;font-size:11px;color:#f87171;background:rgba(239,68,68,.05);border-left:3px solid rgba(239,68,68,.4);}
      .ws7-info{font-family:'DM Mono',monospace;font-size:10px;color:#a78bfa;}
      .ws7-confirm{font-size:12px;color:#fbbf24;background:rgba(251,191,36,.05);border-left:3px solid rgba(251,191,36,.4);}
      .ws7-row{display:none;flex-shrink:0;gap:6px;padding:8px 10px;border-top:1px solid rgba(255,255,255,.05);align-items:center;}
      .ws7-row.show{display:flex;}
      .ws7-input{flex:1;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);border-radius:8px;padding:8px 10px;color:#f0ecff;font-family:'DM Mono',monospace;font-size:11px;outline:none;}
      .ws7-input::placeholder{color:#374151;}
      .ws7-input:focus{border-color:rgba(6,182,212,.35);}
      .ws7-sendbtn{background:rgba(6,182,212,.15);border:1px solid rgba(6,182,212,.3);border-radius:8px;padding:8px 12px;cursor:pointer;color:#22d3ee;font-size:13px;transition:all .2s;flex-shrink:0;}
      .ws7-sendbtn:hover{background:rgba(6,182,212,.25);}
      .ws7-clearbtn{background:transparent;border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:8px 10px;cursor:pointer;color:#374151;font-size:11px;flex-shrink:0;transition:all .2s;}
      .ws7-clearbtn:hover{border-color:rgba(239,68,68,.3);color:#f87171;}
      #ws7-hover{position:fixed;z-index:2147483646;background:rgba(6,182,212,.93);color:#000;font-size:12px;font-weight:700;padding:6px 12px;border-radius:8px;pointer-events:none;max-width:300px;word-wrap:break-word;box-shadow:0 4px 16px rgba(0,0,0,.4);display:none;}
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.className = 'ws7';
    root.innerHTML = `
      <div class="ws7-hdr">
        <div class="ws7-dot" id="ws7-dot"></div>
        <div><div class="ws7-title">Web-Sight</div><div class="ws7-sub">AI Browser Agent · Voice + Vision</div></div>
      </div>
      <div class="ws7-stopbar" id="ws7-stopbar">
        <button class="ws7-stopbtn" id="ws7-stopbtn">⏹ &nbsp;Stop</button>
      </div>
      <div class="ws7-restartbar" id="ws7-restartbar">
        <button class="ws7-restartbtn" id="ws7-restartbtn">🌐 &nbsp;Start</button>
      </div>
      <div class="ws7-status" id="ws7-status"></div>
      <div class="ws7-cta" id="ws7-cta">
        <button class="ws7-startbtn" id="ws7-startbtn"><span style="font-size:22px">🌐</span> Start</button>
        <div class="ws7-hint">Voice-controlled AI · reads pages aloud · describes images · controls browser hands-free</div>
      </div>
      <div class="ws7-feed" id="ws7-feed"></div>
      <div class="ws7-row" id="ws7-row">
        <input class="ws7-input" id="ws7-input" placeholder="Or type a command…" />
        <button class="ws7-sendbtn" id="ws7-send">▶</button>
        <button class="ws7-clearbtn" id="ws7-clear">🗑</button>
      </div>
    `;
    paneEl.appendChild(root);
    outputEl = document.getElementById('ws7-feed');

    document.getElementById('ws7-startbtn').addEventListener('click', toggle);
    document.getElementById('ws7-stopbtn').addEventListener('click', toggle);
    document.getElementById('ws7-restartbtn').addEventListener('click', toggle);
    document.getElementById('ws7-send').addEventListener('click', sendText);
    document.getElementById('ws7-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendText(); });
    document.getElementById('ws7-clear').addEventListener('click', () => { clearHistory(); outputEl.innerHTML = ''; document.getElementById('ws7-restartbar').classList.remove('show'); document.getElementById('ws7-cta').style.display = 'flex'; document.getElementById('ws7-feed').classList.remove('show'); document.getElementById('ws7-row').classList.remove('show'); addMsg('system', 'Cleared.'); });

    if (!hoverOverlay) {
      hoverOverlay = document.createElement('div');
      hoverOverlay.id = 'ws7-hover';
      document.body.appendChild(hoverOverlay);
    }
    document.addEventListener('mouseover', onHover, true);
    document.addEventListener('mouseout', e => {
      if (!e.relatedTarget?.closest?.('#accessai-sidebar')) { clearTimeout(hoverTimer); lastHoverEl = null; if (hoverOverlay) hoverOverlay.style.display = 'none'; }
    }, true);

    await loadHistory();
    if (history.length > 0) {
      document.getElementById('ws7-cta').style.display = 'none';
      document.getElementById('ws7-restartbar').classList.add('show');
      document.getElementById('ws7-feed').classList.add('show');
      document.getElementById('ws7-row').classList.add('show');
      history.forEach(replayEntry);
    }

    chrome.storage.local.get('ws_reconnect', r => {
      if (chrome.runtime.lastError || !r.ws_reconnect) return;
      chrome.storage.local.remove('ws_reconnect');
      setTimeout(() => { if (!isActive) startAgent(); }, 1200);
    });
  }

  // ─── Layout ───────────────────────────────────────────────
  function showActive() {
    document.getElementById('ws7-cta').style.display = 'none';
    document.getElementById('ws7-restartbar').classList.remove('show');
    document.getElementById('ws7-stopbar').classList.add('show');
    document.getElementById('ws7-status').classList.add('show');
    document.getElementById('ws7-feed').classList.add('show');
    document.getElementById('ws7-row').classList.add('show');
  }

  function showIdle() {
    document.getElementById('ws7-stopbar').classList.remove('show');
    document.getElementById('ws7-status').classList.remove('show');
    if (history.length > 0) {
      // Keep feed visible, show compact Start button
      document.getElementById('ws7-restartbar').classList.add('show');
      document.getElementById('ws7-feed').classList.add('show');
      document.getElementById('ws7-row').classList.add('show');
    } else {
      // No history: show big CTA
      document.getElementById('ws7-cta').style.display = 'flex';
    }
  }

  function setStatus(msg, cls) {
    const el = document.getElementById('ws7-status');
    if (!el) return;
    el.textContent = msg; el.className = 'ws7-status show ' + (cls||'');
  }
  function setDot(state) {
    const el = document.getElementById('ws7-dot');
    if (el) el.className = 'ws7-dot' + (state ? ' '+state : '');
  }

  // ─── Agent lifecycle ──────────────────────────────────────
  async function toggle() { if (isActive) stopAgent(); else await startAgent(); }

  async function startAgent() {
    document.getElementById('ws7-restartbar').classList.remove('show');
    showActive(); setDot('thinking'); setStatus('Connecting…', '');
    try {
      const kr = await ipc({ type: 'API_REALTIME_SESSION' });
      if (!kr?.success) throw new Error('Could not get API key. Check extension settings.');
      apiKey = kr.apiKey;
      setStatus('Requesting microphone…', '');
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 24000, channelCount: 1 } });
      pbCtx = new AudioContext({ sampleRate: 24000 }); pbNext = 0; reconnectCount = 0; shouldReconnect = true;
      setStatus('Connecting to AI…', '');
      await connectWS();
      ipc({ type: 'WEBSIGHT_ACTIVE_STATE', active: true }).catch(() => {});
    } catch (err) { addMsg('error', err.message || 'Failed to start'); stopAgent(false); }
  }

  function stopAgent(showMsg = true) {
    isActive = false; isRunning = false; cancelTask = true; shouldReconnect = false;
    stopSpeech();
    if (micProc) { try { micProc.disconnect(); } catch (e) {} micProc = null; }
    if (micCtx)  { try { micCtx.close(); }       catch (e) {} micCtx = null; }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    if (pbCtx) { try { pbCtx.close(); } catch (e) {} pbCtx = null; }
    pendingConfirm = null;
    chrome.storage.local.remove('ws_reconnect');
    ipc({ type: 'WEBSIGHT_ACTIVE_STATE', active: false }).catch(() => {});
    setDot('');
    showIdle(); // always shows Start now
    if (showMsg) addMsg('system', 'Stopped. Tap Start to begin again.');
    window.__accessai?.setFooterStatus('Web-Sight stopped');
  }

  // ─── WebSocket ────────────────────────────────────────────
  async function connectWS() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { try { ws?.close(); } catch (e) {} reject(new Error('Timed out')); }, 15000);
      ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', ['realtime', `openai-insecure-api-key.${apiKey}`, 'openai-beta.realtime-v1']);
      ws.onopen = () => {
        clearTimeout(timeout);
        ws.send(JSON.stringify({ type: 'session.update', session: { modalities: ['text','audio'], instructions: 'Transcription service only. Output ONLY the English transcription of speech. No comments or responses.', voice: 'alloy', input_audio_format: 'pcm16', output_audio_format: 'pcm16', input_audio_transcription: { model: 'whisper-1', language: 'en' }, turn_detection: { type: 'server_vad', threshold: 0.45, prefix_padding_ms: 300, silence_duration_ms: 800, create_response: false }, temperature: 0.6, max_response_output_tokens: 1 } }));
        isActive = true; setDot('on'); setStatus('Listening… Speak your command!', 'on');
        addMsg('system', 'Web-Sight connected. Speak your command!');
        speak('Web-Sight ready. Speak your command.');
        startMic(); resolve();
      };
      ws.onmessage = e => { try { onWS(JSON.parse(e.data)); } catch (ex) {} };
      ws.onerror = () => { clearTimeout(timeout); reject(new Error('WebSocket failed')); };
      ws.onclose = () => {
        if (!isActive || !shouldReconnect) return;
        reconnectCount++;
        if (reconnectCount > MAX_RECONNECT) { addMsg('error', 'Connection lost. Tap Start to retry.'); stopAgent(false); return; }
        const delay = Math.min(2000 * reconnectCount, 8000);
        addMsg('system', `Reconnecting (${reconnectCount})…`);
        setTimeout(async () => { if (!isActive) return; try { await connectWS(); reconnectCount = 0; } catch (e) {} }, delay);
      };
    });
  }

  function startMic() {
    if (!micStream) return;
    try {
      micCtx = new AudioContext({ sampleRate: 24000 });
      const src = micCtx.createMediaStreamSource(micStream);
      micProc = micCtx.createScriptProcessor(2048, 1, 1);
      micProc.onaudioprocess = e => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const f32 = e.inputBuffer.getChannelData(0);
        const i16 = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); i16[i] = s < 0 ? s * 32768 : s * 32767; }
        const bytes = new Uint8Array(i16.buffer);
        let bin = ''; for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
        try { ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(bin) })); } catch (e) {}
      };
      src.connect(micProc); micProc.connect(micCtx.destination);
    } catch (e) { console.error('[Web-Sight] Mic error:', e); }
  }

  function onWS(ev) {
    switch (ev.type) {
      case 'input_audio_buffer.speech_started': stopSpeech(); setStatus('Speech detected…', 'on'); break;
      case 'input_audio_buffer.speech_stopped': if (!isRunning) setStatus('Processing…', 'thinking'); break;
      case 'conversation.item.input_audio_transcription.completed':
        if (ev.transcript?.trim()) { const t = ev.transcript.trim(); addMsg('user', t); if (!checkConfirm(t)) runTask(t); }
        break;
      case 'response.done': if (!isRunning) { setDot('on'); setStatus('Listening… Speak your command!', 'on'); } break;
      case 'error': if (ev.error?.code === 'session_expired') { addMsg('system', 'Session expired, reconnecting…'); try { ws?.close(); } catch (e) {} } break;
    }
  }

  // ─── Text input ───────────────────────────────────────────
  function sendText() {
    const inp = document.getElementById('ws7-input');
    if (!inp) return;
    const text = inp.value.trim(); if (!text) return;
    inp.value = ''; addMsg('user', text);
    if (checkConfirm(text)) return;
    if (!isActive) { showActive(); addMsg('system', 'Starting…'); startAgent().then(() => runTask(text)); }
    else runTask(text);
  }

  // ─── Messages ─────────────────────────────────────────────
  function addMsg(type, text) {
    if (!outputEl) return;
    const el = document.createElement('div');
    el.className = `ws7-msg ws7-${type}`;
    if (type === 'user') el.innerHTML = `<span class="lbl">You</span><span class="body">${esc(text)}</span>`;
    else if (type === 'response') el.innerHTML = `<span class="lbl">Web-Sight</span><span class="body">${esc(text)}</span>`;
    else el.textContent = text;
    outputEl.appendChild(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    const all = outputEl.querySelectorAll('.ws7-msg');
    if (all.length > 200) all[0].remove();
  }
  function replayEntry(e) {
    if (e.role === 'user' && e.type === 'cmd') addMsg('user', e.text);
    else if (e.role === 'ai' && e.type === 'reply') addMsg('response', e.text);
  }
  function highlight(el) {
    if (!el) return;
    const o = el.style.outline, oo = el.style.outlineOffset;
    el.style.outline = '3px solid #22d3ee'; el.style.outlineOffset = '2px';
    setTimeout(() => { el.style.outline = o; el.style.outlineOffset = oo; }, 2000);
  }
  function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
  function ts() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function ipc(msg) {
    return new Promise(r => {
      try { chrome.runtime.sendMessage(msg, res => { if (chrome.runtime.lastError) r({ success: false, error: chrome.runtime.lastError.message }); else r(res || { success: false }); }); }
      catch (e) { r({ success: false, error: e.message }); }
    });
  }

  // ─── Lifecycle ────────────────────────────────────────────
  window.addEventListener('accessai-mode-changed', e => {
    if (e.detail.mode === 'web-sight') initPane();
    else { if (isActive) stopAgent(); clearTimeout(hoverTimer); if (hoverOverlay) hoverOverlay.style.display = 'none'; }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PERFORM_DOM_ACTION') { execTool(msg.action.action, msg.action).then(r => sendResponse(r)).catch(() => sendResponse({ success: false })); return true; }
    if (msg.type === 'PING') { sendResponse({ alive: true }); return; }
    if (msg.type === 'RESTORE_STATE') {
      if (window.__accessai?.openSidebar) window.__accessai.openSidebar();
      if (msg.mode) setTimeout(() => window.dispatchEvent(new CustomEvent('accessai-mode-changed', { detail: { mode: msg.mode } })), 300);
      sendResponse({ success: true }); return;
    }
  });

  window.addEventListener('beforeunload', () => {
    if (isActive && shouldReconnect) chrome.storage.local.set({ ws_reconnect: true });
    saveHistory();
  });

  chrome.storage.local.get('activeMode', r => {
    if (!chrome.runtime.lastError && r.activeMode === 'web-sight') setTimeout(initPane, 500);
  });

})();