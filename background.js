"use strict";

const BACKEND_BASE = "http://localhost:8000";
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 200; // ~10 minutes total

// Keep the event page alive while any job is polling.
// browser.alarms is the only mechanism Firefox respects for waking
// a suspended event page — setInterval and self-messages do not work.
const KEEP_ALIVE_ALARM = "yt-transcriber-keepalive";

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEP_ALIVE_ALARM) return;
  if (activeJobs.size === 0) {
    browser.alarms.clear(KEEP_ALIVE_ALARM);
  }
  // Just being woken up is enough; the poll loop continues on its own.
});

function startKeepAlive() {
  browser.alarms.get(KEEP_ALIVE_ALARM).then((existing) => {
    if (!existing) {
      browser.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 0.4 }); // every ~24s
    }
  });
}

function stopKeepAlive() {
  browser.alarms.clear(KEEP_ALIVE_ALARM);
}

// Map from videoId -> { tabId, jobId, polling }
const activeJobs = new Map();

// Map from tabId -> videoId (to cancel old jobs when a tab navigates)
const tabToVideo = new Map();

// ─── Message Listener ─────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab ? sender.tab.id : null;

  switch (msg.type) {
    case "START_TRANSCRIPT":
      if (tabId !== null) {
        handleStartTranscript(msg.videoId, msg.url, msg.title, tabId);
      }
      return Promise.resolve({ ok: true });

    case "CANCEL_JOB":
      handleCancelJob(msg.videoId);
      return Promise.resolve({ ok: true });

    case "CLEAR_CACHE":
      handleClearCache(msg.videoId);
      return Promise.resolve({ ok: true });

    case "POLL_NOW":
      if (tabId !== null) handlePollNow(msg.videoId, tabId);
      return Promise.resolve({ ok: true });
  }
});

// ─── Tab cleanup ──────────────────────────────────────────────────────────────

browser.tabs.onRemoved.addListener((tabId) => {
  const videoId = tabToVideo.get(tabId);
  if (videoId) {
    stopPolling(videoId);
    tabToVideo.delete(tabId);
  }
});

// ─── Start Transcript ─────────────────────────────────────────────────────────

