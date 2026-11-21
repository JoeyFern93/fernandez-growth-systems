'use strict';

const serviceOrigin = 'https://sitereview.fernandezgrowthsystems.com';
const panelIds = ['loading', 'home', 'connect', 'shelf', 'new-confirm', 'preview', 'shared', 'unavailable'];
const byId = id => document.getElementById(id);
let context;
let pendingCapture;
let fullImage;
let sharedLink;
let busy = false;

function show(panelId) {
  for (const id of panelIds) byId(id).hidden = id !== panelId;
  byId('my-reviews').hidden = !['home','connect','unavailable'].includes(panelId);
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
    byId('existing').hidden = !context.hasReview;
    byId('copy-latest').hidden = !context.lastScreenshotUrl;
    byId('options').open = false;
    byId('capture-handoff').hidden = !context.captureRequested;
    if (context.captureRequested) byId('capture-area').value = 'full';
    show('home');
    if (context.captureRequested) byId('capture').focus();
  } catch (err) {
    byId('unavailable-detail').textContent = err.message;
    show('unavailable');
  }
}

function action(elementOrId, handler, waitingLabel) {
  const button = typeof elementOrId === 'string' ? byId(elementOrId) : elementOrId;
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
  fullImage = null;
  byId('preview-image').removeAttribute('src');
  byId('tile-preview').replaceChildren();
  byId('tile-preview').hidden = true;
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

async function copyClientLink(urlOrPromise) {
  const link = Promise.resolve(urlOrPromise).then(reviewerLink);
  const copyResult = copyWhenReady(link);
  const safeLink = await link;
  const copied = await copyResult;
  if (copied) {
    byId('status').textContent = 'Client link copied. Send it to anyone you want feedback from.';
  } else if (!byId('shared').hidden) {
    selectLink(byId('share-link'));
    byId('status').textContent = 'Press Ctrl+C or ⌘C to copy the selected link.';
  } else {
    byId('manual-link').value = safeLink;
    byId('manual').hidden = false;
    selectLink(byId('manual-link'));
  }
  return safeLink;
}

async function startReview(type, values = {}) {
  await request(type, values);
  window.close();
}
action('start', () => startReview('begin-feedback'), 'Opening feedback…');
action('connect-review', async () => {
  await request('open-connected-site');
  window.close();
}, 'Opening the website…');
action('open-notes', async () => {
  await request('open-review');
  window.close();
}, 'Opening notes…');
action('new-review', () => show('new-confirm'));
action('confirm-new', () => startReview('new-review', {previousReviewerUrl:context.reviewerUrl}), 'Starting review…');
action('cancel-new', () => { show('home'); byId('options').open = false; });
action('copy-review', async () => {
  const link = await copyClientLink(request('get-reviewer-link').then(result => result.reviewerUrl));
  context.reviewerUrl = link;
  context.hasReview = true;
  byId('existing').hidden = false;
}, 'Getting client link…');
action('copy-latest', () => copyClientLink(context.lastScreenshotUrl));

function reviewRow(review) {
  const item = document.createElement('li');
  const heading = document.createElement('h3');
  heading.textContent = review.host;
  const detail = document.createElement('p');
  const parts = [review.isOwner ? 'Owner' : 'Reviewer'];
  if (review.current) parts.push('Current review');
  if (review.savedAt > 0) {
    parts.push(new Date(review.savedAt).toLocaleString(undefined, {dateStyle:'medium', timeStyle:'short'}));
  }
  detail.textContent = parts.join(' · ');
  const buttons = document.createElement('div');
  buttons.className = 'row-actions';
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = 'Open notes';
  action(open, async () => {
    await request('open-saved-review', {id:review.id});
    window.close();
  });
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy client link';
  action(copy, () => copyClientLink(request('get-saved-reviewer-link', {id:review.id}).then(result => result.reviewerUrl)));
  buttons.append(open, copy);
  item.append(heading, detail, buttons);
  return item;
}

action('my-reviews', async () => {
  const {reviews} = await request('list-reviews');
  byId('review-list').replaceChildren(...reviews.map(reviewRow));
  byId('empty-shelf').hidden = reviews.length > 0;
  show('shelf');
}, 'Opening…');
action('shelf-back', loadContext);

action('capture', async () => {
  const result = await request('capture', {area:byId('capture-area').value === 'full' ? 'full' : 'visible'});
  const tiles = result.area==='full' && Array.isArray(result.tiles) ? result.tiles : null;
  const validImage = url => typeof url==='string' && /^data:image\/(?:jpeg|png|webp);base64,/i.test(url);
  if (!result.captureKey || (tiles ? !tiles.length || !tiles.every(t=>validImage(t.dataUrl)) : !validImage(result.dataUrl))) {
    throw new Error('The screenshot could not be previewed. Try capturing the page again.');
  }
  clearPreview();
  pendingCapture = result.captureKey;
  const fullPage = result.area === 'full';
  byId('preview-image').hidden = fullPage;
  if (fullPage) {
    const sections = tiles || [result];
    byId('tile-preview').replaceChildren(...sections.map((tile,index) => {
      const img = document.createElement('img');
      img.alt = tiles ? 'Screenshot section ' + (index+1) + ' of ' + sections.length : 'Full-page screenshot';
      img.src = tile.dataUrl;
      return img;
    }));
    byId('tile-preview').scrollTop = 0;
    byId('tile-preview').hidden = false;
  } else byId('preview-image').src = result.dataUrl;
  if (fullPage) fullImage = tiles ? {tiles:tiles.map(t=>({dataUrl:t.dataUrl}))} : {dataUrl:result.dataUrl};
  byId('capture-site').textContent = result.host + (result.path || '/') +
    (result.width && result.height ? ' · ' + result.width + ' × ' + result.height : '');
  show('preview');
}, 'Capturing…');
action('discard', async () => {
  try { await request('discard-capture', {captureKey:pendingCapture}); }
  finally { clearPreview(); show('home'); }
});
action('share', async () => {
  const linkPromise = request('share-capture', fullImage ? {captureKey:pendingCapture,fullImage} : {captureKey:pendingCapture})
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
action('copy-shot', () => copyClientLink(sharedLink));
action('done', loadContext);
window.addEventListener('pagehide', () => {
  if (pendingCapture && !busy) request('discard-capture', {captureKey:pendingCapture}).catch(() => {});
});
loadContext();
