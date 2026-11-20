'use strict';

const serviceOrigin = 'https://sitereview.fernandezgrowthsystems.com';
const panelIds = ['loading', 'home', 'connect', 'new-confirm', 'preview', 'shared', 'unavailable'];
const byId = id => document.getElementById(id);
let context;
let pendingCapture;
let sharedLink;
let busy = false;

function show(panelId) {
  for (const id of panelIds) byId(id).hidden = id !== panelId;
  byId('manual').hidden = true;
  byId('error').textContent = '';
  byId('status').textContent = '';
  if (busy) {
    const heading = byId(panelId).querySelector('h2');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }
}

async function request(type, values = {}) {
  const result = await chrome.runtime.sendMessage({type, ...values});
  if (!result?.ok) throw new Error(result?.error || 'Site Review could not finish. Please try again.');
  return result;
}

function reviewerLink(value) {
  const url = new URL(value);
  if (url.origin !== serviceOrigin || url.username || url.password || url.search ||
      !/^\/[^/]+\/[\w-]+\/?$/.test(url.pathname) || (url.hash && !/^#shot=[\w-]+$/.test(url.hash))) {
    throw new Error('Could not get a reviewer link. Reopen the extension and try again.');
  }
  return url.href;
}

async function loadContext() {
  try {
    context = await request('status');
    if (context.isReviewPage) {
      byId('connect-site').textContent = context.host;
      show('connect');
      return;
    }
    byId('host').textContent = context.host;
    byId('start').textContent = context.hasReview ? 'Show feedback button' : 'Start reviewing';
    byId('existing').hidden = !context.hasReview;
    byId('copy-latest').hidden = !context.lastScreenshotUrl;
    byId('options').open = false;
    show('home');
  } catch (err) {
    byId('unavailable-detail').textContent = err.message;
    show('unavailable');
  }
}

function action(id, handler, waitingLabel) {
  const button = byId(id);
  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    const label = button.textContent;
    byId('error').textContent = '';
    byId('status').textContent = '';
    byId('manual').hidden = true;
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const item of buttons) item.disabled = true;
    if (waitingLabel) button.textContent = waitingLabel;
    try {
      await handler();
    } catch (err) {
      byId('error').textContent = err.message || 'Something went wrong. Please try again.';
    } finally {
      if (waitingLabel) button.textContent = label;
      for (const item of buttons) item.disabled = false;
      busy = false;
    }
  });
}

function clearPreview() {
  pendingCapture = null;
  byId('preview-image').removeAttribute('src');
}

// Request the clipboard while the Share click still has a user gesture. The
// clipboard receives the client link only after the upload succeeds.
async function copyWhenReady(linkPromise) {
  try {
    if (typeof ClipboardItem === 'function' && navigator.clipboard?.write) {
      const content = linkPromise.then(link => new Blob([link], {type:'text/plain'}));
      content.catch(() => {});
      await navigator.clipboard.write([new ClipboardItem({'text/plain':content})]);
    } else {
      await navigator.clipboard.writeText(await linkPromise);
    }
    return true;
  } catch {
    return false;
  }
}

function selectLink(field) {
  field.focus();
  field.select();
}

async function copyExisting(url) {
  const safeLink = reviewerLink(url);
  const copied = await copyWhenReady(Promise.resolve(safeLink));
  if (copied) {
    byId('status').textContent = 'Reviewer link copied.';
  } else if (!byId('shared').hidden) {
    selectLink(byId('share-link'));
    byId('status').textContent = 'Press Ctrl+C or ⌘C to copy the selected link.';
  } else {
    byId('manual-link').value = safeLink;
    byId('manual').hidden = false;
    selectLink(byId('manual-link'));
  }
}

async function startReview(type) {
  await request(type);
  window.close();
}
action('start', () => startReview('start'), 'Opening feedback…');
action('connect-review', async () => {
  await request('connect-review');
  await request('open-connected-site');
  window.close();
}, 'Opening the website…');
action('open-notes', async () => {
  await request('open-review');
  window.close();
}, 'Opening notes…');
action('new-review', () => {
  byId('new-detail').textContent = context.isOwner
    ? 'This opens a fresh set of notes. To return to the current review later, save its private owner link under Open review notes → Share.'
    : 'This opens a fresh review that you own. Your existing reviewer link still opens the current review.';
  show('new-confirm');
});
action('confirm-new', () => startReview('new-review'), 'Starting review…');
action('cancel-new', () => { show('home'); byId('options').open = false; });
action('copy-review', () => copyExisting(context.reviewerUrl));
action('copy-latest', () => copyExisting(context.lastScreenshotUrl));

action('capture', async () => {
  const result = await request('capture');
  if (!result.captureKey || !/^data:image\/(?:jpeg|png|webp);base64,/i.test(result.dataUrl)) {
    throw new Error('The screenshot could not be previewed. Try capturing the page again.');
  }
  pendingCapture = result.captureKey;
  byId('preview-image').src = result.dataUrl;
  byId('capture-site').textContent = result.host + (result.path || '/');
  show('preview');
}, 'Capturing…');
action('discard', async () => {
  try { await request('discard-capture', {captureKey:pendingCapture}); }
  finally { clearPreview(); show('home'); }
});
action('share', async () => {
  const linkPromise = request('share-capture', {captureKey: pendingCapture})
    .then(result => reviewerLink(result.reviewerUrl));
  const copyResult = copyWhenReady(linkPromise);
  sharedLink = await linkPromise;
  const copied = await copyResult;
  clearPreview();
  byId('share-link').value = sharedLink;
  byId('open-shot').href = sharedLink;
  show('shared');
  byId('status').textContent = copied ? 'Client link copied.' : 'Select Copy link to copy the client link.';
}, 'Sharing screenshot…');
action('copy-shot', () => copyExisting(sharedLink));
action('done', loadContext);
window.addEventListener('pagehide', () => {
  if (pendingCapture && !busy) request('discard-capture', {captureKey:pendingCapture}).catch(() => {});
});
loadContext();
