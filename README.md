# Read Aloud — Reading Time + TTS Chrome Extension

A free, no-account Chrome extension that shows estimated reading time on any article and reads it aloud using your browser's built-in text-to-speech.

## Features

- Shows reading time badge on any article page
- Reads the article aloud with play/pause/stop controls
- Works on Medium, Substack, news sites, blogs, and more
- No account, no server, no tracking — runs entirely in your browser
- Keyboard shortcut: `Alt + Shift + R` to toggle play/pause

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

The extension is now installed.

## How to Use

1. Navigate to any article or blog post
2. Look for the pink **reading time badge** in the bottom-right corner of the page
3. Click the badge to open the player
4. Press **▶** to start reading aloud
5. Press **⏸** to pause, **■** to stop and reset

You can also use `Alt + Shift + R` to toggle play/pause from your keyboard.

## How It Works

- Uses [Mozilla Readability](https://github.com/mozilla/readability) to extract the main article text from the page
- Falls back to semantic HTML selectors (`<article>`, `<main>`, etc.) if Readability doesn't find enough content
- Splits text into small chunks and uses the browser's built-in `SpeechSynthesis` API to read them aloud
- Includes a fix for a Chrome bug where speech synthesis silently stops after ~15 seconds

## Limitations

- Does not work on PDFs or pages with very little text (under 100 words)
- Voice quality depends on the voices installed in your operating system
- Not yet published to the Chrome Web Store (manual install required)

## License

MIT
