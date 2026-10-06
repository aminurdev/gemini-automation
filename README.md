# 🎨 Gemini Bulk Image Generator (Chrome Extension)

A Chrome extension that automates image generation on **Google Gemini** (`https://gemini.google.com/`) one by one from multiple prompts.

Designed based on Gemini's Angular + Quill rich-text input architecture, with a floating UI docked in the top-right corner (or toggleable to bottom-right).

---

## ✨ Features

- 📌 **Corner Floating UI**: Injected directly on `gemini.google.com` with top-right or bottom-right toggle, minimize pill button, and draggable header.
- 📝 **Multi-Prompt Queue**: Submit multiple prompts separated by newlines.
- 🤖 **Smart Gemini Automation**:
  - Automatically targets Gemini's `rich-textarea .ql-editor[contenteditable="true"]` input container.
  - Triggers Quill Delta and Angular reactive form updates.
  - Automatically clicks the `[aria-label="Send message"]` send button or dispatches Enter.
- ⏱️ **Auto-Detection of Generation Completion**:
  - Monitors Gemini's active generation states (`Stop response` button, thinking/loading spinners).
  - Automatically detects when image generation is complete.
  - User-configurable safety cooldown delay between prompts (default: 8s).
- 📥 **Auto-Download Generated Images (Sequential & Single-Flight Safe)**:
  - Automatically detects Gemini's `<download-generated-image-button>` as soon as each image finishes generating.
  - **Sequential download queue**: Monitors Gemini's `"Downloading full size…"` snackbar notification and waits for each file download to complete before triggering the next, preventing download conflicts.
  - Pre-marks existing images to avoid duplicate downloads of older chat history.
  - Includes a manual **"Download All Images in Chat"** button in options.
- ⏯️ **Full Queue Control**: Start, Pause, Resume, Stop, and Clear controls.
- 📊 **Live Progress & Queue Preview**: Visual indicator for each prompt (`⏳ Pending`, `🔄 Generating`, `✅ Done`, `⚠️ Error`).
- 🔔 **Finish Chime & Auto-Scroll**: Plays an audio chime when the entire batch is complete and auto-scrolls down to keep newly generated images in view.
- 💾 **State Persistence**: Preserves your prompts and settings in `chrome.storage.local`.

---

## 🚀 Installation Guide (Load Unpacked)

1. Open **Google Chrome**.
2. In the URL bar, go to:
   ```text
   chrome://extensions
   ```
3. Enable **Developer mode** using the toggle switch in the top-right corner.
4. Click the **Load unpacked** button in the top-left corner.
5. Select this folder:
   ```text
   c:\Users\aminur\Desktop\test\gemini-automation
   ```
6. The **Gemini Bulk Image Generator** extension is now installed and active!

---

## 🎯 How to Use

1. Navigate to **[https://gemini.google.com/](https://gemini.google.com/)** and log in to your Google account.
2. In the top-right corner of the Gemini page, you will see the floating **Bulk Prompts** panel.
3. Paste your prompts into the text box (one prompt per line), for example:
   ```text
   Majestic lion with glowing crystal armor in an enchanted forest
   Cozy cyberpunk coffee shop in rainy Tokyo at night, neon lights
   Vintage 1960s sports car speeding across Mars, red dust trail
   Surreal floating islands with waterfalls in a pastel twilight sky
   ```
4. Configure options (click ⚙ button):
   - **Auto prefix**: Prepend `Generate an image of: ` to every prompt automatically.
   - **Delay**: Cooldown delay (in seconds) after each generation completes.
   - **Auto-scroll**: Automatically scroll down to view new images as they generate.
   - **Auto-download images**: Automatically download full-size generated images once ready.
   - **Download All Images in Chat**: One-click download of all images currently visible on the page.
5. Click **Start**.
6. Sit back while the extension types each prompt, clicks Send, waits for Gemini to generate the image, automatically downloads the full-resolution file, and proceeds to the next prompt!

---

## 📁 File Structure

```text
├── manifest.json              # Extension Manifest V3 configuration
├── content.js                 # Content script: DOM automation & floating UI
├── content.css                # Premium glassmorphic styling for floating widget
├── popup.html                 # Extension toolbar action popup
├── popup.js                   # Popup interactions
├── popup.css                  # Popup styling
├── icons/
│   ├── icon16.png             # 16x16 icon
│   ├── icon48.png             # 48x48 icon
│   └── icon128.png            # 128x128 icon
└── context.inspect.data.html  # Original inspected Gemini input area DOM
```
