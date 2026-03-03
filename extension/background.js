// AccessAI Background Service Worker
const OPENAI_API_KEY = '';

let activeMode = null;
const injectedTabs = new Set(); // FIX #6: Track injected tabs

// ─── On install ─────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ activeMode: null });
  injectedTabs.clear();
  injectIntoAllTabs();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.remove('websight_conversation_history');
  chrome.storage.local.set({ sidebarOpen: true, activeMode: 'web-sight' });
  activeMode = 'web-sight';
  injectedTabs.clear();
});

// ─── Inject scripts ─────────────────────────────────────────
function injectIntoAllTabs() {
  chrome.tabs.query({ url: ['https://*/*', 'http://*/*'] }, (tabs) => {
    if (chrome.runtime.lastError) return;
    for (const tab of tabs) {
      if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('about') || tab.url.startsWith('edge')) continue;
      injectScripts(tab.id);
    }
  });
}

function injectScripts(tabId) {
  // FIX #6: Guard against double-injection
  if (injectedTabs.has(tabId)) return;
  injectedTabs.add(tabId);

  chrome.scripting.insertCSS({ target: { tabId }, files: ['styles/sidebar.css'] }).catch(() => {});
  chrome.scripting.executeScript({ target: { tabId }, files: [
    'content-scripts/sidebar.js',
    'content-scripts/social-cue.js',
    'content-scripts/web-sight.js',
    'content-scripts/clear-context.js'
  ] }).catch(() => {
    injectedTabs.delete(tabId); // Allow retry on failure
  });
}

// FIX #6: Clean up tracking when tabs close or navigate
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
  websightActiveTabs.delete(tabId);
});

// ─── Message handling ────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    'SET_MODE':              handleSetMode,
    'GET_MODE':              handleGetMode,
    'API_REQUEST':           handleApiRequest,
    'API_REALTIME_SESSION':  handleRealtimeSession,
    'TTS_SPEAK':             handleTtsSpeak,
    'EXECUTE_DOM_ACTION':    handleDomAction,
    'TOGGLE_SIDEBAR':        handleToggleSidebar,
    'GET_API_KEY':           handleGetApiKey,
    'WEBSIGHT_ACTIVE_STATE': handleWebSightState,
    'WEBSIGHT_NAVIGATE':     handleWebSightNavigate,
    'WEBSIGHT_OPEN_TAB':     handleWebSightOpenTab,
    'WEBSIGHT_CLOSE_TAB':    handleWebSightCloseTab,
    'WEBSIGHT_SWITCH_TAB':   handleWebSightSwitchTab,
    'WEBSIGHT_CAPTURE_VISIBLE_TAB': handleCaptureVisibleTab,
  };
  const handler = handlers[message.type];
  if (handler) {
    handler(message, sender, sendResponse);
    return true;
  }
});

// ─── Handlers ────────────────────────────────────────────────
function handleCaptureVisibleTab(message, sender, sendResponse) {
  chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 40 }, (dataUrl) => {
    if (chrome.runtime.lastError) {
      sendResponse({ success: false, error: chrome.runtime.lastError.message });
    } else {
      sendResponse({ success: true, dataUrl });
    }
  });
}

function handleGetApiKey(m, s, sr) { sr({ key: OPENAI_API_KEY }); }

function handleSetMode(m, s, sr) {
  activeMode = m.mode;
  chrome.storage.local.set({ activeMode: m.mode });
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError) return;
    tabs.forEach(t => {
      chrome.tabs.sendMessage(t.id, { type: 'MODE_CHANGED', mode: m.mode }).catch(() => {});
    });
  });
  sr({ success: true, mode: activeMode });
}

function handleGetMode(m, s, sr) { sr({ mode: activeMode }); }

