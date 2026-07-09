// Injected into chatgpt.com — handles batch submission

function findInput() {
  return (
    document.getElementById('prompt-textarea') ||
    document.querySelector('div[contenteditable="true"][data-virtualkeyboard]') ||
    document.querySelector('div[contenteditable="true"]') ||
    document.querySelector('textarea[placeholder]')
  );
}

function findSendButton() {
  return (
    document.querySelector('button[data-testid="send-button"]') ||
    document.querySelector('button[data-testid="fruitjuice-send-button"]') ||
    document.querySelector('[data-testid="composer-submit-button"]') ||
    document.querySelector('button[aria-label="Send message"]') ||
    document.querySelector('button[aria-label*="Send"]')
  );
}

function findStopButton() {
  return (
    document.querySelector('button[data-testid="stop-button"]') ||
    document.querySelector('[data-testid="stop-streaming-button"]') ||
    document.querySelector('button[aria-label="Stop streaming"]') ||
    document.querySelector('button[aria-label="Stop generating"]') ||
    document.querySelector('button[aria-label*="Stop"]')
  );
}

// Count assistant messages as a reliable "response appeared" signal
function countAssistantMessages() {
  return document.querySelectorAll('[data-message-author-role="assistant"]').length;
}

// Extract plain text from all assistant messages in conversation order
function collectResponses() {
  const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
  const responses = [];
  messages.forEach(msg => {
    const content =
      msg.querySelector('[data-message-text-content]') ||
      msg.querySelector('.prose') ||
      msg.querySelector('[class*="prose"]') ||
      msg.querySelector('.markdown') ||
      msg;
    const text = content.innerText.trim();
    if (text) responses.push(text);
  });
  return responses;
}

// True when ChatGPT is actively generating
function isGenerating() {
  if (findStopButton()) return true;
  if (document.querySelector('[data-testid="result-streaming-indicator"]')) return true;
  if (document.querySelector('.result-streaming')) return true;
  const send = findSendButton();
  return !!(send && send.disabled);
}

function setInputText(text) {
  const input = findInput();
  if (!input) return false;

  input.focus();

  if (input.tagName === 'TEXTAREA') {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    ).set;
    nativeSetter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    // contenteditable — clear then insert via execCommand so React picks it up
    input.innerHTML = '';
    document.execCommand('insertText', false, text);
  }

  return true;
}

function submitMessage() {
  const btn = findSendButton();
  if (btn && !btn.disabled) {
    btn.click();
    return true;
  }

  // Fallback: dispatch Enter on the input
  const input = findInput();
  if (input) {
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13,
      bubbles: true, cancelable: true
    }));
    return true;
  }

  return false;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Resolves when ChatGPT finishes generating.
// Strategy:
//   1. Record current assistant message count before waiting.
//   2. Wait up to 12 s for generation to START (stop button, streaming indicator,
//      or a new assistant message appears).
//   3. Once started, wait for generation to END: not generating AND a new message exists.
//   4. Fallback: if neither button nor streaming indicator is ever found but a new message
//      appeared and nothing is generating, resolve anyway.
function waitForResponse(timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const deadline = startTime + timeoutMs;
    const initialCount = countAssistantMessages();
    let generationStarted = false;
    let observer = null;

    function cleanup() {
      if (observer) { observer.disconnect(); observer = null; }
      clearInterval(poller);
    }

    function done() { cleanup(); resolve(); }
    function fail(msg) { cleanup(); reject(new Error(msg)); }

    function check() {
      if (!isRunning) { done(); return; }
      if (Date.now() > deadline) { fail('Timed out waiting for ChatGPT response'); return; }

      const elapsed = Date.now() - startTime;
      const generating = isGenerating();
      const newMessageAppeared = countAssistantMessages() > initialCount;

      if (!generationStarted) {
        if (generating || newMessageAppeared) {
          generationStarted = true;
        } else if (elapsed > 12000) {
          // 12 s with no signal — assume done (e.g. very fast response already complete)
          done();
          return;
        }
        return;
      }

      // Generation has started; wait for it to stop
      if (!generating && newMessageAppeared) {
        done();
        return;
      }

      // Fallback: not generating and no new message after 60 s — move on
      if (!generating && elapsed > 60000) {
        done();
      }
    }

    observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'aria-disabled', 'data-state', 'aria-label', 'class', 'data-message-author-role']
    });

    const poller = setInterval(check, 300);
    check(); // run immediately in case response is already done
  });
}

let isRunning = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'STOP') {
    isRunning = false;
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'SUBMIT_BATCHES') {
    if (isRunning) {
      sendResponse({ error: 'Already running' });
      return;
    }
    isRunning = true;
    runBatches(message.batches, message.startIndex || 0, message.total || message.batches.length)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true; // keep channel open for async response
  }
});

function getLastAssistantResponse() {
  const responses = collectResponses();
  return responses[responses.length - 1] || '';
}

async function runBatches(batches, startIndex, total) {
  let stopped = false;
  let submittedCount = 0;

  for (let i = 0; i < batches.length; i++) {
    if (!isRunning) { stopped = true; break; }

    const batchIndex = startIndex + i;

    chrome.runtime.sendMessage({
      type: 'PROGRESS',
      current: batchIndex,
      total,
      done: false
    }).catch(() => {});

    if (!setInputText(batches[i])) {
      isRunning = false;
      throw new Error('Could not find the ChatGPT input field. Make sure you are on chatgpt.com.');
    }

    await sleep(400); // let React reconcile before submitting

    if (!submitMessage()) {
      isRunning = false;
      throw new Error('Could not submit — send button not found or disabled.');
    }

    chrome.runtime.sendMessage({
      type: 'BATCH_SUBMITTED',
      batchIndex,
      total
    }).catch(() => {});
    submittedCount++;

    // Wait for ChatGPT to finish (every batch, including the last)
    await waitForResponse();
    if (!isRunning) { stopped = true; break; }

    chrome.runtime.sendMessage({
      type: 'BATCH_DONE',
      batchIndex,
      total,
      response: getLastAssistantResponse()
    }).catch(() => {});

    await sleep(600); // small buffer so the UI settles
  }

  isRunning = false;

  const nextIndex = Math.min(startIndex + submittedCount, total);
  const allDone = nextIndex >= total;

  chrome.runtime.sendMessage({
    type: 'RUN_COMPLETE',
    nextIndex,
    total,
    allDone,
    stopped
  }).catch(() => {});

}
