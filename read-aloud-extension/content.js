(() => {
  // ─── GUARD: skip PDFs, frames, no-body pages, no-TTS environments ────────────
  if (document.contentType === 'application/pdf') return;
  if (window.location.pathname.endsWith('.pdf')) return;
  if (!document.body) return;
  if (!window.speechSynthesis) return;

  // ─── 1. EXTRACT READABLE TEXT ────────────────────────────────────────────────
  function extractText() {
    // Primary: Mozilla Readability — requires both a title and substantial body
    // so homepages/feeds (no article title) are correctly excluded
    try {
      const docClone = document.cloneNode(true);
      // Strip code blocks — they sound terrible when read aloud
      docClone.querySelectorAll('pre, code').forEach(el => el.remove());
      const article = new Readability(docClone).parse(); // eslint-disable-line no-undef
      if (article?.title?.trim() && article?.textContent?.trim().length > 200) {
        return article.textContent.trim();
      }
    } catch (_) {
      // Readability failed, fall through to selector strategy
    }

    // Fallback: semantic selectors — use a higher threshold (300 words) to
    // avoid triggering on homepages/feeds that aggregate multiple short previews
    const SELECTORS = [
      'article',
      '[role="article"]',
      '.post-content',
      '.article-body',
      '.entry-content',
    ];
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel);
      const text = el?.innerText?.trim() ?? '';
      if (text.split(/\s+/).length >= 300) return text;
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
        if (tryInit() || attempts >= 20) clearInterval(retryTimer);
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

    // Wait for Substack/Next.js to clear old DOM and start rendering new content
    setTimeout(runInitWithRetry, 1000);
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
    rate: 1.0,
    chunkStartTime: 0, // Date.now() when current chunk began, for real-time progress
    ticker: null,      // setInterval handle for live progress updates
  };

  // ─── TIME PROGRESS HELPERS ───────────────────────────────────────────────────
  // Estimate seconds for a chunk based on word count at 150 wpm (TTS rate 1.0)
  const chunkDurations = tts.chunks.map(c => (c.trim().split(/\s+/).length / 150) * 60);

  function secsToMMSS(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  function totalSecs() { return chunkDurations.reduce((a, b) => a + b, 0); }

  function elapsedSecs(index) {
    return chunkDurations.slice(0, index).reduce((a, b) => a + b, 0);
  }

  // ─── BUILD UI (Shadow DOM for CSS isolation) ──────────────────────────────────
  const host = document.createElement('div');
  host.id = 'ra-host';
  // Ensure nothing on the page can accidentally style our host element
  host.style.cssText = 'all: initial; position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }

      /* shared font — system stack, no external request */
      * { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }

      /* ── Badge (collapsed) ───────────────────────────── */
      #badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: #f43f7e;
        color: #fff;
        padding: 7px 14px 7px 11px;
        border-radius: 999px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
        box-shadow: 0 2px 10px rgba(244,63,126,0.35);
        transition: box-shadow 0.15s, transform 0.15s;
      }
      #badge:hover  { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(244,63,126,0.4); }
      #badge:active { transform: translateY(1px);  box-shadow: 0 1px 6px rgba(244,63,126,0.3); }

      /* ── Player card (expanded) ──────────────────────── */
      #player {
        display: none;
        flex-direction: column;
        background: #ffffff;
        border-radius: 16px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06);
        min-width: 260px;
        overflow: hidden;
      }
      #player.visible { display: flex; }

      /* Thin pink accent bar at top */
      #player-stripe {
        background: #f43f7e;
        height: 3px;
        width: 100%;
      }

      /* Header */
      #player-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px 6px;
      }
      #player-title {
        font-size: 11px;
        font-weight: 700;
        color: #9ca3af;
        letter-spacing: 1px;
        text-transform: uppercase;
        display: flex;
        align-items: center;
        gap: 5px;
      }

      /* Controls row */
      #player-controls {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 12px 12px;
      }

      /* ── Buttons ─────────────────────────────────────── */
      button {
        border: none;
        border-radius: 50%;
        width: 34px;
        height: 34px;
        font-size: 13px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: opacity 0.15s, transform 0.15s;
      }
      button:hover  { opacity: 0.85; transform: translateY(-1px); }
      button:active { opacity: 1;    transform: translateY(1px); }
      button:disabled { opacity: 0.3; cursor: not-allowed; transform: none; }

      /* Play/pause — pink */
      #btn-play { background: #f43f7e; color: #fff; font-size: 14px; }

      /* Stop — light gray */
      #btn-stop { background: #f3f4f6; color: #374151; font-size: 11px; }

      /* Speed — pill, gray */
      #btn-speed {
        background: #f3f4f6;
        color: #374151;
        border-radius: 999px;
        width: auto;
        height: 28px;
        padding: 0 10px;
        font-size: 11px;
        font-weight: 600;
      }

      /* Close — top-right, minimal */
      #btn-close {
        background: transparent;
        color: #9ca3af;
        border-radius: 50%;
        width: 22px;
        height: 22px;
        font-size: 12px;
      }
      #btn-close:hover { background: #f3f4f6; color: #374151; }

      /* ── Progress label ──────────────────────────────── */
      #progress {
        flex: 1;
        font-size: 12px;
        font-weight: 500;
        color: #6b7280;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
    </style>

    <!-- Collapsed pill badge -->
    <div id="badge">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path d="M3 18v-6a9 9 0 0118 0v6" stroke="rgba(255,255,255,0.9)" stroke-width="2.5" stroke-linecap="round"/>
        <rect x="1" y="16" width="4" height="6" rx="2" fill="rgba(255,255,255,0.9)"/>
        <rect x="19" y="16" width="4" height="6" rx="2" fill="rgba(255,255,255,0.9)"/>
      </svg>
      <span id="badge-label">${hasContent ? readingTime(articleText) : '< 1 min read'}</span>
    </div>

    <!-- Expanded player card -->
    <div id="player">
      <div id="player-stripe"></div>

      <div id="player-head">
        <span id="player-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M9 18V5l12-2v13" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="6" cy="18" r="3" stroke="#9ca3af" stroke-width="2"/>
            <circle cx="18" cy="16" r="3" stroke="#9ca3af" stroke-width="2"/>
          </svg>
          Read Aloud
        </span>
        <button id="btn-close" title="Close">✕</button>
      </div>

      <div id="player-controls">
        <button id="btn-play" title="Play · Alt+Shift+R">▶</button>
        <button id="btn-stop" title="Stop">■</button>
        <button id="btn-speed" title="Change speed">1×</button>
        <span id="progress">${hasContent ? `0:00 / ${secsToMMSS(totalSecs())}` : 'Too short'}</span>
      </div>
    </div>
  `;

  // ─── DOM REFERENCES ───────────────────────────────────────────────────────────
  const badge      = shadow.getElementById('badge');
  const badgeLabel = shadow.getElementById('badge-label');
  const player     = shadow.getElementById('player');
  const btnPlay    = shadow.getElementById('btn-play');
  const btnStop    = shadow.getElementById('btn-stop');
  const btnSpeed   = shadow.getElementById('btn-speed');
  const progress   = shadow.getElementById('progress');

  if (!hasContent) {
    btnPlay.disabled = true;
    btnStop.disabled = true;
    btnSpeed.disabled = true;
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
    if (!hasContent) return;
    // Add real-time offset within the current chunk so display ticks smoothly
    const liveOffset = tts.speaking && !tts.paused && tts.chunkStartTime
      ? (Date.now() - tts.chunkStartTime) / 1000 / tts.rate
      : 0;
    const elapsed = Math.min(elapsedSecs(tts.index) + liveOffset, totalSecs());
    progress.textContent = `${secsToMMSS(elapsed)} / ${secsToMMSS(totalSecs())}`;
  }

  function startTicker() {
    clearInterval(tts.ticker);
    tts.ticker = setInterval(updateProgress, 500);
  }

  function stopTicker() {
    clearInterval(tts.ticker);
    tts.ticker = null;
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
    tts.chunkStartTime = 0;
    clearTimeout(tts.watchdog);
    stopTicker();
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

    tts.chunkStartTime = Date.now();
    const u = new SpeechSynthesisUtterance(tts.chunks[index]);
    u.rate = tts.rate;
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
    startTicker();
  }

  function pauseReading() {
    tts.paused = true;
    tts.speaking = false;
    clearTimeout(tts.watchdog);
    stopTicker();
    synth.pause();
    btnPlay.textContent = '▶';
    updateProgress();
  }

  function resumeReading() {
    tts.paused = false;
    tts.speaking = true;
    tts.chunkStartTime = Date.now(); // reset timer for resumed chunk
    synth.resume();
    btnPlay.textContent = '⏸';
    resetWatchdog();
    startTicker();
  }

  function stopReading() {
    synth.cancel();
    tts.speaking = false;
    tts.paused = false;
    tts.index = 0;
    tts.chunkStartTime = 0;
    clearTimeout(tts.watchdog);
    stopTicker();
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

  // Speed button: cycles 1× → 1.5× → 2× → 0.75× → 1×
  const SPEEDS = [1.0, 1.5, 2.0, 0.75];
  btnSpeed.addEventListener('click', () => {
    const next = SPEEDS[(SPEEDS.indexOf(tts.rate) + 1) % SPEEDS.length];
    tts.rate = next;
    btnSpeed.textContent = `${next}×`;
    // If already speaking, restart current chunk at new rate
    if (tts.speaking && !tts.paused) {
      synth.cancel();
      speakChunk(tts.index);
    }
  });

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
        // Recompute time estimates for new content
        chunkDurations.length = 0;
        tts.chunks.forEach(c => chunkDurations.push((c.trim().split(/\s+/).length / 150) * 60));
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
