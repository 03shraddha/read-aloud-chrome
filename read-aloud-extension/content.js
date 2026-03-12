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

  // Re-show the widget when the user clicks the extension icon after dismissing it
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'show') runInitWithRetry();
  });

  // ─── 6. SPA NAVIGATION DETECTION ─────────────────────────────────────────────
  // React, Next.js, Substack, Medium navigate via history API without page reload.
  // Detect URL changes, tear down old UI, and re-initialise for the new article.
  function onUrlChange() {
    const newUrl = location.href;
    if (newUrl === lastUrl) return;
    lastUrl = newUrl;

    // Stop any active speech before tearing down
    window.speechSynthesis.cancel();

    // Remove old badge/player and selection button
    document.getElementById('ra-host')?.remove();
    document.getElementById('ra-sel-host')?.remove();
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
      * { box-sizing: border-box; margin: 0; padding: 0;
          font-family: -apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif; }

      /* ── Badge ───────────────────────────────────────── */
      #badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: rgba(255,255,255,0.92);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(0,0,0,0.08);
        color: #1c1c1e;
        padding: 6px 13px 6px 10px;
        border-radius: 20px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
        box-shadow: 0 2px 12px rgba(0,0,0,0.1);
        transition: box-shadow 0.2s, transform 0.2s;
      }
      #badge:hover  { transform: scale(1.02); box-shadow: 0 4px 20px rgba(0,0,0,0.14); }
      #badge:active { transform: scale(0.98); }

      /* Dismiss ×  on the badge */
      #badge-dismiss {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: transparent;
        color: #8e8e93;
        font-size: 11px;
        line-height: 1;
        cursor: pointer;
        flex-shrink: 0;
        transition: color 0.15s, background 0.15s;
        margin-left: 2px;
      }
      #badge-dismiss:hover { background: #e5e5ea; color: #3a3a3c; }

      /* ── Player card ─────────────────────────────────── */
      #player {
        display: none;
        flex-direction: column;
        background: rgba(255,255,255,0.94);
        backdrop-filter: blur(24px);
        -webkit-backdrop-filter: blur(24px);
        border: 1px solid rgba(0,0,0,0.08);
        border-radius: 22px;
        box-shadow: 0 8px 40px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06);
        width: 280px;
        padding: 16px 16px 14px;
        gap: 0;
      }
      #player.visible { display: flex; }

      /* Header row */
      #player-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 14px;
      }
      #player-title {
        font-size: 12px;
        font-weight: 600;
        color: #8e8e93;
        letter-spacing: 0.3px;
        text-transform: uppercase;
      }

      /* Close button */
      #btn-close {
        background: #e5e5ea;
        border: none;
        border-radius: 50%;
        width: 22px;
        height: 22px;
        font-size: 11px;
        color: #6c6c70;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s;
        flex-shrink: 0;
      }
      #btn-close:hover { background: #d1d1d6; }

      /* ── Scrubber ────────────────────────────────────── */
      #scrubber-track {
        height: 4px;
        background: #e5e5ea;
        border-radius: 99px;
        margin-bottom: 6px;
        cursor: pointer;
        position: relative;
        /* Expand hit area without changing visual size */
        padding: 8px 0;
        margin-top: -8px;
        margin-bottom: -2px;
      }
      #scrubber-fill {
        height: 4px;
        width: 0%;
        background: #ff375f;
        border-radius: 99px;
        transition: width 0.5s linear;
        position: relative;
        pointer-events: none;
      }
      #scrubber-thumb {
        position: absolute;
        right: -5px;
        top: 50%;
        transform: translateY(-50%);
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #ff375f;
        opacity: 0;
        transition: opacity 0.15s;
        pointer-events: none;
      }
      #scrubber-track:hover #scrubber-thumb { opacity: 1; }
      #scrubber-track:hover #scrubber-fill { transition: none; }

      /* Time labels */
      #progress-times {
        display: flex;
        justify-content: space-between;
        margin-bottom: 14px;
        font-size: 11px;
        font-weight: 400;
        color: #8e8e93;
        font-variant-numeric: tabular-nums;
      }

      /* ── Controls ────────────────────────────────────── */
      #player-controls {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      /* Speed pill */
      #btn-speed {
        background: #e5e5ea;
        border: none;
        border-radius: 999px;
        padding: 5px 11px;
        font-size: 12px;
        font-weight: 600;
        color: #3a3a3c;
        cursor: pointer;
        transition: background 0.15s;
        flex-shrink: 0;
      }
      #btn-speed:hover { background: #d1d1d6; }
      #btn-speed:disabled { opacity: 0.35; cursor: not-allowed; }

      /* Play/pause — large center button */
      #btn-play {
        background: #ff375f;
        border: none;
        border-radius: 50%;
        width: 48px;
        height: 48px;
        font-size: 18px;
        color: #fff;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.15s, background 0.15s;
        flex-shrink: 0;
      }
      #btn-play:hover  { transform: scale(1.06); }
      #btn-play:active { transform: scale(0.94); }
      #btn-play:disabled { opacity: 0.35; cursor: not-allowed; transform: none; }

      /* Dismiss (was stop) — matches speed pill width visually */
      #btn-stop {
        background: #e5e5ea;
        border: none;
        border-radius: 999px;
        padding: 5px 11px;
        font-size: 12px;
        font-weight: 500;
        color: #3a3a3c;
        cursor: pointer;
        transition: background 0.15s;
        flex-shrink: 0;
      }
      #btn-stop:hover { background: #d1d1d6; }
      #btn-stop:disabled { opacity: 0.35; cursor: not-allowed; }
    </style>

    <!-- Badge -->
    <div id="badge">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
        <path d="M3 18v-6a9 9 0 0118 0v6" stroke="#ff375f" stroke-width="2.5" stroke-linecap="round"/>
        <rect x="1" y="16" width="4" height="6" rx="2" fill="#ff375f"/>
        <rect x="19" y="16" width="4" height="6" rx="2" fill="#ff375f"/>
      </svg>
      <span id="badge-label">${hasContent ? readingTime(articleText) : '< 1 min read'}</span>
      <span id="badge-dismiss" title="Dismiss">✕</span>
    </div>

    <!-- Player -->
    <div id="player">
      <div id="player-head">
        <span id="player-title">Read Aloud</span>
        <button id="btn-close" title="Minimise">✕</button>
      </div>

      <!-- Scrubber -->
      <div id="scrubber-track">
        <div id="scrubber-fill">
          <div id="scrubber-thumb"></div>
        </div>
      </div>
      <div id="progress-times">
        <span id="time-elapsed">0:00</span>
        <span id="time-total">${hasContent ? secsToMMSS(totalSecs()) : '--:--'}</span>
      </div>

      <!-- Controls: speed · play · dismiss -->
      <div id="player-controls">
        <button id="btn-speed" title="Speed">1×</button>
        <button id="btn-play" title="Play · Alt+Shift+R">▶</button>
        <button id="btn-stop" title="Dismiss">Done</button>
      </div>
    </div>
  `;

  // ─── DOM REFERENCES ───────────────────────────────────────────────────────────
  const badge        = shadow.getElementById('badge');
  const badgeLabel   = shadow.getElementById('badge-label');
  const player       = shadow.getElementById('player');
  const btnPlay      = shadow.getElementById('btn-play');
  const btnStop      = shadow.getElementById('btn-stop');
  const btnSpeed     = shadow.getElementById('btn-speed');
  const timeElapsed  = shadow.getElementById('time-elapsed');
  const scrubberFill = shadow.getElementById('scrubber-fill');

  if (!hasContent) {
    btnPlay.disabled = true;
    btnSpeed.disabled = true;
  }

  // Dismiss × on badge — remove the whole widget
  shadow.getElementById('badge-dismiss').addEventListener('click', (e) => {
    e.stopPropagation(); // don't also open the player
    synth.cancel();
    clearTimeout(tts.watchdog);
    stopTicker();
    document.getElementById('ra-sel-host')?.remove();
    uiCreated = false; // allow re-init when icon is clicked again
    host.remove();
  });

  // Toggle badge ↔ player
  badge.addEventListener('click', () => {
    badge.style.display = 'none';
    player.classList.add('visible');
  });

  shadow.getElementById('btn-close').addEventListener('click', () => {
    synth.cancel();
    clearTimeout(tts.watchdog);
    stopTicker();
    tts.speaking = false;
    tts.paused = false;
    tts.chunkStartTime = 0;
    btnPlay.textContent = '▶';
    player.classList.remove('visible');
    badge.style.display = '';
  });

  // ─── TTS ENGINE ───────────────────────────────────────────────────────────────
  const synth = window.speechSynthesis;

  function updateProgress() {
    if (totalSecs() === 0) return; // nothing to display
    const liveOffset = tts.speaking && !tts.paused && tts.chunkStartTime
      ? (Date.now() - tts.chunkStartTime) / 1000 / tts.rate
      : 0;
    const elapsed = Math.min(elapsedSecs(tts.index) + liveOffset, totalSecs());
    const total = totalSecs();
    timeElapsed.textContent = secsToMMSS(elapsed);
    scrubberFill.style.width = total > 0 ? `${(elapsed / total) * 100}%` : '0%';
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

  // Saved article chunks — set when reading a selection so we can restore after
  let savedChunks = null;
  let savedChunkDurations = null;

  function restoreArticleChunks() {
    if (!savedChunks) return;
    tts.chunks.length = 0;
    savedChunks.forEach(c => tts.chunks.push(c));
    chunkDurations.length = 0;
    savedChunkDurations.forEach(d => chunkDurations.push(d));
    savedChunks = null;
    savedChunkDurations = null;
    shadow.getElementById('time-total').textContent = secsToMMSS(totalSecs());
  }

  function onFinished() {
    tts.speaking = false;
    tts.paused = false;
    tts.index = 0;
    tts.chunkStartTime = 0;
    clearTimeout(tts.watchdog);
    stopTicker();
    btnPlay.textContent = '▶';
    restoreArticleChunks(); // restore article if we were reading a selection
    updateProgress();
  }

  // Generation counter — incremented on every queueFromIndex call.
  // Callbacks from a cancelled/stale queue will see gen !== queueGen and bail,
  // preventing Chrome's spurious onend events from resetting tts.index/tts.speaking.
  let queueGen = 0;

  // Queue ALL remaining chunks at once so Chrome plays them in sequence even in
  // background tabs (Chrome blocks new JS-initiated speak() calls when backgrounded,
  // but continues playing an already-loaded queue).
  function queueFromIndex(startIdx) {
    synth.cancel();
    queueGen++;
    const gen = queueGen;
    tts.index = startIdx;
    updateProgress();

    for (let i = startIdx; i < tts.chunks.length; i++) {
      const idx = i;
      const u = new SpeechSynthesisUtterance(tts.chunks[i]);
      u.rate = tts.rate;
      u.lang = pageLang;

      u.onstart = () => {
        if (queueGen !== gen) return; // stale queue — ignore
        tts.index = idx;
        tts.chunkStartTime = Date.now();
        updateProgress();
      };

      u.onend = () => {
        if (queueGen !== gen) return; // stale queue — ignore
        clearTimeout(tts.watchdog);
        if (idx >= tts.chunks.length - 1) {
          onFinished();
        } else {
          tts.index = idx + 1;
          resetWatchdog();
        }
      };

      u.onerror = (e) => {
        if (queueGen !== gen) return; // stale queue — ignore
        if (e.error !== 'interrupted') {
          console.warn('[ReadAloud] TTS error:', e.error);
          onFinished();
        }
      };

      synth.speak(u);
    }
    resetWatchdog();
  }

  function startReading() {
    tts.speaking = true;
    tts.paused = false;
    btnPlay.textContent = '⏸';
    queueFromIndex(tts.index);
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

  // ─── SCRUBBER SEEK ────────────────────────────────────────────────────────────
  function seekToRatio(ratio) {
    if (tts.chunks.length === 0) return;
    const targetSecs = Math.max(0, Math.min(1, ratio)) * totalSecs();

    // Find the chunk index at this time position
    let acc = 0, idx = chunkDurations.length - 1;
    for (let i = 0; i < chunkDurations.length; i++) {
      if (acc + chunkDurations[i] > targetSecs) { idx = i; break; }
      acc += chunkDurations[i];
    }

    const wasPlaying = tts.speaking && !tts.paused;
    synth.cancel();
    clearTimeout(tts.watchdog);
    stopTicker();
    tts.index = idx;
    tts.chunkStartTime = 0;
    tts.speaking = false;
    tts.paused = false;

    // Jump scrubber immediately (no transition lag)
    scrubberFill.style.transition = 'none';
    updateProgress();
    requestAnimationFrame(() => { scrubberFill.style.transition = ''; });

    if (wasPlaying) {
      tts.speaking = true;
      btnPlay.textContent = '⏸';
      queueFromIndex(idx);
      startTicker();
    } else {
      synth.cancel();
      btnPlay.textContent = '▶';
    }
  }

  // ─── BUTTON HANDLERS ──────────────────────────────────────────────────────────
  btnPlay.addEventListener('click', () => {
    if (!tts.speaking && !tts.paused) startReading();    // fresh start
    else if (tts.speaking && !tts.paused) pauseReading(); // pause
    else if (tts.paused) resumeReading();                // resume
  });

  // "Done" dismisses the entire widget and stops audio
  shadow.getElementById('btn-stop').addEventListener('click', () => {
    synth.cancel();
    clearTimeout(tts.watchdog);
    stopTicker();
    document.getElementById('ra-sel-host')?.remove();
    uiCreated = false; // allow re-init when icon is clicked again
    host.remove();
  });

  // Scrubber click → seek to that position
  shadow.getElementById('scrubber-track').addEventListener('click', (e) => {
    const track = e.currentTarget;
    const rect = track.getBoundingClientRect();
    seekToRatio((e.clientX - rect.left) / rect.width);
  });

  // Speed button: cycles 1× → 1.5× → 2× → 0.75× → 1×
  const SPEEDS = [1.0, 1.5, 2.0, 0.75];
  btnSpeed.addEventListener('click', () => {
    const next = SPEEDS[(SPEEDS.indexOf(tts.rate) + 1) % SPEEDS.length];
    tts.rate = next;
    btnSpeed.textContent = `${next}×`;
    // Re-queue at new rate if playing (all queued utterances had old rate baked in)
    if (tts.speaking && !tts.paused) queueFromIndex(tts.index);
  });

  // Keyboard shortcut: Alt+Shift+R to toggle play/pause
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.key === 'R') {
      if (!tts.speaking && !tts.paused) startReading();
      else if (tts.speaking) pauseReading();
      else if (tts.paused) resumeReading();
    }
  });

  // Tab visibility: if TTS died while backgrounded (Chrome bug), restart queue on return.
  // With the queued approach this should rarely be needed, but kept as a safety net.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && tts.speaking && !tts.paused) {
      if (!synth.speaking && !synth.pending) {
        queueFromIndex(tts.index);
      }
    }
  });

  // Clean up on full page navigation
  window.addEventListener('beforeunload', () => {
    synth.cancel();
    clearTimeout(tts.watchdog);
  });

  // ─── SELECTION READING ───────────────────────────────────────────────────────
  // Shows a small floating button when the user selects text.
  // Clicking it reads just the selected portion; article resumes after.
  const selHost = document.createElement('div');
  selHost.id = 'ra-sel-host';
  selHost.style.cssText = 'all: initial; position: fixed; z-index: 2147483646; pointer-events: none;';
  document.body.appendChild(selHost);

  const selShadow = selHost.attachShadow({ mode: 'open' });
  selShadow.innerHTML = `
    <style>
      #sel-btn {
        display: none; align-items: center; gap: 5px;
        background: #ff375f; color: #fff; border: none; border-radius: 16px;
        padding: 5px 12px 5px 9px;
        font-family: -apple-system, 'Helvetica Neue', sans-serif;
        font-size: 12px; font-weight: 600; cursor: pointer;
        pointer-events: all;
        box-shadow: 0 2px 12px rgba(255,55,95,0.35);
        white-space: nowrap; user-select: none; transition: transform 0.15s;
      }
      #sel-btn.visible { display: inline-flex; }
      #sel-btn:hover  { transform: scale(1.04); }
      #sel-btn:active { transform: scale(0.96); }
    </style>
    <button id="sel-btn">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" style="flex-shrink:0">
        <path d="M3 18v-6a9 9 0 0118 0v6" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>
        <rect x="1" y="16" width="4" height="6" rx="2" fill="#fff"/>
        <rect x="19" y="16" width="4" height="6" rx="2" fill="#fff"/>
      </svg>
      Read selection
    </button>
  `;

  const selBtn = selShadow.getElementById('sel-btn');
  function hideSelBtn() { selBtn.classList.remove('visible'); }

  document.addEventListener('mouseup', (e) => {
    setTimeout(() => {
      const text = window.getSelection()?.toString().trim() ?? '';
      if (text.split(/\s+/).length >= 3) {
        selHost.style.left = `${Math.min(e.clientX, window.innerWidth - 160)}px`;
        selHost.style.top  = `${Math.max(e.clientY - 44, 8)}px`;
        selBtn.classList.add('visible');
      } else {
        hideSelBtn();
      }
    }, 10);
  });

  document.addEventListener('mousedown', (e) => {
    if (!e.composedPath().includes(selHost)) hideSelBtn();
  });

  selBtn.addEventListener('click', () => {
    const text = window.getSelection()?.toString().trim() ?? '';
    if (!text) return;
    hideSelBtn();
    window.getSelection().removeAllRanges();

    // Save article chunks so we can restore them when selection finishes
    if (!savedChunks) {
      savedChunks = [...tts.chunks];
      savedChunkDurations = [...chunkDurations];
    }

    // Swap in selected text as the chunks to read
    const selChunks = buildChunks(text);
    tts.chunks.length = 0; selChunks.forEach(c => tts.chunks.push(c));
    chunkDurations.length = 0;
    selChunks.forEach(c => chunkDurations.push((c.trim().split(/\s+/).length / 150) * 60));
    tts.index = 0;
    shadow.getElementById('time-total').textContent = secsToMMSS(totalSecs());
    updateProgress();

    // Open player and start reading (enable controls even if page had no article)
    btnPlay.disabled = false;
    btnSpeed.disabled = false;
    badge.style.display = 'none';
    player.classList.add('visible');
    tts.speaking = true;
    tts.paused = false;
    btnPlay.textContent = '⏸';
    queueFromIndex(0);
    startTicker();
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
