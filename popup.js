const textInput     = document.getElementById('textInput');
const fileInput     = document.getElementById('fileInput');
const batchSizeEl   = document.getElementById('batchSize');
const batchSizeLabel= document.getElementById('batchSizeLabel');
const splitModeEl   = document.getElementById('splitMode');
const langWrap      = document.getElementById('langWrap');
const langInput     = document.getElementById('langInput');
const prefixEl      = document.getElementById('prefixInput');
const prefixHint    = document.getElementById('prefixHint');
const previewEl     = document.getElementById('preview');
const charCountEl   = document.getElementById('charCount');
const startBtn      = document.getElementById('startBtn');
const stopBtn       = document.getElementById('stopBtn');
const exportBtn     = document.getElementById('exportBtn');
const progressWrap  = document.getElementById('progressWrap');
const progressBar   = document.getElementById('progressBar');
const progressText  = document.getElementById('progressText');
const progressPct   = document.getElementById('progressPct');
const statusEl      = document.getElementById('status');
const sessionInfo   = document.getElementById('sessionInfo');
const resetBtn      = document.getElementById('resetBtn');

let collectedResponses = [];
let exportAsSRT = false;
let prefixAutoFilled = false; // true when prefix was set by auto-detect, not the user
let currentSession = null;
let currentRunTabId = null;

const MAX_BATCHES_PER_RUN = 10;
const SESSION_KEY = 'batchSubmitterSession';

// ── SRT utilities ────────────────────────────────────────────────────────────

function isSRT(text) {
  return /^\s*\d+\s*\n\d{2}:\d{2}:\d{2}[,\.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,\.]\d{3}/m.test(text);
}

// Returns array of raw entry strings, e.g. ["1\n00:00:02,320 --> ...\nHello", ...]
function parseSRTEntries(text) {
  const entries = [];
  const blocks = text.trim().split(/\n[ \t]*\n+/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    const num  = lines[0].trim();
    const time = lines[1].trim();
    const txt  = lines.slice(2).join('\n').trim();
    if (/^\d+$/.test(num) && /\d{2}:\d{2}:\d{2}[,\.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,\.]\d{3}/.test(time)) {
      entries.push(txt ? `${num}\n${time}\n${txt}` : `${num}\n${time}`);
    }
  }
  return entries;
}

// Group SRT entries into batches of N, returning each batch as one string
function batchSRTEntries(entries, perBatch) {
  const batches = [];
  for (let i = 0; i < entries.length; i += perBatch) {
    batches.push(entries.slice(i, i + perBatch).join('\n\n'));
  }
  return batches;
}

// ── Text splitting (non-SRT) ─────────────────────────────────────────────────

