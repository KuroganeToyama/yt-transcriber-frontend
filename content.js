"use strict";

const PANEL_ID = "yt-transcriber-panel";

let currentVideoId = null;
let segments = [];
let rafId = null;
let videoEl = null;
let activeIndex = -1;
let theaterObserver = null;
let stickyObserver = null;
let loadTimer = null;

// UI state — persists across panel re-injections
let uiStatus = "";
let uiStatusIsError = false;
let uiProgress = 0;
// 'idle' | 'processing' | 'done'
let panelState = "idle";

// kept for backward compat with syncPanelState segment restore
let transcriptReady = false;

let videoTitleEn = "";

// ─── Message Listener ─────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg) => {
  if (!msg.videoId || msg.videoId !== currentVideoId) return;

  switch (msg.type) {
    case "TRANSCRIPT_PROGRESS":
      updateStatus(
        stageLabel(msg.stage) +
          (msg.progress > 0 ? ` (${Math.round(msg.progress * 100)}%)` : "")
      );
      updateProgressBar(msg.progress);
      break;

    case "TRANSCRIPT_READY":
      segments = msg.transcript.segments || [];
      videoTitleEn = msg.transcript.titleEn || "";
      transcriptReady = true;
      panelState = "done";
      updateProgressBar(1);
      updateStatus("");
      // If YouTube ejected the panel, put it back immediately before rendering
      if (!document.getElementById(PANEL_ID)) {
        const anchor = findRelatedAnchor();
        const panel = buildPanelElement();
        insertPanel(panel, anchor);
      }
      renderVideoTitle();
      renderSegments();
      startPlaybackSync();
      applyPanelButtons();
      break;

    case "TRANSCRIPT_ERROR":
      panelState = "idle";
      updateStatus(`Error: ${msg.error}`, true);
      updateProgressBar(0);
      applyPanelButtons();
      break;

    case "TRANSCRIPT_CANCELLED":
      panelState = "idle";
      updateStatus("Cancelled.");
      updateProgressBar(0);
      applyPanelButtons();
      break;
  }
});

// ─── Navigation Detection ─────────────────────────────────────────────────────

// YouTube fires 'yt-navigate-finish' on every SPA navigation.
// Fall back to patching history.pushState for any edge cases.
function onUrlChange() {
  if (isWatchPage()) {
    schedulePageLoad();
  } else {
    teardown();
  }
}

window.addEventListener("yt-navigate-finish", onUrlChange);
window.addEventListener("popstate", onUrlChange);

// Patch pushState so navigations that don't fire popstate are caught.
(function () {
  const origPush = history.pushState.bind(history);
  history.pushState = function (...args) {
    origPush(...args);
    onUrlChange();
  };
})();

// Initial load
if (isWatchPage()) {
  schedulePageLoad();
}

// ─── Page Load ────────────────────────────────────────────────────────────────

function isWatchPage() {
  return (
    location.pathname === "/watch" &&
    new URLSearchParams(location.search).has("v")
  );
}

function schedulePageLoad() {
  if (loadTimer) clearTimeout(loadTimer);
  loadTimer = setTimeout(tryPageLoad, 800);
}

// Returns the container that holds the recommendations (right sidebar).
// We anchor to #related (ytd-watch-next-secondary-results-renderer) when
// available, because its parent is definitively #secondary-inner.
function findRelatedAnchor() {
  return (
    document.getElementById("related") ||
    document.getElementById("secondary-inner") ||
    document.getElementById("secondary")
  );
}

function findVideoElement() {
  return (
    document.querySelector("#movie_player video") ||
    document.querySelector("ytd-player video") ||
    document.querySelector("video")
  );
}

function tryPageLoad() {
  const anchor = findRelatedAnchor();
  const secondary = document.getElementById("secondary");
  const video = findVideoElement();

  if (!anchor || !secondary || !video) {
    // DOM not ready yet; retry
    loadTimer = setTimeout(tryPageLoad, 500);
    return;
  }

  const videoId = new URLSearchParams(location.search).get("v");
  if (!videoId) return;
  if (videoId === currentVideoId) return; // Already loaded for this video

  currentVideoId = videoId;
  segments = [];
  activeIndex = -1;
  videoEl = findVideoElement();

  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  injectPanel();
  setupTheaterObserver();
}

