document.addEventListener('DOMContentLoaded', () => {
  const openGeminiBtn = document.getElementById('btn-open-gemini');
  const themeToggleBtn = document.getElementById('btn-theme-toggle');

  if (openGeminiBtn) {
    openGeminiBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://gemini.google.com/' });
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

  // Load saved theme
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['gbi_theme'], (res) => {
      if (res.gbi_theme) {
        applyTheme(res.gbi_theme);
      } else {
        const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
        applyTheme(prefersLight ? 'light' : 'dark');
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