function splitText(text, batchSize, mode) {
  if (text.length <= batchSize) return [text];

  const chunks = [];
  let remaining = text.trim();

  while (remaining.length > batchSize) {
    let splitAt = batchSize;

    if (mode === 'paragraph') {
      const idx = remaining.lastIndexOf('\n\n', batchSize);
      if (idx > batchSize * 0.5) splitAt = idx + 2;
      else {
        const idx2 = remaining.lastIndexOf('\n', batchSize);
        if (idx2 > batchSize * 0.5) splitAt = idx2 + 1;
      }
    } else if (mode === 'sentence') {
      const slice = remaining.slice(0, batchSize);
      const match = [...slice.matchAll(/[.!?]["']?\s/g)];
      if (match.length) {
        const last = match[match.length - 1];
        if (last.index > batchSize * 0.4) splitAt = last.index + last[0].length;
      }
    } else if (mode === 'word') {
      const idx = remaining.lastIndexOf(' ', batchSize);
      if (idx > batchSize * 0.5) splitAt = idx + 1;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks.filter(c => c.length > 0);
}

// Apply prefix to all chunks (applyToAll=true) or skip the first (false)
function applyPrefix(chunks, prefix, applyToAll = false) {
  if (!prefix.trim()) return chunks;
  return chunks.map((c, i) =>
    (applyToAll || i > 0) ? `${prefix.trim()}\n\n${c}` : c
  );
}

function getPreparedBatches() {
  const text = textInput.value.trim();
  const mode = splitModeEl.value;
  const prefix = prefixEl.value;
  let chunks;

  if (mode === 'srt') {
    const entries = parseSRTEntries(text);
    const perBatch = Math.max(1, parseInt(batchSizeEl.value, 10) || 30);
    chunks = batchSRTEntries(entries, perBatch);
    chunks = applyPrefix(chunks, prefix, true);
    return { chunks, exportAsSRT: true };
  }

  const batchSize = parseInt(batchSizeEl.value, 10) || 3000;
  chunks = splitText(text, batchSize, mode);
  chunks = applyPrefix(chunks, prefix, false);
  return { chunks, exportAsSRT: false };
}

function makeSessionFingerprint(chunks, isSRTOutput) {
  const source = JSON.stringify({
    chunks,
    isSRTOutput,
    mode: splitModeEl.value,
    batchSize: batchSizeEl.value,
    prefix: prefixEl.value
  });
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = ((hash << 5) - hash + source.charCodeAt(i)) | 0;
  }
  return `${source.length}:${hash}`;
}

function storageGet(key) {
  return chrome.storage.local.get(key).then(result => result[key]);
}

function storageSet(key, value) {
  return chrome.storage.local.set({ [key]: value });
}

function storageRemove(key) {
  return chrome.storage.local.remove(key);
}

async function saveSession() {
  if (currentSession) await storageSet(SESSION_KEY, currentSession);
}

async function loadSession() {
  currentSession = await storageGet(SESSION_KEY) || null;
  if (currentSession?.sourceText) {
    textInput.value = currentSession.sourceText;
    splitModeEl.value = currentSession.mode || 'paragraph';
    if (splitModeEl.value === 'srt') {
      enterSRTMode();
    } else {
      exitSRTMode();
    }
    batchSizeEl.value = currentSession.batchSize || batchSizeEl.value;
    prefixEl.value = currentSession.prefix || '';
    langInput.value = currentSession.lang || '';
    prefixAutoFilled = false;
  }
  collectedResponses = currentSession?.responses || [];
  exportAsSRT = !!currentSession?.exportAsSRT;
  exportBtn.textContent = exportAsSRT
    ? 'Export Subtitles (.srt)'
    : 'Export Responses (.txt)';
  updateSessionInfo();
  if (currentSession) {
    const done = Math.min(currentSession.nextIndex, currentSession.total);
    setProgress(done, currentSession.total, done >= currentSession.total);
  }
}

function updateSessionInfo() {
  if (!currentSession) {
    sessionInfo.textContent = 'No saved batch session.';
    startBtn.textContent = 'Submit to ChatGPT';
    return;
  }

  const done = Math.min(currentSession.nextIndex, currentSession.total);
  const remaining = Math.max(0, currentSession.total - done);
  sessionInfo.innerHTML =
    `Saved progress: <strong>${done}</strong> / <strong>${currentSession.total}</strong> batches submitted. ` +
    `<strong>${remaining}</strong> remaining. This tab run will send up to <strong>${MAX_BATCHES_PER_RUN}</strong>.`;
  startBtn.textContent = remaining > 0 ? 'Continue in This Tab' : 'All Batches Submitted';
}

// ── SRT mode management ──────────────────────────────────────────────────────

function enterSRTMode() {
  splitModeEl.value = 'srt';
  batchSizeLabel.textContent = 'Entries per batch';
  if (parseInt(batchSizeEl.value, 10) > 200) batchSizeEl.value = 30;
  batchSizeEl.min = 1;
  batchSizeEl.max = 500;
  batchSizeEl.step = 1;
  langWrap.style.display = 'block';
  updateAutoPrefix();
}

function exitSRTMode() {
  batchSizeLabel.textContent = 'Batch size (chars)';
  batchSizeEl.value = 3000;
  batchSizeEl.min = 100;
  batchSizeEl.max = 20000;
  batchSizeEl.step = 100;
  langWrap.style.display = 'none';
  if (prefixAutoFilled) {
    prefixEl.value = '';
    prefixHint.textContent = '(optional)';
    prefixAutoFilled = false;
  }
}

function updateAutoPrefix() {
  if (splitModeEl.value !== 'srt') return;
  const lang = langInput.value.trim();
  // Don't overwrite if the user manually edited the prefix
  if (!prefixAutoFilled && prefixEl.value.trim()) return;
  if (lang) {
    prefixEl.value = `Translate the following subtitles to ${lang}. Keep the exact SRT format — do not change sequence numbers or timestamps. Only translate the subtitle text:`;
    prefixHint.textContent = '(auto-generated — edit if needed)';
    prefixAutoFilled = true;
  } else if (prefixAutoFilled) {
    prefixEl.value = '';
    prefixHint.textContent = '(optional)';
    prefixAutoFilled = false;
  }
}

// ── Live preview ─────────────────────────────────────────────────────────────

function updatePreview() {
  const text = textInput.value;
  charCountEl.textContent = text.length.toLocaleString();

  if (!text.trim()) {
    previewEl.innerHTML = 'Paste text above to see batch preview.';
    startBtn.disabled = true;
    return;
  }

  // Auto-detect SRT
  const srtDetected = isSRT(text);
  const currentMode = splitModeEl.value;

  if (srtDetected && currentMode !== 'srt') {
    enterSRTMode();
  } else if (!srtDetected && currentMode === 'srt') {
    splitModeEl.value = 'paragraph';
    exitSRTMode();
  }

  if (splitModeEl.value === 'srt') {
    const entries = parseSRTEntries(text);
    const perBatch = Math.max(1, parseInt(batchSizeEl.value, 10) || 30);
    const numBatches = Math.ceil(entries.length / perBatch);
    previewEl.innerHTML =
      `<strong>${entries.length}</strong> subtitle entries → ` +
      `<strong>${numBatches}</strong> batch${numBatches !== 1 ? 'es' : ''} ` +
      `(<strong>${perBatch}</strong> entries each)`;
  } else {
    const batchSize = parseInt(batchSizeEl.value, 10) || 3000;
    const mode = splitModeEl.value;
    const chunks = splitText(text, batchSize, mode);
    previewEl.innerHTML =
      `Will send <strong>${chunks.length}</strong> batch${chunks.length !== 1 ? 'es' : ''} ` +
      `(largest: <strong>${Math.max(...chunks.map(c => c.length)).toLocaleString()}</strong> chars)`;
  }

  startBtn.disabled = false;
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => { textInput.value = e.target.result; updatePreview(); };
  reader.readAsText(file, 'utf-8');
  fileInput.value = '';
});

// Drag-and-drop onto the textarea
textInput.addEventListener('dragover', e => {
  e.preventDefault();
  textInput.style.borderColor = '#10a37f';
});
textInput.addEventListener('dragleave', () => {
  textInput.style.borderColor = '#3a3a3a';
});
textInput.addEventListener('drop', e => {
  e.preventDefault();
  textInput.style.borderColor = '#3a3a3a';
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { textInput.value = ev.target.result; updatePreview(); };
  reader.readAsText(file, 'utf-8');
});

textInput.addEventListener('input', updatePreview);
batchSizeEl.addEventListener('input', updatePreview);
splitModeEl.addEventListener('change', () => {
  if (splitModeEl.value === 'srt') {
    enterSRTMode();
  } else {
    exitSRTMode();
  }
  updatePreview();
});
prefixEl.addEventListener('input', () => {
  if (prefixAutoFilled) {
    prefixAutoFilled = false;
    prefixHint.textContent = '(manually edited)';
  }
});
langInput.addEventListener('input', updateAutoPrefix);

// ── Progress updates from content script ─────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'BATCH_SUBMITTED') {
    if (!currentSession) return;
    currentSession.nextIndex = Math.max(currentSession.nextIndex, msg.batchIndex + 1);
    saveSession();
    setProgress(currentSession.nextIndex, currentSession.total, false);
    updateSessionInfo();
  }
  if (msg.type === 'BATCH_DONE') {
    if (!currentSession) return;
    if (typeof msg.response === 'string' && msg.response.trim()) {
      currentSession.responses[msg.batchIndex] = msg.response.trim();
      collectedResponses = currentSession.responses.filter(Boolean);
      saveSession();
      exportBtn.textContent = currentSession.exportAsSRT
        ? 'Export Subtitles (.srt)'
        : 'Export Responses (.txt)';
    }
  }
  if (msg.type === 'RUN_COMPLETE') {
    if (!currentSession) return;
    setProgress(currentSession.nextIndex, currentSession.total, msg.allDone);
    updateSessionInfo();
    currentRunTabId = null;
    setRunning(false);
    if (msg.stopped) {
      setStatus(`Stopped. Next run will continue from batch ${currentSession.nextIndex + 1}.`, 'error');
    } else if (msg.allDone) {
      setStatus('All batches submitted — export when ready.', 'success');
    } else {
      setStatus(`This tab reached ${MAX_BATCHES_PER_RUN} batches. Open or switch to a new ChatGPT tab to continue.`, 'success');
    }
  }
  if (msg.type === 'RESPONSES') {
    collectedResponses = msg.responses || collectedResponses;
    exportBtn.textContent = exportAsSRT
      ? 'Export Subtitles (.srt)'
      : 'Export Responses (.txt)';
  }
});

