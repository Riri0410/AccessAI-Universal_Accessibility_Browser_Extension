// ============================================================
// AccessAI Unified Sidebar v2
// - Right-side sidebar that PUSHES page content (never overlaps)
// - On meet.google.com: directly nudges Meet's video grid
//   so the sidebar sits beside it, not on top of it
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
  // Google Meet uses a specific container for the video grid.
  // We inject a CSS override that reduces its right-margin to
  // make room for the sidebar, rather than overlapping it.
  let meetStyleEl = null;

  function pushMeetLayout(open) {
    if (!IS_MEET) return;

    if (!meetStyleEl) {
      meetStyleEl = document.createElement('style');
      meetStyleEl.id = 'accessai-meet-layout';
      document.head.appendChild(meetStyleEl);
    }

    if (open) {
      // Meet's main video container. These selectors target the
      // known Meet DOM structure as of 2024–2025.
      // We use multiple selectors to be robust against Meet updates.
      meetStyleEl.textContent = `
        /* Shrink the main content area so sidebar sits beside, not over it */
        body[data-accessai-open] {
          overflow: hidden !important;
        }

        /* Meet's root layout wrapper */
        body[data-accessai-open] c-wiz,
        body[data-accessai-open] [jscontroller][data-use-native-client-navigation],
        body[data-accessai-open] [jscontroller][jsaction*="rcuQ6b"] {
          width: calc(100vw - ${SIDEBAR_WIDTH}px) !important;
          max-width: calc(100vw - ${SIDEBAR_WIDTH}px) !important;
          transition: width 0.35s cubic-bezier(0.4, 0, 0.2, 1),
                      max-width 0.35s cubic-bezier(0.4, 0, 0.2, 1);
        }

        /* Meet's inner video grid / stage */
        body[data-accessai-open] [data-allocation-index],
        body[data-accessai-open] [jsname="F57Jan"],
        body[data-accessai-open] [jsname="HlFzId"] {
          max-width: calc(100vw - ${SIDEBAR_WIDTH}px) !important;
        }

        /* Bottom controls bar — keep centred relative to the narrowed space */
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

  // For non-Meet pages, push with margin-right on <html>
  function pushGenericLayout(open) {
    if (IS_MEET) return;
    const el = document.documentElement;
    if (open) {
      el.style.marginRight = SIDEBAR_WIDTH + 'px';
      el.style.transition = 'margin-right 0.35s cubic-bezier(0.4, 0, 0.2, 1)';
      el.style.overflow = 'auto';
    } else {
      el.style.marginRight = '0px';
    }
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
    chrome.storage.local.get('activeMode', (r) => { if (r.activeMode) selectMode(r.activeMode); });
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
    // Watch for Meet's call UI to appear (the video grid loads after a delay)
    const meetObserver = new MutationObserver(() => {
      const inCall = document.querySelector('[data-call-ended], [jsname="F57Jan"], [data-allocation-index]');
      if (inCall && !isOpen) {
        meetObserver.disconnect();
        // Auto-open on Social Cue tab when a call is detected
        setTimeout(() => {
          openSidebar();
          selectMode('social-cue');
        }, 1200);
      }
    });
    meetObserver.observe(document.body, { childList: true, subtree: true });

    // Stop observing after 30s to avoid ongoing overhead
    setTimeout(() => meetObserver.disconnect(), 30000);
  }

})();
