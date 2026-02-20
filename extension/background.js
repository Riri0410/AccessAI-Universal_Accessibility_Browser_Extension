// AccessAI Background Service Worker
const OPENAI_API_KEY = ''; // <-- Put your key here

let activeMode = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ activeMode: null });
  chrome.tabs.query({ url: ['https://*/*', 'http://*/*'] }, (tabs) => {
    for (const tab of tabs) {
      if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('about')) continue;
      chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['styles/sidebar.css'] }).catch(() => {});
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-scripts/sidebar.js','content-scripts/social-cue.js','content-scripts/web-sight.js','content-scripts/clear-context.js'] }).catch(() => {});
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = { 'SET_MODE': handleSetMode, 'GET_MODE': handleGetMode, 'API_REQUEST': handleApiRequest, 'API_REALTIME_SESSION': handleRealtimeSession, 'TTS_SPEAK': handleTtsSpeak, 'EXECUTE_DOM_ACTION': handleDomAction, 'TOGGLE_SIDEBAR': handleToggleSidebar, 'GET_API_KEY': handleGetApiKey };
  const handler = handlers[message.type];
  if (handler) { handler(message, sender, sendResponse); return true; }
});

function handleGetApiKey(m, s, sr) { sr({ key: OPENAI_API_KEY }); }
function handleSetMode(m, s, sr) {
  activeMode = m.mode;
  chrome.storage.local.set({ activeMode: m.mode });
  chrome.tabs.query({}, (tabs) => tabs.forEach(t => chrome.tabs.sendMessage(t.id, { type: 'MODE_CHANGED', mode: m.mode }).catch(() => {})));
  sr({ success: true, mode: activeMode });
}
function handleGetMode(m, s, sr) { sr({ mode: activeMode }); }
async function handleApiRequest(message, sender, sendResponse) {
  try {
    const body = { model: message.model || 'gpt-4o', messages: message.messages, max_tokens: message.max_tokens || 300, temperature: message.temperature !== undefined ? message.temperature : 0.3 };
    if (message.tools) { body.tools = message.tools; body.tool_choice = message.tool_choice || 'auto'; }
    const response = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) { sendResponse({ success: false, error: data.error?.message || 'API error' }); return; }
    sendResponse({ success: true, data });
  } catch (error) { sendResponse({ success: false, error: error.message }); }
}
async function handleRealtimeSession(message, sender, sendResponse) { sendResponse({ success: true, apiKey: OPENAI_API_KEY, model: 'gpt-4o-realtime-preview' }); }
function handleTtsSpeak(message, sender, sendResponse) {
  chrome.tts.speak(message.text, { rate: message.rate || 0.9, pitch: message.pitch || 0.8, volume: message.volume || 0.4, lang: 'en-US', onEvent: (event) => { if (event.type === 'end' || event.type === 'error') sendResponse({ success: event.type === 'end' }); } });
}
function handleDomAction(message, sender, sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => { if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'PERFORM_DOM_ACTION', action: message.action }, (r) => sendResponse(r || { success: false })); });
}
function handleToggleSidebar(message, sender, sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => { if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_SIDEBAR' }, (r) => sendResponse(r || { success: true })); });
  sendResponse({ success: true });
}
chrome.action.onClicked.addListener((tab) => {
  if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('about')) return;
  chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' }, () => {
    const err = chrome.runtime.lastError?.message || '';
    if (err.includes('Could not establish connection') || err.includes('Receiving end does not exist')) {
      chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['styles/sidebar.css'] })
        .then(() => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-scripts/sidebar.js','content-scripts/social-cue.js','content-scripts/web-sight.js','content-scripts/clear-context.js'] }))
        .then(() => setTimeout(() => chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' }).catch(() => {}), 300))
        .catch(() => {});
    }
  });
});
