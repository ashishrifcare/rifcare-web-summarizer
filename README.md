# Rifcare Web Summarizer — Chrome Extension

This extension provides on-device webpage summarization and Q&A using Chrome's built-in Gemini Nano model.

Folder structure

- manifest.json — extension manifest
- background.js — service worker / context menu
- content_script.js — page extraction, summarization, highlighting
- popup.html — popup UI
- popup.js — popup logic
- styles.css — popup styles
- icons/ — extension icons

Installation (Developer mode)

1. Open Chrome and go to chrome://extensions
2. Enable "Developer mode"
3. Click "Load unpacked" and select this `extension` folder.
4. The extension should appear in the toolbar.


Usage

- Right-click on any page and select "Summarize this page" to run in-place summarization and highlighting.
- Click the extension icon to open the popup. Click "Summarize Page" or ask questions after a summary has been generated.

Mock mode (for testing without Gemini Nano)

- The popup includes a "Mock" toggle switch. When enabled, the extension will use deterministic fake summaries and answers so you can test highlights, storage, and UI without the built-in AI.
- You can persist the mock setting between sessions from the popup. Use it to validate functionality even if your Chrome build doesn't expose `chrome.ai`.

Developer

- Built and maintained by Ashish Panchal.

What's new

- Mock-mode banner: when Mock mode is active the extension displays a subtle banner on pages so you know responses are simulated.
- Animations: popup and highlight animations for smoother UX.
- Polished icons: the extension now uses SVG icons and supports localization.

Notes & Limitations

- This extension relies on Chrome's built-in AI APIs (Gemini Nano) available in Chrome builds that include the feature. If the APIs are not present the extension will not be able to summarize.
- The extension is designed to prefer on-device (offline) models via `chrome.ai` or `window.ai` where supported.
- For privacy, summaries and QA history are stored in `chrome.storage.local` per URL. No external servers are contacted by default.

Security & Privacy

- The extension extracts visible page text to create summaries. Avoid using it on pages that contain highly sensitive information unless you trust the local environment.
- If you need networked backups or email notifications, integrate a secure backend and inform users.
