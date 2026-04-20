# YT Transcriber — Firefox Extension

Firefox extension (Manifest V2) that injects a transcript panel into YouTube watch pages, backed by the local Python backend.

## What it does

- Adds a **Transcribe** button panel into the YouTube sidebar on any `/watch` page
- On click, sends the video to the local backend for processing
- Polls the backend for job status and shows a live progress bar
- When the transcript is ready, renders time-aligned Japanese + English segments in the panel
- Highlights the active segment and scrolls to it as the video plays

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (permissions, content script config) |
| `background.js` | Job creation, status polling, keep-alive via `browser.alarms` |
| `content.js` | YouTube DOM integration, panel injection, playback sync |
| `panel.css` | Panel styles |

## Loading in Firefox

1. Open `about:debugging` → **This Firefox**
2. Click **Load Temporary Add-on**
3. Select any file inside this folder (e.g. `manifest.json`)

To reload after editing, click **Reload** on the extension card in `about:debugging`.

## Requirements

The backend must be running at `http://localhost:8000` before transcribing. See `yt-transcriber-backend/README.md` for setup.
