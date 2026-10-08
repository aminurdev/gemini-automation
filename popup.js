document.addEventListener('DOMContentLoaded', () => {
  const openGeminiBtn = document.getElementById('btn-open-gemini');
  const themeToggleBtn = document.getElementById('btn-theme-toggle');
  const powerToggle = document.getElementById('popup-power-toggle');
  const statusDot = document.getElementById('popup-status-dot');
  const statusLabel = document.getElementById('popup-status-label');
  const footerText = document.getElementById('popup-footer-text');

  if (openGeminiBtn) {
    openGeminiBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://gemini.google.com/images' });
    });
  }

  function applyTheme(theme) {
    const isLight = theme === 'light';
    document.body.classList.toggle('theme-light', isLight);
    if (themeToggleBtn) {
      themeToggleBtn.textContent = isLight ? '☀️' : '🌙';
      themeToggleBtn.title = isLight ? 'Current: Light Mode (Click for Dark)' : 'Current: Dark Mode (Click for Light)';
    }
  }

  function updatePowerUI(enabled) {
    if (powerToggle) powerToggle.checked = enabled;
    if (statusDot) {
      statusDot.classList.toggle('disabled', !enabled);
    }
    if (statusLabel) {
      statusLabel.textContent = enabled ? 'Automation Enabled' : 'Automation Disabled';
    }
    if (footerText) {
      footerText.textContent = enabled ? 'Ready to generate' : 'Automation is turned off';
    }
  }

  // Load saved state (theme & enabled status)
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['gbi_theme', 'gbi_enabled'], (res) => {
      if (res.gbi_theme) {
        applyTheme(res.gbi_theme);
      } else {
        const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
        applyTheme(prefersLight ? 'light' : 'dark');
      }

      const isEnabled = res.gbi_enabled !== false;
      updatePowerUI(isEnabled);
    });
  }

  // Handle power toggle
  if (powerToggle) {
    powerToggle.addEventListener('change', (e) => {
      const isEnabled = e.target.checked;
      updatePowerUI(isEnabled);

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ gbi_enabled: isEnabled });
      }

      // Notify any active Gemini tabs immediately
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
        chrome.tabs.query({ url: '*://gemini.google.com/*' }, (tabs) => {
          if (tabs && tabs.length) {
            tabs.forEach((tab) => {
              chrome.tabs.sendMessage(tab.id, { type: 'GBI_SET_ENABLED', enabled: isEnabled }).catch(() => {});
            });
          }
        });
      }
    });
  }

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const isCurrentlyLight = document.body.classList.contains('theme-light');
      const nextTheme = isCurrentlyLight ? 'dark' : 'light';
      applyTheme(nextTheme);
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ gbi_theme: nextTheme });
      }
    });
  }
});
