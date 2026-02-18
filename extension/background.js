// AccessAI Background Service Worker
// Direct OpenAI calls (prototype mode - API key in extension)

const OPENAI_API_KEY = ''; // <-- Put your key here

let activeMode = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ activeMode: null });

  // Inject into every already-open tab so the user doesn't need to reload
  chrome.tabs.query({ url: ['https://*/*', 'http://*/*'] }, (tabs) => {
    for (const tab of tabs) {
      // Skip chrome:// pages, extension pages etc — scripting.executeScript will
      // silently fail on those, so guard with a URL check first
      if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('about')) continue;

      chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['styles/sidebar.css']
      }).catch(() => {});

      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          'content-scripts/sidebar.js',
          'content-scripts/social-cue.js',
          'content-scripts/web-sight.js',
          'content-scripts/clear-context.js'
        ]
      }).catch(() => {});
    }
  });
});

// ------- Message Router -------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    'SET_MODE': handleSetMode,
    'GET_MODE': handleGetMode,
    'API_REQUEST': handleApiRequest,
    'API_REALTIME_SESSION': handleRealtimeSession,
    'TTS_SPEAK': handleTtsSpeak,
    'EXECUTE_DOM_ACTION': handleDomAction,
    'TOGGLE_SIDEBAR': handleToggleSidebar,
    'GET_API_KEY': handleGetApiKey
  };

  const handler = handlers[message.type];
  if (handler) {
    handler(message, sender, sendResponse);
    return true;
  }
});

function handleGetApiKey(message, sender, sendResponse) {
  sendResponse({ key: OPENAI_API_KEY });
}

function handleSetMode(message, sender, sendResponse) {
  activeMode = message.mode;
  chrome.storage.local.set({ activeMode: message.mode });

  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, {
        type: 'MODE_CHANGED',
        mode: message.mode
      }).catch(() => {});
    });
  });

  sendResponse({ success: true, mode: activeMode });
}

function handleGetMode(message, sender, sendResponse) {
  sendResponse({ mode: activeMode });
}

async function handleApiRequest(message, sender, sendResponse) {
  try {
    const body = {
      model: message.model || 'gpt-4o',
      messages: message.messages,
      max_tokens: message.max_tokens || 300,
      temperature: message.temperature !== undefined ? message.temperature : 0.3
    };

    // Support function calling (tools)
    if (message.tools) {
      body.tools = message.tools;
      body.tool_choice = message.tool_choice || 'auto';
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!response.ok) {
      sendResponse({ success: false, error: data.error?.message || 'API error' });
      return;
    }
    sendResponse({ success: true, data });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleRealtimeSession(message, sender, sendResponse) {
  // For Realtime API, the content script connects directly via WebSocket
  // We just provide the API key
  sendResponse({
    success: true,
    apiKey: OPENAI_API_KEY,
    model: 'gpt-4o-realtime-preview'
  });
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
    }
  });
}

function handleDomAction(message, sender, sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'PERFORM_DOM_ACTION',
        action: message.action
      }, (response) => {
        sendResponse(response || { success: false });
      });
    }
  });
}

function handleToggleSidebar(message, sender, sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_SIDEBAR' }, (response) => {
        sendResponse(response || { success: true });
      });
    }
  });
  sendResponse({ success: true });
}

// Clicking the extension icon toggles the sidebar.
// If the content script isn't present yet (tab opened before install),
// inject it first, then toggle.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('about')) return;

  chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' }, () => {
    const err = chrome.runtime.lastError?.message || '';
    // Only inject if the content script truly isn't present
    if (err.includes('Could not establish connection') || err.includes('Receiving end does not exist')) {
      chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['styles/sidebar.css']
      }).then(() => chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          'content-scripts/sidebar.js',
          'content-scripts/social-cue.js',
          'content-scripts/web-sight.js',
          'content-scripts/clear-context.js'
        ]
      })).then(() => {
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' }).catch(() => {});
        }, 300);
      }).catch(() => {});
    }
    // If err is "port closed before response was received", the message was
    // delivered successfully — sidebar.js just didn't call sendResponse before.
    // Now that sidebar.js calls sendResponse, this branch should never fire.
  });
});
