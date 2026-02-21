// AccessAI Background Service Worker
const OPENAI_API_KEY = '';

let activeMode = null;

// ─── On install: inject scripts into all existing tabs ──────
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ activeMode: null });
  injectIntoAllTabs();
});

// ─── On Chrome startup: clear session data, auto-open sidebar ──
chrome.runtime.onStartup.addListener(() => {
  // Clear Web-Sight conversation history on Chrome restart
  chrome.storage.local.remove('websight_conversation_history');
  // Set sidebar to auto-open on next page load
  chrome.storage.local.set({ sidebarOpen: true, activeMode: 'web-sight' });
  activeMode = 'web-sight';
});

// ─── Inject scripts into all eligible tabs ──────────────────
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
  chrome.scripting.insertCSS({ target: { tabId }, files: ['styles/sidebar.css'] }).catch(() => {});
  chrome.scripting.executeScript({ target: { tabId }, files: [
    'content-scripts/sidebar.js',
    'content-scripts/social-cue.js',
    'content-scripts/web-sight.js',
    'content-scripts/clear-context.js'
  ] }).catch(() => {});
}

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
  };
  const handler = handlers[message.type];
  if (handler) {
    handler(message, sender, sendResponse);
    return true; // keep channel open for async
  }
});

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
  try {
    const body = {
      model: message.model || 'gpt-4o',
      messages: message.messages,
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
  sendResponse({ success: true, apiKey: OPENAI_API_KEY, model: 'gpt-4o-realtime-preview' });
}

function handleTtsSpeak(message, sender, sendResponse) {
  chrome.tts.speak(message.text, {
    rate: message.rate || 0.9,
    pitch: message.pitch || 0.8,
    volume: message.volume || 0.4,
    lang: 'en-US',
    onEvent: (event) => {
      if (event.type === 'end' || event.type === 'error') {
        sendResponse({ success: event.type === 'end' });
      }
    },
  });
}

function handleDomAction(message, sender, sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError || !tabs[0]) { sendResponse({ success: false }); return; }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'PERFORM_DOM_ACTION', action: message.action }, (r) => {
      sendResponse(r || { success: false });
    });
  });
}

function handleToggleSidebar(message, sender, sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError || !tabs[0]) { sendResponse({ success: false }); return; }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_SIDEBAR' }, (r) => {
      if (chrome.runtime.lastError) {
        // Scripts not loaded yet, inject them
        injectScripts(tabs[0].id);
        setTimeout(() => {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_SIDEBAR' }).catch(() => {});
        }, 500);
      }
      sendResponse(r || { success: true });
    });
  });
}

// Track Web-Sight active state per tab for reconnection after navigation
const websightActiveTabs = new Set();

function handleWebSightState(message, sender, sendResponse) {
  const tabId = sender.tab?.id;
  if (!tabId) { sendResponse({ success: false }); return; }
  if (message.active) {
    websightActiveTabs.add(tabId);
  } else {
    websightActiveTabs.delete(tabId);
  }
  sendResponse({ success: true });
}

// ─── Extension icon click ─────────────────────────────────────
chrome.action.onClicked.addListener((tab) => {
  if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('about') || tab.url.startsWith('edge')) return;
  chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' }, () => {
    const err = chrome.runtime.lastError?.message || '';
    if (err.includes('Could not establish connection') || err.includes('Receiving end does not exist')) {
      injectScripts(tab.id);
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' }).catch(() => {});
      }, 500);
    }
  });
});

// ─── Tab navigation: re-inject scripts and restore state ──────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('about') || tab.url.startsWith('edge')) return;

  chrome.storage.local.get(['sidebarOpen', 'activeMode'], (result) => {
    if (chrome.runtime.lastError) return;
    if (!result.sidebarOpen) return;

    // Always restore sidebar + active mode after navigation completes.
    // We try to contact the content script first; if it's not ready, inject it.
    const doRestore = () => {
      chrome.tabs.sendMessage(tabId, { type: 'RESTORE_STATE', mode: result.activeMode }, (response) => {
        if (chrome.runtime.lastError) {
          // Scripts not loaded yet — inject then retry
          injectScripts(tabId);
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { type: 'RESTORE_STATE', mode: result.activeMode }).catch(() => {});
          }, 800);
        }
      });
    };

    // Small delay to let document_idle scripts settle
    setTimeout(doRestore, 350);
  });
});