function startTranscription() {
  if (!currentVideoId) return;
  panelState = "processing";
  applyPanelButtons();
  const url = location.href;
  const titleEl =
    document.querySelector("yt-formatted-string.style-scope.ytd-watch-metadata") ||
    document.querySelector("#title h1 yt-formatted-string") ||
    document.querySelector("h1.title");
  const title = titleEl ? titleEl.textContent.trim() : document.title;

  // Switch panel into processing mode
  updateStatus("Connecting to backend\u2026");
  updateProgressBar(0);

  browser.runtime.sendMessage({
    type: "START_TRANSCRIPT",
    videoId: currentVideoId,
    url,
    title,
  });
}

// ─── Panel Injection ──────────────────────────────────────────────────────────

function injectPanel() {
  const existing = document.getElementById(PANEL_ID);
  if (existing) existing.remove();

  const anchor = findRelatedAnchor();
  const panel = buildPanelElement();
  insertPanel(panel, anchor);
  applyPanelButtons();
  startStickyObserver();
}

// ─── Sticky Observer (re-insert panel if YouTube ejects it) ─────────────────

function startStickyObserver() {
  if (stickyObserver) {
    stickyObserver.disconnect();
    stickyObserver = null;
  }

  // subtree:true catches panel removal anywhere inside #secondary.
  // The debounce coalesces rapid framework mutations into a single check.
  const secondary = document.getElementById("secondary");
  if (!secondary) return;

  let debounceTimer = null;
  stickyObserver = new MutationObserver(() => {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!currentVideoId) return;
      if (!document.getElementById(PANEL_ID)) {
        const anchor = findRelatedAnchor();
        const panel = buildPanelElement();
        insertPanel(panel, anchor);
        syncPanelState(panel);
      }
    }, 150);
  });

  stickyObserver.observe(secondary, { childList: true, subtree: true });
}

