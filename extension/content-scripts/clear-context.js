// ============================================================
// ClearContext v5 — Intelligent Topic Card Engine
//
// Architecture:
//   1. Screen/tab audio only (no mic needed) → gpt-4o-mini-transcribe transcription
//   2. Transcripts accumulate in a rolling buffer
//   3. Every 3 chunks AI decides: skip / create new card / update existing
//   4. Cards are markdown-rich, topic-aware, and persistently saved
//   5. Three sub-tabs: Live (transcript stream) | Cards | Chat
//   6. Workspace naming on first start for persistent card storage
//
// AI MODEL: gpt-4o — smart contextual analysis, not dumb 12s summaries
// ============================================================

(function () {
  'use strict';

  // ─── Config ──────────────────────────────────────────────
  const CHUNK_MS           = 8000;  // 8 s audio chunks sent to gpt-4o-mini-transcribe
  const ANALYSIS_EVERY_N   = 3;     // run AI card analysis after N new transcripts
  const MAX_TRANSCRIPT_BUF = 30;    // rolling transcript window for context
  const AI_MODEL           = 'gpt-4o';

  // ─── State ───────────────────────────────────────────────
  let paneEl          = null;
  let initialized     = false;
  let isActive        = false;
  let activeTab       = 'live';

  let mediaRecorder            = null;
  let audioChunks              = [];
  let chunkTimer               = null;
  let processingQueue          = Promise.resolve();
  let apiKey                   = null;

  let transcriptBuffer         = [];
  let transcriptsSinceAnalysis = 0;
  let cards                    = [];
  let cardIdCounter            = 0;
  let workspace                = null;   // the RECORDING workspace (locked while active)
  let viewWorkspace            = null;   // the workspace DISPLAYED in the cards tab (can differ)
  let _ttsAudio                = null;   // current playing HTMLAudioElement
  let _ttsPlayingId            = null;   // card id currently being spoken

  // Stream refs
  let _screenStream = null;
  let _activeStream = null;
  let _videoEl      = null;  // hidden video element for screen frame capture
  let _canvasEl     = null;  // offscreen canvas for frame export

  // DOM refs
  let liveEl    = null;
  let cardsEl   = null;
  let chatEl    = null;
  let chatInput = null;
  let chatHistory = [];   // In-memory conversation turns for multi-turn chat context

  // ─── Storage helpers ─────────────────────────────────────
  function storageKey() { return 'cc_ws_' + (workspace || 'default'); }

  function saveCards() {
    if (!workspace) return;
    try { chrome.storage.local.set({ [storageKey()]: cards }); } catch (_) {}
  }

  function loadCards() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(storageKey(), r => {
          if (chrome.runtime.lastError) { resolve([]); return; }
          resolve(r[storageKey()] || []);
        });
      } catch (_) { resolve([]); }
    });
  }

  // ─── Workspace list helpers ────────────────────────────────
  function loadWorkspaceList() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get('cc_workspace_list', r => {
          if (chrome.runtime.lastError) { resolve([]); return; }
          resolve(r['cc_workspace_list'] || []);
        });
      } catch (_) { resolve([]); }
    });
  }

  function addWorkspaceToList(name) {
    loadWorkspaceList().then(list => {
      if (!list.includes(name)) {
        list.push(name);
        try { chrome.storage.local.set({ cc_workspace_list: list }); } catch (_) {}
      }
    });
  }

  function loadCardsForWorkspace(wsName) {
    const key = 'cc_ws_' + wsName;
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(key, r => {
          if (chrome.runtime.lastError) { resolve([]); return; }
          resolve(r[key] || []);
        });
      } catch (_) { resolve([]); }
    });
  }

  // ─── Simple markdown renderer (no external deps) ─────────
  function renderMarkdown(md) {
    if (!md) return '';
    // Fenced code blocks first (before escaping)
    let h = md.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) =>
      '<pre style="background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.07);border-radius:6px;' +
      'padding:8px 10px;overflow-x:auto;font-size:10px;color:#a5f3fc;margin:6px 0;white-space:pre;">' +
      escHtml(code.trimEnd()) + '</pre>');
    // Markdown tables
    h = h.replace(/(\|[^\n]+\|\n?)+/g, match => {
      const rows = match.trim().split('\n').filter(r => !/^\|[-:| ]+\|$/.test(r.trim()));
      const trs  = rows.map((row, i) => {
        const cells = row.split('|').slice(1, -1).map(c => c.trim());
        const tag   = i === 0 ? 'th' : 'td';
        const style = i === 0
          ? 'style="color:#10b981;font-size:9px;letter-spacing:.05em;text-transform:uppercase;padding:4px 8px;border-bottom:1px solid rgba(16,185,129,.2);"'
          : 'style="font-size:11px;color:#d1fae5;padding:4px 8px;border-bottom:1px solid rgba(255,255,255,.04);"';
        return '<tr>' + cells.map(c => '<' + tag + ' ' + style + '>' + escHtml(c) + '</' + tag + '>').join('') + '</tr>';
      });
      return '<table style="width:100%;border-collapse:collapse;margin:6px 0;">' + trs.join('') + '</table>';
    });
    h = escHtml(h).replace(/&lt;pre /g, '<pre ').replace(/&lt;\/pre&gt;/g, '</pre>')
       .replace(/&lt;table /g, '<table ').replace(/&lt;\/table&gt;/g, '</table>')
       .replace(/&lt;tr&gt;/g, '<tr>').replace(/&lt;\/tr&gt;/g, '</tr>')
       .replace(/&lt;th /g, '<th ').replace(/&lt;\/th&gt;/g, '</th>')
       .replace(/&lt;td /g, '<td ').replace(/&lt;\/td&gt;/g, '</td>')
       .replace(/&lt;\/pre&gt;/g, '</pre>');
    // Actually let's do it properly - process raw markdown, escape, then re-inject HTML
    // Reset: start from original and do it properly
    h = md;
    // Extract & protect fenced code blocks
    const codeBlocks = [];
    h = h.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push('<pre style="background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.07);border-radius:6px;' +
        'padding:8px 10px;overflow-x:auto;font-size:10px;color:#a5f3fc;margin:6px 0;white-space:pre;">' +
        escHtml(code.trimEnd()) + '</pre>');
      return '\x00CODE' + idx + '\x00';
    });
    // Extract & protect tables
    const tableBlocks = [];
    h = h.replace(/(\|[^\n]+\|\n?)+/g, match => {
      const rows = match.trim().split('\n').filter(r => !/^\|[-:| ]+\|$/.test(r.trim()));
      const trs  = rows.map((row, i) => {
        const cells = row.split('|').slice(1, -1).map(c => c.trim());
        const tag   = i === 0 ? 'th' : 'td';
        const style = i === 0
          ? 'style="color:#10b981;font-size:9px;letter-spacing:.05em;text-transform:uppercase;padding:4px 8px;border-bottom:1px solid rgba(16,185,129,.2);"'
          : 'style="font-size:11px;color:#d1fae5;padding:4px 8px;border-bottom:1px solid rgba(255,255,255,.04);"';
        return '<tr>' + cells.map(c => '<' + tag + ' ' + style + '>' + escHtml(c) + '</' + tag + '>').join('') + '</tr>';
      });
      const idx = tableBlocks.length;
      tableBlocks.push('<table style="width:100%;border-collapse:collapse;margin:6px 0;">' + trs.join('') + '</table>');
      return '\x00TABLE' + idx + '\x00';
    });
    // Now escape and apply inline formatting
    h = escHtml(h);
    h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
    h = h.replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:3px;font-size:11px;">$1</code>');
    h = h.replace(/^## (.+)$/gm, '<div class="acc-md-h2">$1</div>');
    h = h.replace(/^### (.+)$/gm, '<div class="acc-md-h3">$1</div>');
    h = h.replace(/^[-•] (.+)$/gm, '<div class="acc-md-li">$1</div>');
    h = h.replace(/^\d+\. (.+)$/gm, '<div class="acc-md-li">$1</div>');
    h = h.replace(/\n/g, '<br>');
    // Restore protected blocks
    h = h.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[+i] || '');
    h = h.replace(/\x00TABLE(\d+)\x00/g, (_, i) => tableBlocks[+i] || '');
    return h;
  }

  // ─── Init pane ────────────────────────────────────────────
  function initPane() {
    if (initialized) return;
    const pane = window.__accessai?.getSidebarPane('clear-context');
    if (!pane) { setTimeout(initPane, 200); return; }
    initialized = true;
    paneEl = pane;

    paneEl.innerHTML = `
      <style>
        .aai-start-orb-cc .aai-orb-core { background: linear-gradient(135deg,#059669,#10b981); }
        .aai-start-orb-cc .aai-orb-ring-1 { border-color: rgba(16,185,129,.5); }
        .aai-start-orb-cc .aai-orb-ring-2 { border-color: rgba(16,185,129,.3); }
        .aai-start-orb-cc .aai-orb-ring-3 { border-color: rgba(16,185,129,.15); }

        /* modal */
        .acc-modal-overlay {
          position:absolute;inset:0;background:rgba(0,0,0,.72);
          display:flex;align-items:center;justify-content:center;
          z-index:100;border-radius:12px;
        }
        .acc-modal {
          background:#1a1f2e;border:1px solid rgba(16,185,129,.3);
          border-radius:12px;padding:20px 18px;width:88%;max-width:280px;
          box-shadow:0 8px 32px rgba(0,0,0,.5);
        }
        .acc-modal-title { font-size:13px;font-weight:700;color:#e2faf2;margin-bottom:5px; }
        .acc-modal-sub   { font-size:11px;color:#9ca3af;margin-bottom:14px;line-height:1.45; }
        .acc-modal-input {
          width:100%;box-sizing:border-box;
          background:rgba(255,255,255,.05);border:1px solid rgba(16,185,129,.3);
          border-radius:8px;padding:8px 10px;color:#e2faf2;
          font-size:12px;font-family:inherit;outline:none;margin-bottom:12px;
        }
        .acc-modal-input:focus { border-color:rgba(16,185,129,.6); }
        .acc-modal-btn {
          width:100%;background:linear-gradient(135deg,#059669,#10b981);
          border:none;border-radius:8px;padding:9px;
          color:#fff;font-size:12px;font-weight:700;cursor:pointer;transition:opacity .2s;
        }
        .acc-modal-btn:hover { opacity:.85; }

        /* tabs */
        .acc-tabs {
          display:flex;border-bottom:1px solid rgba(255,255,255,.06);
          flex-shrink:0;background:rgba(0,0,0,.2);
        }
        .acc-tab {
          flex:1;padding:8px 4px;font-size:10px;font-weight:700;
          text-align:center;cursor:pointer;color:#6b7280;
          letter-spacing:.05em;text-transform:uppercase;
          border-bottom:2px solid transparent;transition:all .15s;user-select:none;
        }
        .acc-tab.active  { color:#10b981;border-bottom-color:#10b981; }
        .acc-tab:hover:not(.active) { color:#9ca3af; }
        .acc-tab-badge {
          font-size:9px;background:rgba(16,185,129,.15);
          border-radius:7px;padding:1px 5px;margin-left:3px;color:#10b981;
        }

        /* panels */
        .acc-panel {
          display:none;flex:1;overflow-y:auto;padding:10px 12px;
          scrollbar-width:thin;scrollbar-color:rgba(16,185,129,.3) transparent;
        }
        .acc-panel.active { display:flex;flex-direction:column;gap:6px; }
        .acc-panel::-webkit-scrollbar { width:3px; }
        .acc-panel::-webkit-scrollbar-thumb { background:rgba(16,185,129,.3);border-radius:2px; }

        /* live */
        .acc-live-line {
          font-size:11px;color:#9ca3af;line-height:1.5;
          border-left:2px solid rgba(16,185,129,.2);
          padding:3px 8px;flex-shrink:0;
        }
        .acc-live-ts { font-size:9px;color:#4b5563;font-family:monospace;margin-right:6px; }
        .acc-live-status {
          font-size:11px;color:#60a5fa;font-family:monospace;
          animation:acc-pulse 1.4s ease-in-out infinite;flex-shrink:0;padding:4px 8px;
        }
        @keyframes acc-pulse { 0%,100%{opacity:.4} 50%{opacity:1} }

        /* cards */
        .acc-card-wrap {
          background:rgba(16,185,129,.05);border:1px solid rgba(16,185,129,.2);
          border-radius:10px;padding:12px 13px;
          animation:acc-pop .3s cubic-bezier(.16,1,.3,1);flex-shrink:0;
        }
        .acc-card-wrap.updated { border-color:rgba(16,185,129,.45); }
        @keyframes acc-pop {
          from { opacity:0;transform:translateY(8px) scale(.97); }
          to   { opacity:1;transform:translateY(0) scale(1); }
        }
        .acc-card-title {
          font-size:10px;font-weight:800;color:#10b981;
          letter-spacing:.06em;text-transform:uppercase;margin-bottom:7px;
        }
        .acc-card-body { font-size:12px;color:#d1fae5;line-height:1.7; }
        .acc-card-body .acc-md-h2 {
          font-size:12px;font-weight:700;color:#e2faf2;
          margin:8px 0 3px;border-bottom:1px solid rgba(16,185,129,.15);padding-bottom:2px;
        }
        .acc-card-body .acc-md-h3 { font-size:11px;font-weight:600;color:#a7f3d0;margin:6px 0 2px; }
        .acc-card-body .acc-md-li { padding-left:14px;position:relative;margin:2px 0; }
        .acc-card-body .acc-md-li::before { content:"›";position:absolute;left:3px;color:#10b981; }
        .acc-card-meta {
          margin-top:8px;font-size:9px;color:#4b5563;font-family:monospace;
          display:flex;justify-content:space-between;align-items:center;
        }
        .acc-badge-new {
          font-size:8px;background:rgba(16,185,129,.15);border:1px solid rgba(16,185,129,.2);
          border-radius:4px;padding:1px 5px;color:#10b981;
        }
        .acc-badge-upd {
          font-size:8px;background:rgba(96,165,250,.15);border:1px solid rgba(96,165,250,.2);
          border-radius:4px;padding:1px 5px;color:#60a5fa;
        }
        .acc-empty-state {
          flex:1;display:flex;flex-direction:column;
          align-items:center;justify-content:center;
          gap:8px;color:#4b5563;text-align:center;padding:20px;
        }
        .acc-empty-state svg { opacity:.3; }
        .acc-empty-state p { font-size:11px;line-height:1.45; }

        /* chat */
        .acc-chat-messages {
          flex:1;overflow-y:auto;display:flex;flex-direction:column;
          gap:8px;padding:10px 12px;
          scrollbar-width:thin;scrollbar-color:rgba(16,185,129,.3) transparent;
        }
        .acc-chat-messages::-webkit-scrollbar { width:3px; }
        .acc-chat-messages::-webkit-scrollbar-thumb { background:rgba(16,185,129,.3);border-radius:2px; }
        .acc-chat-bubble {
          max-width:92%;border-radius:10px;padding:8px 11px;
          font-size:12px;line-height:1.55;flex-shrink:0;
          animation:acc-pop .2s ease-out;
        }
        .acc-chat-bubble.user {
          align-self:flex-end;
          background:rgba(16,185,129,.15);border:1px solid rgba(16,185,129,.25);color:#e2faf2;
        }
        .acc-chat-bubble.ai {
          align-self:flex-start;
          background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:#d1d5db;
        }
        .acc-chat-lbl { font-size:9px;font-weight:700;letter-spacing:.06em;margin-bottom:4px; }
        .acc-chat-bubble.user .acc-chat-lbl { color:#10b981; }
        .acc-chat-bubble.ai  .acc-chat-lbl { color:#6b7280; }
        .acc-chat-input-row {
          display:flex;gap:6px;padding:8px 10px;
          border-top:1px solid rgba(255,255,255,.05);flex-shrink:0;
        }
        .acc-chat-field {
          flex:1;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);
          border-radius:8px;padding:7px 10px;color:#e2faf2;
          font-size:12px;font-family:inherit;outline:none;
        }
        .acc-chat-field:focus { border-color:rgba(16,185,129,.4); }
        .acc-chat-send {
          background:rgba(16,185,129,.2);border:1px solid rgba(16,185,129,.3);
          border-radius:8px;padding:7px 12px;color:#10b981;
          font-size:13px;cursor:pointer;transition:background .15s;align-self:flex-end;
        }
        .acc-chat-send:hover { background:rgba(16,185,129,.35); }

        /* footer */
        .acc-footer-bar {
          padding:7px 12px;border-top:1px solid rgba(255,255,255,.04);
          display:flex;gap:8px;align-items:center;flex-shrink:0;
        }
        .acc-ws-badge {
          font-size:9px;color:#4b5563;font-family:monospace;
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px;
        }
        .acc-stop-btn {
          flex:1;background:transparent;border:1px solid rgba(255,255,255,.07);
          border-radius:8px;padding:6px;color:#6b7280;font-family:monospace;
          font-size:10px;letter-spacing:.07em;text-transform:uppercase;
          cursor:pointer;transition:all .2s;
        }
        .acc-stop-btn:hover { border-color:rgba(239,68,68,.3);color:#f87171; }

        /* workspace picker hero */
        .acc-ws-picker { padding:12px 12px 10px;display:flex;flex-direction:column;gap:9px; }
        .acc-ws-picker-lbl { font-size:10px;font-weight:700;color:#6b7280;letter-spacing:.06em;text-transform:uppercase; }
        .acc-ws-select {
          width:100%;box-sizing:border-box;
          background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);
          border-radius:8px;padding:8px 28px 8px 10px;color:#e2faf2;
          font-size:12px;font-family:inherit;outline:none;cursor:pointer;
          appearance:none;-webkit-appearance:none;
          background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%236b7280'/%3E%3C/svg%3E");
          background-repeat:no-repeat;background-position:right 10px center;
        }
        .acc-ws-select:focus { border-color:rgba(16,185,129,.4); }
        .acc-ws-select option { background:#1a1f2e;color:#e2faf2; }
        .acc-new-ws-row { display:none;flex-direction:column; }
        .acc-new-ws-row.visible { display:flex; }
        .acc-hero-actions { display:flex;gap:6px; }
        .acc-hero-btn {
          flex:1;border-radius:8px;padding:9px 6px;font-size:11px;font-weight:700;
          cursor:pointer;transition:all .15s;letter-spacing:.04em;text-transform:uppercase;
          font-family:inherit;text-align:center;
        }
        .acc-hero-btn.primary { background:linear-gradient(135deg,#059669,#10b981);border:none;color:#fff; }
        .acc-hero-btn.primary:hover { opacity:.85; }
        .acc-hero-btn.secondary { background:transparent;border:1px solid rgba(255,255,255,.1);color:#9ca3af; }
        .acc-hero-btn.secondary:hover { border-color:rgba(16,185,129,.3);color:#10b981; }
        .acc-hero-sublabel { font-size:10px;color:#4b5563;text-align:center;line-height:1.45;padding:0 4px; }
        /* browse strip */
        .acc-browse-strip {
          padding:6px 12px;border-bottom:1px solid rgba(255,255,255,.05);
          font-size:10px;color:#6b7280;letter-spacing:.04em;
          display:flex;align-items:center;gap:8px;flex-shrink:0;
        }
        .acc-browse-dot { width:6px;height:6px;border-radius:50%;background:#4b5563;flex-shrink:0; }
        .acc-browse-dot.live { background:#10b981;animation:acc-pulse 1.4s ease-in-out infinite; }
        .acc-vision-badge {
          font-size:8px;background:rgba(96,165,250,.12);border:1px solid rgba(96,165,250,.2);
          border-radius:4px;padding:1px 5px;color:#60a5fa;margin-left:auto;
        }

        /* cards sub-header (workspace browser bar) */
        .acc-cards-header {
          display:flex;align-items:center;gap:6px;padding:7px 10px 5px;
          border-bottom:1px solid rgba(255,255,255,.05);flex-shrink:0;
        }
        .acc-cards-ws-select {
          flex:1;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);
          border-radius:6px;padding:4px 22px 4px 7px;color:#9ca3af;
          font-size:10px;font-family:inherit;outline:none;cursor:pointer;
          appearance:none;-webkit-appearance:none;
          background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%236b7280'/%3E%3C/svg%3E");
          background-repeat:no-repeat;background-position:right 8px center;
        }
        .acc-cards-ws-select:focus { border-color:rgba(16,185,129,.3);color:#e2faf2; }
        .acc-cards-ws-select option { background:#1a1f2e;color:#e2faf2; }
        .acc-cards-lock-badge {
          font-size:8px;color:#f59e0b;border:1px solid rgba(245,158,11,.25);
          background:rgba(245,158,11,.08);border-radius:4px;padding:1px 5px;
          white-space:nowrap;flex-shrink:0;
        }
        /* tts / download buttons on cards */
        .acc-card-actions {
          display:flex;gap:4px;margin-top:8px;border-top:1px solid rgba(255,255,255,.04);
          padding-top:7px;
        }
        .acc-card-act-btn {
          background:transparent;border:1px solid rgba(255,255,255,.06);border-radius:6px;
          padding:3px 8px;font-size:10px;color:#6b7280;cursor:pointer;transition:all .15s;
          font-family:inherit;display:flex;align-items:center;gap:3px;
        }
        .acc-card-act-btn:hover { border-color:rgba(16,185,129,.3);color:#10b981; }
        .acc-card-act-btn.playing { color:#10b981;border-color:rgba(16,185,129,.3);
          animation:acc-pulse 1.4s ease-in-out infinite; }
        .acc-dl-ws-btn {
          width:100%;background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.15);
          border-radius:8px;padding:7px;font-size:10px;color:#6b7280;cursor:pointer;
          transition:all .15s;font-family:inherit;letter-spacing:.04em;margin-top:6px;
        }
        .acc-dl-ws-btn:hover { background:rgba(16,185,129,.12);color:#10b981; }
      </style>

      <!-- Hero (pre-start) -->
      <div id="acc-hero" style="display:flex;flex-direction:column;flex:1;overflow:hidden;min-height:0;">
        <div class="aai-start-hero" style="flex-shrink:0;">
          <button class="aai-start-orb aai-start-orb-cc" id="acc-start-orb" aria-label="ClearContext" style="pointer-events:none;">
            <span class="aai-orb-ring aai-orb-ring-1"></span>
            <span class="aai-orb-ring aai-orb-ring-2"></span>
            <span class="aai-orb-ring aai-orb-ring-3"></span>
            <span class="aai-orb-core">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
              </svg>
            </span>
          </button>
          <div class="aai-start-label" id="acc-hero-label">ClearContext</div>
        </div>
        <div class="acc-ws-picker">
          <div class="acc-ws-picker-lbl">Workspace</div>
          <select class="acc-ws-select" id="acc-ws-select">
            <option value="__new__">＋ New workspace…</option>
          </select>
          <div class="acc-new-ws-row" id="acc-new-ws-row">
            <input class="acc-modal-input" id="acc-ws-input" type="text"
              placeholder="e.g. CS101, Biology Week 4…" maxlength="40" style="margin-bottom:0;" />
          </div>
          <div class="acc-hero-actions">
            <button class="acc-hero-btn secondary" id="acc-browse-btn">Browse Cards</button>
            <button class="acc-hero-btn primary" id="acc-start-btn">▶ Start Listening</button>
          </div>
          <div class="acc-hero-sublabel">AI watches your screen &amp; listens to audio, building smart topic cards automatically.</div>
        </div>
      </div>

      <!-- Main UI (post-start) -->
      <div id="acc-main" style="display:none;flex-direction:column;flex:1;overflow:hidden;min-height:0;">
        <div class="acc-tabs">
          <div class="acc-tab active" data-tab="live"  id="acc-tab-live">Live</div>
          <div class="acc-tab"        data-tab="cards" id="acc-tab-cards">
            Cards<span id="acc-card-count-badge" class="acc-tab-badge" style="display:none"></span>
          </div>
          <div class="acc-tab"        data-tab="chat"  id="acc-tab-chat">Chat</div>
        </div>

        <!-- Live panel -->
        <div class="acc-panel active" id="acc-panel-live"></div>

        <!-- Cards panel -->
        <div class="acc-panel" id="acc-panel-cards" style="padding:0;gap:0;flex-direction:column;">
          <div class="acc-cards-header">
            <select class="acc-cards-ws-select" id="acc-cards-ws-select"></select>
            <span class="acc-cards-lock-badge" id="acc-cards-lock-badge" style="display:none">🔴 Live</span>
          </div>
          <div style="flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:6px;" id="acc-cards-scroll">
            <div class="acc-empty-state" id="acc-cards-empty">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
              </svg>
              <p>Cards will appear once AI detects meaningful topics in what you are watching.</p>
            </div>
          </div>
        </div>

        <!-- Chat panel -->
        <div class="acc-panel" id="acc-panel-chat" style="padding:0;gap:0;">
          <div class="acc-chat-messages" id="acc-chat-messages">
            <div class="acc-empty-state">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              <p>Ask me anything about the content. I answer using only your saved cards.</p>
            </div>
          </div>
          <div class="acc-chat-input-row">
            <input class="acc-chat-field" id="acc-chat-input" type="text" placeholder="Ask about the content…" />
            <button class="acc-chat-send" id="acc-chat-send" aria-label="Send">↑</button>
          </div>
        </div>

        <!-- Footer -->
        <div class="acc-footer-bar">
          <span class="acc-ws-badge" id="acc-ws-badge"></span>
          <button class="acc-stop-btn" id="acc-stop-btn">■ Stop</button>
        </div>
      </div>
    `;

    // ─── Workspace dropdown setup ────────────────────────────
    const wsSelect = document.getElementById('acc-ws-select');
    const newWsRow = document.getElementById('acc-new-ws-row');
    const wsInput  = document.getElementById('acc-ws-input');

    async function populateWsDropdown() {
      const list = await loadWorkspaceList();
      while (wsSelect.options.length > 1) wsSelect.remove(1); // keep __new__ option
      list.slice().reverse().forEach(name => {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        wsSelect.add(opt); // append after __new__
      });
      if (list.length > 0) {
        wsSelect.value = list[list.length - 1];
        newWsRow.classList.remove('visible');
      } else {
        wsSelect.value = '__new__';
        newWsRow.classList.add('visible');
        setTimeout(() => wsInput?.focus(), 80);
      }
    }
    populateWsDropdown();

    wsSelect.addEventListener('change', () => {
      if (wsSelect.value === '__new__') {
        newWsRow.classList.add('visible');
        setTimeout(() => wsInput?.focus(), 80);
      } else {
        newWsRow.classList.remove('visible');
      }
    });

    function resolveWorkspaceName() {
      // If a new workspace name is typed in the input, always prefer that
      const typed = (wsInput?.value || '').trim();
      if (wsSelect.value === '__new__') {
        return typed || null;  // null = user must type a name
      }
      // If they selected an existing workspace but also typed new name text, use typed
      if (typed && newWsRow.classList.contains('visible')) return typed;
      return wsSelect.value || null;
    }

    document.getElementById('acc-browse-btn').addEventListener('click', async () => {
      const name = resolveWorkspaceName();
      if (!name) { wsInput?.focus(); return; }
      await browseWorkspace(name);
    });

    document.getElementById('acc-start-btn').addEventListener('click', () => {
      const name = resolveWorkspaceName();
      if (!name) { wsInput?.focus(); return; }
      startSession(name);
    });

    wsInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const name = resolveWorkspaceName();
        if (!name) return;
        startSession(name);
      }
    });

    document.querySelectorAll('.acc-tab').forEach(t =>
      t.addEventListener('click', () => switchTab(t.dataset.tab)));

    document.getElementById('acc-stop-btn').addEventListener('click', stopSession);
    document.getElementById('acc-chat-send').addEventListener('click', sendChatMessage);
    document.getElementById('acc-chat-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') sendChatMessage();
    });

    liveEl    = document.getElementById('acc-panel-live');
    cardsEl   = document.getElementById('acc-cards-scroll');  // inner scroll container
    chatEl    = document.getElementById('acc-chat-messages');
    chatInput = document.getElementById('acc-chat-input');

    // Cards panel workspace selector
    const cardsWsSel = document.getElementById('acc-cards-ws-select');
    cardsWsSel.addEventListener('change', async () => {
      const sel = cardsWsSel.value;
      if (!sel) return;
      // If recording, only change the DISPLAY — don't stop recording
      const displayCards = await loadCardsForWorkspace(sel);
      viewWorkspace = sel;
      chatHistory = [];   // Reset chat context when switching workspace
      cardsEl.querySelectorAll('.acc-card-wrap').forEach(el => el.remove());
      const emptyEl = document.getElementById('acc-cards-empty');
      if (displayCards.length === 0) {
        if (emptyEl) emptyEl.style.display = '';
      } else {
        if (emptyEl) emptyEl.style.display = 'none';
        displayCards.forEach(c => renderCardInto(cardsEl, c, false));
      }
      updateCardBadge(displayCards.length);
    });

    // Delegated handler for TTS play / download on cards
    cardsEl.addEventListener('click', async e => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const cardId = parseInt(btn.closest('[data-card-id]')?.dataset.cardId ?? '-1');
      const card   = findCardById(cardId);
      if (!card) return;
      if (btn.dataset.act === 'play')     await handleTtsPlay(btn, card);
      if (btn.dataset.act === 'dl-card')  downloadCardMd(card);
      if (btn.dataset.act === 'dl-audio') await downloadCardAudio(card);
    });
  }

  // ─── Tab switching ────────────────────────────────────────
  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.acc-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.acc-panel').forEach(p =>
      p.classList.toggle('active', p.id === 'acc-panel-' + tab));
  }

  // ─── Browse workspace (read-only, no recording) ──────────
  async function browseWorkspace(name) {
    if (!name) return;
    workspace     = name;
    viewWorkspace = name;
    cards         = await loadCardsForWorkspace(name);
    cardIdCounter = cards.length > 0 ? Math.max(...cards.map(c => c.id)) + 1 : 0;
    chatHistory   = [];   // Reset chat context for new workspace

    document.getElementById('acc-hero').style.display = 'none';
    document.getElementById('acc-main').style.display = 'flex';
    document.getElementById('acc-ws-badge').textContent = '📁 ' + workspace;

    const stopBtn = document.getElementById('acc-stop-btn');
    if (stopBtn) stopBtn.textContent = '← Back';

    // Browse strip indicator
    const mainEl = document.getElementById('acc-main');
    let strip = document.getElementById('acc-browse-strip');
    if (!strip && mainEl) {
      strip = document.createElement('div');
      strip.id = 'acc-browse-strip';
      strip.className = 'acc-browse-strip';
      strip.innerHTML =
        '<span class="acc-browse-dot"></span>' +
        '<span>' + escHtml(name) + ' — browse mode</span>' +
        '<span class="acc-vision-badge">read-only</span>';
      mainEl.insertBefore(strip, mainEl.querySelector('.acc-tabs'));
    }

    renderAllCards();
    refreshCardsWsDropdown(null);  // no live lock in browse mode
    switchTab('cards');
    window.__accessai?.setFooterStatus('Browsing "' + name + '": ' + cards.length + ' card' + (cards.length !== 1 ? 's' : ''));
  }

  // ─── Start session ────────────────────────────────────────
  async function startSession(name) {
    workspace = name;
    addWorkspaceToList(name);

    // Clean up any previous browse-mode UI
    document.getElementById('acc-browse-strip')?.remove();
    const stopBtn = document.getElementById('acc-stop-btn');
    if (stopBtn) stopBtn.textContent = '■ Stop';

    const orb   = document.getElementById('acc-start-orb');
    const label = document.getElementById('acc-hero-label');
    if (orb) orb.classList.add('aai-orb-connecting');
    if (label) label.textContent = 'Connecting…';

    // Get API key
    try {
      const kr = await msg({ type: 'API_REALTIME_SESSION' });
      if (!kr?.success || !kr.apiKey) throw new Error('No API key');
      apiKey = kr.apiKey;
    } catch (e) {
      if (orb) orb.classList.remove('aai-orb-connecting');
      if (label) label.textContent = 'ClearContext';
      document.getElementById('acc-hero').style.display = '';
      document.getElementById('acc-main').style.display = 'none';
      addLiveLine('❌ Could not get API key. Check extension settings.');
      return;
    }

    // Load saved cards for this workspace
    cards = await loadCards();
    cardIdCounter = cards.length > 0 ? Math.max(...cards.map(c => c.id)) + 1 : 0;

    // Request screen/tab share — audio + video (video used for frame capture)
    if (label) label.textContent = 'Select screen or tab…';
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 1, max: 2 } },  // low fps — we only need screenshots
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 16000 },
      });
      if (!s.getAudioTracks().length) {
        s.getTracks().forEach(t => t.stop());
        throw new Error('No audio track — enable "Share system audio" when prompted.');
      }
      _screenStream = s;

      // Keep video for frame capture (lets AI see the screen like Gemini Live)
      const videoTracks = s.getVideoTracks();
      if (videoTracks.length > 0) {
        _videoEl = document.createElement('video');
        _videoEl.srcObject = new MediaStream(videoTracks);
        _videoEl.muted = true;
        _videoEl.autoplay = true;
        _videoEl.playsInline = true;
        _videoEl.style.cssText = 'position:fixed;width:1px;height:1px;top:-2px;left:-2px;opacity:0;pointer-events:none;';
        document.body.appendChild(_videoEl);
        _videoEl.play().catch(() => {});
      }

      // Audio-only stream for chunked recording
      _activeStream = new MediaStream(s.getAudioTracks());
    } catch (e) {
      if (orb) orb.classList.remove('aai-orb-connecting');
      if (label) label.textContent = 'ClearContext';
      document.getElementById('acc-hero').style.display = '';
      document.getElementById('acc-main').style.display = 'none';
      addLiveLine('❌ ' + (e.message || 'Screen share cancelled.'));
      apiKey = null;
      return;
    }

    // Switch to main UI
    document.getElementById('acc-hero').style.display = 'none';
    document.getElementById('acc-main').style.display = 'flex';
    document.getElementById('acc-ws-badge').textContent = '📁 ' + workspace;

    if (orb) { orb.classList.remove('aai-orb-connecting'); orb.classList.add('aai-orb-active'); }
    if (label) label.textContent = 'ClearContext';

    isActive = true;
    viewWorkspace = workspace;  // lock cards view to recording workspace
    transcriptBuffer = [];
    transcriptsSinceAnalysis = 0;

    renderAllCards();
    refreshCardsWsDropdown(workspace);  // populate cards dropdown with live badge
    startChunkedRecording();

    window.__accessai?.setFooterStatus('ClearContext: Listening → ' + workspace);
    const visionActive = _videoEl !== null;
    addLiveLine('🎧 Listening' + (visionActive ? ' + 👁 watching screen' : '') + '. AI will build cards as topics emerge…');
    if (visionActive) addLiveLine('👁 Screen vision active — AI can read on-screen text to correct mishearings.');
  }

  // ─── Stop session ─────────────────────────────────────────
  function stopSession() {
    isActive = false;
    stopChunkedRecording();
    if (_screenStream) { _screenStream.getTracks().forEach(t => t.stop()); _screenStream = null; }
    _activeStream = null;
    if (_videoEl) { _videoEl.srcObject = null; _videoEl.remove(); _videoEl = null; }
    apiKey = null;

    document.getElementById('acc-hero').style.display = '';
    document.getElementById('acc-main').style.display = 'none';
    document.getElementById('acc-browse-strip')?.remove();

    const orb   = document.getElementById('acc-start-orb');
    const label = document.getElementById('acc-hero-label');
    if (orb) orb.classList.remove('aai-orb-connecting', 'aai-orb-active');
    if (label) label.textContent = 'ClearContext';

    window.__accessai?.setFooterStatus(
      'ClearContext: ' + cards.length + ' card' + (cards.length !== 1 ? 's' : '') + ' saved to "' + workspace + '"'
    );

    // Refresh workspace dropdown so the just-used workspace appears
    const savedWs = workspace;
    workspace = null;
    viewWorkspace = null;

    const wsSelect = document.getElementById('acc-ws-select');
    const newWsRow = document.getElementById('acc-new-ws-row');
    if (wsSelect) {
      setTimeout(async () => {
        const list = await loadWorkspaceList();
        while (wsSelect.options.length > 1) wsSelect.remove(1);
        list.slice().reverse().forEach(name => {
          const opt = document.createElement('option');
          opt.value = name; opt.textContent = name;
          wsSelect.add(opt);
        });
        if (savedWs && list.includes(savedWs)) {
          wsSelect.value = savedWs;
          newWsRow?.classList.remove('visible');
        }
        refreshCardsWsDropdown(null);  // clear live lock
      }, 100);
    }
  }

  // ─── Chunked recording ────────────────────────────────────
  function startChunkedRecording() {
    if (!_activeStream) return;
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find(m => MediaRecorder.isTypeSupported(m)) || '';
    try {
      mediaRecorder = new MediaRecorder(_activeStream, mimeType ? { mimeType, audioBitsPerSecond: 16000 } : {});
    } catch (e) { addLiveLine('❌ MediaRecorder failed to start.'); return; }

    audioChunks = [];
    mediaRecorder.ondataavailable = e => { if (e.data?.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      if (!isActive) return;
      if (audioChunks.length > 0) {
        const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        audioChunks = [];
        enqueueProcessing(blob, mediaRecorder.mimeType || 'audio/webm');
      }
    };
    mediaRecorder.onerror = e => console.error('[ClearContext] MediaRecorder error:', e);
    mediaRecorder.start();

    chunkTimer = setInterval(() => {
      if (!isActive) { clearInterval(chunkTimer); return; }
      if (mediaRecorder?.state === 'recording') {
        mediaRecorder.stop();
        setTimeout(() => {
          if (!isActive || !mediaRecorder) return;
          try { mediaRecorder.start(); } catch (_) { stopSession(); }
        }, 80);
      }
    }, CHUNK_MS);
  }

  function stopChunkedRecording() {
    clearInterval(chunkTimer); chunkTimer = null;
    if (mediaRecorder?.state !== 'inactive') { try { mediaRecorder.stop(); } catch (_) {} }
    mediaRecorder = null;
    audioChunks   = [];
  }

  // ─── Screen frame capture for vision ─────────────────────
  function captureFrame() {
    if (!_videoEl || _videoEl.readyState < 2 || _videoEl.videoWidth === 0) return null;
    try {
      if (!_canvasEl) {
        _canvasEl = document.createElement('canvas');
        _canvasEl.style.cssText = 'position:fixed;width:1px;height:1px;top:-2px;left:-2px;opacity:0;pointer-events:none;';
      }
      const maxW = 1024;
      const W    = Math.min(_videoEl.videoWidth, maxW);
      const H    = Math.round(_videoEl.videoHeight * W / _videoEl.videoWidth);
      _canvasEl.width  = W;
      _canvasEl.height = H;
      const ctx = _canvasEl.getContext('2d');
      ctx.drawImage(_videoEl, 0, 0, W, H);
      return _canvasEl.toDataURL('image/jpeg', 0.65).split(',')[1]; // base64 only
    } catch (_) { return null; }
  }

  // ─── Processing queue (serial to avoid races) ─────────────
  function enqueueProcessing(blob, mimeType) {
    processingQueue = processingQueue.then(() => processChunk(blob, mimeType)).catch(() => {});
  }

  async function processChunk(blob, mimeType) {
    if (!isActive || !apiKey) return;
    const statusEl = addLiveStatus('⟳ Transcribing…');
    try {
      const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
      const fd = new FormData();
      fd.append('file', blob, 'audio.' + ext);
      fd.append('model', 'gpt-4o-mini-transcribe');
      fd.append('temperature', '0');

      const wr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey },
        body: fd,
      });
      if (!wr.ok) {
        const e = await wr.json().catch(() => ({}));
        throw new Error(e.error?.message || 'Transcription error ' + wr.status);
      }
      const wData      = await wr.json();
      const transcript = (wData.text || '').trim();
      statusEl?.remove();

      if (!transcript || transcript.length < 10) return;

      addLiveLine(transcript);
      transcriptBuffer.push(transcript);
      if (transcriptBuffer.length > MAX_TRANSCRIPT_BUF) transcriptBuffer.shift();
      transcriptsSinceAnalysis++;

      if (transcriptsSinceAnalysis >= ANALYSIS_EVERY_N) {
        transcriptsSinceAnalysis = 0;
        await runSmartAnalysis();
      }
    } catch (e) {
      statusEl?.remove();
      if (isActive) {
        console.warn('[ClearContext] Chunk error:', e.message);
        window.__accessai?.setFooterStatus('Error: ' + e.message.slice(0, 60));
      }
    }
  }

  // ─── Smart AI card analysis ───────────────────────────────
  async function runSmartAnalysis() {
    if (!isActive || !apiKey) return;
    const statusEl = addLiveStatus('🧠 AI analysing content…');
    try {
      const existingSummary = cards.length > 0
        ? cards.map(c => 'Card #' + c.id + ': "' + c.title + '"\n' + c.content.slice(0, 300)).join('\n\n---\n\n')
        : 'No cards yet.';

      const recentTranscript = transcriptBuffer.slice(-10).join('\n');

      const systemPrompt = `You are ClearContext, an intelligent study assistant. You watch a user's screen and listen to audio from lectures and videos.
Your job is to build a rich set of knowledge cards — one card per DISTINCT topic, concept, piece of code, or example shown.

You receive:
1. Rolling audio transcript — may have transcription mishearings (wrong brand names, tech terms, product names)
2. A screenshot of the current screen — USE THIS as the ground truth.
   - Correct any mishearings: if screen shows "CrewAI" but transcript says "CREO AI", use "CrewAI"
   - If you see CODE on screen, extract it exactly and put it in a code card
   - If you see a DATA TABLE or SCHEMA on screen, represent it as a markdown table
   - If you see a DIAGRAM or FLOW, describe it with bullet points

ACTIONS — reply ONLY with valid JSON (one action per response), no prose, no markdown fences:

1. Skip → {"action":"skip"}
   When: pure filler, no new information.

2. New card → {"action":"new_card","title":"Short Topic Title","content":"...markdown..."}
   CREATE A NEW CARD when ANY of these are true:
   - A new concept/topic is introduced (even briefly)
   - Code appears on screen (always its own card: "Code: [what it does]")
   - A new example, demo, or project is shown
   - A tool, library, or product is introduced for the first time
   DON'T force everything into one card — multiple focused cards are MUCH better than one bloated card.

3. Update card → {"action":"update_card","id":<number>,"title":"Updated Title","content":"...full updated markdown..."}
   Only when genuinely more detail about the SAME specific topic is added.
   Write the FULL card content (not just the new bit).

CARD CONTENT FORMAT by type:

CONCEPT/THEORY card:
- **Bold** 1-sentence summary
- ## Sub-sections for depth (use ## headings)
- Bullet lists: - item
- 1–2 topic emojis max

CODE card (when code visible on screen):
\`\`\`python
# paste or reconstruct the exact code from the screenshot
\`\`\`
- Brief explanation of what each part does

TABLE / DATA card (when schema or table visible):
| Col 1 | Col 2 |
|-------|-------|
| ...   | ...   |

RULES:
- Max ~200 words per card
- Use EXACT names as seen on screen
- Independent cards — readable without the lecture
- SKIP is a last resort — if there's ANY new info, make a card`;

      // Capture current screen frame
      const frameB64 = captureFrame();

      const userTextContent = 'Existing cards:\n' + existingSummary +
        '\n\n---\n\n' +
        (frameB64 ? 'Audio transcript (may have mishearings — screen screenshot attached for correction):\n' : 'New transcript:\n') +
        recentTranscript + '\n\nDecide action. Reply JSON only.';

      const userContent = frameB64
        ? [
            { type: 'text', text: userTextContent },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + frameB64, detail: 'low' } },
          ]
        : userTextContent;

      const gr = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          max_tokens: 600,
          temperature: 0.2,
          response_format: { type: 'json_object' },
        }),
      });
      if (!gr.ok) {
        const e = await gr.json().catch(() => ({}));
        throw new Error(e.error?.message || 'GPT ' + gr.status);
      }
      const gData = await gr.json();
      let result;
      try { result = JSON.parse(gData.choices?.[0]?.message?.content || '{}'); }
      catch (_) { result = { action: 'skip' }; }

      statusEl?.remove();

      if (result.action === 'new_card' && result.title && result.content) {
        const ts   = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const card = { id: cardIdCounter++, title: result.title, content: result.content, createdAt: ts, updatedAt: null };
        cards.push(card);
        saveCards();
        renderCard(card, false);
        updateCardBadge();
        window.__accessai?.setFooterStatus(cards.length + ' card' + (cards.length !== 1 ? 's' : '') + ' — ' + workspace);
        addLiveLine('📌 New card: "' + card.title + '"');
        if (cards.length === 1) setTimeout(() => switchTab('cards'), 700);

      } else if (result.action === 'update_card' && typeof result.id === 'number' && result.content) {
        const idx = cards.findIndex(c => c.id === result.id);
        if (idx !== -1) {
          const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          cards[idx].content   = result.content;
          cards[idx].title     = result.title || cards[idx].title;
          cards[idx].updatedAt = ts;
          saveCards();
          rerenderCard(cards[idx]);
          addLiveLine('✏️ Updated card: "' + cards[idx].title + '"');
          window.__accessai?.setFooterStatus('Updated: "' + cards[idx].title + '"');
        }
      }
      // else: skip
    } catch (e) {
      statusEl?.remove();
      if (isActive) console.warn('[ClearContext] Analysis error:', e.message);
    }
  }

  // ─── Card rendering ───────────────────────────────────────
  async function refreshCardsWsDropdown(lockToWs) {
    const sel = document.getElementById('acc-cards-ws-select');
    if (!sel) return;
    const list = await loadWorkspaceList();
    // Merge in the current session workspace if not yet saved
    const all = lockToWs && !list.includes(lockToWs) ? [lockToWs, ...list] : list;
    sel.innerHTML = '';
    all.forEach(name => {
      const opt = document.createElement('option'); opt.value = name; opt.textContent = name;
      sel.appendChild(opt);
    });
    sel.value = viewWorkspace || lockToWs || (all[0] ?? '');
    // Show live lock badge if recording
    const lockBadge = document.getElementById('acc-cards-lock-badge');
    if (lockBadge) lockBadge.style.display = lockToWs ? '' : 'none';
  }

  function renderAllCards() {
    if (!cardsEl) return;
    cardsEl.querySelectorAll('.acc-card-wrap').forEach(el => el.remove());
    cards.forEach(c => renderCardInto(cardsEl, c, false));
    updateCardBadge(cards.length);
  }

  function renderCardInto(container, card, isUpdate) {
    if (!container) return null;
    const empty = document.getElementById('acc-cards-empty');
    if (empty) empty.style.display = 'none';
    const el = document.createElement('div');
    el.className      = 'acc-card-wrap' + (isUpdate ? ' updated' : '');
    el.dataset.cardId = card.id;
    el.innerHTML      = buildCardHTML(card, isUpdate);
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    if (isUpdate) setTimeout(() => el?.classList.remove('updated'), 2500);
    return el;
  }

  // Only renders into cardsEl when the user is viewing the recording workspace
  function renderCard(card, isUpdate) {
    if (viewWorkspace && viewWorkspace !== workspace) return; // viewing a different ws
    renderCardInto(cardsEl, card, isUpdate);
    updateCardBadge(cards.length);
  }

  function rerenderCard(card) {
    if (!cardsEl) return;
    if (viewWorkspace && viewWorkspace !== workspace) return; // not viewing recording ws
    const existing = cardsEl.querySelector('[data-card-id="' + card.id + '"]');
    if (existing) {
      existing.className = 'acc-card-wrap updated';
      existing.innerHTML = buildCardHTML(card, true);
      existing.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setTimeout(() => existing?.classList.remove('updated'), 2500);
    } else {
      renderCardInto(cardsEl, card, true);
    }
    updateCardBadge(cards.length);
  }

  function buildCardHTML(card, isUpdate) {
    const badge = (isUpdate || card.updatedAt)
      ? '<span class="acc-badge-upd">↺ ' + (card.updatedAt || 'updated') + '</span>'
      : '<span class="acc-badge-new">NEW</span>';
    return (
      '<div class="acc-card-title">' + escHtml(card.title) + '</div>' +
      '<div class="acc-card-body">' + renderMarkdown(card.content) + '</div>' +
      '<div class="acc-card-meta"><span>' + escHtml(card.createdAt) + '</span>' + badge + '</div>' +
      '<div class="acc-card-actions">' +
        '<button class="acc-card-act-btn" data-act="play" data-card-id="' + card.id + '" title="Read aloud">▶ Play</button>' +
        '<button class="acc-card-act-btn" data-act="dl-card" data-card-id="' + card.id + '" title="Download as markdown">⬇ .md</button>' +
        '<button class="acc-card-act-btn" data-act="dl-audio" data-card-id="' + card.id + '" title="Download audio">⬇ .mp3</button>' +
      '</div>'
    );
  }

  function updateCardBadge(count) {
    const badge = document.getElementById('acc-card-count-badge');
    if (!badge) return;
    const n = count !== undefined ? count : cards.length;
    if (n > 0) { badge.textContent = n; badge.style.display = ''; }
    else badge.style.display = 'none';
  }

  // ─── Card lookup ──────────────────────────────────────────
  function findCardById(id) {
    return cards.find(c => c.id === id) || null;
  }

  // ─── TTS helpers ─────────────────────────────────────────
  function cleanForSpeech(card) {
    // Strip markdown syntax so TTS reads cleanly
    return (card.title + '. ' + card.content)
      .replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => 'code block: ' + code.replace(/\n/g, '. '))
      .replace(/\|[^\n]+\|(\n)?/g, ' ')     // tables
      .replace(/^#{1,3} /gm, '')             // headings
      .replace(/\*\*(.+?)\*\*/g, '$1')       // bold
      .replace(/\*(.+?)\*/g, '$1')           // italic
      .replace(/`([^`]+)`/g, '$1')           // inline code
      .replace(/^[-•] /gm, '')               // bullets
      .replace(/\n/g, ' ')
      .replace(/  +/g, ' ')
      .trim();
  }

  async function ensureApiKey() {
    if (apiKey) return true;
    try {
      const kr = await msg({ type: 'API_REALTIME_SESSION' });
      if (!kr?.success || !kr.apiKey) return false;
      apiKey = kr.apiKey;
      return true;
    } catch (_) { return false; }
  }

  async function fetchTtsBlob(text) {
    if (!(await ensureApiKey())) throw new Error('No API key');
    const resp = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', voice: 'alloy', input: text }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || 'TTS ' + resp.status);
    }
    return resp.blob();
  }

  async function handleTtsPlay(btn, card) {
    // Stop currently playing audio
    if (_ttsAudio) {
      _ttsAudio.pause();
      _ttsAudio = null;
      const prevBtn = cardsEl?.querySelector('.acc-card-act-btn.playing');
      if (prevBtn) { prevBtn.classList.remove('playing'); prevBtn.textContent = '▶ Play'; }
      if (_ttsPlayingId === card.id) { _ttsPlayingId = null; return; }  // toggle off
    }
    btn.textContent = '⏳ Loading…';
    btn.disabled = true;
    try {
      const blob = await fetchTtsBlob(cleanForSpeech(card));
      const url  = URL.createObjectURL(blob);
      _ttsAudio   = new Audio(url);
      _ttsPlayingId = card.id;
      btn.classList.add('playing');
      btn.textContent = '⏸ Playing';
      btn.disabled = false;
      _ttsAudio.onended = () => {
        btn.classList.remove('playing');
        btn.textContent = '▶ Play';
        URL.revokeObjectURL(url);
        _ttsAudio = null; _ttsPlayingId = null;
      };
      _ttsAudio.play();
    } catch (e) {
      btn.textContent = '▶ Play';
      btn.disabled = false;
      console.warn('[ClearContext] TTS error:', e.message);
    }
  }

  function downloadCardMd(card) {
    const md  = '# ' + card.title + '\n\n' + card.content + '\n\n---\nCreated: ' + card.createdAt;
    const url = URL.createObjectURL(new Blob([md], { type: 'text/plain' }));
    const a   = document.createElement('a');
    a.href = url; a.download = card.title.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.md';
    a.click(); URL.revokeObjectURL(url);
  }

  async function downloadCardAudio(card) {
    const btn = cardsEl?.querySelector('[data-act="dl-audio"][data-card-id="' + card.id + '"]');
    if (btn) { btn.textContent = '⏳…'; btn.disabled = true; }
    try {
      const blob = await fetchTtsBlob(cleanForSpeech(card));
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = card.title.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.mp3';
      a.click(); URL.revokeObjectURL(url);
    } catch (e) {
      console.warn('[ClearContext] TTS download error:', e.message);
    } finally {
      if (btn) { btn.textContent = '⬇ .mp3'; btn.disabled = false; }
    }
  }

  // ─── Chat ─────────────────────────────────────────────────
  async function sendChatMessage() {
    const q = (chatInput?.value || '').trim();
    if (!q) return;
    chatInput.value = '';
    appendChatBubble('user', q);

    // Get API key on demand — works even when not recording
    if (!apiKey) {
      try {
        const kr = await msg({ type: 'API_REALTIME_SESSION' });
        if (!kr?.success || !kr.apiKey) throw new Error('no key');
        apiKey = kr.apiKey;
      } catch (_) {
        appendChatBubble('ai', '❌ No API key — check extension settings.');
        return;
      }
    }

    const thinkEl = appendChatBubble('ai', '…');

    try {
      const ctx = cards.length > 0
        ? cards.map(c => '## ' + c.title + '\n' + c.content).join('\n\n---\n\n')
        : '';

      const systemMsg = ctx
        ? 'You are a helpful study assistant. The user has saved knowledge cards from their study sessions. ' +
          'Primarily answer from the cards, but you may supplement with your own knowledge when the cards lack detail. ' +
          'Always clearly signal when you go beyond the cards (e.g. "Beyond what\'s in your notes…"). ' +
          'Be concise (2–5 sentences or a short list), clear, and friendly.\n\nSAVED CARDS:\n' + ctx
        : 'You are a helpful study assistant. The user has no saved cards yet. Answer from your general knowledge, ' +
          'clearly and concisely. Encourage them to start a listening session to build cards.';

      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: [
            { role: 'system', content: systemMsg },
            ...chatHistory,
            { role: 'user', content: q },
          ],
          max_tokens: 400,
          temperature: 0.4,
        }),
      });
      if (!resp.ok) throw new Error('API ' + resp.status);
      const data   = await resp.json();
      const answer = (data.choices?.[0]?.message?.content || '').trim() || 'No answer found.';
      thinkEl.innerHTML = '<div class="acc-chat-lbl">ClearContext</div><div>' + renderMarkdown(answer) + '</div>';

      // Save this turn to history (keep last 20 turns to avoid token overflow)
      chatHistory.push({ role: 'user', content: q });
      chatHistory.push({ role: 'assistant', content: answer });
      if (chatHistory.length > 40) chatHistory.splice(0, 2);
    } catch (e) {
      thinkEl.innerHTML = '<div class="acc-chat-lbl">ClearContext</div><div>❌ ' + escHtml(e.message) + '</div>';
    }

    if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
  }

  function appendChatBubble(role, text) {
    if (!chatEl) return null;
    chatEl.querySelectorAll('.acc-empty-state').forEach(el => el.remove());
    const el      = document.createElement('div');
    el.className  = 'acc-chat-bubble ' + role;
    el.innerHTML  = '<div class="acc-chat-lbl">' + (role === 'user' ? 'You' : 'ClearContext') + '</div>' +
                    '<div>' + escHtml(text) + '</div>';
    chatEl.appendChild(el);
    chatEl.scrollTop = chatEl.scrollHeight;
    while (chatEl.children.length > 80) chatEl.removeChild(chatEl.firstChild);
    return el;
  }

  // ─── Live panel helpers ───────────────────────────────────
  function addLiveLine(text) {
    if (!liveEl) return;
    const ts  = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const el  = document.createElement('div');
    el.className = 'acc-live-line';
    el.innerHTML = '<span class="acc-live-ts">' + ts + '</span>' + escHtml(text);
    liveEl.appendChild(el);
    while (liveEl.children.length > 120) liveEl.removeChild(liveEl.firstChild);
    liveEl.scrollTop = liveEl.scrollHeight;
  }

  function addLiveStatus(text) {
    if (!liveEl) return null;
    const el = document.createElement('div');
    el.className   = 'acc-live-status';
    el.textContent = text;
    liveEl.appendChild(el);
    liveEl.scrollTop = liveEl.scrollHeight;
    return el;
  }

  // ─── Helpers ──────────────────────────────────────────────
  function escHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
  function msg(m)     { return new Promise(r => chrome.runtime.sendMessage(m, r)); }

  // ─── Lifecycle ────────────────────────────────────────────
  window.addEventListener('accessai-mode-changed', e => {
    if (e.detail.mode === 'clear-context') initPane();
    else if (isActive) stopSession();
  });

  chrome.storage.local.get('activeMode', r => {
    if (r.activeMode === 'clear-context') setTimeout(initPane, 500);
  });

})();