async function handleApiRequest(message, sender, sendResponse) {
  // FIX #2: Guard against empty API key
  if (!OPENAI_API_KEY) {
    sendResponse({ success: false, error: 'API key not configured. Add it to background.js.' });
    return;
  }

  try {
    const body = {
      model: message.model || 'gpt-4o',
      messages: message.messages,
      // FIX #1: Propagate max_tokens from message
      max_tokens: message.max_tokens || 300,
      temperature: message.temperature !== undefined ? message.temperature : 0.3,
    };
    if (message.tools) {
      body.tools = message.tools;
      body.tool_choice = message.tool_choice || 'auto';
    }
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      sendResponse({ success: false, error: data.error?.message || `API error (${response.status})` });
      return;
    }
    sendResponse({ success: true, data });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleRealtimeSession(message, sender, sendResponse) {
  // FIX #2: Don't return success with empty API key
  if (!OPENAI_API_KEY) {
    sendResponse({ success: false, error: 'API key not configured.' });
    return;
  }
  sendResponse({ success: true, apiKey: OPENAI_API_KEY, model: 'gpt-4o-realtime-preview' });
}

// FIX #3 + #4: Add timeout to prevent hanging, handle 'cancelled' event
function handleTtsSpeak(message, sender, sendResponse) {
  let responded = false;
  const timeout = setTimeout(() => {
    if (!responded) { responded = true; sendResponse({ success: false, error: 'TTS timeout' }); }
  }, 15000);

  chrome.tts.speak(message.text, {
    rate: message.rate || 0.9,
    pitch: message.pitch || 0.8,
    volume: message.volume || 0.4,
    lang: 'en-US',
    onEvent: (event) => {
      if (responded) return;
      if (event.type === 'end' || event.type === 'error' || event.type === 'cancelled') {
        responded = true;
        clearTimeout(timeout);
        sendResponse({ success: event.type === 'end' });
      }
    },
  });
}

// FIX #5 + #7: Use sender.tab.id, check lastError
function handleDomAction(message, sender, sendResponse) {
  const tabId = sender.tab?.id;
  if (tabId) {
    chrome.tabs.sendMessage(tabId, { type: 'PERFORM_DOM_ACTION', action: message.action }, (r) => {
      if (chrome.runtime.lastError) { sendResponse({ success: false }); return; }
      sendResponse(r || { success: false });
    });
  } else {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError || !tabs[0]) { sendResponse({ success: false }); return; }
      chrome.tabs.sendMessage(tabs[0].id, { type: 'PERFORM_DOM_ACTION', action: message.action }, (r) => {
        if (chrome.runtime.lastError) { sendResponse({ success: false }); return; }
        sendResponse(r || { success: false });
      });
    });
  }
}

function handleToggleSidebar(message, sender, sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError || !tabs[0]) { sendResponse({ success: false }); return; }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_SIDEBAR' }, (r) => {
      if (chrome.runtime.lastError) {
        injectedTabs.delete(tabs[0].id);
        injectScripts(tabs[0].id);
        setTimeout(() => {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_SIDEBAR' }).catch(() => {});
        }, 500);
      }
      sendResponse(r || { success: true });
    });
  });
}

const websightActiveTabs = new Set();

function handleWebSightState(message, sender, sendResponse) {
  const tabId = sender.tab?.id;
  if (!tabId) { sendResponse({ success: false }); return; }
  if (message.active) websightActiveTabs.add(tabId);
  else websightActiveTabs.delete(tabId);
  sendResponse({ success: true });
}

function handleWebSightNavigate(message, sender, sendResponse) {
  chrome.tabs.update(sender.tab.id, { url: message.url }, () => {
    sendResponse({ success: !chrome.runtime.lastError });
  });
  return true;
}

function handleWebSightOpenTab(message, sender, sendResponse) {
  chrome.tabs.create({ url: message.url }, () => {
    sendResponse({ success: !chrome.runtime.lastError });
  });
  return true;
}

function handleWebSightCloseTab(message, sender, sendResponse) {
  chrome.tabs.remove(sender.tab.id, () => {
    sendResponse({ success: !chrome.runtime.lastError });
  });
  return true;
}

function handleWebSightSwitchTab(message, sender, sendResponse) {
  const query = (message.query || '').toLowerCase();
  chrome.tabs.query({}, tabs => {
    const match = tabs.find(t =>
      t.title?.toLowerCase().includes(query) ||
      t.url?.toLowerCase().includes(query)
    );
    if (match) {
      chrome.windows.update(match.windowId, { focused: true }, () => {
        chrome.tabs.update(match.id, { active: true }, () => {
          sendResponse({ success: true, title: match.title });
        });
      });
    } else {
      sendResponse({ success: false, error: `No tab found matching: ${query}` });
    }
  });
  return true;
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('about') || tab.url.startsWith('edge')) return;
  chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' }, () => {
    const err = chrome.runtime.lastError?.message || '';
    if (err.includes('Could not establish connection') || err.includes('Receiving end does not exist')) {
      injectedTabs.delete(tab.id);
      injectScripts(tab.id);
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' }).catch(() => {});
      }, 500);
    }
  });
});

// FIX #38: Clear injection tracking on navigation so scripts re-inject properly
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('about') || tab.url.startsWith('edge')) return;

  injectedTabs.delete(tabId); // Page navigated — need fresh injection

  chrome.storage.local.get(['sidebarOpen', 'activeMode'], (result) => {
    if (chrome.runtime.lastError) return;
    if (!result.sidebarOpen) return;

    const doRestore = () => {
      chrome.tabs.sendMessage(tabId, { type: 'RESTORE_STATE', mode: result.activeMode }, (response) => {
        if (chrome.runtime.lastError) {
          injectScripts(tabId);
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { type: 'RESTORE_STATE', mode: result.activeMode }).catch(() => {});
          }, 800);
        }
      });
    };

    setTimeout(doRestore, 350);
  });
});
