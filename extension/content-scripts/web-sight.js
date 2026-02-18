// ============================================================
// Web-Sight: Agentic Accessibility Assistant
//
// Architecture:
//   - OpenAI Realtime API  → mic streaming, voice transcription, TTS output
//   - GPT-4o + function calling → multi-step agentic browser control loop
//   - Each tool call executes a real DOM action, then re-scans the page
//   - Up to 12 steps per command before giving up
// ============================================================

(function () {
  'use strict';

  const SYSTEM_PROMPT = `You are Web-Sight, a hands-free AI browser agent for people with accessibility needs.

When the user gives a command, use your tools to complete it step by step.
- You receive the current page URL, title, headings, and all interactive elements with selectors.
- Use find_elements to discover what's on the page when you need to locate something.
- Use click_element, type_text, press_key in sequence to interact with forms and buttons.
- Use get_page_context after actions to see what the page now shows.
- Give a SHORT spoken reply when done (1-2 sentences, plain English, grade 5 level).
- If uncertain, prefer find_elements first then click.

SAFETY: If the user's command involves "buy", "checkout", "purchase", or "pay" — do NOT proceed. Instead reply asking them to say "confirm" first.`;

  // ------- State -------
  let paneEl       = null;
  let outputEl     = null;
  let hoverOverlay = null;
  let initialized  = false;
  let isAgentActive = false;
  let isTaskRunning = false;
  let pendingConfirm = null;

  // Realtime WebSocket + Audio
  let ws           = null;
  let micStream    = null;
  let micContext   = null;
  let micProcessor = null;
  let apiKey       = null;

  // Audio playback for AI voice response
  let playbackContext = null;
  let nextStartTime   = 0;

  // ============================================================
  // FUNCTION-CALLING TOOL DEFINITIONS
  // ============================================================
  const BROWSER_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'get_page_context',
        description: 'Get the current page URL, title, headings, and all interactive elements. Call this any time you need to see what is on the page.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'find_elements',
        description: 'Search for elements on the page matching a natural language description. Returns matching elements with selectors.',
        parameters: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'e.g. "search box", "login button", "price of first item"' }
          },
          required: ['description']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'click_element',
        description: 'Click an element. Tries the selector first, then falls back to text/aria-label matching.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector, xpath: prefix for XPath, or visible text of the button/link' },
            description: { type: 'string', description: 'Human-readable label of what you are clicking' }
          },
          required: ['selector', 'description']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'type_text',
        description: 'Type text into an input field or textarea.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector or XPath of the input. Omit to use the currently focused field.' },
            text: { type: 'string', description: 'Text to type' },
            clear_first: { type: 'boolean', description: 'If true, clears existing content first (default true)' }
          },
          required: ['text']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'press_key',
        description: 'Press a keyboard key on the currently focused element, e.g. Enter to submit, Escape to dismiss.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Key name: Enter, Escape, Tab, ArrowDown, ArrowUp, Space, Backspace' },
            selector: { type: 'string', description: 'Optional: focus this element before pressing the key' }
          },
          required: ['key']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'scroll_page',
        description: 'Scroll the page.',
        parameters: {
          type: 'object',
          properties: {
            direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Scroll direction' },
            amount: { type: 'number', description: 'Pixels to scroll (default 500)' }
          },
          required: ['direction']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'navigate_to',
        description: 'Navigate the browser to a URL or website.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL or domain name, e.g. "skyscanner.com" or "https://google.com"' }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_page',
        description: 'Read the visible text content of the page or a specific section.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'Optional CSS selector to limit reading to that section. Omit for main content.' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'select_option',
        description: 'Select a value from a <select> dropdown.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector of the <select> element' },
            value: { type: 'string', description: 'Option text or value to select' }
          },
          required: ['selector', 'value']
        }
      }
    }
  ];

  // ============================================================
  // AGENTIC TASK RUNNER — GPT-4o + function calling loop
  // ============================================================
  async function runAgentTask(command) {
    if (isTaskRunning) {
      addMsg('warning', 'Still working on a previous task — please wait.');
      return;
    }

    // Safety: purchase commands require confirmation
    const buyWords = ['buy ', 'purchase', 'checkout', 'pay ', 'place order', 'order now'];
    if (buyWords.some(w => command.toLowerCase().includes(w))) {
      pendingConfirm = command;
      addMsg('confirm', `Safety: "${command.slice(0, 60)}" — say "confirm" to proceed, or say something else to cancel.`);
      return;
    }

    isTaskRunning = true;
    setOrbState('thinking');

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Command: "${command}"\n\n${buildRichPageContext()}` }
    ];

    const MAX_STEPS = 12;
    let steps = 0;
    let finalResponse = '';

    try {
      while (steps < MAX_STEPS) {
        steps++;

        const resp = await sendMessage({
          type: 'API_REQUEST',
          model: 'gpt-4o',
          messages,
          tools: BROWSER_TOOLS,
          tool_choice: 'auto',
          max_tokens: 600,
          temperature: 0.1
        });

        if (!resp.success) {
          addMsg('error', `API error: ${resp.error}`);
          break;
        }

        const choice = resp.data.choices?.[0];
        if (!choice) break;

        // --- Tool calls ---
        if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls?.length) {
          messages.push({
            role: 'assistant',
            content: choice.message.content || null,
            tool_calls: choice.message.tool_calls
          });

          for (const tc of choice.message.tool_calls) {
            let args;
            try { args = JSON.parse(tc.function.arguments); } catch(e) { args = {}; }

            const toolLabel = formatToolLabel(tc.function.name, args);
            addMsg('action', `→ ${toolLabel}`);

            const result = await executeBrowserTool(tc.function.name, args);

            messages.push({
              role: 'tool',
              content: typeof result === 'string' ? result : JSON.stringify(result),
              tool_call_id: tc.id
            });

            // Keep message history from bloating — trim old page contexts
            if (messages.length > 30) {
              messages.splice(2, 2); // remove oldest user+tool pair
            }
          }

          // Re-scan page after actions
          messages.push({
            role: 'user',
            content: 'Here is the updated page after those actions:\n' + buildRichPageContext()
          });

        // --- Final text response ---
        } else {
          finalResponse = choice.message?.content?.trim() || 'Done.';
          break;
        }
      }

      if (steps >= MAX_STEPS && !finalResponse) {
        finalResponse = 'I reached the maximum steps. The task may not be fully complete.';
      }

    } catch (err) {
      finalResponse = `Something went wrong: ${err.message}`;
    }

    if (finalResponse) {
      addMsg('response', finalResponse);
      speakResponse(finalResponse);
    }

    setOrbState('active');
    isTaskRunning = false;
  }

  function formatToolLabel(name, args) {
    switch (name) {
      case 'click_element':   return `Clicking: ${args.description || args.selector}`;
      case 'type_text':       return `Typing: "${(args.text || '').slice(0, 40)}"`;
      case 'press_key':       return `Press key: ${args.key}`;
      case 'navigate_to':     return `Navigating to: ${args.url}`;
      case 'scroll_page':     return `Scrolling ${args.direction}`;
      case 'find_elements':   return `Searching for: ${args.description}`;
      case 'get_page_context':return `Reading page`;
      case 'read_page':       return `Reading page content`;
      case 'select_option':   return `Selecting: ${args.value}`;
      default:                return name;
    }
  }

  // ============================================================
  // BROWSER TOOL EXECUTOR
  // ============================================================
  async function executeBrowserTool(name, args) {
    switch (name) {

      case 'get_page_context':
        return buildRichPageContext();

      case 'find_elements':
        return findElementsByDescription(args.description || '');

      case 'click_element': {
        const el = resolveElement(args.selector);
        if (el) {
          highlightElement(el);
          el.click();
          el.focus();
          await wait(400);
          return { success: true, clicked: args.description };
        }
        // Fallback: fuzzy text match
        const found = findElementsByDescription(args.description || args.selector || '');
        if (found.elements?.length > 0) {
          const fallback = resolveElement(found.elements[0].selector);
          if (fallback) {
            highlightElement(fallback);
            fallback.click();
            fallback.focus();
            await wait(400);
            return { success: true, clicked: found.elements[0].description };
          }
        }
        return { success: false, error: `Could not find element: ${args.selector}` };
      }

      case 'type_text': {
        let el = args.selector ? resolveElement(args.selector) : null;
        if (!el) {
          el = document.querySelector('input:focus, textarea:focus')
            || document.querySelector('input[type="text"], input[type="search"], input:not([type]), textarea');
        }
        if (!el) return { success: false, error: 'No input field found on page' };

        highlightElement(el);
        el.focus();

        if (args.clear_first !== false) {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // Set value directly then dispatch events (more reliable than char-by-char)
        el.value = (el.value || '') + (args.text || '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(200);
        return { success: true, typed: args.text };
      }

      case 'press_key': {
        const target = args.selector ? resolveElement(args.selector) : document.activeElement;
        if (target) target.focus();

        const keyMap = {
          'Enter':     { key: 'Enter',     code: 'Enter',      keyCode: 13 },
          'Escape':    { key: 'Escape',    code: 'Escape',     keyCode: 27 },
          'Tab':       { key: 'Tab',       code: 'Tab',        keyCode: 9  },
          'Space':     { key: ' ',         code: 'Space',      keyCode: 32 },
          'Backspace': { key: 'Backspace', code: 'Backspace',  keyCode: 8  },
          'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown',  keyCode: 40 },
          'ArrowUp':   { key: 'ArrowUp',   code: 'ArrowUp',    keyCode: 38 },
        };
        const k = keyMap[args.key] || { key: args.key, code: args.key, keyCode: 0 };
        const activeEl = target || document.body;

        activeEl.dispatchEvent(new KeyboardEvent('keydown',  { ...k, bubbles: true, cancelable: true }));
        activeEl.dispatchEvent(new KeyboardEvent('keypress', { ...k, bubbles: true, cancelable: true }));
        activeEl.dispatchEvent(new KeyboardEvent('keyup',    { ...k, bubbles: true }));

        // For Enter on forms, also try native submit
        if (args.key === 'Enter' && activeEl.tagName === 'INPUT' && activeEl.form) {
          activeEl.form.submit();
        }

        await wait(600);
        return { success: true, key: args.key };
      }

      case 'navigate_to': {
        let url = (args.url || '').trim();
        if (!url) return { success: false, error: 'No URL provided' };
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        addMsg('info', `Going to ${url}`);
        setTimeout(() => { window.location.href = url; }, 500);
        return { success: true, navigating_to: url };
      }

      case 'scroll_page': {
        const amt = args.amount || 500;
        switch (args.direction) {
          case 'top':    window.scrollTo({ top: 0, behavior: 'smooth' }); break;
          case 'bottom': window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); break;
          case 'up':     window.scrollBy({ top: -amt, behavior: 'smooth' }); break;
          default:       window.scrollBy({ top: amt, behavior: 'smooth' }); break;
        }
        await wait(400);
        return { success: true, scrolled: args.direction };
      }

      case 'read_page': {
        const el = args.selector
          ? resolveElement(args.selector)
          : document.querySelector('main, [role="main"], article') || document.body;
        const text = (el || document.body).innerText.trim().replace(/\s+/g, ' ').slice(0, 2000);
        return { success: true, content: text };
      }

      case 'select_option': {
        const sel = resolveElement(args.selector);
        if (!sel || sel.tagName !== 'SELECT') return { success: false, error: 'No <select> element found' };
        const option = Array.from(sel.options).find(o =>
          o.text.toLowerCase().includes((args.value || '').toLowerCase()) ||
          o.value.toLowerCase() === (args.value || '').toLowerCase()
        );
        if (!option) return { success: false, error: `Option "${args.value}" not found in dropdown` };
        sel.value = option.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, selected: option.text };
      }

      default:
        return { success: false, error: `Unknown tool: ${name}` };
    }
  }

  // ============================================================
  // ELEMENT RESOLUTION — multiple strategies in order
  // ============================================================
  function resolveElement(selector) {
    if (!selector) return null;

    // XPath
    if (selector.startsWith('xpath:') || selector.startsWith('//')) {
      try {
        const r = document.evaluate(
          selector.replace('xpath:', ''), document, null,
          XPathResult.FIRST_ORDERED_NODE_TYPE, null
        );
        if (r.singleNodeValue) return r.singleNodeValue;
      } catch(e) {}
    }

    // CSS selector
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch(e) {}

    // aria-label partial match
    try {
      const ariaEl = document.querySelector(`[aria-label*="${CSS.escape(selector)}"]`);
      if (ariaEl) return ariaEl;
    } catch(e) {}

    // Visible text match on interactive elements
    return findByText(selector);
  }

  function findByText(text) {
    if (!text || typeof text !== 'string') return null;
    const lower = text.toLowerCase().trim().slice(0, 60);
    const candidates = document.querySelectorAll(
      'button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"]'
    );
    for (const el of candidates) {
      if (el.closest('#accessai-sidebar')) continue;
      const elText = (el.textContent || el.value || el.getAttribute('aria-label') || '').toLowerCase().trim();
      if (elText === lower || elText.includes(lower) || lower.includes(elText.slice(0, 20))) return el;
    }
    return null;
  }

  function findElementsByDescription(description) {
    const lower = (description || '').toLowerCase();
    const words = lower.split(/\s+/).filter(w => w.length > 2);
    const results = [];
    const seen = new Set();

    document.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), select, textarea, ' +
      '[role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="combobox"], ' +
      '[tabindex]:not([tabindex="-1"])'
    ).forEach(el => {
      if (el.closest('#accessai-sidebar')) return;
      const sig = generateSelector(el);
      if (seen.has(sig)) return;

      const desc = describeElement(el) || '';
      const searchable = [
        desc, el.textContent, el.getAttribute('aria-label'),
        el.getAttribute('placeholder'), el.getAttribute('name'),
        el.getAttribute('type'), el.getAttribute('value')
      ].filter(Boolean).join(' ').toLowerCase();

      const score = words.filter(w => searchable.includes(w)).length;
      if (score > 0) {
        seen.add(sig);
        results.push({ description: desc, selector: sig, score });
      }
    });

    results.sort((a, b) => b.score - a.score);
    return { count: results.length, elements: results.slice(0, 10) };
  }

  // ============================================================
  // RICH PAGE CONTEXT
  // ============================================================
  function buildRichPageContext() {
    const lines = [
      `URL: ${window.location.href}`,
      `Title: ${document.title}`
    ];

    // Heading structure
    const headings = Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 8);
    if (headings.length) {
      lines.push('Headings: ' + headings.map(h => `[${h.tagName}] ${h.textContent.trim().slice(0, 50)}`).join(' | '));
    }

    // Interactive elements, only visible ones
    const els = [];
    let i = 0;
    document.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), select, textarea, ' +
      '[role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="combobox"]'
    ).forEach(el => {
      if (i >= 80) return;
      if (el.closest('#accessai-sidebar')) return;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const desc = describeElement(el);
      if (!desc) return;
      els.push(`[${i++}] ${desc} → ${generateSelector(el)}`);
    });

    lines.push(`\nInteractive elements (${i}):\n${els.join('\n')}`);

    const focused = document.activeElement;
    if (focused && focused !== document.body) {
      lines.push(`\nFocused: ${describeElement(focused) || focused.tagName}`);
    }

    return lines.join('\n');
  }

  function generateSelector(el) {
    if (el.id && !/^\d/.test(el.id) && el.id.length < 50) return `#${el.id}`;
    const tag = el.tagName.toLowerCase();
    const aria = el.getAttribute('aria-label');
    if (aria && aria.length < 80) return `${tag}[aria-label="${aria.replace(/"/g, "'")}"]`;
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (testId) return `[data-testid="${testId}"]`;
    const name = el.getAttribute('name');
    if (name && ['input','textarea','select'].includes(tag)) return `${tag}[name="${name}"]`;
    const ph = el.getAttribute('placeholder');
    if (ph && ph.length < 60) return `${tag}[placeholder="${ph.replace(/"/g, "'")}"]`;
    const text = el.textContent?.trim().slice(0, 30);
    if (text && el.children.length === 0) return `xpath://${tag}[normalize-space()="${text.replace(/"/g, "'")}"]`;
    const cls = Array.from(el.classList).filter(c => c.length > 2 && !/^\d/.test(c) && !c.match(/\d{3,}/)).slice(0, 2).join('.');
    if (cls) return `${tag}.${cls}`;
    return tag;
  }

  // ============================================================
  // CONFIRM / SAFETY CHECK
  // ============================================================
  function checkConfirmPhrase(text) {
    if (!pendingConfirm) return false;
    if (/\bconfirm\b/i.test(text)) {
      const cmd = pendingConfirm + ' (user confirmed)';
      pendingConfirm = null;
      runAgentTask(cmd);
    } else {
      pendingConfirm = null;
      addMsg('system', 'Action cancelled.');
    }
    return true;
  }

  // ============================================================
  // ORB STATE CONTROL
  // ============================================================
  function setOrbState(state) {
    const orb = document.getElementById('aai-ws-start-orb');
    const label = paneEl?.querySelector('.aai-start-label');
    if (!orb) return;

    orb.classList.remove('aai-orb-connecting', 'aai-orb-active', 'aai-orb-speaking');

    switch (state) {
      case 'thinking':
        orb.classList.add('aai-orb-connecting');
        if (label) label.textContent = 'Working...';
        window.__accessai?.setFooterStatus('Web-Sight: Working...');
        break;
      case 'active':
        orb.classList.add('aai-orb-active');
        if (label) label.textContent = 'Listening...';
        window.__accessai?.setFooterStatus('Web-Sight: Listening...');
        break;
      case 'speaking':
        orb.classList.add('aai-orb-speaking');
        window.__accessai?.setFooterStatus('Web-Sight: Speaking...');
        break;
    }
  }

  // ============================================================
  // SPEAK RESPONSE via Realtime API (inject text → request audio)
  // ============================================================
  function speakResponse(text) {
    if (!isAgentActive || !ws || ws.readyState !== WebSocket.OPEN) {
      sendMessage({ type: 'TTS_SPEAK', text, rate: 0.9, volume: 0.7 });
      return;
    }
    ws.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }]
      }
    }));
    ws.send(JSON.stringify({
      type: 'response.create',
      response: { modalities: ['text', 'audio'], max_output_tokens: 150 }
    }));
  }

  // ============================================================
  // INIT PANE
  // ============================================================
  function initPane() {
    if (initialized) return;
    const pane = window.__accessai?.getSidebarPane('web-sight');
    if (!pane) { setTimeout(initPane, 200); return; }

    initialized = true;
    paneEl = pane;
    paneEl.innerHTML = `
      <div class="aai-ws-output" id="aai-ws-output" role="log" aria-live="polite">
        <div class="aai-ws-hero-wrap" id="aai-ws-hero">
          <div class="aai-start-hero">
            <button class="aai-start-orb" id="aai-ws-start-orb" aria-label="Start Web-Sight AI">
              <span class="aai-orb-ring aai-orb-ring-1"></span>
              <span class="aai-orb-ring aai-orb-ring-2"></span>
              <span class="aai-orb-ring aai-orb-ring-3"></span>
              <span class="aai-orb-core">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <circle cx="12" cy="12" r="4"/>
                  <line x1="21.17" y1="8" x2="12" y2="8"/>
                  <line x1="3.95" y1="6.06" x2="8.54" y2="14"/>
                  <line x1="10.88" y1="21.94" x2="15.46" y2="14"/>
                </svg>
              </span>
            </button>
            <div class="aai-start-label">Start Web-Sight</div>
            <div class="aai-start-sublabel">Hands-free AI that controls the browser by your voice</div>
          </div>
        </div>
      </div>

      <div class="aai-ws-input-row">
        <input type="text" id="aai-ws-text-input" class="aai-ws-text-field"
          placeholder="Or type a command here..." aria-label="Type a command" />
        <button class="aai-ws-btn" id="aai-ws-send" aria-label="Send">&#10148;</button>
      </div>
    `;

    outputEl = document.getElementById('aai-ws-output');

    document.getElementById('aai-ws-start-orb').addEventListener('click', toggleAgent);
    document.getElementById('aai-ws-send').addEventListener('click', handleTextCommand);
    document.getElementById('aai-ws-text-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleTextCommand();
    });

    if (!hoverOverlay) {
      hoverOverlay = document.createElement('div');
      hoverOverlay.id = 'accessai-ws-hover-overlay';
      hoverOverlay.setAttribute('role', 'tooltip');
      hoverOverlay.style.display = 'none';
      document.body.appendChild(hoverOverlay);
    }

    document.addEventListener('mouseover', handleHover, true);
    document.addEventListener('mouseout', () => { if (hoverOverlay) hoverOverlay.style.display = 'none'; }, true);
  }

  // ============================================================
  // AGENT TOGGLE
  // ============================================================
  async function toggleAgent() {
    isAgentActive ? stopAgent() : await startAgent();
  }

  async function startAgent() {
    const orb   = document.getElementById('aai-ws-start-orb');
    const label = paneEl.querySelector('.aai-start-label');
    orb.classList.add('aai-orb-connecting');
    if (label) label.textContent = 'Connecting...';

    try {
      const keyResp = await sendMessage({ type: 'API_REALTIME_SESSION' });
      if (!keyResp.success) throw new Error('Could not get API key');
      apiKey = keyResp.apiKey;

      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 24000, channelCount: 1 }
      });

      playbackContext = new AudioContext({ sampleRate: 24000 });
      nextStartTime = 0;

      await connectWebSocket();
    } catch (err) {
      orb.classList.remove('aai-orb-connecting');
      if (label) label.textContent = 'Start Web-Sight';
      addMsg('error', err.message);
      stopAgent(false);
    }
  }

  function stopAgent(showMsg = true) {
    isAgentActive = false;
    isTaskRunning = false;

    if (micProcessor) { try { micProcessor.disconnect(); } catch(e){} micProcessor = null; }
    if (micContext)   { try { micContext.close(); }        catch(e){} micContext = null; }
    if (micStream)    { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (ws)           { try { ws.close(); }                catch(e){} ws = null; }
    if (playbackContext) { try { playbackContext.close(); } catch(e){} playbackContext = null; }

    pendingConfirm = null;

    const orb      = document.getElementById('aai-ws-start-orb');
    const label    = paneEl?.querySelector('.aai-start-label');
    const sublabel = paneEl?.querySelector('.aai-start-sublabel');
    const hero     = document.getElementById('aai-ws-hero');

    if (orb)     orb.classList.remove('aai-orb-connecting', 'aai-orb-active', 'aai-orb-speaking');
    if (label)   label.textContent = 'Start Web-Sight';
    if (sublabel) sublabel.textContent = 'Hands-free AI that controls the browser by your voice';
    if (hero)    hero.classList.remove('aai-hero-compact');

    if (showMsg) addMsg('system', 'Agent stopped.');
    window.__accessai?.setFooterStatus('Web-Sight stopped');
  }

  // ============================================================
  // WEBSOCKET — Realtime API (voice only: transcription + TTS)
  // ============================================================
  async function connectWebSocket() {
    return new Promise((resolve, reject) => {
      ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', [
        'realtime',
        `openai-insecure-api-key.${apiKey}`,
        'openai-beta.realtime-v1'
      ]);

      ws.onopen = () => {
        // Configure: we use Realtime ONLY for mic transcription + TTS voice output
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            // This Realtime session is ONLY for: mic → transcription, and injected text → TTS.
            // It must NEVER respond on its own — all intelligence runs in the GPT-4o tool loop.
            instructions: 'You are a silent voice synthesizer. You only speak when an assistant message is explicitly injected. You NEVER respond to user speech on your own. Stay completely silent until spoken to.',
            voice: 'alloy',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 200,
              silence_duration_ms: 700,
              // Critical: do NOT auto-generate a response when VAD detects turn end.
              // Without this, Realtime API generates its own "I can't open websites" reply
              // before our response.cancel even arrives.
              create_response: false
            },
            temperature: 0.7,
            max_response_output_tokens: 150
          }
        }));

        isAgentActive = true;
        setOrbState('active');

        addMsg('system', 'Web-Sight connected — just speak your command!');
        startMicStreaming();
        resolve();
      };

      ws.onmessage = (e) => { try { handleRealtimeEvent(JSON.parse(e.data)); } catch(ex) {} };
      ws.onerror   = ()  => reject(new Error('WebSocket connection failed'));
      ws.onclose   = ()  => {
        if (isAgentActive) {
          setTimeout(async () => {
            if (isAgentActive) { try { await connectWebSocket(); } catch(err) { stopAgent(); } }
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
      let bin = '';
      for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(bin) }));
    };

    source.connect(micProcessor);
    micProcessor.connect(micContext.destination);
  }

  // ============================================================
  // REALTIME EVENT HANDLER (transcription + audio playback only)
  // ============================================================
  function handleRealtimeEvent(ev) {
    switch (ev.type) {

      case 'input_audio_buffer.speech_started':
        setOrbState('speaking');
        stopAudioPlayback();
        break;

      case 'input_audio_buffer.speech_stopped':
        if (!isTaskRunning) setOrbState('active');
        break;

      // Transcript received → run agentic task
      case 'conversation.item.input_audio_transcription.completed':
        if (ev.transcript?.trim()) {
          const transcript = ev.transcript.trim();
          addMsg('user', transcript);
          // No need to cancel — create_response:false means Realtime never auto-responds
          if (!checkConfirmPhrase(transcript)) {
            runAgentTask(transcript);
          }
        }
        break;

      // AI audio (TTS output from speakResponse)
      case 'response.audio.delta':
        if (ev.delta) scheduleAudioChunk(ev.delta);
        break;

      case 'response.done':
        if (!isTaskRunning) setOrbState('active');
        break;

      case 'error':
        addMsg('error', ev.error?.message || 'API error');
        break;
    }
  }

  // ============================================================
  // AUDIO PLAYBACK
  // ============================================================
  function scheduleAudioChunk(b64) {
    if (!playbackContext) return;
    const bin   = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const int16  = new Int16Array(bytes.buffer);
    const f32    = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768.0;
    const buf    = playbackContext.createBuffer(1, f32.length, 24000);
    buf.getChannelData(0).set(f32);
    const src    = playbackContext.createBufferSource();
    src.buffer   = buf;
    src.connect(playbackContext.destination);
    const startAt = Math.max(playbackContext.currentTime, nextStartTime);
    src.start(startAt);
    nextStartTime = startAt + buf.duration;
  }

  function stopAudioPlayback() {
    if (playbackContext) nextStartTime = playbackContext.currentTime;
  }

  // ============================================================
  // TEXT INPUT
  // ============================================================
  function handleTextCommand() {
    const input = document.getElementById('aai-ws-text-input');
    const text  = input.value.trim();
    if (!text) return;
    input.value = '';
    addMsg('user', text);
    if (!checkConfirmPhrase(text)) runAgentTask(text);
  }

  // ============================================================
  // HOVER DESCRIPTIONS
  // ============================================================
  function handleHover(e) {
    if (!initialized) return;
    const target = e.target;
    if (!target || target.closest('#accessai-sidebar') || target.closest('#accessai-ws-hover-overlay')) return;
    const desc = describeElement(target);
    if (!desc) { hoverOverlay.style.display = 'none'; return; }
    hoverOverlay.textContent = desc;
    hoverOverlay.style.display = 'block';
    const rect = target.getBoundingClientRect();
    hoverOverlay.style.left = (rect.left + 260 > window.innerWidth - 380 ? rect.left - 270 : rect.left) + 'px';
    hoverOverlay.style.top  = (rect.bottom + 6) + 'px';
  }

  function describeElement(el) {
    const tag = el.tagName?.toLowerCase();
    if (!tag) return null;
    const role      = el.getAttribute('role');
    const ariaLabel = el.getAttribute('aria-label');
    const text      = el.textContent?.trim().slice(0, 60);
    const alt       = el.getAttribute('alt');

    if (['hr','br','script','style'].includes(tag)) return null;
    if (el.getAttribute('aria-hidden') === 'true') return null;
    if (['div','span'].includes(tag) && !text && !role && !ariaLabel) return null;

    if (tag === 'img')    return `Image: ${alt || 'no description'}`;
    if (tag === 'a')      return `Link: ${text || ariaLabel || el.href || 'unknown'}`;
    if (tag === 'button' || role === 'button') return `Button: ${text || ariaLabel || 'unnamed'}`;
    if (tag === 'input') {
      const t   = el.type || 'text';
      const lbl = ariaLabel || el.placeholder || el.name || '';
      return `${t === 'submit' ? 'Submit button' : `Input (${t})`}: ${lbl}`;
    }
    if (tag === 'select')   return `Dropdown: ${ariaLabel || el.name || 'options'}`;
    if (['h1','h2','h3','h4','h5','h6'].includes(tag)) return `Heading: ${text}`;
    if (tag === 'textarea') return `Text area: ${ariaLabel || el.placeholder || el.name || ''}`;
    if (ariaLabel) return ariaLabel;
    return null;
  }

  function highlightElement(el) {
    const orig = el.style.outline;
    el.style.outline       = '3px solid #60a5fa';
    el.style.outlineOffset = '2px';
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setTimeout(() => { el.style.outline = orig; el.style.outlineOffset = ''; }, 2000);
  }

  // ============================================================
  // UI HELPERS
  // ============================================================
  function clearHero() {
    const heroWrap = document.getElementById('aai-ws-hero');
    if (heroWrap && !heroWrap.classList.contains('aai-hero-compact')) {
      heroWrap.classList.add('aai-hero-compact');
    }
  }

  function addMsg(type, text) {
    if (!outputEl) return;
    clearHero();
    const el = document.createElement('div');
    el.className = `aai-ws-msg aai-ws-msg-${type}`;

    if (type === 'user') {
      el.innerHTML = `<span class="aai-ws-msg-label">You</span><span class="aai-ws-msg-body">${escHtml(text)}</span>`;
    } else if (type === 'response') {
      el.innerHTML = `<span class="aai-ws-ai-label">Web-Sight</span><span class="aai-ws-ai-text">${escHtml(text)}</span>`;
    } else {
      el.textContent = text;
    }

    outputEl.appendChild(el);
    outputEl.scrollTop = outputEl.scrollHeight;
    const msgs = outputEl.querySelectorAll('.aai-ws-msg');
    while (msgs.length > 80) msgs[0].remove();
  }

  function escHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
  function wait(ms)    { return new Promise(r => setTimeout(r, ms)); }
  function sendMessage(msg) { return new Promise(r => chrome.runtime.sendMessage(msg, r)); }

  // ============================================================
  // LIFECYCLE
  // ============================================================
  window.addEventListener('accessai-mode-changed', (e) => {
    if (e.detail.mode === 'web-sight') {
      initPane();
    } else {
      if (isAgentActive) stopAgent();
      if (hoverOverlay) hoverOverlay.style.display = 'none';
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'PERFORM_DOM_ACTION') {
      executeBrowserTool(msg.action.action, msg.action);
    }
  });

  chrome.storage.local.get('activeMode', (result) => {
    if (result.activeMode === 'web-sight') setTimeout(initPane, 500);
  });

})();