function setProgress(current, total, done) {
  progressWrap.style.display = 'block';
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  progressBar.style.width = pct + '%';
  progressText.textContent = `${current} / ${total} submitted`;
  progressPct.textContent = pct + '%';

  if (done) {
    setStatus('All batches submitted — export when ready.', 'success');
    setRunning(false);
  } else {
    setStatus(`Progress saved through batch ${current} of ${total}.`);
  }
}

// ── Submit ────────────────────────────────────────────────────────────────────

startBtn.addEventListener('click', async () => {
  setStatus('');
  const text = textInput.value.trim();
  if (!text) return setStatus('Please paste some text first.', 'error');

  if (splitModeEl.value === 'srt' && parseSRTEntries(text).length === 0) {
    return setStatus('No valid SRT entries found.', 'error');
  }

  const prepared = getPreparedBatches();
  const chunks = prepared.chunks;
  exportAsSRT = prepared.exportAsSRT;

  if (chunks.length === 0) return setStatus('Nothing to send.', 'error');

  const fingerprint = makeSessionFingerprint(chunks, exportAsSRT);
  if (!currentSession || currentSession.fingerprint !== fingerprint) {
    currentSession = {
      fingerprint,
      total: chunks.length,
      nextIndex: 0,
      responses: [],
      exportAsSRT,
      sourceText: text,
      mode: splitModeEl.value,
      batchSize: batchSizeEl.value,
      prefix: prefixEl.value,
      lang: langInput.value,
      createdAt: Date.now()
    };
    collectedResponses = [];
    await saveSession();
  }

  if (currentSession.nextIndex >= currentSession.total) {
    setProgress(currentSession.total, currentSession.total, true);
    updateSessionInfo();
    return;
  }

  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.match(/https:\/\/(chat\.openai\.com|chatgpt\.com)/)) {
    return setStatus('Open chatgpt.com first, then try again.', 'error');
  }

  let contentReady = false;
  try {
    const pong = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    contentReady = pong && pong.ok;
  } catch (_) {}

  if (!contentReady) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await new Promise(r => setTimeout(r, 200));
      const pong2 = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
      contentReady = pong2 && pong2.ok;
    } catch (e) {
      return setStatus('Could not connect to ChatGPT tab. Try refreshing the page.', 'error');
    }
  }

  currentRunTabId = tab.id;
  const startIndex = currentSession.nextIndex;
  const runBatches = chunks.slice(startIndex, startIndex + MAX_BATCHES_PER_RUN);
  setRunning(true);
  setProgress(startIndex, currentSession.total, false);
  setStatus(`Starting at batch ${startIndex + 1}. This tab will send up to ${runBatches.length} batch${runBatches.length > 1 ? 'es' : ''}.`);
  updateSessionInfo();

  try {
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: 'SUBMIT_BATCHES',
      batches: runBatches,
      startIndex,
      total: currentSession.total,
      maxBatches: MAX_BATCHES_PER_RUN
    });
    if (resp && resp.error) {
      setStatus(resp.error, 'error');
      setRunning(false);
    }
  } catch (e) {
    setStatus('Connection lost. Was the tab closed?', 'error');
    setRunning(false);
  }
});