function buildPanelElement() {
  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="ytt-header">
      <span class="ytt-title">&#9654; Transcript</span>
      <div class="ytt-controls">
        <button class="ytt-btn ytt-btn-transcribe" id="ytt-transcribe-btn" title="Transcribe this video">Transcribe</button>
        <button class="ytt-btn" id="ytt-refresh-btn" title="Clear cache and re-fetch">&#8635;</button>
        <button class="ytt-btn" id="ytt-cancel-btn" title="Cancel processing">&#10005;</button>
      </div>
    </div>
    <div class="ytt-status" id="ytt-status"></div>
    <div class="ytt-progress-bar-wrap">
      <div class="ytt-progress-bar" id="ytt-progress-bar"></div>
    </div>
    <div class="ytt-video-title" id="ytt-video-title"></div>
    <div class="ytt-segments" id="ytt-segments"></div>
  `;
  attachPanelHandlers(panel);
  return panel;
}

function insertPanel(panel, anchor) {
  if (anchor && anchor.id === "related" && anchor.parentNode) {
    anchor.parentNode.insertBefore(panel, anchor);
  } else if (anchor) {
    anchor.insertBefore(panel, anchor.firstChild);
  } else {
    document.body.appendChild(panel);
  }
}

// Applies the correct button visibility to the panel in the DOM.
// Always driven from panelState so re-injections get it right too.
function applyPanelButtons() {
  const tb = document.getElementById("ytt-transcribe-btn");
  const cb = document.getElementById("ytt-cancel-btn");
  const rb = document.getElementById("ytt-refresh-btn");
  if (!tb || !cb || !rb) return;
  if (panelState === "idle") {
    tb.style.display = "inline-block";
    cb.style.display = "none";
    rb.style.display = "none";
  } else if (panelState === "processing") {
    tb.style.display = "none";
    cb.style.display = "inline-block";
    rb.style.display = "inline-block";
  } else { // done
    tb.style.display = "none";
    cb.style.display = "none";
    rb.style.display = "inline-block";
  }
}

function syncPanelState(panel) {
  // Restore status bar
  const el = panel.querySelector("#ytt-status");
  if (el) {
    el.textContent = uiStatus;
    el.classList.toggle("ytt-error", uiStatusIsError);
    el.style.display = uiStatus ? "block" : "none";
  }
  // Restore progress bar
  const bar = panel.querySelector("#ytt-progress-bar");
  if (bar) {
    bar.style.width = `${Math.round(Math.min(1, Math.max(0, uiProgress)) * 100)}%`;
  }
  // Restore video title
  const titleEl = panel.querySelector("#ytt-video-title");
  if (titleEl) {
    titleEl.textContent = videoTitleEn;
    titleEl.style.display = videoTitleEn ? "block" : "none";
  }
  // Restore segments and playback sync if transcript is ready
  if (transcriptReady && segments.length > 0) {
    renderSegments();
    if (activeIndex >= 0) highlightSegment(activeIndex);
    startPlaybackSync();
  }
  // Always restore correct button state
  applyPanelButtons();
}

function attachPanelHandlers(panel) {
  const transcribeBtn = panel.querySelector("#ytt-transcribe-btn");
  const cancelBtn = panel.querySelector("#ytt-cancel-btn");
  const refreshBtn = panel.querySelector("#ytt-refresh-btn");

  transcribeBtn.addEventListener("click", () => {
    startTranscription();
  });

  cancelBtn.addEventListener("click", () => {
    browser.runtime.sendMessage({ type: "CANCEL_JOB", videoId: currentVideoId });
    panelState = "idle";
    updateStatus("Cancelled.");
    updateProgressBar(0);
    applyPanelButtons();
  });

  refreshBtn.addEventListener("click", () => {
    if (!currentVideoId) return;
    if (panelState === "processing") {
      // Manual status check — don't restart, just force an immediate poll
      browser.runtime.sendMessage({ type: "POLL_NOW", videoId: currentVideoId });
      updateStatus("Checking status\u2026");
    } else {
      // Done state — clear cache and re-transcribe
      browser.runtime.sendMessage({ type: "CLEAR_CACHE", videoId: currentVideoId });
      transcriptReady = false;
      segments = [];
      activeIndex = -1;
      renderSegments();
      startTranscription();
    }
  });
}

// ─── Theater Mode ─────────────────────────────────────────────────────────────

function setupTheaterObserver() {
  if (theaterObserver) {
    theaterObserver.disconnect();
    theaterObserver = null;
  }

  const watchFlexy = document.querySelector("ytd-watch-flexy");
  if (!watchFlexy) return;

  function applyTheaterLayout() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const isTheater = watchFlexy.hasAttribute("theater");
    panel.classList.toggle("ytt-theater", isTheater);

    if (isTheater) {
      // In theater mode the secondary sidebar is hidden; move panel below primary
      const primary = document.getElementById("primary");
      if (primary && !primary.contains(panel)) {
        primary.appendChild(panel);
      }
    } else {
      // Restore panel before #related in the right sidebar
      const anchor = findRelatedAnchor();
      if (anchor && anchor.id === "related" && anchor.parentNode && !anchor.parentNode.contains(panel)) {
        anchor.parentNode.insertBefore(panel, anchor);
      } else if (anchor && anchor.id !== "related" && !anchor.contains(panel)) {
        anchor.insertBefore(panel, anchor.firstChild);
      }
    }
  }

  theaterObserver = new MutationObserver(applyTheaterLayout);
  theaterObserver.observe(watchFlexy, {
    attributes: true,
    attributeFilter: ["theater"],
  });

  applyTheaterLayout(); // Run immediately for the current state
}

// ─── Video Title ──────────────────────────────────────────────────────────────

function renderVideoTitle() {
  const el = document.getElementById("ytt-video-title");
  if (!el) return;
  if (videoTitleEn) {
    el.textContent = videoTitleEn;
    el.style.display = "block";
  } else {
    el.style.display = "none";
  }
}

// ─── Segment Rendering ────────────────────────────────────────────────────────

function renderSegments() {
  const container = document.getElementById("ytt-segments");
  if (!container) return;

  if (segments.length === 0) {
    container.innerHTML = '<div class="ytt-empty">No segments available.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  segments.forEach((seg, i) => {
    const row = document.createElement("div");
    row.className = "ytt-segment";
    row.dataset.index = i;
    row.dataset.start = seg.start;
    row.dataset.end = seg.end;

    const time = document.createElement("span");
    time.className = "ytt-time";
    time.textContent = formatTime(seg.start);

    const text = document.createElement("span");
    text.className = "ytt-text";
    text.textContent = seg.en;

    row.appendChild(time);
    row.appendChild(text);

    row.addEventListener("click", () => {
      if (videoEl) {
        videoEl.currentTime = seg.start;
        videoEl.play();
      }
    });

    fragment.appendChild(row);
  });

  container.innerHTML = "";
  container.appendChild(fragment);
}

// ─── Playback Sync ────────────────────────────────────────────────────────────

function startPlaybackSync() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;

  if (!videoEl) return;

  function tick() {
    if (videoEl && segments.length > 0) {
      const newIndex = findActiveSegment(videoEl.currentTime);
      if (newIndex !== activeIndex) {
        highlightSegment(newIndex);
        activeIndex = newIndex;
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  function startRaf() {
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  function stopRaf() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  // Only run the RAF loop while the video is actually playing
  videoEl.addEventListener("play",   startRaf);
  videoEl.addEventListener("pause",  stopRaf);
  videoEl.addEventListener("ended",  stopRaf);

  // Start immediately if already playing
  if (!videoEl.paused) startRaf();
}

function findActiveSegment(t) {
  // Binary search for the last segment whose start <= t
  let lo = 0;
  let hi = segments.length - 1;
  let result = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start <= t) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  // Confirm that t falls within [start, end]
  if (result >= 0 && t <= segments[result].end) return result;
  return -1;
}

function highlightSegment(index) {
  const container = document.getElementById("ytt-segments");
  if (!container) return;

  const prev = container.querySelector(".ytt-segment.active");
  if (prev) prev.classList.remove("active");

  if (index < 0) return;

  const rows = container.querySelectorAll(".ytt-segment");
  if (index >= rows.length) return;

  const row = rows[index];
  row.classList.add("active");

  // Scroll the active segment into the center of the panel
  const rowTop = row.offsetTop;
  const rowHeight = row.offsetHeight;
  const containerHeight = container.clientHeight;
  const targetScroll = rowTop - containerHeight / 2 + rowHeight / 2;
  const currentScroll = container.scrollTop;

  // Only scroll if the row is near the edge of the visible area
  if (
    rowTop < currentScroll + 40 ||
    rowTop + rowHeight > currentScroll + containerHeight - 40
  ) {
    container.scrollTo({ top: targetScroll, behavior: "smooth" });
  }
}

// ─── Status & Progress Bar ────────────────────────────────────────────────────

function updateStatus(message, isError = false) {
  uiStatus = message;
  uiStatusIsError = isError;
  const el = document.getElementById("ytt-status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("ytt-error", isError);
  el.style.display = message ? "block" : "none";
}

function updateProgressBar(progress) {
  uiProgress = progress;
  const bar = document.getElementById("ytt-progress-bar");
  if (bar) {
    bar.style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
  }
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

function teardown() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (theaterObserver) {
    theaterObserver.disconnect();
    theaterObserver = null;
  }
  if (stickyObserver) {
    stickyObserver.disconnect();
    stickyObserver = null;
  }
  if (loadTimer) {
    clearTimeout(loadTimer);
    loadTimer = null;
  }
  const panel = document.getElementById(PANEL_ID);
  if (panel) panel.remove();

  currentVideoId = null;
  segments = [];
  activeIndex = -1;
  videoEl = null;
  uiStatus = "";
  uiStatusIsError = false;
  uiProgress = 0;
  panelState = "idle";
  transcriptReady = false;
  videoTitleEn = "";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(seconds) {
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const ss = String(s % 60).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function stageLabel(stage) {
  const labels = {
    queued: "Queued\u2026",
    downloading: "Downloading audio\u2026",
    extracting: "Extracting audio\u2026",
    chunking: "Chunking audio\u2026",
    transcribing: "Transcribing\u2026",
    translating: "Translating\u2026",
    assembling: "Assembling transcript\u2026",
    complete: "Complete",
    failed: "Failed",
    processing: "Processing\u2026",
  };
  return (
    labels[stage] ||
    (stage
      ? stage.charAt(0).toUpperCase() + stage.slice(1) + "\u2026"
      : "Processing\u2026")
  );
}
