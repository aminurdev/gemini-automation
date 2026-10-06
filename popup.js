document.addEventListener('DOMContentLoaded', () => {
  const openGeminiBtn = document.getElementById('btn-open-gemini');

  if (openGeminiBtn) {
    openGeminiBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://gemini.google.com/' });
    });
  }
});
