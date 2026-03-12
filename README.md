# Read Aloud — Reading Time + TTS Chrome Extension

A free, no-account Chrome extension that shows estimated reading time on any article and reads it aloud using your browser's built-in text-to-speech.

## Features

- **Reading time badge** — shows estimated read time in the bottom-right corner on any article page
- **Play / Pause / Speed controls** — play at 0.75×, 1×, 1.5×, or 2× speed
- **Seekable scrubber** — click anywhere on the progress bar to jump to that position
- **Selection reading** — highlight any text on the page → a "Read selection" button appears → reads just that portion, then resumes the article
- **Background tab playback** — audio continues playing when you switch to another tab
- **Re-open after dismiss** — click the extension icon in the toolbar to bring the widget back after closing it
- **SPA navigation** — automatically detects page changes on React/Next.js/Substack/Medium and resets for the new article
- **Keyboard shortcut** — `Alt + Shift + R` to toggle play/pause
- No account, no server, no tracking — runs entirely in your browser

## Installation (Developer Mode)

Chrome extensions not yet published to the Web Store can be loaded manually.

### Step 1 — Download the code

Clone or download this repository:

```
git clone https://github.com/03shraddha/read-aloud-chrome.git
```

Or click **Code → Download ZIP** on GitHub and unzip it.

### Step 2 — Get Readability.js

This extension uses Mozilla's open-source Readability library to extract article text.

1. Open this URL in your browser:
   `https://raw.githubusercontent.com/mozilla/readability/main/Readability.js`
2. Press `Ctrl + S` (or `Cmd + S` on Mac) to save the file
3. Save it as `Readability.js` directly inside the `read-aloud-extension/` folder

Your folder should look like this:

```
read-aloud-extension/
├── manifest.json
├── background.js
├── Readability.js    ← file you just downloaded
├── content.js
└── icons/
    ├── icon-48.png
    └── icon-128.png
```

### Step 3 — Load in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `read-aloud-extension/` folder

The extension is now installed. Pin it to your toolbar for quick access.

## How to Use

1. Navigate to any article or blog post
2. Look for the pink **reading time badge** in the bottom-right corner
3. Click the badge to open the player
4. Press **▶** to start reading aloud
5. Use the scrubber to skip forward/back, or change speed with the **1×** button
6. Press **✕** to stop and minimise back to the badge, or **Done** to dismiss entirely

**Read a selection:** highlight any text → click the red **Read selection** button that appears → the extension reads only that text.

**Re-open after dismiss:** click the extension icon in the Chrome toolbar.

You can also use `Alt + Shift + R` to toggle play/pause from your keyboard.

## How It Works

- Uses [Mozilla Readability](https://github.com/mozilla/readability) to extract the main article text
- Falls back to semantic HTML selectors (`<article>`, `[role="article"]`, etc.) if Readability finds insufficient content
- Splits text into sentence-grouped chunks and queues them all at once with the browser's `SpeechSynthesis` API — this allows audio to continue in background tabs without Chrome killing playback
- A generation counter on each queue prevents stale callbacks (e.g. Chrome firing `onend` for cancelled utterances) from resetting playback position
- Shadow DOM ensures the widget's styles never conflict with the page

## Limitations

- Does not work on PDFs or pages with very little text (under 100 words)
- Voice quality depends on the voices installed in your operating system
- Not yet published to the Chrome Web Store (manual install required)

## License

MIT
