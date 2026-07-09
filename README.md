# ChatGPT Batch Submitter

A Chrome extension that automatically splits large text into manageable chunks and submits them to ChatGPT one batch at a time — with session persistence, subtitle (SRT) translation support, and response export.

---

## ✨ Features

- **Automatic batch splitting** — splits large text by paragraph, sentence, word boundary, or exact character count
- **SRT / subtitle support** — auto-detects `.srt` files and batches them by subtitle entry count rather than character count
- **Subtitle translation** — enter a target language and the extension auto-generates the correct ChatGPT prompt for SRT translation
- **Session persistence** — progress is saved to `chrome.storage.local`; if you close the panel mid-run, you can pick up exactly where you left off
- **Up to 10 batches per tab run** — after 10 batches, open a new ChatGPT tab and click **Continue** to carry on from where you stopped
- **Live batch preview** — shows how many batches will be created and the size of the largest batch before you start
- **Custom prompt prefix** — prepend any instruction to every batch (e.g. *"Summarise the following:"*)
- **Stop / resume at any time** — click **Stop** to pause; progress is saved automatically
- **Export responses** — download all collected ChatGPT responses as a single `.txt` file or a reassembled `.srt` subtitle file
- **Drag-and-drop file loading** — drag a `.srt` or `.txt` file onto the text area to load it instantly
- **Side panel UI** — lives in Chrome's native side panel so it never blocks the ChatGPT tab

---

## 🗂️ Project Structure

```
chatgpt-batcher/
├── manifest.json   # Chrome extension manifest (MV3)
├── background.js   # Service worker — opens the side panel on toolbar click
├── content.js      # Injected into chatgpt.com — drives batch submission
├── popup.html      # Side-panel UI (markup + styles)
└── popup.js        # Side-panel logic (splitting, session, messaging)
```

### File Responsibilities

| File | Role |
|------|------|
| `manifest.json` | Declares permissions, content script injection targets, and side panel path |
| `background.js` | Service worker that opens `popup.html` in the side panel when the toolbar icon is clicked |
| `content.js` | Injected into `chatgpt.com`; finds the input field, types each batch, clicks Send, waits for the response, and streams progress back via `chrome.runtime.sendMessage` |
| `popup.html` | Dark-themed side-panel interface with all controls and inline CSS |
| `popup.js` | Handles text splitting, SRT parsing, session management, progress display, and communication with the content script |

---

## 🚀 Installation

> The extension is not yet published to the Chrome Web Store. Load it manually as an unpacked extension.

1. Clone or download this repository.
2. Open **Chrome** and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `chatgpt-batcher` folder.
5. The **ChatGPT Batch Submitter** icon will appear in your toolbar.

---

## 🖥️ How to Use

1. Open [chatgpt.com](https://chatgpt.com) in a Chrome tab.
2. Click the **ChatGPT Batch Submitter** toolbar icon — the side panel opens.
3. **Load your text** — paste it directly, click **Browse .srt**, or drag-and-drop a file onto the text area.
4. Configure the batch settings:

   | Setting | Description |
   |---------|-------------|
   | **Batch size (chars)** | Maximum characters per batch (default: 3 000). In SRT mode this becomes *entries per batch* (default: 30). |
   | **Split at** | How to find the split point: paragraph break, sentence end, word boundary, exact character, or SRT entries. |
   | **Translate to language** *(SRT only)* | Target language for subtitle translation; auto-generates the correct prompt. |
   | **Prompt prefix** | Text prepended to every batch (e.g. *"Continue translating:"*). |

5. The **live preview** shows the expected number of batches.
6. Click **Submit to ChatGPT** — the extension types and submits each batch automatically.
7. Click **Stop** at any time to pause. Progress is saved.
8. If the run hits the 10-batch limit, open a fresh ChatGPT tab and click **Continue in This Tab**.
9. Once done, click **Export Responses (.txt)** or **Export Subtitles (.srt)** to download all collected responses.
10. Click **Reset Saved Progress** to clear the session and start fresh.

---

## ⚙️ Splitting Modes

| Mode | Behaviour |
|------|-----------|
| **Paragraph break** | Splits at the nearest `\n\n` before the batch limit |
| **Sentence end** | Splits after the last `.`, `!`, or `?` before the limit |
| **Word boundary** | Splits at the last space before the limit |
| **Exact character** | Splits at exactly the character limit |
| **Subtitle entries (SRT)** | Groups N subtitle blocks together; auto-detected when `.srt` content is pasted |

---

## 🔑 Permissions

| Permission | Reason |
|------------|--------|
| `activeTab` | Access the currently active ChatGPT tab |
| `scripting` | Inject `content.js` into the tab if not already loaded |
| `tabs` | Query and communicate with open tabs |
| `sidePanel` | Display the extension UI in Chrome's side panel |
| `storage` + `unlimitedStorage` | Persist session progress and collected responses across browser sessions |

Host permissions are restricted to `https://chatgpt.com/*` and `https://chat.openai.com/*`.

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────┐
│         Side Panel (popup)       │
│  popup.html + popup.js           │
│  • Text input & splitting        │
│  • Session persistence           │
│  • Progress display              │
└──────────┬──────────────────────┘
           │ chrome.tabs.sendMessage
           ▼
┌─────────────────────────────────┐
│     Content Script (content.js) │
│  Injected into chatgpt.com       │
│  • Finds input / send button     │
│  • Submits each batch            │
│  • Waits for response            │
│  • Streams progress back         │
└──────────┬──────────────────────┘
           │ chrome.runtime.sendMessage
           ▼
┌─────────────────────────────────┐
│     Background (background.js)  │
│  Service worker                  │
│  • Opens side panel on click     │
└─────────────────────────────────┘
```

**Message types used between scripts:**

| Message | Direction | Meaning |
|---------|-----------|---------|
| `PING` | popup → content | Health-check before starting |
| `SUBMIT_BATCHES` | popup → content | Start the batch run |
| `STOP` | popup → content | Abort current run |
| `BATCH_SUBMITTED` | content → popup | A batch was sent to ChatGPT |
| `BATCH_DONE` | content → popup | ChatGPT finished responding; includes captured response text |
| `RUN_COMPLETE` | content → popup | All batches in this run are finished |

---

## 🛠️ Development Notes

- Built with **Manifest V3** and vanilla JS/HTML — no build step required.
- Response detection in `content.js` uses a `MutationObserver` combined with a 300 ms polling interval to reliably detect when ChatGPT finishes generating, without depending on fragile CSS class names.
- The side panel has a hard limit of **10 batches per tab run** (`MAX_BATCHES_PER_RUN = 10`) to avoid hitting ChatGPT rate limits.
- Session fingerprinting (`makeSessionFingerprint`) detects when input or settings change so a new session is started automatically instead of continuing the old one.

---

## 📄 License

This project does not currently include a license file. All rights reserved by the author unless stated otherwise.