async function handleStartTranscript(videoId, url, title, tabId) {
  // Cancel any existing job that was running for this tab
  const oldVideoId = tabToVideo.get(tabId);
  if (oldVideoId && oldVideoId !== videoId) {
    stopPolling(oldVideoId);
  }
  tabToVideo.set(tabId, videoId);

  // Stop any existing poll for this videoId
  stopPolling(videoId);
  activeJobs.set(videoId, { tabId, jobId: null, polling: true });
  startKeepAlive();

  // Check local extension cache first
  const cached = await loadFromCache(videoId);
  if (cached) {
    sendToTab(tabId, { type: "TRANSCRIPT_READY", videoId, transcript: cached });
    finishJob(videoId);
    return;
  }

  // Notify content script we are contacting the backend
  sendToTab(tabId, { type: "TRANSCRIPT_PROGRESS", videoId, stage: "queued", progress: 0 });

  // Create job on backend
  let jobId;
  try {
    const resp = await fetch(`${BACKEND_BASE}/api/jobs/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId, url, title }),
    });
    if (!resp.ok) throw new Error(`Backend returned ${resp.status}`);
    const data = await resp.json();

    // Backend already had this transcript cached
    if (data.status === "complete") {
      const transcript = await fetchTranscriptFromBackend(videoId);
      await saveToCache(videoId, transcript);
      sendToTab(tabId, { type: "TRANSCRIPT_READY", videoId, transcript });
      finishJob(videoId);
      return;
    }

    jobId = data.jobId;
    const entry = activeJobs.get(videoId);
    if (entry) entry.jobId = jobId;
  } catch (err) {
    sendToTab(tabId, { type: "TRANSCRIPT_ERROR", videoId, error: err.message });
    finishJob(videoId);
    return;
  }

  // Poll until the job completes
  await pollJob(jobId, videoId, tabId);
}

function finishJob(videoId) {
  activeJobs.delete(videoId);
  if (activeJobs.size === 0) stopKeepAlive();
}

// ─── Polling ──────────────────────────────────────────────────────────────────

async function pollJob(jobId, videoId, tabId) {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    const entry = activeJobs.get(videoId);
    if (!entry || !entry.polling) return; // Cancelled or superseded

    let job;
    try {
      const resp = await fetch(`${BACKEND_BASE}/api/jobs/${jobId}`);
      if (!resp.ok) throw new Error(`Job poll returned ${resp.status}`);
      job = await resp.json();
    } catch (err) {
      sendToTab(tabId, { type: "TRANSCRIPT_ERROR", videoId, error: err.message });
      finishJob(videoId);
      return;
    }

    sendToTab(tabId, {
      type: "TRANSCRIPT_PROGRESS",
      videoId,
      stage: job.stage || job.status,
      progress: typeof job.progress === "number" ? job.progress : 0,
    });

    if (job.status === "complete") {
      try {
        const transcript = await fetchTranscriptFromBackend(videoId);
        await saveToCache(videoId, transcript);
        sendToTab(tabId, { type: "TRANSCRIPT_READY", videoId, transcript });
      } catch (err) {
        sendToTab(tabId, { type: "TRANSCRIPT_ERROR", videoId, error: err.message });
      }
      finishJob(videoId);
      return;
    }

    if (job.status === "failed") {
      sendToTab(tabId, {
        type: "TRANSCRIPT_ERROR",
        videoId,
        error: job.error || "Processing failed",
      });
      finishJob(videoId);
      return;
    }

    if (job.status === "cancelled") {
      sendToTab(tabId, { type: "TRANSCRIPT_CANCELLED", videoId });
      finishJob(videoId);
      return;
    }
  }

  sendToTab(tabId, {
    type: "TRANSCRIPT_ERROR",
    videoId,
    error: "Timed out waiting for transcript",
  });
  finishJob(videoId);
}

// ─── Poll Now (manual status check) ──────────────────────────────────────────

async function handlePollNow(videoId, tabId) {
  const entry = activeJobs.get(videoId);

  // If polling is still running, just let it continue — it will update soon.
  // But also do an immediate one-off check so the UI refreshes right away.
  const jobId = entry ? entry.jobId : null;

  // Check if the transcript is already cached (job may have finished while
  // the UI was out of sync).
  const cached = await loadFromCache(videoId);
  if (cached) {
    sendToTab(tabId, { type: "TRANSCRIPT_READY", videoId, transcript: cached });
    stopPolling(videoId);
    return;
  }

  if (!jobId) {
    // No active job — check the backend transcript endpoint directly.
    try {
      const transcript = await fetchTranscriptFromBackend(videoId);
      await saveToCache(videoId, transcript);
      sendToTab(tabId, { type: "TRANSCRIPT_READY", videoId, transcript });
      stopPolling(videoId);
    } catch (_) {
      sendToTab(tabId, {
        type: "TRANSCRIPT_ERROR",
        videoId,
        error: "No active job and no transcript found.",
      });
    }
    return;
  }

  // Fetch the current job status and relay it to the tab immediately.
  try {
    const resp = await fetch(`${BACKEND_BASE}/api/jobs/${jobId}`);
    if (!resp.ok) throw new Error(`Job poll returned ${resp.status}`);
    const job = await resp.json();

    if (job.status === "complete") {
      const transcript = await fetchTranscriptFromBackend(videoId);
      await saveToCache(videoId, transcript);
      sendToTab(tabId, { type: "TRANSCRIPT_READY", videoId, transcript });
      stopPolling(videoId);
    } else if (job.status === "failed") {
      sendToTab(tabId, {
        type: "TRANSCRIPT_ERROR",
        videoId,
        error: job.error || "Processing failed",
      });
      stopPolling(videoId);
    } else {
      sendToTab(tabId, {
        type: "TRANSCRIPT_PROGRESS",
        videoId,
        stage: job.stage || job.status,
        progress: typeof job.progress === "number" ? job.progress : 0,
      });
    }
  } catch (err) {
    sendToTab(tabId, { type: "TRANSCRIPT_ERROR", videoId, error: err.message });
  }
}

// ─── Cancel ───────────────────────────────────────────────────────────────────

async function handleCancelJob(videoId) {
  const entry = activeJobs.get(videoId);
  if (!entry) return;

  entry.polling = false;

  if (entry.jobId) {
    try {
      await fetch(`${BACKEND_BASE}/api/jobs/${entry.jobId}/cancel`, {
        method: "POST",
      });
    } catch (_) {
      // Best-effort cancellation
    }
  }

  activeJobs.delete(videoId);
  if (activeJobs.size === 0) stopKeepAlive();
}

function stopPolling(videoId) {
  const entry = activeJobs.get(videoId);
  if (entry) {
    entry.polling = false;
    activeJobs.delete(videoId);
    if (activeJobs.size === 0) stopKeepAlive();
  }
}

// ─── Cache ────────────────────────────────────────────────────────────────────

async function loadFromCache(videoId) {
  try {
    const key = `transcript:${videoId}`;
    const result = await browser.storage.local.get(key);
    return result[key] || null;
  } catch (_) {
    return null;
  }
}

async function saveToCache(videoId, transcript) {
  try {
    await browser.storage.local.set({ [`transcript:${videoId}`]: transcript });
  } catch (_) {
    // Non-fatal
  }
}

async function handleClearCache(videoId) {
  try {
    await browser.storage.local.remove(`transcript:${videoId}`);
  } catch (_) {
    // Non-fatal
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchTranscriptFromBackend(videoId) {
  const resp = await fetch(`${BACKEND_BASE}/api/transcripts/${videoId}`);
  if (!resp.ok) throw new Error(`Transcript fetch returned ${resp.status}`);
  return resp.json();
}

function sendToTab(tabId, msg) {
  browser.tabs.sendMessage(tabId, msg).catch(() => {
    // Tab may have been closed or navigated away; ignore
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
