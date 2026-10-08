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
    theme: 'dark',         // 'dark' or 'light'
    clickImagesOption: true, // click "Images" in side nav before each prompt
    cooldownDelay: 8,      // seconds to wait after generation completes
    maxTimeout: 120,       // maximum seconds to wait per prompt
    autoScroll: true,
    autoDownload: true,    // auto-download generated images
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
      chrome.storage.local.get(['gbi_prompts', 'gbi_config', 'gbi_position', 'gbi_theme'], (res) => {
        if (res.gbi_prompts && typeof res.gbi_prompts === 'string') {
          const textarea = document.getElementById('gbi-prompts-input');
          if (textarea && !textarea.value) {
            textarea.value = res.gbi_prompts;
            updatePromptCount();
            updateLineNumbers();
          }
        }
        if (res.gbi_config) {
          if (res.gbi_config.clickImagesOption !== undefined) {
            state.clickImagesOption = res.gbi_config.clickImagesOption;
            const cb = document.getElementById('gbi-click-images-cb');
            if (cb) cb.checked = state.clickImagesOption;
          }
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
          if (res.gbi_config.autoDownload !== undefined) {
            state.autoDownload = res.gbi_config.autoDownload;
            const cb = document.getElementById('gbi-autodownload-cb');
            if (cb) cb.checked = state.autoDownload;
          }
        }
        if (res.gbi_position) {
          setPosition(res.gbi_position);
        }
        if (res.gbi_theme) {
          setTheme(res.gbi_theme);
        } else {
          // Auto-detect based on Gemini UI class or system preference
          const isGeminiLight =
            document.body.classList.contains('lm-enabled') ||
            document.documentElement.classList.contains('lm-enabled') ||
            document.querySelector('.lm-enabled') !== null ||
            (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
          setTheme(isGeminiLight ? 'light' : 'dark');
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
          clickImagesOption: state.clickImagesOption,
          cooldownDelay: state.cooldownDelay,
          addPrefix: state.addPrefix,
          prefixText: state.prefixText,
          autoScroll: state.autoScroll,
          autoDownload: state.autoDownload
        },
        gbi_position: state.position
      });
    }
  }

  // ==========================================
  // DOM Selectors for Gemini
  // ==========================================
  function findEditorElement() {
    // Exact selectors from Gemini inspect structure & Imagen workspace
    return (
      document.querySelector('rich-textarea .ql-editor[contenteditable="true"]') ||
      document.querySelector('div.ql-editor.textarea[contenteditable="true"]') ||
      document.querySelector('div.ql-editor[role="textbox"]') ||
      document.querySelector('div[aria-label="Enter a prompt for Gemini"]') ||
      document.querySelector('div[aria-label*="prompt" i][contenteditable="true"]') ||
      document.querySelector('div[aria-label*="Describe" i][contenteditable="true"]') ||
      document.querySelector('rich-textarea div[contenteditable="true"]') ||
      document.querySelector('textarea[aria-label*="prompt" i]') ||
      document.querySelector('textarea.ql-editor') ||
      document.querySelector('.input-area textarea') ||
      document.querySelector('.input-area [contenteditable="true"]')
    );
  }

  function findSendButton() {
    // 1. Send button container check
    const container = document.querySelector('[data-test-id="send-button-container"]');
    if (container) {
      const btn = container.querySelector('button');
      if (btn && !btn.disabled) {
        return btn;
      }
    }

    // 2. Button with aria-label / data-test-id
    const ariaSelectors = [
      'button[aria-label="Send message"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Generate" i]',
      'button[aria-label*="Create" i]',
      'button[data-test-id="send-button"]',
      'button[data-test-id="generate-button"]'
    ];
    for (const sel of ariaSelectors) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled) return btn;
    }

    // 3. Button inside gem-icon-button submit
    const submitBtn = document.querySelector('.send-button button');
    if (submitBtn && !submitBtn.disabled) return submitBtn;

    return null;
  }

  // ==========================================
  // Images Workspace Navigation
  // ==========================================
  function findImagesNavButton() {
    // 1. Direct data-test-id on nav item (exact match from Gemini side nav inspection)
    const testIdItem = document.querySelector('[data-test-id="images-side-nav-entry-button"]');
    if (testIdItem) {
      const anchor = testIdItem.querySelector('a') || testIdItem;
      return anchor;
    }

    // 2. Anchor with href="/images"
    const hrefAnchor = document.querySelector('a[href="/images"], a[href$="/images"], a[href*="/images"]');
    if (hrefAnchor) return hrefAnchor;

    // 3. Elements with aria-label="Images"
    const ariaEl = document.querySelector('a[aria-label="Images"], button[aria-label="Images"], [aria-label="Images"]');
    if (ariaEl) return ariaEl;

    // 4. mat-icon with data-mat-icon-name="image_create" or fonticon="image_create"
    const icon = document.querySelector('mat-icon[data-mat-icon-name="image_create"], mat-icon[fonticon="image_create"]');
    if (icon) {
      const parent = icon.closest('a') || icon.closest('[data-test-id="images-side-nav-entry-button"]') || icon.closest('button');
      if (parent) return parent;
    }

    // 5. Look in side navigation lists for item with "Images" text
    const sideNavLinks = document.querySelectorAll(
      'mat-nav-list a, gem-sidenav-list a, .gds-sidenav-list a, gem-nav-list-item a, nav a'
    );
    for (const el of sideNavLinks) {
      const text = (el.textContent || '').trim();
      if (text === 'Images' || text.startsWith('Images\n') || el.getAttribute('aria-label') === 'Images') {
        return el;
      }
    }

    return null;
  }

  async function clickImagesOption(signal) {
    if (signal?.aborted) return false;

    updateStatus('Opening "Images" workspace...', true);

    let btn = findImagesNavButton();

    // If button is not immediately found, sidebar might be collapsed
    if (!btn) {
      const menuToggle = document.querySelector(
        'button[aria-label="Main menu"], button[aria-label="Expand menu"], [data-test-id="side-nav-menu-button"], button[aria-label*="menu" i]'
      );
      if (menuToggle) {
        console.log('[GBI] Side menu collapsed, clicking menu toggle...');
        menuToggle.click();
        await delay(500);
        btn = findImagesNavButton();
      }
    }

    if (!btn) {
      console.warn('[GBI] Images nav entry not found in DOM.');
      // Fallback: If not already on /images, navigate to /images
      if (!window.location.pathname.includes('/images')) {
        console.log('[GBI] Navigating to /images via location.href fallback...');
        window.location.href = 'https://gemini.google.com/images';
      }
      return false;
    }

    console.log('[GBI] Found Images nav entry, triggering click...', btn);

    // Scroll into view
    try {
      btn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {}
    await delay(120);

    // Dispatch full pointer and mouse event sequence for Angular router
    const clickTarget = btn.tagName && btn.tagName.toLowerCase() === 'a' ? btn : (btn.querySelector('a') || btn);
    clickTarget.focus();
    clickTarget.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    clickTarget.click();
    clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    clickTarget.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    clickTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));

    // Also dispatch on parent if different
    if (btn !== clickTarget) {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }

    await delay(800);
    return true;
  }

  async function waitForEditorReady(signal, maxWaitMs = 15000) {
    const startTime = Date.now();
    updateStatus('Waiting for "Images" workspace to be ready...', true);

    // Initial wait for Angular router and DOM transition
    await delay(1200);

    while (Date.now() - startTime < maxWaitMs) {
      if (signal?.aborted) return false;

      if (!isGeminiGenerating()) {
        const editor = findEditorElement();
        if (editor) {
          try {
            editor.focus();
            await delay(300);
            return true;
          } catch (e) {}
        }
      }

      await delay(400);
    }

    console.warn('[GBI] Editor ready wait timed out, proceeding.');
    return false;
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
  // Image Download Automation
  // ==========================================
  function findDownloadButtons(onlyNew = false) {
    const matched = new Set();

    // 1. Angular component tag: <download-generated-image-button>
    document.querySelectorAll('download-generated-image-button').forEach((comp) => {
      const btn = comp.querySelector('button') || comp;
      matched.add(btn);
    });

    // 2. data-test-id="download-generated-image-button"
    document.querySelectorAll('[data-test-id="download-generated-image-button"]').forEach((el) => {
      const btn = el.tagName && el.tagName.toLowerCase() === 'button' ? el : el.querySelector('button');
      if (btn) matched.add(btn);
      else matched.add(el);
    });

    // 3. aria-label and tooltips matching download
    const ariaSelectors = [
      'button[aria-label="Download full-sized image"]',
      'button[aria-label*="Download full-sized"]',
      'button[aria-label*="Download full size"]',
      'button[aria-label*="Download image"]',
      'gem-icon-button[arialabel="Download full-sized image"] button',
      'gem-icon-button[gemtooltip="Download full size"] button',
      'gem-icon-button[gemtooltip*="Download"] button'
    ];
    for (const sel of ariaSelectors) {
      document.querySelectorAll(sel).forEach((btn) => matched.add(btn));
    }

    // 4. mat-icon with download icon
    document.querySelectorAll('mat-icon[data-mat-icon-name="download"], mat-icon[fonticon="download"]').forEach((icon) => {
      const btn = icon.closest('button');
      if (btn) matched.add(btn);
    });

    const list = Array.from(matched);

    if (onlyNew) {
      return list.filter((btn) => {
        const parentComp = btn.closest('download-generated-image-button');
        const isDownloaded =
          btn.getAttribute('data-gbi-downloaded') === 'true' ||
          btn.dataset.gbiDownloaded === 'true' ||
          (parentComp && (parentComp.getAttribute('data-gbi-downloaded') === 'true' || parentComp.dataset.gbiDownloaded === 'true'));
        return !isDownloaded;
      });
    }

    return list;
  }

  function markExistingImagesAsDownloaded() {
    const existing = findDownloadButtons(false);
    existing.forEach((btn) => {
      btn.setAttribute('data-gbi-downloaded', 'true');
      btn.dataset.gbiDownloaded = 'true';
      const comp = btn.closest('download-generated-image-button');
      if (comp) {
        comp.setAttribute('data-gbi-downloaded', 'true');
        comp.dataset.gbiDownloaded = 'true';
      }
    });
    console.log(`[GBI] Marked ${existing.length} existing image download button(s) as already processed.`);
  }

  function isGeminiDownloading() {
    // Detect Gemini's "Downloading full size…" snackbar (extended-snackbar / mat-snack-bar-container)
    const snackbars = document.querySelectorAll(
      'extended-snackbar [data-test-id="label"], mat-snack-bar-container .mat-mdc-snack-bar-label, mat-snack-bar-container, extended-snackbar'
    );
    for (const el of snackbars) {
      const text = el.textContent || '';
      if (text.includes('Downloading full size') || text.toLowerCase().includes('downloading')) {
        return true;
      }
    }
    return false;
  }

  async function waitForDownloadToComplete(signal, maxWaitMs = 45000) {
    // 1. Wait up to 4s for the "Downloading full size…" snackbar to appear
    const appearStart = Date.now();
    let appeared = false;

    while (Date.now() - appearStart < 4000) {
      if (signal?.aborted) return;
      if (isGeminiDownloading()) {
        appeared = true;
        break;
      }
      await delay(150);
    }

    // 2. If the snackbar appeared or is active, wait until it disappears (download completed!)
    if (appeared || isGeminiDownloading()) {
      const downloadStart = Date.now();
      while (isGeminiDownloading()) {
        if (signal?.aborted) return;
        const elapsed = Math.round((Date.now() - downloadStart) / 1000);
        if (Date.now() - downloadStart > maxWaitMs) {
          console.warn('[GBI] Download snackbar wait timeout exceeded.');
          break;
        }
        updateStatus(`Downloading full size image... (${elapsed}s)`, true);
        await delay(350);
      }
      // 3. Cooldown delay after snackbar closes to allow Gemini's internal single-download state to reset
      await delay(1200);
    } else {
      // If snackbar wasn't caught (e.g. instant or browser prompt), wait safety fallback
      await delay(2000);
    }
  }

  async function triggerDownloadButton(btn) {
    if (!btn) return false;

    // Mark as downloaded immediately so it won't be processed again
    btn.setAttribute('data-gbi-downloaded', 'true');
    btn.dataset.gbiDownloaded = 'true';
    const comp = btn.closest('download-generated-image-button');
    if (comp) {
      comp.setAttribute('data-gbi-downloaded', 'true');
      comp.dataset.gbiDownloaded = 'true';
    }

    // Scroll button gently into view so it is rendered and interactive
    try {
      (comp || btn).scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {}

    // Reveal on-hover container if hidden
    const hoverContainer = btn.closest('.on-hover-button') || comp || btn.parentElement;
    if (hoverContainer) {
      hoverContainer.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
      hoverContainer.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    }

    btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    await delay(120);

    // Focus & dispatch mouse down / pointer down
    btn.focus();
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    // Primary action: click
    btn.click();

    // Dispatch click events
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));

    await delay(100);
    if (hoverContainer) {
      hoverContainer.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, cancelable: true }));
    }

    return true;
  }

  async function autoDownloadNewImages(signal) {
    if (!state.autoDownload) return 0;

    updateStatus('Searching for generated images...', true);

    const maxWaitMs = 6000;
    const intervalMs = 500;
    let elapsed = 0;
    let newButtons = [];

    // Poll until download button appears or timeout
    while (elapsed < maxWaitMs) {
      if (signal?.aborted) return 0;

      newButtons = findDownloadButtons(true);
      if (newButtons.length > 0) {
        // Wait an extra 800ms in case multi-image grid is still rendering remaining buttons
        await delay(800);
        newButtons = findDownloadButtons(true);
        break;
      }

      await delay(intervalMs);
      elapsed += intervalMs;
    }

    if (newButtons.length === 0) {
      console.log('[GBI] No new generated images detected for auto-download.');
      return 0;
    }

    const total = newButtons.length;
    let downloadedCount = 0;

    // Gemini only allows one download at a time! Process sequentially:
    for (let idx = 0; idx < total; idx++) {
      if (signal?.aborted) break;

      const btn = newButtons[idx];

      // Wait if previous download snackbar is still active
      while (isGeminiDownloading()) {
        if (signal?.aborted) return downloadedCount;
        updateStatus('Waiting for previous download to finish...', true);
        await delay(500);
      }

      updateStatus(`📥 Downloading image ${idx + 1} of ${total}...`, true);
      await triggerDownloadButton(btn);

      // Wait for Gemini's "Downloading full size…" snackbar to complete and close!
      await waitForDownloadToComplete(signal);
      downloadedCount++;
    }

    updateStatus(`✅ Downloaded ${downloadedCount} of ${total} image${total > 1 ? 's' : ''}!`);
    await delay(600);
    return downloadedCount;
  }

  async function downloadAllVisibleImages() {
    const buttons = findDownloadButtons(false);
    if (buttons.length === 0) {
      alert('No generated image download buttons found in the current conversation.');
      return;
    }

    const total = buttons.length;
    const confirmed = confirm(
      `Found ${total} image download button${total > 1 ? 's' : ''}.\n\nGemini downloads one file at a time. The extension will download them one by one as each completes.\n\nProceed?`
    );
    if (!confirmed) return;

    let count = 0;
    for (let idx = 0; idx < total; idx++) {
      const btn = buttons[idx];

      // Wait if previous download snackbar is still active
      while (isGeminiDownloading()) {
        updateStatus('Waiting for previous download to finish...', true);
        await delay(500);
      }

      updateStatus(`📥 Downloading image ${idx + 1} of ${total}...`, true);
      await triggerDownloadButton(btn);

      // Wait for Gemini snackbar to complete
      await waitForDownloadToComplete(null);
      count++;
    }

    updateStatus(`✅ Successfully downloaded ${count} images!`);
  }

  // ==========================================
  // Automation Core Actions
  // ==========================================
  async function injectPromptText(text) {
    const editor = findEditorElement();
    if (!editor) {
      throw new Error('Could not find Gemini prompt editor. Make sure chat or Images workspace is open.');
    }

    editor.focus();
    await delay(100);

    // Support standard HTML textarea
    if (editor.tagName && editor.tagName.toLowerCase() === 'textarea') {
      editor.value = text;
      editor.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      await delay(350);
      return true;
    }

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

    try {
      document.execCommand('selectAll', false, null);
    } catch (e) {}

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
  // Sample Prompts & Pipeline Helpers
  // ==========================================
const SAMPLE_PROMPTS = [
  'Elegant Islamic geometric patterns in gold and emerald green, intricate arabesque details, luxurious studio lighting',
  'Beautiful peaceful mosque courtyard at sunset, Islamic architecture, warm golden light, serene atmosphere, highly detailed',
  'Open Quran on a wooden stand beside prayer beads and a lantern, soft natural light, peaceful Islamic atmosphere, photorealistic'
];

  function loadSamplePrompts() {
    const textarea = document.getElementById('gbi-prompts-input');
    if (!textarea) return;
    textarea.value = SAMPLE_PROMPTS.join('\n');
    updatePromptCount();
    updateLineNumbers();
    savePromptsToStorage();
    if (!state.isRunning) {
      state.prompts = getPromptsFromInput();
      state.queueStatus = state.prompts.map(() => 'pending');
      state.currentIndex = 0;
      renderQueueList();
      updateProgress();
    }
    updateStatus('Loaded 3 sample prompts. Ready to start!');
  }

  function updatePipelineStep(step) {
    const stepImages = document.getElementById('gbi-step-images');
    const stepGenerate = document.getElementById('gbi-step-generate');
    const stepDownload = document.getElementById('gbi-step-download');

    if (stepImages) stepImages.classList.toggle('gbi-step-active', step === 'images');
    if (stepGenerate) stepGenerate.classList.toggle('gbi-step-active', step === 'generate');
    if (stepDownload) stepDownload.classList.toggle('gbi-step-active', step === 'download');
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

    // If starting from the beginning, mark pre-existing chat images so they won't be re-downloaded
    if (state.currentIndex === 0) {
      markExistingImagesAsDownloaded();
    }

    try {
      for (let i = state.currentIndex; i < state.prompts.length; i++) {
        if (!state.isRunning) break;

        // Handle pause
        while (state.isPaused) {
          if (!state.isRunning) break;
          updatePipelineStep('idle');
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

        try {
          // 1. Click "Images" option first (if enabled)
          if (state.clickImagesOption) {
            updatePipelineStep('images');
            updateStatus(`[${i + 1}/${state.prompts.length}] Opening "Images" workspace...`, true);
            await clickImagesOption(signal);
            if (signal?.aborted || !state.isRunning) break;

            await waitForEditorReady(signal);
            if (signal?.aborted || !state.isRunning) break;
          }

          // Mark any existing images on screen so only the newly generated image is downloaded
          markExistingImagesAsDownloaded();

          // 2. Inject Prompt & Generate
          updatePipelineStep('generate');
          updateStatus(`[${i + 1}/${state.prompts.length}] Submitting prompt: "${promptText.slice(0, 45)}..."`, true);
          await injectPromptText(promptText);
          await delay(400);

          // 3. Submit
          await submitPrompt();
          await delay(1500);

          // 4. Wait for generation to complete
          await waitForGenerationToComplete(signal);
          if (signal?.aborted || !state.isRunning) break;

          // 5. Auto-download generated image(s) if enabled
          let downloadedCount = 0;
          if (state.autoDownload && !signal.aborted && state.isRunning) {
            updatePipelineStep('download');
            downloadedCount = await autoDownloadNewImages(signal);
          }

          updatePipelineStep('idle');
          state.queueStatus[i] = 'done';
          renderQueueList();

          // 6. Cooldown delay before next prompt (next prompt will click Images option again!)
          if (i < state.prompts.length - 1 && state.isRunning) {
            let remaining = state.cooldownDelay;
            while (remaining > 0 && state.isRunning && !state.isPaused) {
              const dlNote = downloadedCount > 0 ? ` (${downloadedCount} img saved)` : '';
              updateStatus(`Waiting ${remaining}s cooldown before next prompt${dlNote}...`);
              await delay(1000);
              remaining--;
            }
          }
        } catch (err) {
          console.error('[GBI] Error processing prompt:', err);
          updatePipelineStep('idle');
          state.queueStatus[i] = 'error';
          renderQueueList();
          updateStatus(`Error on prompt ${i + 1}: ${err.message}. Continuing...`);
          await delay(3000);
        }
      }

      updatePipelineStep('idle');
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
      updatePipelineStep('idle');
      state.isRunning = false;
      updateUIState();
    }
  }

  function pauseQueue() {
    state.isPaused = !state.isPaused;
    if (state.isPaused) updatePipelineStep('idle');
    updateUIState();
    updateStatus(state.isPaused ? '⏸️ Execution paused' : '▶️ Resuming execution...');
  }

  function stopQueue() {
    state.isRunning = false;
    state.isPaused = false;
    updatePipelineStep('idle');
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
    updateLineNumbers();
    updateProgress();
    renderQueueList();
    updatePipelineStep('idle');
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
      <span class="gbi-pill-dot"></span>
      <span>Bulk Prompts</span>
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
          <div class="gbi-logo-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>
            </svg>
          </div>
          <span class="gbi-title">Bulk Prompts</span>
          <span class="gbi-status-chip status-idle" id="gbi-status-chip">Idle</span>
        </div>
        <div class="gbi-header-actions">
          <button class="gbi-icon-btn" id="gbi-theme-btn" title="Toggle Theme">🌙</button>
          <button class="gbi-icon-btn" id="gbi-settings-btn" title="Settings">⚙</button>
          <button class="gbi-icon-btn" id="gbi-pos-btn" title="Dock Top/Bottom">↕</button>
          <button class="gbi-icon-btn" id="gbi-min-btn" title="Minimize">✕</button>
        </div>
      </div>

      <!-- Body -->
      <div class="gbi-body">
        <!-- Minimal Stepper Banner -->
        <div class="gbi-pipeline-banner">
          <div class="gbi-pipeline-step" id="gbi-step-images" title="Step 1: Open Images workspace">
            <span class="gbi-step-num">1</span>
            <span>Images</span>
          </div>
          <span class="gbi-pipeline-divider">›</span>
          <div class="gbi-pipeline-step" id="gbi-step-generate" title="Step 2: Generate image">
            <span class="gbi-step-num">2</span>
            <span>Generate</span>
          </div>
          <span class="gbi-pipeline-divider">›</span>
          <div class="gbi-pipeline-step" id="gbi-step-download" title="Step 3: Save image">
            <span class="gbi-step-num">3</span>
            <span>Download</span>
          </div>
        </div>

        <!-- Collapsible Settings Drawer -->
        <div class="gbi-settings-drawer gbi-collapsed" id="gbi-settings-drawer">
          <div class="gbi-drawer-section-title">Workflow</div>
          <div class="gbi-config-row">
            <div class="gbi-config-label-group">
              <b>Reset via Images</b>
              <span>Clicks Images menu each prompt</span>
            </div>
            <div style="display:flex; align-items:center; gap:6px;">
              <button type="button" class="gbi-inline-link-btn" id="gbi-jump-images-btn" title="Click 'Images' now">Go ↗</button>
              <label class="gbi-switch">
                <input type="checkbox" id="gbi-click-images-cb" checked>
                <span class="gbi-slider"></span>
              </label>
            </div>
          </div>

          <div class="gbi-drawer-section-title">Automation & Timing</div>
          <div class="gbi-config-row">
            <div class="gbi-config-label-group">
              <b>Auto-download</b>
              <span>Save high-res output</span>
            </div>
            <label class="gbi-switch">
              <input type="checkbox" id="gbi-autodownload-cb" checked>
              <span class="gbi-slider"></span>
            </label>
          </div>

          <div class="gbi-config-row">
            <div class="gbi-config-label-group">
              <b>Auto-scroll</b>
              <span>Keep images in view</span>
            </div>
            <label class="gbi-switch">
              <input type="checkbox" id="gbi-autoscroll-cb" checked>
              <span class="gbi-slider"></span>
            </label>
          </div>

          <div class="gbi-config-row">
            <div class="gbi-config-label-group">
              <b>Cooldown delay</b>
              <span>Seconds between prompts</span>
            </div>
            <div style="display:flex; align-items:center; gap:4px;">
              <input type="number" class="gbi-number-input" id="gbi-delay-input" min="2" max="60" value="8">
              <span style="color:var(--gbi-text-muted); font-size:10px;">s</span>
            </div>
          </div>

          <div class="gbi-drawer-section-title">Prompt Modification</div>
          <div class="gbi-config-row">
            <div class="gbi-config-label-group">
              <b>Prepend prefix</b>
              <span>Add prefix to each prompt</span>
            </div>
            <label class="gbi-switch">
              <input type="checkbox" id="gbi-prefix-cb" checked>
              <span class="gbi-slider"></span>
            </label>
          </div>
          <input
            type="text"
            class="gbi-text-input"
            id="gbi-prefix-input"
            value="Generate an image of: "
            placeholder="Prefix text..."
          >

          <div class="gbi-drawer-section-title">Batch & Theme</div>
          <button type="button" class="gbi-btn-secondary" id="gbi-download-all-btn">
            Download Visible Images
          </button>

          <div class="gbi-config-row" style="margin-top:2px;">
            <div class="gbi-config-label-group">
              <b>Appearance</b>
            </div>
            <div class="gbi-theme-toggle-group">
              <button type="button" class="gbi-theme-pill-btn active" id="gbi-theme-dark-btn">Dark</button>
              <button type="button" class="gbi-theme-pill-btn" id="gbi-theme-light-btn">Light</button>
            </div>
          </div>
        </div>

        <!-- Prompts Textarea Container -->
        <div class="gbi-input-container">
          <div class="gbi-editor-top-bar">
            <span class="gbi-count-badge" id="gbi-count-badge">0 prompts</span>
            <div class="gbi-editor-tools">
              <button type="button" class="gbi-tool-btn" id="gbi-sample-btn" title="Load sample prompts">Sample</button>
              <button type="button" class="gbi-tool-btn" id="gbi-clear-btn" title="Clear all prompts">Clear</button>
            </div>
          </div>
          <div class="gbi-editor-wrapper">
            <div class="gbi-line-numbers" id="gbi-line-numbers" aria-hidden="true">
              <div class="gbi-ln">1</div>
            </div>
            <textarea
              class="gbi-textarea"
              id="gbi-prompts-input"
              wrap="off"
              spellcheck="false"
              placeholder="Enter prompts (one prompt per line)..."
            ></textarea>
          </div>
        </div>

        <!-- Action Controls -->
        <div class="gbi-controls">
          <button class="gbi-btn gbi-btn-primary" id="gbi-start-btn">Start Queue</button>
          <button class="gbi-btn gbi-btn-stop" id="gbi-stop-btn" disabled>Stop</button>
        </div>

        <!-- Status & Progress Card -->
        <div class="gbi-status-card">
          <div class="gbi-progress-track">
            <div class="gbi-progress-bar" id="gbi-progress-bar"></div>
          </div>
          <div class="gbi-status-row">
            <div class="gbi-status-text" id="gbi-status-msg">
              <span>Ready</span>
            </div>
            <span id="gbi-progress-percent" class="gbi-progress-percent">0%</span>
          </div>
        </div>

        <!-- Queue Accordion -->
        <div class="gbi-queue-accordion">
          <div class="gbi-queue-header" id="gbi-queue-toggle">
            <span id="gbi-queue-summary">Queue (0)</span>
            <span id="gbi-queue-arrow" style="font-size:8px;">▶</span>
          </div>
          <div class="gbi-queue-list" id="gbi-queue-list"></div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    bindUIEvents();
    loadSavedState();
    updateLineNumbers();
  }

  function bindUIEvents() {
    const input = document.getElementById('gbi-prompts-input');
    const startBtn = document.getElementById('gbi-start-btn');
    const stopBtn = document.getElementById('gbi-stop-btn');
    const clearBtn = document.getElementById('gbi-clear-btn');
    const sampleBtn = document.getElementById('gbi-sample-btn');
    const minBtn = document.getElementById('gbi-min-btn');
    const posBtn = document.getElementById('gbi-pos-btn');
    const settingsBtn = document.getElementById('gbi-settings-btn');
    const settingsDrawer = document.getElementById('gbi-settings-drawer');
    const prefixCb = document.getElementById('gbi-prefix-cb');
    const prefixInput = document.getElementById('gbi-prefix-input');
    const delayInput = document.getElementById('gbi-delay-input');
    const autoScrollCb = document.getElementById('gbi-autoscroll-cb');
    const autoDownloadCb = document.getElementById('gbi-autodownload-cb');
    const clickImagesCb = document.getElementById('gbi-click-images-cb');
    const jumpImagesBtn = document.getElementById('gbi-jump-images-btn');
    const downloadAllBtn = document.getElementById('gbi-download-all-btn');
    const themeBtn = document.getElementById('gbi-theme-btn');
    const themeDarkBtn = document.getElementById('gbi-theme-dark-btn');
    const themeLightBtn = document.getElementById('gbi-theme-light-btn');
    const queueToggle = document.getElementById('gbi-queue-toggle');

    if (sampleBtn) {
      sampleBtn.addEventListener('click', loadSamplePrompts);
    }

    if (clickImagesCb) {
      clickImagesCb.addEventListener('change', (e) => {
        state.clickImagesOption = e.target.checked;
        saveConfigToStorage();
      });
    }

    if (jumpImagesBtn) {
      jumpImagesBtn.addEventListener('click', async () => {
        updatePipelineStep('images');
        updateStatus('Opening "Images" workspace...', true);
        await clickImagesOption(null);
        await waitForEditorReady(null);
        updatePipelineStep('idle');
        updateStatus('Images workspace ready.');
      });
    }

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

    if (autoDownloadCb) {
      autoDownloadCb.addEventListener('change', (e) => {
        state.autoDownload = e.target.checked;
        saveConfigToStorage();
      });
    }

    if (downloadAllBtn) {
      downloadAllBtn.addEventListener('click', downloadAllVisibleImages);
    }

    if (themeBtn) {
      themeBtn.addEventListener('click', toggleTheme);
    }

    if (themeDarkBtn) {
      themeDarkBtn.addEventListener('click', () => {
        setTheme('dark');
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ gbi_theme: 'dark' });
        }
      });
    }

    if (themeLightBtn) {
      themeLightBtn.addEventListener('click', () => {
        setTheme('light');
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ gbi_theme: 'light' });
        }
      });
    }

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

    if (settingsBtn && settingsDrawer) {
      settingsBtn.addEventListener('click', () => {
        const isCollapsed = settingsDrawer.classList.toggle('gbi-collapsed');
        settingsBtn.classList.toggle('gbi-active-btn', !isCollapsed);
      });
    }

    if (input) {
      input.addEventListener('input', () => {
        updatePromptCount();
        updateLineNumbers();
        savePromptsToStorage();
        if (!state.isRunning) {
          state.prompts = getPromptsFromInput();
          state.queueStatus = state.prompts.map(() => 'pending');
          state.currentIndex = 0;
          renderQueueList();
          updateProgress();
        }
      });

      input.addEventListener('scroll', () => {
        const gutter = document.getElementById('gbi-line-numbers');
        if (gutter) {
          gutter.scrollTop = input.scrollTop;
        }
      });
    }

    if (queueToggle) {
      queueToggle.addEventListener('click', () => {
        const list = document.getElementById('gbi-queue-list');
        const arrow = document.getElementById('gbi-queue-arrow');
        if (list) {
          const isHidden = list.style.display === 'none' || !list.style.display;
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
        panel.style.bottom = '20px';
      }
      if (pill) {
        pill.classList.add('gbi-pill-bottom');
        pill.style.top = 'auto';
        pill.style.bottom = '20px';
      }
    } else {
      if (panel) {
        panel.classList.remove('gbi-panel-bottom');
        panel.style.bottom = 'auto';
        panel.style.top = '14px';
      }
      if (pill) {
        pill.classList.remove('gbi-pill-bottom');
        pill.style.bottom = 'auto';
        pill.style.top = '14px';
      }
    }
  }

  function setTheme(theme) {
    state.theme = theme === 'light' ? 'light' : 'dark';
    const panel = document.getElementById('gbi-main-panel');
    const pill = document.getElementById('gbi-floating-pill');
    const themeBtn = document.getElementById('gbi-theme-btn');
    const darkPill = document.getElementById('gbi-theme-dark-btn');
    const lightPill = document.getElementById('gbi-theme-light-btn');

    if (state.theme === 'light') {
      if (panel) panel.classList.add('gbi-theme-light');
      if (pill) pill.classList.add('gbi-theme-light');
      if (themeBtn) {
        themeBtn.textContent = '☀️';
        themeBtn.title = 'Current: Light Mode (Click for Dark)';
      }
      if (darkPill) darkPill.classList.remove('active');
      if (lightPill) lightPill.classList.add('active');
    } else {
      if (panel) panel.classList.remove('gbi-theme-light');
      if (pill) pill.classList.remove('gbi-theme-light');
      if (themeBtn) {
        themeBtn.textContent = '🌙';
        themeBtn.title = 'Current: Dark Mode (Click for Light)';
      }
      if (darkPill) darkPill.classList.add('active');
      if (lightPill) lightPill.classList.remove('active');
    }
  }

  function toggleTheme() {
    const nextTheme = state.theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ gbi_theme: state.theme });
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
    const queueSummary = document.getElementById('gbi-queue-summary');
    const label = `${prompts.length} ${prompts.length === 1 ? 'prompt' : 'prompts'}`;

    if (countBadge) countBadge.textContent = label;
    if (pillBadge) pillBadge.textContent = prompts.length;
    if (queueSummary) queueSummary.textContent = `Queue (${prompts.length})`;
  }

  function updateLineNumbers() {
    const textarea = document.getElementById('gbi-prompts-input');
    const gutter = document.getElementById('gbi-line-numbers');
    if (!textarea || !gutter) return;

    const lines = textarea.value.split('\n');
    const lineCount = Math.max(1, lines.length);

    let html = '';
    for (let i = 1; i <= lineCount; i++) {
      html += `<div class="gbi-ln">${i}</div>`;
    }
    gutter.innerHTML = html;
    gutter.scrollTop = textarea.scrollTop;
  }

  function updateStatus(text, isSpinning = false) {
    const msg = document.getElementById('gbi-status-msg');
    if (!msg) return;

    // Keep the spinner element alive across calls so its CSS animation never resets.
    let spinnerEl = msg.querySelector('.gbi-spinner');
    let labelEl   = msg.querySelector('.gbi-status-label');

    // First call — build the structure once.
    if (!spinnerEl || !labelEl) {
      msg.innerHTML = '';
      spinnerEl = document.createElement('span');
      spinnerEl.className = 'gbi-spinner';
      labelEl = document.createElement('span');
      labelEl.className = 'gbi-status-label';
      msg.appendChild(spinnerEl);
      msg.appendChild(labelEl);
    }

    // Toggle spinner visibility without touching the element itself.
    spinnerEl.style.display = isSpinning ? 'inline-block' : 'none';
    labelEl.textContent = text;
  }

  function updateProgress() {
    const total = state.prompts.length;
    const completed = state.queueStatus.filter((s) => s === 'done').length;

    const progressPercent = document.getElementById('gbi-progress-percent');
    const progressBar = document.getElementById('gbi-progress-bar');

    const pct = total === 0 ? 0 : Math.round((completed / total) * 100);

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
          startBtn.textContent = 'Resume Queue';
          startBtn.className = 'gbi-btn gbi-btn-primary';
        }
        if (statusChip) {
          statusChip.textContent = 'Paused';
          statusChip.className = 'gbi-status-chip status-paused';
        }
      } else {
        if (startBtn) {
          startBtn.textContent = 'Pause Queue';
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
        startBtn.textContent = 'Start Queue';
        startBtn.className = 'gbi-btn gbi-btn-primary';
      }
      if (statusChip) {
        const allDone = state.prompts.length > 0 && state.queueStatus.every((s) => s === 'done');
        if (allDone) {
          statusChip.textContent = 'Done';
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
      container.innerHTML = `<div style="color:var(--gbi-text-muted); font-size:11px; padding:4px 0;">No prompts in queue.</div>`;
      return;
    }

    let html = '';
    state.prompts.forEach((prompt, idx) => {
      const status = state.queueStatus[idx] || 'pending';
      let icon = '•';
      let itemClass = '';

      if (status === 'running') {
        icon = '●';
        itemClass = 'gbi-item-active';
      } else if (status === 'done') {
        icon = '✓';
        itemClass = 'gbi-item-done';
      } else if (status === 'error') {
        icon = '!';
        itemClass = 'gbi-item-error';
      }

      html += `
        <div class="gbi-queue-item ${itemClass}">
          <span style="color:var(--gbi-text-muted); font-size:10px; width:16px;">#${idx + 1}</span>
          <span class="gbi-queue-text" title="${escapeHtml(prompt)}">${escapeHtml(prompt)}</span>
          <span style="font-size:10px; font-weight:600;">${icon}</span>
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
