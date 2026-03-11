(() => {
  // ─── GUARD: skip PDFs, frames, no-body pages, no-TTS environments ────────────
  if (document.contentType === 'application/pdf') return;
  if (window.location.pathname.endsWith('.pdf')) return;
  if (!document.body) return;
  if (!window.speechSynthesis) return;

  // ─── 1. EXTRACT READABLE TEXT ────────────────────────────────────────────────
  function extractText() {
    // Primary: Mozilla Readability (handles Medium, Substack, dynamic class names)
    try {
      const docClone = document.cloneNode(true);
      // Strip code blocks — they sound terrible when read aloud
      docClone.querySelectorAll('pre, code').forEach(el => el.remove());
      const article = new Readability(docClone).parse(); // eslint-disable-line no-undef
      if (article?.textContent?.trim().length > 200) {
        return article.textContent.trim();
      }
    } catch (_) {
      // Readability failed, fall through to selector strategy
    }

    // Fallback: semantic selectors in priority order
    const SELECTORS = [
      'article',
      'main',
      '[role="main"]',
      '.post-content',
      '.article-body',
      '.entry-content',
      '.content',
    ];
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 200) return el.innerText.trim();
    }

    return '';
  }

  // ─── 2. CHUNK TEXT for TTS (sentence groups ≤ 200 chars) ────────────────────
  function buildChunks(text) {
    const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
    const chunks = [];
    let current = '';
    for (const s of sentences) {
      const trimmed = s.trim();
      if (!trimmed) continue;
      if ((current + ' ' + trimmed).trim().length <= 200) {
        current = (current + ' ' + trimmed).trim();
      } else {
        if (current) chunks.push(current);
        // If a single sentence is > 200 chars, split it further by comma
        if (trimmed.length > 200) {
          const parts = trimmed.split(',').map(p => p.trim()).filter(Boolean);
          for (const p of parts) chunks.push(p);
        } else {
          current = trimmed;
        }
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  // ─── 3. READING TIME ─────────────────────────────────────────────────────────
  function readingTime(text) {
    const words = text.trim().split(/\s+/).length;
    const mins = Math.ceil(words / 238); // 238 wpm — research-backed average
    return mins < 1 ? '< 1 min read' : `${mins} min read`;
  }

  // ─── 4. STATE ────────────────────────────────────────────────────────────────
  let uiCreated = false;
  let lastUrl = location.href;
  let retryTimer = null; // tracked so we can cancel on SPA navigation

  // ─── 5. INIT WITH RETRY ──────────────────────────────────────────────────────
  function tryInit() {
    if (uiCreated) return true;
    if (!document.body) return false;

    const articleText = extractText();
    const wordCount = articleText.trim().split(/\s+/).length;
    const hasContent = articleText.length > 0 && wordCount >= 100;
    const tooShort = articleText.length > 0 && wordCount < 100;

    if (!hasContent && !tooShort) return false;

    uiCreated = true;
    setupUI(articleText, hasContent);
    return true;
  }

  function runInitWithRetry() {
    clearInterval(retryTimer); // cancel any previous pending retry loop
    if (!tryInit()) {
      let attempts = 0;
      retryTimer = setInterval(() => {
        attempts++;
        if (tryInit() || attempts >= 10) clearInterval(retryTimer);
      }, 1000);
    }
  }

  runInitWithRetry();

  // ─── 6. SPA NAVIGATION DETECTION ─────────────────────────────────────────────
  // React, Next.js, Substack, Medium navigate via history API without page reload.
  // Detect URL changes, tear down old UI, and re-initialise for the new article.
  function onUrlChange() {
    const newUrl = location.href;
    if (newUrl === lastUrl) return;
    lastUrl = newUrl;

    // Stop any active speech before tearing down
    window.speechSynthesis.cancel();

    // Remove old badge/player
    const existing = document.getElementById('ra-host');
    if (existing) existing.remove();
    uiCreated = false;

    // Wait briefly for new page content to start rendering, then try init
    setTimeout(runInitWithRetry, 500);
  }

  // Intercept pushState and replaceState (used by React Router, Next.js, etc.)
  ['pushState', 'replaceState'].forEach(method => {
    const orig = history[method];
    history[method] = function (...args) {
      orig.apply(this, args);
      onUrlChange();
    };
  });
  window.addEventListener('popstate', onUrlChange);

  // ─── 7. SETUP UI ─────────────────────────────────────────────────────────────
  function setupUI(articleText, hasContent) {
    const wordCount = articleText.trim().split(/\s+/).length;
    // Use the page's declared language for TTS voice matching
    const pageLang = document.documentElement.lang || 'en-US';

  // ─── TTS STATE ───────────────────────────────────────────────────────────────
  const tts = {
    chunks: hasContent ? buildChunks(articleText) : [],
    index: 0,
    speaking: false,
    paused: false,
    watchdog: null,
  };

  // ─── BUILD UI (Shadow DOM for CSS isolation) ──────────────────────────────────
  const host = document.createElement('div');
  host.id = 'ra-host';
  // Ensure nothing on the page can accidentally style our host element
  host.style.cssText = 'all: initial; position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Fredoka+One&display=swap');

      /* ── Reset ─────────────────────────────────────────── */
      * { box-sizing: border-box; margin: 0; padding: 0; }

      /* ── Retro-pop palette ──────────────────────────────
         hot-pink  : #FF2D87
         cyan      : #00E5FF
         yellow    : #FFE500
         e-blue    : #3D5AFE
         purple    : #CC00FF
         black     : #0D0D0D
         cream     : #FFFDF0
      ────────────────────────────────────────────────────── */

      /* ── Badge (collapsed state) ─────────────────────── */
      #badge {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        background: #FF2D87;
        color: #FFE500;
        padding: 9px 18px 9px 14px;
        border-radius: 999px;
        border: 3px solid #0D0D0D;
        box-shadow: 4px 4px 0 #0D0D0D;
        font-family: 'Fredoka One', 'Arial Black', Impact, sans-serif;
        font-size: 14px;
        letter-spacing: 0.3px;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
        transition: transform 0.1s, box-shadow 0.1s;
        /* chunky text outline */
        text-shadow: 1px 1px 0 #0D0D0D, -1px -1px 0 #0D0D0D,
                     1px -1px 0 #0D0D0D, -1px 1px 0 #0D0D0D;
      }
      #badge:hover {
        transform: translate(-2px, -2px);
        box-shadow: 6px 6px 0 #0D0D0D;
      }
      #badge:active {
        transform: translate(2px, 2px);
        box-shadow: 2px 2px 0 #0D0D0D;
      }

      /* ── Player card (expanded state) ───────────────── */
      #player {
        display: none;
        flex-direction: column;
        gap: 0;
        background: #FFFDF0;
        border: 3px solid #0D0D0D;
        border-radius: 18px;
        box-shadow: 6px 6px 0 #0D0D0D;
        min-width: 260px;
        overflow: hidden;
        position: relative;
      }
      #player.visible { display: flex; }

      /* Coloured top stripe */
      #player-stripe {
        background: linear-gradient(90deg, #00E5FF 0%, #CC00FF 50%, #FF2D87 100%);
        height: 6px;
        width: 100%;
      }

      /* Header row: title + close */
      #player-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px 4px;
      }
      #player-title {
        font-family: 'Fredoka One', 'Arial Black', Impact, sans-serif;
        font-size: 13px;
        color: #0D0D0D;
        letter-spacing: 0.4px;
        display: flex;
        align-items: center;
        gap: 5px;
      }

      /* Controls row */
      #player-controls {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 14px 12px;
      }

      /* ── Buttons ─────────────────────────────────────── */
      button {
        border: 2.5px solid #0D0D0D;
        border-radius: 50%;
        width: 36px;
        height: 36px;
        font-size: 14px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        font-family: 'Fredoka One', 'Arial Black', sans-serif;
        transition: transform 0.1s, box-shadow 0.1s;
        box-shadow: 3px 3px 0 #0D0D0D;
      }
      button:hover  { transform: translate(-1px,-1px); box-shadow: 4px 4px 0 #0D0D0D; }
      button:active { transform: translate(1px,1px);   box-shadow: 1px 1px 0 #0D0D0D; }
      button:disabled { opacity: 0.3; cursor: not-allowed; transform: none; box-shadow: 3px 3px 0 #0D0D0D; }

      /* Play/pause — cyan */
      #btn-play { background: #00E5FF; color: #0D0D0D; font-size: 15px; }

      /* Stop — purple */
      #btn-stop { background: #CC00FF; color: #fff; font-size: 12px; }

      /* Close — small, top-right */
      #btn-close {
        background: #FFE500;
        color: #0D0D0D;
        border: 2px solid #0D0D0D;
        border-radius: 50%;
        width: 24px;
        height: 24px;
        font-size: 12px;
        box-shadow: 2px 2px 0 #0D0D0D;
      }
      #btn-close:hover { background: #FF2D87; color: #fff; }

      /* ── Progress label ──────────────────────────────── */
      #progress {
        flex: 1;
        font-family: 'Fredoka One', 'Arial Black', sans-serif;
        font-size: 12px;
        color: #555;
        text-align: center;
        letter-spacing: 0.5px;
      }

      /* ── Decorative shapes (pure CSS / inline SVG) ───── */
      .deco {
        position: absolute;
        pointer-events: none;
        user-select: none;
      }
      #deco-star   { top: 8px;  right: 44px; opacity: 0.55; }
      #deco-tri    { bottom: 8px; left: 12px; opacity: 0.45; }
      #deco-squig  { top: 28px; right: 10px; opacity: 0.4; }
    </style>

    <!-- Collapsed pill badge -->
    <div id="badge">
      <!-- Headphone icon -->
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M3 18v-6a9 9 0 0118 0v6" stroke="#FFE500" stroke-width="2.5" stroke-linecap="round"/>
        <rect x="1" y="16" width="4" height="6" rx="2" fill="#FFE500" stroke="#0D0D0D" stroke-width="1.5"/>
        <rect x="19" y="16" width="4" height="6" rx="2" fill="#FFE500" stroke="#0D0D0D" stroke-width="1.5"/>
      </svg>
      <span id="badge-label">${hasContent ? readingTime(articleText) : '< 1 min read'}</span>
    </div>

    <!-- Expanded player card -->
    <div id="player">
      <!-- Rainbow stripe at top -->
      <div id="player-stripe"></div>

      <!-- Header -->
      <div id="player-head">
        <span id="player-title">
          <!-- Cassette icon -->
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <rect x="2" y="5" width="20" height="14" rx="3" fill="#FFE500" stroke="#0D0D0D" stroke-width="2"/>
            <circle cx="8"  cy="12" r="2.5" fill="#0D0D0D"/>
            <circle cx="16" cy="12" r="2.5" fill="#0D0D0D"/>
            <rect x="8" y="15" width="8" height="2.5" rx="1" fill="#0D0D0D"/>
          </svg>
          READ ALOUD
        </span>
        <button id="btn-close" title="Close">✕</button>
      </div>

      <!-- Controls -->
      <div id="player-controls">
        <button id="btn-play" title="Play · Alt+Shift+R">▶</button>
        <button id="btn-stop" title="Stop">■</button>
        <span id="progress">${hasContent ? `0 / ${tts.chunks.length}` : 'Too short!'}</span>
      </div>

      <!-- Decorative shapes -->
      <svg id="deco-star" class="deco" width="18" height="18" viewBox="0 0 24 24">
        <polygon points="12,2 15,9 22,9 17,14 19,21 12,17 5,21 7,14 2,9 9,9"
          fill="#FF2D87" stroke="#0D0D0D" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
      <svg id="deco-tri" class="deco" width="14" height="14" viewBox="0 0 24 24">
        <polygon points="12,3 22,21 2,21"
          fill="#00E5FF" stroke="#0D0D0D" stroke-width="2" stroke-linejoin="round"/>
      </svg>
      <svg id="deco-squig" class="deco" width="18" height="28" viewBox="0 0 18 28">
        <path d="M9 2 C14 6, 4 10, 9 14 C14 18, 4 22, 9 26"
          stroke="#CC00FF" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      </svg>
    </div>
  `;

  // ─── DOM REFERENCES ───────────────────────────────────────────────────────────
  const badge      = shadow.getElementById('badge');
  const badgeLabel = shadow.getElementById('badge-label');
  const player     = shadow.getElementById('player');
  const btnPlay    = shadow.getElementById('btn-play');
  const btnStop    = shadow.getElementById('btn-stop');
  const progress   = shadow.getElementById('progress');

  if (!hasContent) {
    btnPlay.disabled = true;
    btnStop.disabled = true;
  }

  // Toggle badge ↔ player
  badge.addEventListener('click', () => {
    badge.style.display = 'none';
    player.classList.add('visible');
  });

  shadow.getElementById('btn-close').addEventListener('click', () => {
    player.classList.remove('visible');
    badge.style.display = '';
    // NOTE: audio keeps playing if user closes the bar — intentional UX
  });

  // ─── TTS ENGINE ───────────────────────────────────────────────────────────────
  const synth = window.speechSynthesis;

  function updateProgress() {
    progress.textContent = `${tts.index} / ${tts.chunks.length}`;
  }

  function resetWatchdog() {
    clearTimeout(tts.watchdog);
    // Chrome has a bug: speechSynthesis silently stops after ~15s of audio
    // Fix: proactively pause/resume every 14s to keep it alive
    tts.watchdog = setTimeout(() => {
      if (tts.speaking && !tts.paused) {
        synth.pause();
        synth.resume();
        resetWatchdog();
      }
    }, 14000);
  }

  function onFinished() {
    tts.speaking = false;
    tts.paused = false;
    tts.index = 0;
    clearTimeout(tts.watchdog);
    btnPlay.textContent = '▶';
    updateProgress();
  }

  function speakChunk(index) {
    if (index >= tts.chunks.length) {
      onFinished();
      return;
    }

    tts.index = index;
    updateProgress();

    const u = new SpeechSynthesisUtterance(tts.chunks[index]);
    u.rate = 1.0;
    // Use the page's declared language so foreign-language articles sound correct
    u.lang = pageLang;

    u.onend = () => {
      clearTimeout(tts.watchdog);
      if (!tts.paused) speakChunk(index + 1);
    };

    u.onerror = (e) => {
      // 'interrupted' fires on manual cancel/pause — not a real error
      if (e.error !== 'interrupted') {
        console.warn('[ReadAloud] TTS error:', e.error);
        onFinished();
      }
    };

    synth.speak(u);
    resetWatchdog();
  }

  function startReading() {
    synth.cancel(); // clear any stale queue
    tts.speaking = true;
    tts.paused = false;
    btnPlay.textContent = '⏸';
    speakChunk(tts.index);
  }

  function pauseReading() {
    tts.paused = true;
    tts.speaking = false;
    clearTimeout(tts.watchdog);
    synth.pause();
    btnPlay.textContent = '▶';
  }

  function resumeReading() {
    tts.paused = false;
    tts.speaking = true;
    synth.resume();
    btnPlay.textContent = '⏸';
    resetWatchdog();
  }

  function stopReading() {
    synth.cancel();
    tts.speaking = false;
    tts.paused = false;
    tts.index = 0;
    clearTimeout(tts.watchdog);
    btnPlay.textContent = '▶';
    updateProgress();
  }

  // ─── BUTTON HANDLERS ──────────────────────────────────────────────────────────
  btnPlay.addEventListener('click', () => {
    if (!tts.speaking && !tts.paused) startReading();    // fresh start
    else if (tts.speaking && !tts.paused) pauseReading(); // pause
    else if (tts.paused) resumeReading();                // resume
  });

  shadow.getElementById('btn-stop').addEventListener('click', stopReading);

  // Keyboard shortcut: Alt+Shift+R to toggle play/pause
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.key === 'R') {
      if (!tts.speaking && !tts.paused) startReading();
      else if (tts.speaking) pauseReading();
      else if (tts.paused) resumeReading();
    }
  });

  // Tab visibility: Chrome TTS silently dies when a tab is backgrounded.
  // When the tab becomes visible again and speech was active, restart from current chunk.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && tts.speaking && !tts.paused) {
      synth.cancel();
      setTimeout(() => speakChunk(tts.index), 100);
    }
  });

  // Clean up on full page navigation
  window.addEventListener('beforeunload', () => {
    synth.cancel();
    clearTimeout(tts.watchdog);
  });

  // ─── CONTENT GROWTH OBSERVER ─────────────────────────────────────────────────
  // Watch for lazy-loaded content growing after initial render (e.g. infinite scroll,
  // paywalled articles revealing content, slow API responses).
  let debounceTimer = null;
  let observerActive = true;
  const initialWordCount = wordCount;

  const observer = new MutationObserver(() => {
    if (!observerActive) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const newText = extractText();
      const newWords = newText.trim().split(/\s+/).length;
      // Only update if new content is meaningfully longer AND user isn't mid-playback
      if (newWords > initialWordCount * 1.2 && !tts.speaking && newWords >= 100) {
        tts.chunks = buildChunks(newText);
        tts.index = 0;
        // Update only the text label — preserve the SVG icon inside the badge
        badgeLabel.textContent = readingTime(newText);
        btnPlay.disabled = false;
        btnStop.disabled = false;
        updateProgress();
      }
    }, 1500);
  });

  // Stop observing after 30s to avoid long-term performance overhead
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => {
    observer.disconnect();
    observerActive = false;
  }, 30000);
  } // end setupUI

})();