stopBtn.addEventListener('click', async () => {
  const tabId = currentRunTabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (tabId) chrome.tabs.sendMessage(tabId, { type: 'STOP' }).catch(() => {});
  const next = currentSession ? currentSession.nextIndex + 1 : 1;
  setStatus(`Stopping. Progress is saved; next run will continue from batch ${next}.`, 'error');
  setRunning(false);
});

exportBtn.addEventListener('click', () => {
  if (collectedResponses.length === 0) return;

  let text, filename;

  if (exportAsSRT) {
    // Join raw SRT blocks — responses should already be in SRT format
    text = collectedResponses.join('\n\n');
    filename = 'subtitles-translated.srt';
  } else {
    const divider = '\n\n' + '─'.repeat(60) + '\n\n';
    text = collectedResponses
      .map((r, i) => `=== Response ${i + 1} of ${collectedResponses.length} ===\n\n${r}`)
      .join(divider);
    filename = 'chatgpt-responses.txt';
  }

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

resetBtn.addEventListener('click', async () => {
  currentSession = null;
  collectedResponses = [];
  exportAsSRT = false;
  await storageRemove(SESSION_KEY);
  progressWrap.style.display = 'none';
  progressBar.style.width = '0%';
  progressText.textContent = '0 / 0 submitted';
  progressPct.textContent = '0%';
  exportBtn.textContent = 'Export Responses (.txt)';
  updateSessionInfo();
  updatePreview();
  setStatus('Saved progress reset.', 'success');
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function setRunning(running) {
  startBtn.disabled = running;
  stopBtn.style.display = running ? 'block' : 'none';
}

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (type ? ` ${type}` : '');
}

loadSession().then(() => {
  updatePreview();
});
