// ============================================================
// AccessAI Unified Sidebar
// Right-side sidebar that pushes page content (never overlaps)
// Glass morphism sliding tab switcher at top
// ============================================================

(function () {
  'use strict';

  // Prevent double-init
  if (window.__accessai_sidebar_init) return;
  window.__accessai_sidebar_init = true;

  const SIDEBAR_WIDTH = 370;
  let sidebarEl = null;
  let isOpen = false;
  let currentMode = null;

  // ------- Build Sidebar Shell -------
  function createSidebar() {
    if (sidebarEl) return;

    sidebarEl = document.createElement('div');
    sidebarEl.id = 'accessai-sidebar';
    sidebarEl.setAttribute('role', 'complementary');
    sidebarEl.setAttribute('aria-label', 'AccessAI Sidebar');

    sidebarEl.innerHTML = `
      <div class="aai-sb-inner">
        <!-- Header -->
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

        <!-- Glass Slider Switcher -->
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

        <!-- Content Panes (each mode renders here) -->
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

        <!-- Footer Status -->
        <div class="aai-sb-footer" id="aai-sb-footer">
          <span class="aai-sb-footer-dot" id="aai-sb-footer-dot"></span>
          <span id="aai-sb-footer-text">Click a mode to begin</span>
        </div>
      </div>
    `;

    document.body.appendChild(sidebarEl);

    // Close button
    document.getElementById('aai-sb-close').addEventListener('click', closeSidebar);

    // Tab clicks
    sidebarEl.querySelectorAll('.aai-sb-slider-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const mode = tab.dataset.mode;
        selectMode(mode);
      });
    });
  }

  // ------- Open / Close (pushes page content) -------
  function openSidebar() {
    if (!sidebarEl) createSidebar();
    isOpen = true;
    sidebarEl.classList.add('aai-sb-open');

    // Push page content to the left
    document.documentElement.style.marginRight = SIDEBAR_WIDTH + 'px';
    document.documentElement.style.transition = 'margin-right 0.35s cubic-bezier(0.4, 0, 0.2, 1)';
    document.documentElement.style.overflow = 'auto';

    chrome.storage.local.set({ sidebarOpen: true });

    // Restore last mode
    chrome.storage.local.get('activeMode', (result) => {
      if (result.activeMode) {
        selectMode(result.activeMode);
      }
    });
  }

  function closeSidebar() {
    if (!sidebarEl) return;
    isOpen = false;
    sidebarEl.classList.remove('aai-sb-open');
    document.documentElement.style.marginRight = '0px';
    chrome.storage.local.set({ sidebarOpen: false });
  }

  function toggleSidebar() {
    if (isOpen) closeSidebar();
    else openSidebar();
  }

  // ------- Mode Selection with Glass Slider -------
  function selectMode(mode) {
    if (currentMode === mode) return;
    currentMode = mode;

    // Update tabs
    const tabs = sidebarEl.querySelectorAll('.aai-sb-slider-tab');
    const glass = document.getElementById('aai-sb-glass');
    let targetIndex = 0;

    tabs.forEach((tab, i) => {
      const isActive = tab.dataset.mode === mode;
      tab.setAttribute('aria-selected', isActive.toString());
      tab.classList.toggle('aai-sb-slider-tab-active', isActive);
      if (isActive) targetIndex = i;
    });

    // Slide the glass tile
    const trackWidth = tabs[0]?.parentElement?.offsetWidth || 0;
    const tabWidth = trackWidth / tabs.length;
    glass.style.width = tabWidth + 'px';
    glass.style.transform = `translateX(${targetIndex * tabWidth}px)`;

    // Switch panes
    sidebarEl.querySelectorAll('.aai-sb-pane').forEach(pane => {
      pane.style.display = 'none';
    });
    const activePane = document.getElementById(`aai-pane-${mode}`);
    if (activePane) activePane.style.display = 'flex';

    // Update footer
    const dot = document.getElementById('aai-sb-footer-dot');
    dot.className = 'aai-sb-footer-dot aai-sb-footer-dot-active';

    // Notify background + other scripts
    chrome.runtime.sendMessage({ type: 'SET_MODE', mode });

    // Dispatch custom event for the mode-specific scripts
    window.dispatchEvent(new CustomEvent('accessai-mode-changed', { detail: { mode } }));
  }

  // ------- Expose to other content scripts -------
  window.__accessai = {
    getSidebarPane: (mode) => document.getElementById(`aai-pane-${mode}`),
    setFooterStatus: (text) => {
      const el = document.getElementById('aai-sb-footer-text');
      if (el) el.textContent = text;
    },
    getCurrentMode: () => currentMode,
    isSidebarOpen: () => isOpen,
    openSidebar,
    closeSidebar
  };

  // ------- Listen for toggle from background -------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'TOGGLE_SIDEBAR') {
      toggleSidebar();
      sendResponse({ ok: true });
    }
    if (message.type === 'MODE_CHANGED' && message.mode && isOpen) {
      selectMode(message.mode);
    }
  });

  // ------- Keyboard shortcut: Alt+A toggles sidebar -------
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'a') {
      e.preventDefault();
      toggleSidebar();
    }
  });

  // ------- Auto-restore sidebar state after navigation -------
  chrome.storage.local.get(['sidebarOpen', 'activeMode'], (result) => {
    if (result.sidebarOpen) {
      openSidebar();
    }
  });

})();
