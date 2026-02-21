// ============================================================
// Web-Sight: Agentic Accessibility Assistant v3
//
// Production-quality hands-free AI browser agent.
//
// Key improvements in v3:
//   - Auto-reconnects mic after page navigation
//   - Forces English-only transcription
//   - Better element resolution with scoring
//   - History cleared on Chrome restart (handled by background.js)
//   - Robust error handling and reconnection
//   - Extension stays open and mic stays active across navigations
// ============================================================

(function () {
  'use strict';

  // Guard against double-initialization
  if (window.__websight_initialized) return;
  window.__websight_initialized = true;

  const SYSTEM_PROMPT = `You are Web-Sight, a hands-free AI browser agent for people with accessibility needs.

You are smart and contextually aware. You think about the website you are on and what it calls things before acting.

When the user gives a command, use your tools to complete it step by step.

GENERAL RULES:
- Use get_page_context first to understand the current page structure, labels, and navigation.
- Give a SHORT reply when done (1-2 sentences, plain English, grade 5 level).
- Always respond in English only.

═══ SEMANTIC SEARCH INTELLIGENCE — CRITICAL ═══
NEVER type the user's literal spoken words into a search box on specialised websites.
Websites use their OWN terminology which may differ completely from how users phrase things.

BEFORE searching on any website:
1. Call read_page to scan the navigation, headings, and category names on the current page.
2. Identify what the website CALLS what the user is looking for.
   EXAMPLE: User says "show me business courses" on a university site.
     → Read the page. Navigation shows: "Business & Management", "Accounting", "Economics".
     → Search for "Business Management" NOT "business courses".
   EXAMPLE: User says "find shoes" on a clothing retailer.
     → Page has category "Footwear" in nav.
     → Click "Footwear" or search "footwear" NOT "shoes".
   EXAMPLE: User says "computer science degree".
     → University nav shows "Informatics" or "Computing Science".
     → Use the site's actual label.
3. If there is a dedicated section/link in the navigation for what the user wants, CLICK it instead of searching.
4. Only type into search if no direct nav link exists — and use the site's vocabulary, not the user's.

SEARCH REWRITE PROCESS (mandatory for educational/institutional sites):
- Read page → identify headings/nav items → infer correct terminology → search with that term
- Log your reasoning in the "action" messages so the user understands what you did

═══════════════════════════════════════════════

ORDINAL ELEMENT SELECTION — CRITICAL:
When the user says "1st", "first", "2nd", "second", "3rd", "third", etc.:
  - "1st" or "first" = element at index [0] in the page context list
  - "2nd" or "second" = element at index [1]
  - "3rd" or "third"  = element at index [2]
  - "4th" or "fourth" = element at index [3]
Count ONLY from the TOP of the interactive elements list.
Use the EXACT selector shown next to that index number. Do NOT pick by name or relevance.
EXAMPLE: "click the 3rd link" → find element [2] in the list → use its exact selector.

TYPING RULES — VERY IMPORTANT:
- To type in ANY input: ALWAYS click_element on the input FIRST (to focus it), THEN call type_text.
- For Google search: click the search box (aria-label="Search" or name="q") first, then type_text.
- Always pass the EXACT CSS selector from page context to both click_element and type_text.
- Never call type_text without clicking first.

NAVIGATION-FIRST WORKFLOW (for "find", "show", "search" commands):
1. read_page (scan nav + headings to understand site vocabulary)
2. IF a relevant nav link/section exists → click_element on it directly
3. IF no direct link → find_elements("search input") → click → type using SITE terminology → press Enter

SAFETY: If the command involves "buy", "checkout", "purchase", or "pay" — stop and ask the user to say "confirm" first.`;

  // ─── Constants ──────────────────────────────────────────────
  const HISTORY_STORAGE_KEY = 'websight_conversation_history';
  const MAX_STORED_MESSAGES = 40;
  const MAX_AGENT_STEPS = 18;
  const MAX_RECONNECT_ATTEMPTS = 5;
  const RECONNECT_BASE_DELAY = 2000;

  // ─── State ────────────────────────────────────────────────
  let paneEl         = null;
  let outputEl       = null;
  let hoverOverlay   = null;
  let initialized    = false;
  let isAgentActive  = false;
  let isTaskRunning  = false;
  let pendingConfirm = null;
  let reconnectAttempts = 0;

  // In-memory conversation history (synced to/from storage)
  let conversationHistory = [];

  // Realtime WebSocket + Audio
  let ws             = null;
  let micStream      = null;
  let micContext      = null;
  let micProcessor    = null;
  let apiKey          = null;
  let playbackContext = null;
  let nextStartTime   = 0;

  // Flag to auto-reconnect after navigation
  let shouldAutoReconnect = false;

  // ─── Persist / restore history ────────────────────────────
  function saveHistory() {
    try {
      const toSave = conversationHistory.slice(-MAX_STORED_MESSAGES);
      chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: toSave });
    } catch (e) {
      // Storage might be unavailable during navigation
    }
  }

  function loadHistory() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(HISTORY_STORAGE_KEY, (result) => {
          if (chrome.runtime.lastError) {
            conversationHistory = [];
            resolve([]);
            return;
          }
          conversationHistory = result[HISTORY_STORAGE_KEY] || [];
          resolve(conversationHistory);
        });
      } catch (e) {
        conversationHistory = [];
        resolve([]);
      }
    });
  }

  function clearHistory() {
    conversationHistory = [];
    try {
      chrome.storage.local.remove(HISTORY_STORAGE_KEY);
    } catch (e) {}
  }

  // Rebuild GPT-4o message array from conversation history
  function buildGPTHistory() {
    const msgs = [];
    for (const entry of conversationHistory) {
      if (entry.role === 'user' && entry.type === 'command') {
        msgs.push({ role: 'user', content: entry.text });
      } else if (entry.role === 'assistant' && entry.type === 'response') {
        msgs.push({ role: 'assistant', content: entry.text });
      }
    }
    // Keep last 10 exchanges to avoid token bloat
    return msgs.slice(-20);
  }

  // ─── Tool definitions ─────────────────────────────────────
  const BROWSER_TOOLS = [
    { type: 'function', function: { name: 'get_page_context', description: 'Get the current page URL, title, headings, and all interactive elements with their index numbers.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'find_elements', description: 'Search for elements on the page matching a natural language description. Returns elements with selectors you can use to click or interact.', parameters: { type: 'object', properties: { description: { type: 'string', description: 'What to search for, e.g. "add to cart button" or "search input"' } }, required: ['description'] } } },
    { type: 'function', function: { name: 'click_element', description: 'Click an element by its CSS selector or description.', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector, XPath, or element description' }, description: { type: 'string', description: 'Human-readable description of what is being clicked' } }, required: ['selector', 'description'] } } },
    { type: 'function', function: { name: 'type_text', description: 'Type text into an input field.', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector of the input field' }, text: { type: 'string', description: 'Text to type' }, clear_first: { type: 'boolean', description: 'Whether to clear the field first (default true)' } }, required: ['text'] } } },
    { type: 'function', function: { name: 'press_key', description: 'Press a keyboard key.', parameters: { type: 'object', properties: { key: { type: 'string', description: 'Key to press: Enter, Escape, Tab, Space, Backspace, ArrowDown, ArrowUp' }, selector: { type: 'string', description: 'Optional CSS selector to focus first' } }, required: ['key'] } } },
    { type: 'function', function: { name: 'scroll_page', description: 'Scroll the page in a direction.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] }, amount: { type: 'number', description: 'Pixels to scroll (default 500)' } }, required: ['direction'] } } },
    { type: 'function', function: { name: 'navigate_to', description: 'Navigate the browser to a URL.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
    { type: 'function', function: { name: 'read_page', description: 'Read the visible text content of the page.', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'Optional CSS selector to read from' } } } } },
    { type: 'function', function: { name: 'select_option', description: 'Select a value from a dropdown.', parameters: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'value'] } } },
  ];

  // ─── Agentic task runner ──────────────────────────────────
  async function runAgentTask(command) {
    if (isTaskRunning) {
      addMsg('warning', 'Still working on a previous task. Please wait.');
      return;
    }

    const buyWords = ['buy ', 'purchase', 'checkout', 'pay ', 'place order', 'order now'];
    if (buyWords.some(w => command.toLowerCase().includes(w))) {
      pendingConfirm = command;
      addMsg('confirm', `Safety check: "${command.slice(0, 60)}" - say "confirm" to proceed, or say something else to cancel.`);
      return;
    }

    isTaskRunning = true;
    setOrbState('thinking');

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...buildGPTHistory(),
      { role: 'user', content: `Command: "${command}"\n\nCurrent page snapshot:\n${buildRichPageContext()}\n\nNavigation text (for vocabulary reference):\n${extractNavText()}` },
    ];

    let steps = 0;
    let finalResponse = '';

    try {
      while (steps < MAX_AGENT_STEPS) {
        steps++;
        const resp = await sendMessage({
          type: 'API_REQUEST',
          model: 'gpt-4o',
          messages,
          tools: BROWSER_TOOLS,
          tool_choice: 'auto',
          max_tokens: 800,
          temperature: 0.05,
        });

        if (!resp || !resp.success) {
          const errMsg = resp?.error || 'Unknown API error';
          addMsg('error', `API error: ${errMsg}`);
          break;
        }

        const choice = resp.data?.choices?.[0];
        if (!choice) {
          addMsg('error', 'No response from AI');
          break;
        }

        if (choice.finish_reason === 'tool_calls' && choice.message?.tool_calls?.length) {
          messages.push({
            role: 'assistant',
            content: choice.message.content || null,
            tool_calls: choice.message.tool_calls,
          });

          for (const tc of choice.message.tool_calls) {
            let args;
            try { args = JSON.parse(tc.function.arguments); } catch (e) { args = {}; }

            const toolLabel = formatToolLabel(tc.function.name, args);
            addMsg('action', toolLabel);

            let result;
            try {
              result = await executeBrowserTool(tc.function.name, args);
            } catch (e) {
              result = { success: false, error: e.message };
            }

            messages.push({
              role: 'tool',
              content: typeof result === 'string' ? result : JSON.stringify(result),
              tool_call_id: tc.id,
            });

            // Prevent message array from growing too large
            if (messages.length > 35) messages.splice(2, 2);
          }

          // Wait a moment for DOM to settle after actions
          await wait(300);
          messages.push({ role: 'user', content: 'Updated page state:\n' + buildRichPageContext() + '\nNavigation vocabulary:\n' + extractNavText() });
        } else {
          finalResponse = choice.message?.content?.trim() || 'Done.';
          break;
        }
      }

      if (steps >= MAX_AGENT_STEPS && !finalResponse) {
        finalResponse = 'I reached the maximum steps. The task may not be fully complete.';
      }
    } catch (err) {
      finalResponse = `Something went wrong: ${err.message}`;
    }

    if (finalResponse) {
      addMsg('response', finalResponse);

      // Persist the command + response to history
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      conversationHistory.push({ role: 'user', type: 'command', text: command, time });
      conversationHistory.push({ role: 'assistant', type: 'response', text: finalResponse, time });
      saveHistory();
    }

    setOrbState('active');
    isTaskRunning = false;
  }

  function formatToolLabel(name, args) {
    switch (name) {
      case 'click_element':    return `Clicking: ${args.description || args.selector || 'element'}`;
      case 'type_text':        return `Typing: "${(args.text || '').slice(0, 40)}"`;
      case 'press_key':        return `Press key: ${args.key}`;
      case 'navigate_to':      return `Navigating to: ${args.url}`;
      case 'scroll_page':      return `Scrolling ${args.direction}`;
      case 'find_elements':    return `Searching for: ${args.description}`;
      case 'get_page_context': return 'Reading page context';
      case 'read_page':        return 'Reading page content';
      case 'select_option':    return `Selecting: ${args.value}`;
      default:                 return name;
    }
  }

  // ─── Browser tool executor ────────────────────────────────
  async function executeBrowserTool(name, args) {
    switch (name) {
      case 'get_page_context':
        return buildRichPageContext();

      case 'find_elements':
        return findElementsByDescription(args.description || '');

      case 'click_element': {
        // Try direct selector first
        let el = resolveElement(args.selector);
        if (el) {
          highlightElement(el);
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await wait(200);
          el.click();
          el.focus();
          await wait(500);
          return { success: true, clicked: args.description || describeElement(el) || args.selector };
        }
        // Try finding by description
        const found = findElementsByDescription(args.description || args.selector || '');
        if (found.elements?.length > 0) {
          const fb = resolveElement(found.elements[0].selector);
          if (fb) {
            highlightElement(fb);
            fb.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await wait(200);
            fb.click();
            fb.focus();
            await wait(500);
            return { success: true, clicked: found.elements[0].description };
          }
        }
        return { success: false, error: `Could not find element: ${args.selector || args.description}` };
      }

      case 'type_text': {
        // ── Resolve the target element ──────────────────────────
        let el = args.selector ? resolveElement(args.selector) : null;
        if (!el) {
          el = document.querySelector('input:focus, textarea:focus, [contenteditable]:focus');
          if (!el) {
            const candidates = document.querySelectorAll(
              'input[type="text"], input[type="search"], input[type="email"], ' +
              'input[type="url"], input:not([type]), textarea, [contenteditable="true"]'
            );
            for (const inp of candidates) {
              if (inp.closest('#accessai-sidebar')) continue;
              const s = window.getComputedStyle(inp);
              if (s.display !== 'none' && s.visibility !== 'hidden') { el = inp; break; }
            }
          }
        }
        if (!el) return { success: false, error: 'No input field found on this page' };

        highlightElement(el);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();
        await wait(120);

        const textToType = args.text || '';
        const isContentEditable = el.isContentEditable;

        if (isContentEditable) {
          // ── ContentEditable (Gmail, Notion, etc.) ───────────────
          if (args.clear_first !== false) el.textContent = '';
          el.focus();
          document.execCommand('selectAll');
          document.execCommand('delete');
          document.execCommand('insertText', false, textToType);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: textToType }));
          // Move cursor to end
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } else {
          // ── Regular <input> / <textarea> ──────────────────────
          // Strategy: execCommand('insertText') is the gold standard —
          // it integrates with React/Angular/Vue's synthetic event system.

          if (args.clear_first !== false) {
            el.focus();
            // Select all existing text
            el.select?.();
            document.execCommand('selectAll');
            await wait(30);
            // Delete selected content via execCommand (React-safe)
            document.execCommand('delete');
            await wait(30);
            // Also nuke via native setter just in case execCommand didn't clear
            const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
                    || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
            if (ns) ns.call(el, ''); else el.value = '';
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
            await wait(30);
          }

          el.focus();
          el.select?.();

          // ─ Method 1: execCommand (works with Google, React, Angular, Vue, Svelte) ─
          let typed = false;
          try {
            typed = document.execCommand('insertText', false, textToType);
          } catch (_) { typed = false; }

          // ─ Method 2: InputEvent with insertText (modern browsers) ─
          if (!typed || el.value !== textToType) {
            const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
                    || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
            if (ns) ns.call(el, textToType); else el.value = textToType;
            el.dispatchEvent(new InputEvent('input',  { bubbles: true, cancelable: true, inputType: 'insertText', data: textToType }));
            el.dispatchEvent(new InputEvent('change', { bubbles: true, cancelable: true }));
          }

          // ─ Method 3: Character-by-character keyboard events (legacy fallback) ─
          if (el.value !== textToType) {
            for (const char of textToType) {
              const kp = { key: char, charCode: char.charCodeAt(0), keyCode: char.charCodeAt(0), which: char.charCodeAt(0), bubbles: true, cancelable: true };
              el.dispatchEvent(new KeyboardEvent('keydown',  kp));
              el.dispatchEvent(new KeyboardEvent('keypress', kp));
              el.dispatchEvent(new KeyboardEvent('keyup',    kp));
            }
          }
        }

        await wait(300);
        const finalVal = isContentEditable ? el.textContent : el.value;
        return { success: true, typed: textToType, actual_value: finalVal?.slice(0, 80) };
      }

      case 'press_key': {
        const target = args.selector ? resolveElement(args.selector) : document.activeElement;
        if (target) target.focus();
        const keyMap = {
          'Enter':     { key: 'Enter',     code: 'Enter',     keyCode: 13 },
          'Escape':    { key: 'Escape',    code: 'Escape',    keyCode: 27 },
          'Tab':       { key: 'Tab',       code: 'Tab',       keyCode: 9 },
          'Space':     { key: ' ',         code: 'Space',     keyCode: 32 },
          'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
          'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
          'ArrowUp':   { key: 'ArrowUp',   code: 'ArrowUp',   keyCode: 38 },
          'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
          'ArrowRight':{ key: 'ArrowRight',code: 'ArrowRight',keyCode: 39 },
        };
        const k = keyMap[args.key] || { key: args.key, code: args.key, keyCode: 0 };
        const activeEl = target || document.body;
        activeEl.dispatchEvent(new KeyboardEvent('keydown', { ...k, bubbles: true, cancelable: true }));
        activeEl.dispatchEvent(new KeyboardEvent('keypress', { ...k, bubbles: true, cancelable: true }));
        activeEl.dispatchEvent(new KeyboardEvent('keyup', { ...k, bubbles: true }));
        if (args.key === 'Enter' && activeEl.tagName === 'INPUT' && activeEl.form) {
          activeEl.form.requestSubmit ? activeEl.form.requestSubmit() : activeEl.form.submit();
        }
        await wait(600);
        return { success: true, key: args.key };
      }

      case 'navigate_to': {
        let url = (args.url || '').trim();
        if (!url) return { success: false, error: 'No URL provided' };
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

        // Save history and mark for reconnection BEFORE navigating
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        conversationHistory.push({ role: 'assistant', type: 'action', text: `Navigated to ${url}`, time });
        saveHistory();
        shouldAutoReconnect = true;

        addMsg('info', `Going to ${url}…`);

        // Await storage write so reconnect flag is set before page unloads
        await new Promise(resolve => {
          chrome.storage.local.set({ websight_should_reconnect: true }, resolve);
        });
        await wait(200);
        window.location.href = url;
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
        const el = args.selector ? resolveElement(args.selector) : (document.querySelector('main, [role="main"], article') || document.body);
        const content = (el || document.body).innerText.trim().replace(/\s+/g, ' ').slice(0, 3000);
        return { success: true, content };
      }

      case 'select_option': {
        const sel = resolveElement(args.selector);
        if (!sel || sel.tagName !== 'SELECT') return { success: false, error: 'No <select> dropdown found' };
        const option = Array.from(sel.options).find(o =>
          o.text.toLowerCase().includes((args.value || '').toLowerCase()) ||
          o.value.toLowerCase() === (args.value || '').toLowerCase()
        );
        if (!option) return { success: false, error: `Option "${args.value}" not found` };
        sel.value = option.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, selected: option.text };
      }

      default:
        return { success: false, error: `Unknown tool: ${name}` };
    }
  }

  // ─── Element resolution ───────────────────────────────────
  function resolveElement(selector) {
    if (!selector) return null;

    // XPath
    if (selector.startsWith('xpath:') || selector.startsWith('//')) {
      try {
        const xpath = selector.replace(/^xpath:/, '');
        const r = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        if (r.singleNodeValue) return r.singleNodeValue;
      } catch (e) {}
    }

    // CSS selector
    try {
      const el = document.querySelector(selector);
      if (el && !el.closest('#accessai-sidebar')) return el;
    } catch (e) {}

    // aria-label match
    try {
      const escaped = CSS.escape(selector);
      const el = document.querySelector(`[aria-label="${escaped}"]`) || document.querySelector(`[aria-label*="${escaped}"]`);
      if (el && !el.closest('#accessai-sidebar')) return el;
    } catch (e) {}

    // Text content match
    return findByText(selector);
  }

  function findByText(text) {
    if (!text || typeof text !== 'string') return null;
    const lower = text.toLowerCase().trim().slice(0, 80);
    const candidates = document.querySelectorAll('button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"], [role="menuitem"], [role="tab"]');
    let bestMatch = null;
    let bestScore = 0;

    for (const el of candidates) {
      if (el.closest('#accessai-sidebar')) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      const t = (el.textContent || el.value || el.getAttribute('aria-label') || '').toLowerCase().trim();
      if (!t) continue;

      let score = 0;
      if (t === lower) score = 100; // Exact match
      else if (t.includes(lower)) score = 80;
      else if (lower.includes(t) && t.length > 3) score = 60;
      else {
        // Word overlap scoring
        const words = lower.split(/\s+/);
        const matchedWords = words.filter(w => w.length > 2 && t.includes(w));
        score = matchedWords.length * 15;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = el;
      }
    }

    return bestScore >= 15 ? bestMatch : null;
  }

  function findElementsByDescription(description) {
    const lower = (description || '').toLowerCase();
    const words = lower.split(/\s+/).filter(w => w.length > 2);
    const results = [];
    const seen = new Set();

    const interactiveSelector = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="combobox"], [role="option"], [tabindex]:not([tabindex="-1"])';

    document.querySelectorAll(interactiveSelector).forEach((el, pageIndex) => {
      if (el.closest('#accessai-sidebar')) return;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

      const sig = generateSelector(el);
      if (seen.has(sig)) return;

      const desc = describeElement(el) || '';
      if (!desc) return;

      const searchable = [
        desc,
        el.textContent,
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('name'),
        el.getAttribute('type'),
        el.getAttribute('value'),
        el.getAttribute('title'),
        el.getAttribute('alt'),
      ].filter(Boolean).join(' ').toLowerCase();

      const score = words.filter(w => searchable.includes(w)).length;
      if (score > 0) {
        seen.add(sig);
        results.push({ description: desc, selector: sig, score, pageIndex });
      }
    });

    results.sort((a, b) => b.score - a.score || a.pageIndex - b.pageIndex);
    return { count: results.length, elements: results.slice(0, 15) };
  }

  // ─── Extract navigation text for vocabulary reference ───
  function extractNavText() {
    const navSelectors = 'nav, [role="navigation"], header, .nav, .navbar, .menu, .site-nav, #nav, #navigation, #menu';
    const navEls = document.querySelectorAll(navSelectors);
    const texts = new Set();
    navEls.forEach(nav => {
      nav.querySelectorAll('a, button, [role="menuitem"], [role="tab"]').forEach(el => {
        if (el.closest('#accessai-sidebar')) return;
        const t = (el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
        if (t && t.length > 1 && t.length < 80) texts.add(t);
      });
    });
    if (texts.size === 0) {
      // Fallback: collect all top-level links
      document.querySelectorAll('a[href]').forEach(a => {
        if (a.closest('#accessai-sidebar')) return;
        const t = a.textContent.trim().replace(/\s+/g, ' ');
        if (t && t.length > 1 && t.length < 60) texts.add(t);
      });
    }
    const result = Array.from(texts).slice(0, 60).join(' | ');
    return result || '(no navigation text found)';
  }

  function buildRichPageContext() {
    const lines = [`URL: ${window.location.href}`, `Title: ${document.title}`];

    // Headings
    const headings = Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 10);
    if (headings.length) {
      lines.push('Headings: ' + headings.map(h => `[${h.tagName}] ${h.textContent.trim().slice(0, 60)}`).join(' | '));
    }

    // Interactive elements with index numbers for ordinal reference
    const els = [];
    let i = 0;
    const interactiveSelector = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="combobox"]';

    document.querySelectorAll(interactiveSelector).forEach(el => {
      if (i >= 100 || el.closest('#accessai-sidebar')) return;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
      const desc = describeElement(el);
      if (!desc) return;
      els.push(`[${i}] ${desc} -> ${generateSelector(el)}`);
      i++;
    });

    lines.push(`\nInteractive elements (${i} found):\n${els.join('\n')}`);
    return lines.join('\n');
  }

  function generateSelector(el) {
    // Prefer stable, unique selectors
    if (el.id && !/^\d/.test(el.id) && el.id.length < 50 && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
      return `#${CSS.escape(el.id)}`;
    }

    const tag = el.tagName.toLowerCase();

    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-qa');
    if (testId) return `[data-testid="${testId}"]`;

    const aria = el.getAttribute('aria-label');
    if (aria && aria.length < 80) {
      const escaped = aria.replace(/"/g, "'");
      return `${tag}[aria-label="${escaped}"]`;
    }

    const name = el.getAttribute('name');
    if (name && ['input', 'textarea', 'select'].includes(tag)) return `${tag}[name="${name}"]`;

    const ph = el.getAttribute('placeholder');
    if (ph && ph.length < 60) return `${tag}[placeholder="${ph.replace(/"/g, "'")}"]`;

    // href for links (use partial match for long URLs)
    if (tag === 'a' && el.href) {
      const href = el.getAttribute('href');
      if (href && href.length < 80 && !href.startsWith('javascript:')) {
        return `a[href="${href.replace(/"/g, "'")}"]`;
      }
    }

    // Text-based XPath for leaf elements
    const text = el.textContent?.trim().slice(0, 40);
    if (text && el.children.length === 0 && text.length > 1) {
      return `xpath://${tag}[normalize-space()="${text.replace(/"/g, "'")}"]`;
    }

    // nth-of-type for elements with classes
    const cls = Array.from(el.classList).filter(c => c.length > 2 && !/^\d/.test(c) && !c.match(/\d{3,}/)).slice(0, 2).join('.');
    if (cls) {
      const selector = `${tag}.${cls}`;
      const matches = document.querySelectorAll(selector);
      if (matches.length === 1) return selector;
      const idx = Array.from(matches).indexOf(el);
      if (idx >= 0) return `${selector}:nth-of-type(${idx + 1})`;
      return selector;
    }

    return tag;
  }

  function describeElement(el) {
    const tag = el.tagName?.toLowerCase();
    if (!tag) return null;
    const role = el.getAttribute('role');
    const ariaLabel = el.getAttribute('aria-label');
    const text = el.textContent?.trim().slice(0, 80);
    const alt = el.getAttribute('alt');
    const title = el.getAttribute('title');

    if (['hr', 'br', 'script', 'style', 'noscript', 'svg', 'path'].includes(tag)) return null;
    if (el.getAttribute('aria-hidden') === 'true' && !ariaLabel) return null;
    if (['div', 'span'].includes(tag) && !text && !role && !ariaLabel) return null;

    if (tag === 'img') return `Image: ${alt || title || 'no description'}`;
    if (tag === 'a') return `Link: ${text || ariaLabel || title || el.href || 'unknown'}`;
    if (tag === 'button' || role === 'button') return `Button: ${text || ariaLabel || title || 'unnamed'}`;
    if (tag === 'input') {
      const t = el.type || 'text';
      const lbl = ariaLabel || el.placeholder || el.name || title || '';
      return `${t === 'submit' ? 'Submit button' : `Input (${t})`}: ${lbl}`;
    }
    if (tag === 'select') return `Dropdown: ${ariaLabel || el.name || 'options'}`;
    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) return `Heading: ${text}`;
    if (tag === 'textarea') return `Text area: ${ariaLabel || el.placeholder || el.name || ''}`;
    if (role === 'menuitem') return `Menu item: ${text || ariaLabel || 'unnamed'}`;
    if (role === 'tab') return `Tab: ${text || ariaLabel || 'unnamed'}`;
    if (role === 'link') return `Link: ${text || ariaLabel || 'unnamed'}`;
    if (ariaLabel) return ariaLabel;
    if (title) return title;
    return null;
  }

  // ─── Confirm / safety ─────────────────────────────────────
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

  // ─── Orb state ────────────────────────────────────────────
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

  // ─── Init pane ────────────────────────────────────────────
  async function initPane() {
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
                  <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/>
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
        <input type="text" id="aai-ws-text-input" class="aai-ws-text-field" placeholder="Or type a command here..." aria-label="Type a command" />
        <button class="aai-ws-btn" id="aai-ws-send" aria-label="Send">&#10148;</button>
        <button class="aai-ws-btn aai-ws-clear-history-btn" id="aai-ws-clear-history" title="Clear conversation history" aria-label="Clear history">&#128465;</button>
      </div>
    `;

    outputEl = document.getElementById('aai-ws-output');
    document.getElementById('aai-ws-start-orb').addEventListener('click', toggleAgent);
    document.getElementById('aai-ws-send').addEventListener('click', handleTextCommand);
    document.getElementById('aai-ws-text-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') handleTextCommand();
    });
    document.getElementById('aai-ws-clear-history').addEventListener('click', () => {
      clearHistory();
      const msgs = outputEl.querySelectorAll('.aai-ws-msg');
      msgs.forEach(m => m.remove());
      addMsg('system', 'Conversation cleared.');
    });

    if (!hoverOverlay) {
      hoverOverlay = document.createElement('div');
      hoverOverlay.id = 'accessai-ws-hover-overlay';
      hoverOverlay.setAttribute('role', 'tooltip');
      hoverOverlay.style.display = 'none';
      document.body.appendChild(hoverOverlay);
    }

    document.addEventListener('mouseover', handleHover, true);
    document.addEventListener('mouseout', () => {
      if (hoverOverlay) hoverOverlay.style.display = 'none';
    }, true);

    // Restore persisted conversation history
    await loadHistory();
    if (conversationHistory.length > 0) {
      clearHero();
      addMsg('system', `Restored ${conversationHistory.length} messages from previous session`);
      for (const entry of conversationHistory) {
        replayHistoryEntry(entry);
      }
    }

    // Check if we should auto-reconnect (after navigation)
    chrome.storage.local.get('websight_should_reconnect', (result) => {
      if (chrome.runtime.lastError) return;
      if (result.websight_should_reconnect) {
        chrome.storage.local.remove('websight_should_reconnect');
        // Auto-start the agent — use a generous delay so the page and
        // mic permissions have time to settle after navigation.
        setTimeout(() => {
          if (!isAgentActive) startAgent();
        }, 1500);
      }
    });
  }

  // Render a stored history entry into the output
  function replayHistoryEntry(entry) {
    if (!outputEl) return;
    clearHero();
    const el = document.createElement('div');

    if (entry.role === 'user' && entry.type === 'command') {
      el.className = 'aai-ws-msg aai-ws-msg-user';
      el.innerHTML = `<span class="aai-ws-msg-label">You</span><span class="aai-ws-msg-body">${escHtml(entry.text)}</span>`;
    } else if (entry.role === 'assistant' && entry.type === 'response') {
      el.className = 'aai-ws-msg aai-ws-msg-response';
      el.innerHTML = `<span class="aai-ws-ai-label">Web-Sight</span><span class="aai-ws-ai-text">${escHtml(entry.text)}</span>`;
    } else if (entry.type === 'action') {
      el.className = 'aai-ws-msg aai-ws-msg-action';
      el.textContent = entry.text;
    } else {
      return; // skip system entries during replay
    }

    // Dimmed timestamp
    const ts = document.createElement('span');
    ts.style.cssText = 'font-size:9px;color:#6b7280;margin-left:6px;font-family:monospace;';
    ts.textContent = entry.time || '';
    el.appendChild(ts);

    outputEl.appendChild(el);
    outputEl.scrollTop = outputEl.scrollHeight;
  }

  // ─── Agent toggle ─────────────────────────────────────────
  async function toggleAgent() { isAgentActive ? stopAgent() : await startAgent(); }

  async function startAgent() {
    const orb = document.getElementById('aai-ws-start-orb');
    const label = paneEl?.querySelector('.aai-start-label');
    if (!orb) return;
    orb.classList.add('aai-orb-connecting');
    if (label) label.textContent = 'Connecting...';

    try {
      const keyResp = await sendMessage({ type: 'API_REALTIME_SESSION' });
      if (!keyResp?.success) throw new Error('Could not get API key');
      apiKey = keyResp.apiKey;

      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 24000,
          channelCount: 1,
        },
      });

      playbackContext = new AudioContext({ sampleRate: 24000 });
      nextStartTime = 0;
      reconnectAttempts = 0;

      await connectWebSocket();

      // Tell background we're active (for reconnection after nav)
      shouldAutoReconnect = true;
      sendMessage({ type: 'WEBSIGHT_ACTIVE_STATE', active: true }).catch(() => {});
    } catch (err) {
      orb.classList.remove('aai-orb-connecting');
      if (label) label.textContent = 'Start Web-Sight';
      addMsg('error', err.message || 'Failed to start');
      stopAgent(false);
    }
  }

  function stopAgent(showMsg = true) {
    isAgentActive = false;
    isTaskRunning = false;
    shouldAutoReconnect = false;

    if (micProcessor) { try { micProcessor.disconnect(); } catch (e) {} micProcessor = null; }
    if (micContext)    { try { micContext.close(); }        catch (e) {} micContext = null; }
    if (micStream)     { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (ws)            { try { ws.close(); }               catch (e) {} ws = null; }
    if (playbackContext) { try { playbackContext.close(); } catch (e) {} playbackContext = null; }

    pendingConfirm = null;
    chrome.storage.local.remove('websight_should_reconnect');
    sendMessage({ type: 'WEBSIGHT_ACTIVE_STATE', active: false }).catch(() => {});

    const orb = document.getElementById('aai-ws-start-orb');
    const label = paneEl?.querySelector('.aai-start-label');
    const sublabel = paneEl?.querySelector('.aai-start-sublabel');
    const hero = document.getElementById('aai-ws-hero');

    if (orb) orb.classList.remove('aai-orb-connecting', 'aai-orb-active', 'aai-orb-speaking');
    if (label) label.textContent = 'Start Web-Sight';
    if (sublabel) sublabel.textContent = 'Hands-free AI that controls the browser by your voice';
    if (hero && conversationHistory.length === 0) hero.classList.remove('aai-hero-compact');
    if (showMsg) addMsg('system', 'Agent stopped.');
    window.__accessai?.setFooterStatus('Web-Sight stopped');
  }

  // ─── WebSocket ────────────────────────────────────────────
  async function connectWebSocket() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        try { ws?.close(); } catch (e) {}
        reject(new Error('WebSocket connection timed out'));
      }, 15000);

      ws = new WebSocket(
        'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
        ['realtime', `openai-insecure-api-key.${apiKey}`, 'openai-beta.realtime-v1']
      );

      ws.onopen = () => {
        clearTimeout(timeout);
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: 'You are a transcription service. Your ONLY job: transcribe every spoken word into English text. ' +
              'ALWAYS output in English regardless of the spoken language. ' +
              'Never add commentary, greetings, or assistant responses. ' +
              'Never produce any audio output. Transcription only.',
            voice: 'alloy',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: { model: 'whisper-1', language: 'en' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.45,
              prefix_padding_ms: 300,
              silence_duration_ms: 800,
              create_response: false,  // never auto-respond — we handle this via GPT-4o agent
            },
            temperature: 0.6,
            max_response_output_tokens: 1,  // near-zero: no meaningful AI response needed
          },
        }));

        isAgentActive = true;
        setOrbState('active');
        addMsg('system', 'Web-Sight connected. Speak your command!');
        startMicStreaming();
        resolve();
      };

      ws.onmessage = e => {
        try { handleRealtimeEvent(JSON.parse(e.data)); } catch (ex) {}
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket connection failed'));
      };

      ws.onclose = () => {
        if (!isAgentActive || !shouldAutoReconnect) return;
        reconnectAttempts++;
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          addMsg('error', 'Connection lost after multiple retries. Click orb to restart.');
          stopAgent(false);
          return;
        }
        const delay = Math.min(RECONNECT_BASE_DELAY * reconnectAttempts, 10000);
        addMsg('system', `Reconnecting... (attempt ${reconnectAttempts})`);
        setTimeout(async () => {
          if (!isAgentActive) return;
          try {
            await connectWebSocket();
            reconnectAttempts = 0;
          } catch (err) {
            // Will retry via the next close handler
          }
        }, delay);
      };
    });
  }

  // ─── Mic streaming ────────────────────────────────────────
  function startMicStreaming() {
    if (!micStream) return;
    try {
      micContext = new AudioContext({ sampleRate: 24000 });
      const source = micContext.createMediaStreamSource(micStream);
      micProcessor = micContext.createScriptProcessor(2048, 1, 1);
      micProcessor.onaudioprocess = (e) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const f32 = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) {
          const s = Math.max(-1, Math.min(1, f32[i]));
          int16[i] = s < 0 ? s * 32768 : s * 32767;
        }
        const bytes = new Uint8Array(int16.buffer);
        let bin = '';
        for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
        try {
          ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(bin) }));
        } catch (e) {}
      };
      source.connect(micProcessor);
      micProcessor.connect(micContext.destination);
    } catch (e) {
      console.error('[Web-Sight] Mic streaming setup failed:', e);
    }
  }

  // ─── Realtime events ──────────────────────────────────────
  function handleRealtimeEvent(ev) {
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        setOrbState('speaking');
        stopAudioPlayback();
        break;

      case 'input_audio_buffer.speech_stopped':
        if (!isTaskRunning) setOrbState('active');
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (ev.transcript?.trim()) {
          const t = ev.transcript.trim();
          addMsg('user', t);
          if (!checkConfirmPhrase(t)) runAgentTask(t);
        }
        break;

      case 'response.audio.delta':
        if (ev.delta) scheduleAudioChunk(ev.delta);
        break;

      case 'response.done':
        if (!isTaskRunning) setOrbState('active');
        break;

      case 'error':
        console.warn('[Web-Sight] API error:', ev.error?.message || ev.error?.code);
        if (ev.error?.code === 'session_expired') {
          addMsg('system', 'Session expired. Reconnecting...');
          if (ws) { try { ws.close(); } catch (e) {} }
        }
        break;
    }
  }

  // ─── Audio playback ───────────────────────────────────────
  function scheduleAudioChunk(b64) {
    if (!playbackContext || playbackContext.state === 'closed') return;
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const int16 = new Int16Array(bytes.buffer);
      const f32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768.0;
      const buf = playbackContext.createBuffer(1, f32.length, 24000);
      buf.getChannelData(0).set(f32);
      const src = playbackContext.createBufferSource();
      src.buffer = buf;
      src.connect(playbackContext.destination);
      const startAt = Math.max(playbackContext.currentTime, nextStartTime);
      src.start(startAt);
      nextStartTime = startAt + buf.duration;
    } catch (e) {}
  }

  function stopAudioPlayback() {
    if (playbackContext && playbackContext.state !== 'closed') {
      nextStartTime = playbackContext.currentTime;
    }
  }

  // ─── Text input ───────────────────────────────────────────
  function handleTextCommand() {
    const input = document.getElementById('aai-ws-text-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    addMsg('user', text);
    if (!checkConfirmPhrase(text)) runAgentTask(text);
  }

  // ─── Hover descriptions ───────────────────────────────────
  function handleHover(e) {
    if (!initialized || !hoverOverlay) return;
    const target = e.target;
    if (!target || target.closest('#accessai-sidebar') || target.closest('#accessai-ws-hover-overlay')) return;
    const desc = describeElement(target);
    if (!desc) { hoverOverlay.style.display = 'none'; return; }
    hoverOverlay.textContent = desc;
    hoverOverlay.style.display = 'block';
    const rect = target.getBoundingClientRect();
    hoverOverlay.style.left = (rect.left + 260 > window.innerWidth - 380 ? rect.left - 270 : rect.left) + 'px';
    hoverOverlay.style.top = (rect.bottom + 6) + 'px';
  }

  // ─── UI helpers ───────────────────────────────────────────
  function clearHero() {
    const hw = document.getElementById('aai-ws-hero');
    if (hw && !hw.classList.contains('aai-hero-compact')) hw.classList.add('aai-hero-compact');
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
    // Cap DOM messages
    const msgs = outputEl.querySelectorAll('.aai-ws-msg');
    while (msgs.length > 150) msgs[0].remove();
  }

  function highlightElement(el) {
    if (!el) return;
    const orig = el.style.outline;
    const origOffset = el.style.outlineOffset;
    el.style.outline = '3px solid #60a5fa';
    el.style.outlineOffset = '2px';
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setTimeout(() => {
      el.style.outline = orig;
      el.style.outlineOffset = origOffset;
    }, 2000);
  }

  function escHtml(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
  }

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  function sendMessage(msg) {
    return new Promise(r => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            r({ success: false, error: chrome.runtime.lastError.message });
          } else {
            r(response || { success: false, error: 'No response' });
          }
        });
      } catch (e) {
        r({ success: false, error: e.message });
      }
    });
  }

  // ─── Lifecycle ────────────────────────────────────────────
  window.addEventListener('accessai-mode-changed', (e) => {
    if (e.detail.mode === 'web-sight') {
      initPane();
    } else {
      if (isAgentActive) stopAgent();
      if (hoverOverlay) hoverOverlay.style.display = 'none';
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PERFORM_DOM_ACTION') {
      executeBrowserTool(msg.action.action, msg.action).then(r => sendResponse(r)).catch(() => sendResponse({ success: false }));
      return true;
    }
    if (msg.type === 'PING') {
      sendResponse({ alive: true });
      return;
    }
    if (msg.type === 'RESTORE_STATE') {
      // Re-open sidebar and restore mode
      if (window.__accessai?.openSidebar) window.__accessai.openSidebar();
      if (msg.mode) {
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('accessai-mode-changed', { detail: { mode: msg.mode } }));
        }, 300);
      }
      sendResponse({ success: true });
      return;
    }
  });

  // Before page unload, save reconnect state if agent is active
  window.addEventListener('beforeunload', () => {
    if (isAgentActive && shouldAutoReconnect) {
      chrome.storage.local.set({ websight_should_reconnect: true });
    }
    saveHistory();
  });

  chrome.storage.local.get('activeMode', (result) => {
    if (chrome.runtime.lastError) return;
    if (result.activeMode === 'web-sight') setTimeout(initPane, 500);
  });

})();
