// ============================================================
// AccessAI Unified Sidebar v2 — Fixed
// - Right-side sidebar that PUSHES page content (never overlaps)
// - On meet.google.com: directly nudges Meet's video grid
// FIX #15: pushGenericLayout guards against duplicate style tags
// ============================================================

(function () {
  'use strict';

  if (window.__accessai_sidebar_init) return;
  window.__accessai_sidebar_init = true;

  const SIDEBAR_WIDTH = 370;
  const IS_MEET = window.location.hostname === 'meet.google.com';

  let sidebarEl = null;
  let isOpen = false;
  let currentMode = null;

  // ─── Meet layout management ───────────────────────────────
  let meetStyleEl = null;

  function pushMeetLayout(open) {
    if (!IS_MEET) return;

    if (!meetStyleEl) {
      meetStyleEl = document.createElement('style');
      meetStyleEl.id = 'accessai-meet-layout';
      document.head.appendChild(meetStyleEl);
    }

    if (open) {
      meetStyleEl.textContent = `
        body[data-accessai-open] {
          overflow: hidden !important;
        }
        body[data-accessai-open] c-wiz,
        body[data-accessai-open] [jscontroller][data-use-native-client-navigation],
        body[data-accessai-open] [jscontroller][jsaction*="rcuQ6b"] {
          width: calc(100vw - ${SIDEBAR_WIDTH}px) !important;
          max-width: calc(100vw - ${SIDEBAR_WIDTH}px) !important;
          transition: width 0.35s cubic-bezier(0.4, 0, 0.2, 1),
                      max-width 0.35s cubic-bezier(0.4, 0, 0.2, 1);
        }
        body[data-accessai-open] [data-allocation-index],
        body[data-accessai-open] [jsname="F57Jan"],
        body[data-accessai-open] [jsname="HlFzId"] {
          max-width: calc(100vw - ${SIDEBAR_WIDTH}px) !important;
        }
        body[data-accessai-open] [jsname="x8HMZb"],
        body[data-accessai-open] [data-self-name],
        body[data-accessai-open] [jscontroller="DE0Bme"] {
          left: 0 !important;
          width: calc(100vw - ${SIDEBAR_WIDTH}px) !important;
        }
      `;
      document.body.setAttribute('data-accessai-open', '1');
    } else {
      meetStyleEl.textContent = '';
      document.body.removeAttribute('data-accessai-open');
    }
  }

  // FIX #15: Use a single persistent style element, check for existing before creating
  let pushStyleEl = null;

  function pushGenericLayout(open) {
    if (IS_MEET) return;

    if (!open) {
      // Remove push style
      if (pushStyleEl) { pushStyleEl.remove(); pushStyleEl = null; }
      document.documentElement.style.removeProperty('margin-right');
      document.documentElement.style.removeProperty('transition');
      return;
    }

    // Guard: don't create duplicate style tags
    if (pushStyleEl && document.head.contains(pushStyleEl)) return;

    // Clean up stale reference if it was removed from DOM
    if (pushStyleEl) { pushStyleEl = null; }

    pushStyleEl = document.createElement('style');
    pushStyleEl.id = 'accessai-push-layout';
    pushStyleEl.textContent = `
      html {
        margin-right: ${SIDEBAR_WIDTH}px !important;
        max-width: calc(100% - ${SIDEBAR_WIDTH}px) !important;
        overflow-x: hidden !important;
        transition: margin-right 0.35s cubic-bezier(0.4,0,0.2,1) !important;
      }
      ytd-app,
      ytd-page-manager,
      #page-manager,
      #masthead-container,
      #masthead {
        max-width: calc(100vw - ${SIDEBAR_WIDTH}px) !important;
      }
      [style*="width: 100vw"],
      [style*="width:100vw"] {
        width: calc(100vw - ${SIDEBAR_WIDTH}px) !important;
      }
      #accessai-sidebar,
      #accessai-ws-hover-overlay {
        margin-right: 0 !important;
        max-width: none !important;
      }
    `;
    document.head.appendChild(pushStyleEl);
  }

  // ─── Build sidebar shell ──────────────────────────────────
  function createSidebar() {
    if (sidebarEl) return;

    sidebarEl = document.createElement('div');
    sidebarEl.id = 'accessai-sidebar';
    sidebarEl.setAttribute('role', 'complementary');
    sidebarEl.setAttribute('aria-label', 'AccessAI Sidebar');

    sidebarEl.innerHTML = `
      <div class="aai-sb-inner">
        <div class="aai-sb-header">
          <div class="aai-sb-brand">
            <span class="aai-sb-logo" aria-hidden="true">&#9883;</span>
            <span class="aai-sb-brand-text">AccessAI</span>
          </div>
          <button class="aai-sb-close" id="aai-sb-close" aria-label="Close sidebar">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        <div class="aai-sb-switcher" role="tablist" aria-label="Choose assistant mode">
          <div class="aai-sb-slider-track">
            <div class="aai-sb-slider-glass" id="aai-sb-glass"></div>
            <button class="aai-sb-slider-tab" data-mode="social-cue" role="tab" aria-selected="false" aria-controls="aai-pane-social-cue" title="Social Cue - Meeting Intelligence">
              <span class="aai-sb-tab-icon" aria-hidden="true">&#128483;</span>
              <span class="aai-sb-tab-label">Social Cue</span>
            </button>
            <button class="aai-sb-slider-tab" data-mode="web-sight" role="tab" aria-selected="false" aria-controls="aai-pane-web-sight" title="Web-Sight - Accessibility Navigator">
              <span class="aai-sb-tab-icon" aria-hidden="true">&#9788;</span>
              <span class="aai-sb-tab-label">Web-Sight</span>
            </button>
            <button class="aai-sb-slider-tab" data-mode="clear-context" role="tab" aria-selected="false" aria-controls="aai-pane-clear-context" title="ClearContext - Education Buddy">
              <span class="aai-sb-tab-icon" aria-hidden="true">&#128218;</span>
              <span class="aai-sb-tab-label">ClearContext</span>
            </button>
          </div>
        </div>

        <div class="aai-sb-content">
          <div class="aai-sb-pane" id="aai-pane-social-cue" role="tabpanel" aria-label="Social Cue" style="display:none;">
            <div class="aai-sb-pane-empty">Select Social Cue to start</div>
          </div>
          <div class="aai-sb-pane" id="aai-pane-web-sight" role="tabpanel" aria-label="Web-Sight" style="display:none;">
            <div class="aai-sb-pane-empty">Select Web-Sight to start</div>
          </div>
          <div class="aai-sb-pane" id="aai-pane-clear-context" role="tabpanel" aria-label="ClearContext" style="display:none;">
            <div class="aai-sb-pane-empty">Select ClearContext to start</div>
          </div>
        </div>

        <div class="aai-sb-footer" id="aai-sb-footer">
          <span class="aai-sb-footer-dot" id="aai-sb-footer-dot"></span>
          <span id="aai-sb-footer-text">Click a mode to begin</span>
        </div>
      </div>
    `;

    document.body.appendChild(sidebarEl);

    document.getElementById('aai-sb-close').addEventListener('click', closeSidebar);

    sidebarEl.querySelectorAll('.aai-sb-slider-tab').forEach(tab => {
      tab.addEventListener('click', () => selectMode(tab.dataset.mode));
    });
  }

  // ─── Open / Close ─────────────────────────────────────────
  function openSidebar() {
    if (!sidebarEl) createSidebar();
    isOpen = true;
    sidebarEl.classList.add('aai-sb-open');

    pushMeetLayout(true);
    pushGenericLayout(true);

    chrome.storage.local.set({ sidebarOpen: true });
    chrome.storage.local.get('activeMode', (r) => { selectMode(r.activeMode || 'social-cue'); });
  }

  function closeSidebar() {
    if (!sidebarEl) return;
    isOpen = false;
    sidebarEl.classList.remove('aai-sb-open');

    pushMeetLayout(false);
    pushGenericLayout(false);

    chrome.storage.local.set({ sidebarOpen: false });
  }

  function toggleSidebar() { isOpen ? closeSidebar() : openSidebar(); }

  // ─── Mode selection with glass slider ─────────────────────
  function selectMode(mode) {
    if (currentMode === mode) return;
    currentMode = mode;

    const tabs  = sidebarEl.querySelectorAll('.aai-sb-slider-tab');
    const glass = document.getElementById('aai-sb-glass');
    let idx = 0;

    tabs.forEach((tab, i) => {
      const active = tab.dataset.mode === mode;
      tab.setAttribute('aria-selected', String(active));
      tab.classList.toggle('aai-sb-slider-tab-active', active);
      if (active) idx = i;
    });

    const trackW = tabs[0]?.parentElement?.offsetWidth || 0;
    const tabW   = trackW / tabs.length;
    glass.style.width     = tabW + 'px';
    glass.style.transform = `translateX(${idx * tabW}px)`;

    sidebarEl.querySelectorAll('.aai-sb-pane').forEach(p => p.style.display = 'none');
    const activePane = document.getElementById(`aai-pane-${mode}`);
    if (activePane) activePane.style.display = 'flex';

    const dot = document.getElementById('aai-sb-footer-dot');
    if (dot) dot.className = 'aai-sb-footer-dot aai-sb-footer-dot-active';

    chrome.runtime.sendMessage({ type: 'SET_MODE', mode });
    window.dispatchEvent(new CustomEvent('accessai-mode-changed', { detail: { mode } }));
  }

  // ─── Expose API ───────────────────────────────────────────
  window.__accessai = {
    getSidebarPane: (mode) => document.getElementById(`aai-pane-${mode}`),
    setFooterStatus: (text) => {
      const el = document.getElementById('aai-sb-footer-text');
      if (el) el.textContent = text;
    },
    getCurrentMode: () => currentMode,
    isSidebarOpen:  () => isOpen,
    openSidebar,
    closeSidebar,
  };

  // ─── Message listener ─────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'TOGGLE_SIDEBAR') {
      toggleSidebar();
      sendResponse({ ok: true });
    }
    if (message.type === 'MODE_CHANGED' && message.mode && isOpen) {
      selectMode(message.mode);
    }
    if (message.type === 'PING') {
      sendResponse({ alive: true, sidebarOpen: isOpen });
    }
    if (message.type === 'RESTORE_STATE') {
      if (!isOpen) openSidebar();
      if (message.mode) selectMode(message.mode);
      sendResponse({ success: true });
    }
  });

  // ─── Keyboard shortcut: Alt+A ─────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'a') { e.preventDefault(); toggleSidebar(); }
  });

  // ─── Auto-restore ─────────────────────────────────────────
  chrome.storage.local.get(['sidebarOpen', 'activeMode'], (result) => {
    if (result.sidebarOpen) openSidebar();
  });

  // ─── On Meet: auto-open on Social Cue when call starts ────
  if (IS_MEET) {
    const meetObserver = new MutationObserver(() => {
      const inCall = document.querySelector('[data-call-ended], [jsname="F57Jan"], [data-allocation-index]');
      if (inCall && !isOpen) {
        meetObserver.disconnect();
        setTimeout(() => {
          openSidebar();
          selectMode('social-cue');
        }, 1200);
      }
    });
    meetObserver.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => meetObserver.disconnect(), 30000);
  }

})();