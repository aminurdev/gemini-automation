/**
 * Gemini Bulk Image Generator - Content Script
 * Automates multi-prompt image generation on gemini.google.com
 */

(function () {
  'use strict';

  // Prevent multiple injections
  if (window.__GBI_INJECTED__) return;
  window.__GBI_INJECTED__ = true;

  // State Management
  const state = {
    prompts: [],
    currentIndex: 0,
    isRunning: false,
    isPaused: false,
    isPanelOpen: true,
    position: 'top-right', // 'top-right' or 'bottom-right'
    cooldownDelay: 8,      // seconds to wait after generation completes
    maxTimeout: 120,       // maximum seconds to wait per prompt
    autoScroll: true,
    addPrefix: true,
    prefixText: 'Generate an image of: ',
    queueStatus: []        // Array of 'pending' | 'running' | 'done' | 'error'
  };

  let executionAbortController = null;

  // ==========================================
  // Storage Helpers
  // ==========================================
  function loadSavedState() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['gbi_prompts', 'gbi_config', 'gbi_position'], (res) => {
        if (res.gbi_prompts && typeof res.gbi_prompts === 'string') {
          const textarea = document.getElementById('gbi-prompts-input');
          if (textarea && !textarea.value) {
            textarea.value = res.gbi_prompts;
            updatePromptCount();
          }
        }
        if (res.gbi_config) {
          if (res.gbi_config.cooldownDelay !== undefined) {
            state.cooldownDelay = res.gbi_config.cooldownDelay;
            const input = document.getElementById('gbi-delay-input');
            if (input) input.value = state.cooldownDelay;
          }
          if (res.gbi_config.addPrefix !== undefined) {
            state.addPrefix = res.gbi_config.addPrefix;
            const cb = document.getElementById('gbi-prefix-cb');
            if (cb) cb.checked = state.addPrefix;
          }
          if (res.gbi_config.prefixText !== undefined) {
            state.prefixText = res.gbi_config.prefixText;
            const input = document.getElementById('gbi-prefix-input');
            if (input) input.value = state.prefixText;
          }
          if (res.gbi_config.autoScroll !== undefined) {
            state.autoScroll = res.gbi_config.autoScroll;
            const cb = document.getElementById('gbi-autoscroll-cb');
            if (cb) cb.checked = state.autoScroll;
          }
        }
        if (res.gbi_position) {
          setPosition(res.gbi_position);
        }
      });
    }
  }

  function savePromptsToStorage() {
    const textarea = document.getElementById('gbi-prompts-input');
    if (textarea && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ gbi_prompts: textarea.value });
    }
  }

  function saveConfigToStorage() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({
        gbi_config: {
          cooldownDelay: state.cooldownDelay,
          addPrefix: state.addPrefix,
          prefixText: state.prefixText,
          autoScroll: state.autoScroll
        },
        gbi_position: state.position
      });
    }
  }

  // ==========================================
  // DOM Selectors for Gemini
  // ==========================================
  function findEditorElement() {
    // Exact selectors from Gemini inspect structure
    return (
      document.querySelector('rich-textarea .ql-editor[contenteditable="true"]') ||
      document.querySelector('div.ql-editor.textarea[contenteditable="true"]') ||
      document.querySelector('div.ql-editor[role="textbox"]') ||
      document.querySelector('div[aria-label="Enter a prompt for Gemini"]') ||
      document.querySelector('rich-textarea div[contenteditable="true"]')
    );
  }

  function findSendButton() {
    // 1. Send button container check
    const container = document.querySelector('[data-test-id="send-button-container"]');
    if (container) {
      const btn = container.querySelector('button');
      if (btn && !btn.disabled && btn.getAttribute('aria-label')?.includes('Send')) {
        return btn;
      }
    }

    // 2. Button with aria-label
    const ariaBtn = document.querySelector('button[aria-label="Send message"]');
    if (ariaBtn && !ariaBtn.disabled) return ariaBtn;

    // 3. Button inside gem-icon-button submit
    const submitBtn = document.querySelector('.send-button button');
    if (submitBtn && !submitBtn.disabled) return submitBtn;

    return null;
  }

  function findStopButton() {
    return (
      document.querySelector('button[aria-label="Stop response"]') ||
      document.querySelector('button[aria-label="Stop"]') ||
      document.querySelector('[data-test-id="stop-button"]') ||
      document.querySelector('mat-icon[data-mat-icon-name="stop"]') ||
      document.querySelector('mat-icon[fonticon="stop"]')
    );
  }

  function isGeminiGenerating() {
    // If stop button exists, Gemini is actively generating
    if (findStopButton()) return true;

    // Check send button container: if it holds a stop button
    const container = document.querySelector('[data-test-id="send-button-container"]');
    if (container && container.querySelector('button[aria-label*="Stop"]')) {
      return true;
    }

    // Check for thinking / streaming animations
    if (document.querySelector('.sparkle-thinking, .loading-indicator, [data-test-id="loading-indicator"]')) {
      return true;
    }

    return false;
  }

  // ==========================================
  // Automation Core Actions
  // ==========================================
  async function injectPromptText(text) {
    const editor = findEditorElement();
    if (!editor) {
      throw new Error('Could not find Gemini prompt editor. Make sure chat is open.');
    }

    editor.focus();
    await delay(100);

    // Select existing contents
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (e) {
      console.warn('[GBI] Selection range error:', e);
    }

    // Attempt standard insertText command for Quill
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch (e) {
      inserted = false;
    }

    // Fallback if execCommand did not update the editor
    if (!inserted || !editor.innerText.trim()) {
      const sanitized = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      editor.innerHTML = `<p>${sanitized}</p>`;
    }

    // Dispatch input events so Quill delta and Angular form bindings trigger
    editor.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text
    }));

    await delay(350);
    return true;
  }

  async function submitPrompt() {
    const editor = findEditorElement();
    const sendBtn = findSendButton();

    if (sendBtn) {
      sendBtn.click();
      return true;
    }

    // Fallback: Simulate Enter keypress on the editor
    if (editor) {
      editor.focus();
      const enterDown = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      });
      editor.dispatchEvent(enterDown);

      const enterUp = new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      });
      editor.dispatchEvent(enterUp);
      return true;
    }

    throw new Error('Send button not available and Enter key did not trigger.');
  }

  async function waitForGenerationToComplete(signal) {
    // 1. Wait a moment for generation to initiate
    let waitedStart = 0;
    while (waitedStart < 4000) {
      if (signal?.aborted) return;
      if (isGeminiGenerating()) break;
      await delay(500);
      waitedStart += 500;
    }

    // 2. Poll until Gemini stops generating
    const startTime = Date.now();
    const maxMs = state.maxTimeout * 1000;

    while (true) {
      if (signal?.aborted) return;

      const elapsed = Date.now() - startTime;
      if (elapsed > maxMs) {
        console.warn('[GBI] Generation timeout exceeded.');
        break;
      }

      const generating = isGeminiGenerating();
      const sendBtn = findSendButton();

      // If stop button is gone and send button is back or editor is ready
      if (!generating && elapsed > 3000) {
        // Wait an extra tick to verify it is truly finished and not a brief pause
        await delay(1000);
        if (!isGeminiGenerating()) {
          break;
        }
      }

      // Update timer in status
      const secondsLeft = Math.max(0, Math.round((maxMs - elapsed) / 1000));
      updateStatus(`Generating response... (${Math.round(elapsed / 1000)}s elapsed)`, true);

      if (state.autoScroll) {
        scrollToChatBottom();
      }

      await delay(1000);
    }
  }

  function scrollToChatBottom() {
    const scrollers = [
      document.querySelector('chat-window'),
      document.querySelector('.conversation-container'),
      document.querySelector('main'),
      document.documentElement
    ];
    for (const scroller of scrollers) {
      if (scroller && scroller.scrollHeight > scroller.clientHeight) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    }
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ==========================================
  // Queue Execution Controller
  // ==========================================
  async function startQueue() {
    const rawPrompts = getPromptsFromInput();
    if (rawPrompts.length === 0) {
      alert('Please enter at least one prompt in the text area.');
      return;
    }

    state.prompts = rawPrompts;
    if (state.queueStatus.length !== state.prompts.length) {
      state.queueStatus = state.prompts.map(() => 'pending');
      state.currentIndex = 0;
    }

    state.isRunning = true;
    state.isPaused = false;
    updateUIState();
    renderQueueList();

    executionAbortController = new AbortController();
    const signal = executionAbortController.signal;

    try {
      for (let i = state.currentIndex; i < state.prompts.length; i++) {
        if (!state.isRunning) break;

        // Handle pause
        while (state.isPaused) {
          if (!state.isRunning) break;
          updateStatus(`Paused at prompt ${i + 1} of ${state.prompts.length}. Click Resume to continue.`);
          await delay(500);
        }

        if (!state.isRunning) break;

        state.currentIndex = i;
        state.queueStatus[i] = 'running';
        renderQueueList();
        updateProgress();

        let promptText = state.prompts[i].trim();
        if (state.addPrefix && state.prefixText) {
          promptText = `${state.prefixText.trim()} ${promptText}`;
        }

        updateStatus(`[${i + 1}/${state.prompts.length}] Submitting prompt: "${promptText.slice(0, 45)}..."`, true);

        try {
          // 1. Inject Prompt
          await injectPromptText(promptText);
          await delay(400);

          // 2. Submit
          await submitPrompt();
          await delay(1500);

          // 3. Wait for generation to complete
          await waitForGenerationToComplete(signal);

          state.queueStatus[i] = 'done';
          renderQueueList();

          // 4. Cooldown delay before next prompt
          if (i < state.prompts.length - 1 && state.isRunning) {
            let remaining = state.cooldownDelay;
            while (remaining > 0 && state.isRunning && !state.isPaused) {
              updateStatus(`Waiting ${remaining}s cooldown before next prompt...`);
              await delay(1000);
              remaining--;
            }
          }
        } catch (err) {
          console.error('[GBI] Error processing prompt:', err);
          state.queueStatus[i] = 'error';
          renderQueueList();
          updateStatus(`Error on prompt ${i + 1}: ${err.message}. Continuing...`);
          await delay(3000);
        }
      }

      if (state.isRunning && state.currentIndex >= state.prompts.length - 1) {
        state.isRunning = false;
        state.isPaused = false;
        updateStatus(`🎉 All ${state.prompts.length} prompts completed successfully!`);
        updateProgress();
        renderQueueList();
        updateUIState();
        playFinishChime();
      }
    } catch (e) {
      console.error('[GBI] Execution aborted or failed:', e);
      state.isRunning = false;
      updateUIState();
    }
  }

  function pauseQueue() {
    state.isPaused = !state.isPaused;
    updateUIState();
    updateStatus(state.isPaused ? '⏸️ Execution paused' : '▶️ Resuming execution...');
  }

  function stopQueue() {
    state.isRunning = false;
    state.isPaused = false;
    if (executionAbortController) {
      executionAbortController.abort();
    }
    updateUIState();
    updateStatus('⏹️ Execution stopped');
  }

  function clearAll() {
    if (state.isRunning) {
      stopQueue();
    }
    const input = document.getElementById('gbi-prompts-input');
    if (input) input.value = '';
    state.prompts = [];
    state.queueStatus = [];
    state.currentIndex = 0;
    savePromptsToStorage();
    updatePromptCount();
    updateProgress();
    renderQueueList();
    updateStatus('Ready');
  }

  function playFinishChime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.15); // A5
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    } catch (e) {
      // Audio might be blocked by browser policy without user interaction
    }
  }

  // ==========================================
  // Floating UI Builder
  // ==========================================
  function createUI() {
    if (document.getElementById('gbi-main-panel')) return;

    // 1. Floating Launcher Pill (shows when minimized)
    const pill = document.createElement('div');
    pill.id = 'gbi-floating-pill';
    pill.style.display = 'none';
    pill.innerHTML = `
      <span class="gbi-pill-icon">✨</span>
      <span>Gemini Bulk Image</span>
      <span class="gbi-pill-badge" id="gbi-pill-count">0</span>
    `;
    pill.addEventListener('click', togglePanel);
    document.body.appendChild(pill);

    // 2. Main Floating Panel
    const panel = document.createElement('div');
    panel.id = 'gbi-main-panel';
    panel.innerHTML = `
      <!-- Header -->
      <div class="gbi-header" id="gbi-header-drag">
        <div class="gbi-header-left">
          <span style="font-size:16px;">✨</span>
          <span class="gbi-title">Bulk Image Automator</span>
          <span class="gbi-status-chip status-idle" id="gbi-status-chip">Idle</span>
        </div>
        <div class="gbi-header-actions">
          <button class="gbi-icon-btn" id="gbi-pos-btn" title="Toggle Position (Top-Right / Bottom-Right)">↕️</button>
          <button class="gbi-icon-btn" id="gbi-min-btn" title="Minimize Panel">_</button>
        </div>
      </div>

      <!-- Body -->
      <div class="gbi-body">
        <!-- Input Section -->
        <div>
          <div class="gbi-label-row">
            <span class="gbi-label">Prompts (One Per Line)</span>
            <span class="gbi-count-badge" id="gbi-count-badge">0 Prompts</span>
          </div>
          <div class="gbi-textarea-wrap">
            <textarea
              class="gbi-textarea"
              id="gbi-prompts-input"
              placeholder="Enter your image prompts here, one per line...&#10;e.g.:&#10;Majestic lion with glowing crystal armor&#10;Cozy cyberpunk coffee shop in rainy Tokyo&#10;Vintage 1960s sports car speeding on Mars"
            ></textarea>
          </div>
        </div>

        <!-- Options Group -->
        <div class="gbi-config-group">
          <!-- Prefix toggle -->
          <div class="gbi-config-row">
            <label>
              <input type="checkbox" class="gbi-checkbox" id="gbi-prefix-cb" checked>
              <span>Auto-prepend image prompt prefix</span>
            </label>
          </div>
          <input
            type="text"
            class="gbi-text-input"
            id="gbi-prefix-input"
            value="Generate an image of: "
            placeholder="e.g. Generate an image of: "
          >

          <!-- Delay Setting -->
          <div class="gbi-config-row" style="margin-top: 4px;">
            <label title="Safety delay after Gemini finishes before sending next prompt">
              <span>Wait between prompts:</span>
            </label>
            <div style="display:flex; align-items:center; gap:4px;">
              <input type="number" class="gbi-number-input" id="gbi-delay-input" min="3" max="60" value="8">
              <span style="color:var(--gbi-text-muted); font-size:11.5px;">sec</span>
            </div>
          </div>

          <!-- Auto-scroll -->
          <div class="gbi-config-row">
            <label>
              <input type="checkbox" class="gbi-checkbox" id="gbi-autoscroll-cb" checked>
              <span>Auto-scroll to view new images</span>
            </label>
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="gbi-btn-grid">
          <button class="gbi-btn gbi-btn-primary" id="gbi-start-btn">
            <span>🚀 Start Generation</span>
          </button>
          <button class="gbi-btn gbi-btn-stop" id="gbi-stop-btn" disabled>
            <span>⏹️ Stop</span>
          </button>
          <button class="gbi-btn gbi-btn-clear" id="gbi-clear-btn">
            <span>🗑️ Clear</span>
          </button>
        </div>

        <!-- Progress Card -->
        <div class="gbi-progress-card">
          <div class="gbi-progress-header">
            <span id="gbi-progress-label">Progress: 0 / 0</span>
            <span id="gbi-progress-percent">0%</span>
          </div>
          <div class="gbi-progress-track">
            <div class="gbi-progress-bar" id="gbi-progress-bar"></div>
          </div>
          <div class="gbi-status-msg" id="gbi-status-msg">
            <span>Ready. Add prompts and click Start.</span>
          </div>
        </div>

        <!-- Prompt Queue Drawer -->
        <div class="gbi-queue-wrap">
          <div class="gbi-queue-header" id="gbi-queue-toggle">
            <span>QUEUE PREVIEW</span>
            <span id="gbi-queue-arrow">▼</span>
          </div>
          <div class="gbi-queue-list" id="gbi-queue-list">
            <!-- Dynamic Items -->
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    bindUIEvents();
    loadSavedState();
  }

  function bindUIEvents() {
    const input = document.getElementById('gbi-prompts-input');
    const startBtn = document.getElementById('gbi-start-btn');
    const stopBtn = document.getElementById('gbi-stop-btn');
    const clearBtn = document.getElementById('gbi-clear-btn');
    const minBtn = document.getElementById('gbi-min-btn');
    const posBtn = document.getElementById('gbi-pos-btn');
    const prefixCb = document.getElementById('gbi-prefix-cb');
    const prefixInput = document.getElementById('gbi-prefix-input');
    const delayInput = document.getElementById('gbi-delay-input');
    const autoScrollCb = document.getElementById('gbi-autoscroll-cb');
    const queueToggle = document.getElementById('gbi-queue-toggle');

    // Input changes
    if (input) {
      input.addEventListener('input', () => {
        updatePromptCount();
        savePromptsToStorage();
        if (!state.isRunning) {
          state.prompts = getPromptsFromInput();
          state.queueStatus = state.prompts.map(() => 'pending');
          state.currentIndex = 0;
          renderQueueList();
          updateProgress();
        }
      });
    }

    // Config inputs
    if (prefixCb) {
      prefixCb.addEventListener('change', (e) => {
        state.addPrefix = e.target.checked;
        if (prefixInput) prefixInput.style.display = state.addPrefix ? 'block' : 'none';
        saveConfigToStorage();
      });
    }

    if (prefixInput) {
      prefixInput.addEventListener('input', (e) => {
        state.prefixText = e.target.value;
        saveConfigToStorage();
      });
    }

    if (delayInput) {
      delayInput.addEventListener('change', (e) => {
        const val = parseInt(e.target.value, 10);
        state.cooldownDelay = isNaN(val) ? 8 : Math.max(2, val);
        e.target.value = state.cooldownDelay;
        saveConfigToStorage();
      });
    }

    if (autoScrollCb) {
      autoScrollCb.addEventListener('change', (e) => {
        state.autoScroll = e.target.checked;
        saveConfigToStorage();
      });
    }

    // Buttons
    if (startBtn) {
      startBtn.addEventListener('click', () => {
        if (!state.isRunning) {
          startQueue();
        } else {
          pauseQueue();
        }
      });
    }

    if (stopBtn) {
      stopBtn.addEventListener('click', stopQueue);
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', clearAll);
    }

    if (minBtn) {
      minBtn.addEventListener('click', togglePanel);
    }

    if (posBtn) {
      posBtn.addEventListener('click', () => {
        const nextPos = state.position === 'top-right' ? 'bottom-right' : 'top-right';
        setPosition(nextPos);
        saveConfigToStorage();
      });
    }

    if (queueToggle) {
      queueToggle.addEventListener('click', () => {
        const list = document.getElementById('gbi-queue-list');
        const arrow = document.getElementById('gbi-queue-arrow');
        if (list) {
          const isHidden = list.style.display === 'none';
          list.style.display = isHidden ? 'flex' : 'none';
          if (arrow) arrow.textContent = isHidden ? '▼' : '▶';
        }
      });
    }

    // Make header draggable
    setupDraggable();
  }

  function setPosition(pos) {
    state.position = pos;
    const panel = document.getElementById('gbi-main-panel');
    const pill = document.getElementById('gbi-floating-pill');

    if (pos === 'bottom-right') {
      if (panel) {
        panel.classList.add('gbi-panel-bottom');
        panel.style.top = 'auto';
        panel.style.bottom = '24px';
      }
      if (pill) {
        pill.classList.add('gbi-pill-bottom');
        pill.style.top = 'auto';
        pill.style.bottom = '24px';
      }
    } else {
      if (panel) {
        panel.classList.remove('gbi-panel-bottom');
        panel.style.bottom = 'auto';
        panel.style.top = '16px';
      }
      if (pill) {
        pill.classList.remove('gbi-pill-bottom');
        pill.style.bottom = 'auto';
        pill.style.top = '16px';
      }
    }
  }

  function togglePanel() {
    state.isPanelOpen = !state.isPanelOpen;
    const panel = document.getElementById('gbi-main-panel');
    const pill = document.getElementById('gbi-floating-pill');

    if (panel && pill) {
      if (state.isPanelOpen) {
        panel.classList.remove('gbi-hidden');
        pill.style.display = 'none';
      } else {
        panel.classList.add('gbi-hidden');
        pill.style.display = 'flex';
      }
    }
  }

  function setupDraggable() {
    const header = document.getElementById('gbi-header-drag');
    const panel = document.getElementById('gbi-main-panel');
    if (!header || !panel) return;

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return; // ignore button clicks
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = panel.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = `${initialLeft}px`;
      panel.style.top = `${initialTop}px`;

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
    });

    function onMouseMove(e) {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      panel.style.left = `${Math.max(10, Math.min(window.innerWidth - panel.offsetWidth - 10, initialLeft + dx))}px`;
      panel.style.top = `${Math.max(10, Math.min(window.innerHeight - panel.offsetHeight - 10, initialTop + dy))}px`;
    }

    function onMouseUp() {
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }
  }

  // ==========================================
  // UI Update Helpers
  // ==========================================
  function getPromptsFromInput() {
    const textarea = document.getElementById('gbi-prompts-input');
    if (!textarea) return [];
    return textarea.value
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }

  function updatePromptCount() {
    const prompts = getPromptsFromInput();
    const countBadge = document.getElementById('gbi-count-badge');
    const pillBadge = document.getElementById('gbi-pill-count');
    const label = `${prompts.length} ${prompts.length === 1 ? 'Prompt' : 'Prompts'}`;

    if (countBadge) countBadge.textContent = label;
    if (pillBadge) pillBadge.textContent = prompts.length;
  }

  function updateStatus(text, isSpinning = false) {
    const msg = document.getElementById('gbi-status-msg');
    if (msg) {
      if (isSpinning) {
        msg.innerHTML = `<span class="gbi-status-spinner"></span><span>${escapeHtml(text)}</span>`;
      } else {
        msg.innerHTML = `<span>${escapeHtml(text)}</span>`;
      }
    }
  }

  function updateProgress() {
    const total = state.prompts.length;
    const completed = state.queueStatus.filter((s) => s === 'done').length;
    const current = Math.min(total, state.currentIndex + 1);

    const progressLabel = document.getElementById('gbi-progress-label');
    const progressPercent = document.getElementById('gbi-progress-percent');
    const progressBar = document.getElementById('gbi-progress-bar');

    const pct = total === 0 ? 0 : Math.round((completed / total) * 100);

    if (progressLabel) {
      progressLabel.textContent = `Progress: ${completed} / ${total} completed`;
    }
    if (progressPercent) {
      progressPercent.textContent = `${pct}%`;
    }
    if (progressBar) {
      progressBar.style.width = `${pct}%`;
    }
  }

  function updateUIState() {
    const startBtn = document.getElementById('gbi-start-btn');
    const stopBtn = document.getElementById('gbi-stop-btn');
    const statusChip = document.getElementById('gbi-status-chip');
    const pill = document.getElementById('gbi-floating-pill');

    if (state.isRunning) {
      if (pill) pill.classList.add('gbi-active-pill');
      if (stopBtn) stopBtn.disabled = false;

      if (state.isPaused) {
        if (startBtn) {
          startBtn.innerHTML = '<span>▶️ Resume</span>';
          startBtn.className = 'gbi-btn gbi-btn-primary';
        }
        if (statusChip) {
          statusChip.textContent = 'Paused';
          statusChip.className = 'gbi-status-chip status-paused';
        }
      } else {
        if (startBtn) {
          startBtn.innerHTML = '<span>⏸️ Pause</span>';
          startBtn.className = 'gbi-btn gbi-btn-pause';
        }
        if (statusChip) {
          statusChip.textContent = 'Running';
          statusChip.className = 'gbi-status-chip status-running';
        }
      }
    } else {
      if (pill) pill.classList.remove('gbi-active-pill');
      if (stopBtn) stopBtn.disabled = true;
      if (startBtn) {
        startBtn.innerHTML = '<span>🚀 Start Generation</span>';
        startBtn.className = 'gbi-btn gbi-btn-primary';
      }
      if (statusChip) {
        const allDone = state.prompts.length > 0 && state.queueStatus.every((s) => s === 'done');
        if (allDone) {
          statusChip.textContent = 'Completed';
          statusChip.className = 'gbi-status-chip status-completed';
        } else {
          statusChip.textContent = 'Idle';
          statusChip.className = 'gbi-status-chip status-idle';
        }
      }
    }
  }

  function renderQueueList() {
    const container = document.getElementById('gbi-queue-list');
    if (!container) return;

    if (state.prompts.length === 0) {
      container.innerHTML = `<div style="color:var(--gbi-text-muted); font-size:11.5px; padding:6px 0;">No prompts in queue.</div>`;
      return;
    }

    let html = '';
    state.prompts.forEach((prompt, idx) => {
      const status = state.queueStatus[idx] || 'pending';
      let icon = '⏳';
      let itemClass = '';

      if (status === 'running') {
        icon = '🔄';
        itemClass = 'gbi-item-active';
      } else if (status === 'done') {
        icon = '✅';
        itemClass = 'gbi-item-done';
      } else if (status === 'error') {
        icon = '⚠️';
        itemClass = 'gbi-item-error';
      }

      html += `
        <div class="gbi-queue-item ${itemClass}">
          <span style="font-weight:600; color:var(--gbi-text-muted); font-size:10.5px; width:16px;">#${idx + 1}</span>
          <span class="gbi-queue-text" title="${escapeHtml(prompt)}">${escapeHtml(prompt)}</span>
          <span class="gbi-queue-badge">${icon}</span>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ==========================================
  // Initialize
  // ==========================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createUI);
  } else {
    createUI();
  }

  // Fallback observer to ensure UI remains attached during client-side routing
  setInterval(() => {
    if (!document.getElementById('gbi-main-panel')) {
      createUI();
    }
  }, 3000);

})();
