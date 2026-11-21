/* global chrome, OffscreenCanvas, createImageBitmap */
'use strict';
importScripts('full-capture.js');

const REVIEW_ORIGIN = 'https://sitereview.fernandezgrowthsystems.com';
const INVITE = /^[A-Za-z0-9_-]{24}$/;
const OWNER = /^[A-Za-z0-9_-]{43}$/;
const SITE_KEY = 'site:';
const ARCHIVE_KEY = 'review:';
const activeKey = id => 'active:' + id;
const captureKey = id => 'capture:' + id;
const connectedKey = id => 'connected:' + id;
const locks = new Map();
let lastScreenshotTime = 0;
const storageReady = chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});

async function read(area, key) {
  await storageReady;
  return (await area.get(key))[key];
}
async function write(area, key, value) {
  await storageReady;
  await area.set({[key]: value});
}
async function withSiteLock(site, task) {
  const previous = locks.get(site) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  locks.set(site, next);
  try { return await next; }
  finally { if (locks.get(site) === next) locks.delete(site); }
}
function publicPage(address, preserveQuery = false) {
  let url;
  try { url = new URL(address); } catch { /* unsupported browser tab */ }
  const validHost = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i;
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
      !validHost.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|lan|home|corp|test|invalid|onion|arpa)$/.test(url.hostname) ||
      url.hostname === 'chromewebstore.google.com' || (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore')) ||
      url.hostname === new URL(REVIEW_ORIGIN).hostname) {
    throw Error('Open a public website in a regular Chrome tab, then click the FGS extension.');
  }
  // Query strings and fragments commonly carry login or invite credentials.
  if (!preserveQuery) url.search = '';
  url.hash = '';
  return url;
}
async function reviewedPage(tab) {
  const url = publicPage(tab.url, true);
  // Only keep query parameters when this exact address was deliberately opened
  // from the review. Never add incidental URLs' account or tracking tokens.
  if (url.search && (await read(chrome.storage.session, connectedKey(tab.id)))?.address !== url.href) url.search = '';
  return url;
}
function siteKey(url) {
  const aliases = ['fernandezgrowthsystems.com', 'ferngrowthsystems.com', 'www.ferngrowthsystems.com'];
  return SITE_KEY + (aliases.includes(url.hostname) ? 'www.fernandezgrowthsystems.com' : url.hostname);
}
function parseInvite(value) {
  let url;
  try { url = new URL(value, REVIEW_ORIGIN); } catch { return null; }
  const parts = url.pathname.split('/');
  if (url.origin !== REVIEW_ORIGIN || url.username || url.password || parts.length !== 3 || !INVITE.test(parts[2])) return null;
  let target;
  try { target = publicPage('https://' + parts[1] + '/'); } catch { return null; }
  if (parts[1] !== target.hostname) return null;
  const owner = new URLSearchParams(url.hash.slice(1)).get('owner');
  if (owner && !OWNER.test(owner)) return null;
  return {host: target.hostname, id: parts[2], owner: owner || null, url: url.origin + url.pathname};
}
async function activeTab() {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab?.id || !tab.url) throw Error('Open the site and click the FGS extension in its tab.');
  return tab;
}
async function api(path, {method = 'GET', body, owner} = {}) {
  const headers = {Accept: 'application/json'};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (owner) headers.Authorization = 'Bearer ' + owner;
  let response;
  try {
    response = await fetch(REVIEW_ORIGIN + '/api/reviews' + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store'
    });
  } catch { throw Error('Could not reach FGS Site Review. Check your connection and try again.'); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(result.error || 'FGS Site Review could not save this change. Try again.');
  return result;
}
function reviewerLink(path, expectedHost) {
  const invite = parseInvite(path);
  if (!invite || invite.owner || invite.host !== expectedHost) throw Error('FGS returned an invalid reviewer link.');
  return invite.url;
}
async function board(record) {
  const data = await api('/' + record.id, {owner: record.owner});
  const url = publicPage(data.review.url, true);
  if (siteKey(url) !== siteKey(new URL('https://' + record.host))) throw Error('This review is for a different site.');
  return {data, url, reviewerUrl: reviewerLink(data.review.reviewerPath, data.review.host)};
}
async function creatorId() {
  return withSiteLock('creatorId', async () => {
    let id = await read(chrome.storage.local, 'creatorId');
    if (!id) {
      id = crypto.randomUUID();
      await write(chrome.storage.local, 'creatorId', id);
    }
    return id;
  });
}
// Keep the site pointer for older installations. When switching rounds,
// file the old one alongside the new pointer in a single storage operation.
async function remember(key, record, previous, extra = {}) {
  const entries = {...extra, [key]: {...record, savedAt: Date.now()}};
  if (previous && previous.id !== record.id && previous.reviewerUrl !== record.reviewerUrl) {
    entries[ARCHIVE_KEY + previous.id] = previous;
  }
  await chrome.storage.local.set(entries);
  return entries[key];
}
async function savedReviews() {
  await storageReady;
  const items = await chrome.storage.local.get(null);
  const records = new Map();
  for (const [key, record] of Object.entries(items)) {
    const current = key.startsWith(SITE_KEY);
    if ((!current && !key.startsWith(ARCHIVE_KEY)) || !record || !INVITE.test(record.id)) continue;
    const invite = parseInvite(record.reviewerUrl);
    if (!invite || invite.owner || invite.host !== record.host || (record.owner && !OWNER.test(record.owner))) continue;
    const item = {...record, reviewerUrl: invite.url, current, savedAt: Number(record.savedAt) || 0};
    if (current || !records.has(record.id)) records.set(record.id, item);
  }
  return [...records.values()].sort((a, b) => b.savedAt - a.savedAt || a.host.localeCompare(b.host));
}
async function openNotes(record) {
  const destination = record.owner ? REVIEW_ORIGIN + '/' + record.host + '/' + record.id + '#owner=' + record.owner + '&panel=notes' : record.reviewerUrl + '#panel=notes';
  await chrome.tabs.create({url: destination});
  return {};
}
async function reviewFor(url, create, replace = false, previousReviewerUrl) {
  const key = siteKey(url);
  return withSiteLock(key, async () => {
    const existing = await read(chrome.storage.local, key);
    if (existing && !replace) return existing;
    if (existing && previousReviewerUrl && previousReviewerUrl !== existing.reviewerUrl) return existing;
    if (!create) throw Error('Open the FGS extension and start a review on this website first.');
    // Keep the original starting URL and secret until the owner link is durably
    // saved. Chrome may restart this worker after the server commits a review.
    const pendingKey = 'pending:' + key;
    const previousId = existing?.id || null;
    let pending = await read(chrome.storage.local, pendingKey);
    if (!pending || pending.previousId !== previousId) {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      pending = {previousId, url: url.href, creationKey: Array.from(secret, b => b.toString(16).padStart(2, '0')).join('')};
      await write(chrome.storage.local, pendingKey, pending);
    }
    const result = await api('', {method: 'POST', body: {
      url: pending.url, creationKey: pending.creationKey, creatorId: await creatorId()
    }});
    const ownerLink = parseInvite(result.ownerPath);
    if (!ownerLink?.owner || siteKey(url) !== siteKey(new URL('https://' + ownerLink.host))) throw Error('FGS could not create the owner link. Try again.');
    const record = {id: ownerLink.id, host: ownerLink.host, owner: ownerLink.owner, reviewerUrl: reviewerLink(result.reviewerPath, ownerLink.host)};
    return remember(key, record, existing, {[pendingKey]: null});
  });
}
async function tabReview(tab, url, create = false) {
  const binding = await read(chrome.storage.session, connectedKey(tab.id));
  if (!binding) return create ? reviewFor(url, true) : read(chrome.storage.local, siteKey(url));
  if (binding.site !== siteKey(url)) throw Error('This tab was opened for a different website. Return to the review and open the page again.');
  const record = (await savedReviews()).find(r => r.id === binding.reviewId);
  if (!record) throw Error('Return to your review link and open this page again to reconnect it.');
  return record;
}
async function updateLink(url, record, latest, screenshotId) {
  return withSiteLock(siteKey(url), async () => {
    const current = await read(chrome.storage.local, siteKey(url));
    const key = current?.id === record.id ? siteKey(url) : ARCHIVE_KEY + record.id;
    const saved = key === siteKey(url) ? current : await read(chrome.storage.local, key);
    if (!saved) return;
    await write(chrome.storage.local, key, {...saved, reviewerUrl: latest, lastShot: screenshotId || saved.lastShot, savedAt: Date.now()});
  });
}
function requireOpen(data) {
  if (data.review.closed) throw Error('This review is closed. Open the extension and choose Start a new review, or ask the owner to reopen it.');
}
async function connect(invite) {
  const record = {id: invite.id, host: invite.host, owner: invite.owner};
  const {data, url, reviewerUrl} = await board(record);
  requireOpen(data);
  const key = siteKey(url);
  const saved = await withSiteLock(key, async () => {
    const old = await read(chrome.storage.local, key);
    // Opening the guest version of your own round should keep your owner access.
    const known = old?.reviewerUrl === reviewerUrl ? old : (await savedReviews()).find(r => r.reviewerUrl === reviewerUrl);
    const preferred = !record.owner && known?.owner ? {id: known.id, host: known.host, owner: known.owner} : record;
    return remember(key, {...preferred, reviewerUrl, lastShot: known?.lastShot}, old);
  });
  return {reviewerUrl, siteUrl: url.href, recordId:saved.id};
}
async function openConnectedPage(invite, target, forCapture = false) {
  if (target && siteKey(target) !== siteKey(new URL('https://' + invite.host))) throw Error('Choose a page on the website named in this review.');
  const {siteUrl, recordId} = await connect(invite);
  const url = target || publicPage(siteUrl, true);
  const opened = await chrome.tabs.create({url:url.href});
  await write(chrome.storage.session, connectedKey(opened.id), {site:siteKey(url), address:url.href, reviewId:recordId, forCapture});
  return {};
}
async function inject(tabId) {
  try { await chrome.scripting.executeScript({target: {tabId}, files: ['overlay.js']}); }
  catch { throw Error('Chrome could not add the feedback button. Click the extension on the website itself and try again.'); }
}
async function start(tab, url, replace, previousReviewerUrl) {
  // Check Chrome grants before creating any review on the server.
  try { await chrome.scripting.executeScript({target: {tabId: tab.id}, func: () => true}); }
  catch { throw Error('Chrome does not allow the feedback button on this page. Open the original website in a regular tab.'); }
  const record = replace ? await reviewFor(url, true, true, previousReviewerUrl) : await tabReview(tab, url, true);
  if (replace) await chrome.storage.session.remove(connectedKey(tab.id));
  const {data, reviewerUrl} = await board(record);
  requireOpen(data);
  if (reviewerUrl !== record.reviewerUrl) await updateLink(url, record, reviewerUrl);
  const now = await chrome.tabs.get(tab.id);
  if (publicPage(now.url).origin !== url.origin) throw Error('The tab changed. Click the extension on the page you want to review.');
  await write(chrome.storage.session, activeKey(tab.id), {origin: url.origin, reviewId: record.id});
  await inject(tab.id);
  return {reviewerUrl};
}
async function beginFeedback(tab, url) {
  const record = await tabReview(tab, url);
  if (record) requireOpen((await board(record)).data);
  await inject(tab.id);
  const now = await chrome.tabs.get(tab.id);
  if (publicPage(now.url).origin !== url.origin) throw Error('The tab changed. Click the extension on the page you want to review.');
  await write(chrome.storage.session, activeKey(tab.id), {origin: url.origin, reviewId: record?.id || null, drafting: !record});
  await chrome.tabs.sendMessage(tab.id, {type: 'pick-feedback'});
  return {};
}
function capturePage(data, url) {
  const existing = data.pages.find(page => {
    const pageUrl = new URL(page.url);
    return siteKey(pageUrl) === siteKey(url) && pageUrl.pathname === url.pathname && pageUrl.search === url.search;
  });
  return existing ? {pageId:existing.id} : {pageId:data.pages[0].id, url:url.href};
}
async function enabledTab(sender) {
  if (!sender.tab?.id || sender.frameId !== 0) throw Error('Start feedback in the active website tab.');
  const tab = await chrome.tabs.get(sender.tab.id);
  const url = await reviewedPage(tab);
  const enabled = await read(chrome.storage.session, activeKey(tab.id));
  if (!enabled || enabled.origin !== url.origin || new URL(sender.url).origin !== url.origin) throw Error('Click the extension on this site to reconnect the feedback button.');
  return {tab, url, enabled};
}
function cleanAnnotation(input) {
  if (input == null) return null;
  const invalid = () => { throw Error('Choose a point or draw a new mark before sending.'); };
  if (!['point','draw'].includes(input.kind) ||
      ![input.width,input.height].every(n => Number.isInteger(n) && n > 0 && n <= 32768)) invalid();
  const clean = {kind: input.kind, width: input.width, height: input.height};
  const point = pair => {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(n => Number.isFinite(n) && n >= 0 && n <= 1)) invalid();
    return pair.map(n => Math.round(n * 10000) / 10000);
  };
  if (input.kind === 'point') clean.point = point(input.point);
  else {
    if (!Array.isArray(input.strokes) || !input.strokes.length || input.strokes.length > 24) invalid();
    let count = 0;
    clean.strokes = input.strokes.map(stroke => {
      if (!Array.isArray(stroke) || !stroke.length || stroke.length > 256 || (count += stroke.length) > 640) invalid();
      return stroke.map(point);
    });
  }
  return clean;
}
async function note(message, sender) {
  const {tab, url, enabled} = await enabledTab(sender);
  if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 3000 || !/^[\w-]{8,80}$/.test(message.clientId || '')) throw Error('Enter a note of up to 3,000 characters.');
  const context = message.context || {};
  const annotation = cleanAnnotation(context.annotation);
  const drafting = enabled.drafting === true && enabled.reviewId === null;
  const record = await tabReview(tab, url, drafting);
  if (!record) throw Error('Return to the review and reconnect this page.');
  if (!drafting && enabled.reviewId !== record.id) throw Error('A different review is active. Open the extension to start feedback on this page again.');
  const {data, reviewerUrl} = await board(record);
  requireOpen(data);
  const bounded = value => typeof value === 'string' ? value.slice(0, 350) : '';
  const element = (annotation || context.mode === 'live') && typeof context.elementLabel === 'string'
    ? {tag: bounded(context.element?.tag), label: bounded(context.elementLabel), selector: bounded(context.selector)}
    : null;
  const clean = {source: 'Chrome extension', mode: annotation?.kind || (element ? 'live' : 'page'), pageUrl: url.href, browser: 'Chrome'};
  if (annotation) clean.annotation = annotation;
  if (element) Object.assign(clean, {element, selector: element.selector, elementLabel: element.label});
  if (Number.isFinite(context.viewport?.width) && Number.isFinite(context.viewport?.height)) {
    clean.liveViewport = clean.viewport = {width: context.viewport.width, height: context.viewport.height};
  }
  for (const k of ['scrollX', 'scrollY']) if (Number.isFinite(context[k])) clean[k] = context[k];
  await api('/' + record.id + '/notes', {method: 'POST', owner: record.owner,
    body: {pageId: data.pages[0].id, name: String(message.name || '').trim().slice(0, 80) || 'Guest',
      text: message.text.trim(), clientId: message.clientId, context: clean,
      ...(annotation?.kind === 'point' ? {x: annotation.point[0], y: annotation.point[1]} : {})}});
  const active = await read(chrome.storage.session, activeKey(tab.id));
  if (active?.origin === url.origin && active.reviewId === enabled.reviewId) {
    await write(chrome.storage.session, activeKey(tab.id), {origin: url.origin, reviewId: record.id, lastNoteReviewId: record.id});
  }
  if (reviewerUrl !== record.reviewerUrl) await updateLink(url, record, reviewerUrl);
  return {};
}
async function prepareImage(raw) {
  const blob = await (await fetch(raw)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    if (blob.size <= 1310720 && bitmap.width * bitmap.height <= 24000000 && Math.max(bitmap.width, bitmap.height) <= 16384) return raw;
    const scale = Math.min(1, 2600 / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.83, 0.67, 0.48, 0.31]) {
      const result = await canvas.convertToBlob({type: 'image/jpeg', quality});
      if (result.size > 1310720) continue;
      const bytes = new Uint8Array(await result.arrayBuffer());
      const parts = [];
      for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
      return 'data:image/jpeg;base64,' + btoa(parts.join(''));
    }
    throw Error('This screenshot is too large. Reduce the browser window size and capture again.');
  } finally { bitmap.close(); }
}
async function capturePixels(tab) {
  return withSiteLock('screenshots', async () => {
    // captureVisibleTab allows at most two calls per second. This includes
    // screenshots taken in other windows by this extension.
    const wait = 600 - (Date.now() - lastScreenshotTime);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    const before = await activeTab();
    if (before.id !== tab.id || before.url !== tab.url) throw Error('The tab changed. Capture the page again.');
    lastScreenshotTime = Date.now();
    const raw = await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'jpeg', quality: 82});
    const after = await activeTab();
    if (after.id !== tab.id || after.url !== tab.url) throw Error('The tab changed. Capture the page again.');
    return raw;
  });
}
async function fullImagePayload(image) {
  const bad = () => { throw Error('Capture this full page again before sharing.'); };
  if (!image || (image.dataUrl && image.tiles)) bad();
  const tiles = !!image.tiles;
  const list = tiles && Array.isArray(image.tiles) ? image.tiles.map(t => t?.dataUrl) : [image.dataUrl];
  if (!list.length || list.length > 24) bad();
  let sum = 0;
  const hashes = [];
  for (const data of list) {
    if (typeof data !== 'string' || !data.startsWith('data:image/jpeg;base64,') || (sum += data.length) > 14.1*1024*1024) bad();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
    hashes.push(Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2,'0')).join(''));
  }
  return {signature:(tiles ? 'tiles:' : 'single:') + hashes.join('.'),
    body:tiles ? {tiles:list.map(dataUrl => ({dataUrl}))} : {dataUrl:list[0]}};
}
async function capture(tab, url, area) {
  const record = await tabReview(tab, url);
  const full = area === 'full';
  const visible = hidden => chrome.tabs.sendMessage(tab.id, {type: 'capture-visibility', hidden}).catch(() => {});
  let view;
  try {
    if (full) {
      view = await fullScreenshot(tab, async () => {
        await visible(true);
        return capturePixels(tab);
      });
    } else {
      await visible(true);
      view = {dataUrl: await prepareImage(await capturePixels(tab))};
    }
  } finally { await visible(false); }
  const id = crypto.randomUUID();
  // Full images can exceed storage.session's quota. The trusted popup holds
  // the local preview; its receipt binds the submitted pixels to this capture.
  const payload = full ? {signature:(await fullImagePayload(view)).signature} : {dataUrl:view.dataUrl};
  await write(chrome.storage.session, captureKey(tab.id), {id, url: url.href, ...payload, reviewId: record?.id || null, created: Date.now()});
  return {...view, area:full ? 'full' : 'visible', captureKey: id, host: url.hostname, path: url.pathname};
}
async function shareCapture(tab, url, key, fullImage) {
  const preview = await read(chrome.storage.session, captureKey(tab.id));
  if (!preview || preview.id !== key || preview.url !== url.href || Date.now() - preview.created > 15 * 60 * 1000) {
    throw Error('Please capture this page again before sharing.');
  }
  if (preview.reviewerUrl) return {reviewerUrl: preview.reviewerUrl};
  let image = {dataUrl:preview.dataUrl};
  if (preview.signature) {
    const verified = await fullImagePayload(fullImage);
    if (verified.signature !== preview.signature) throw Error('The preview changed. Capture the full page again.');
    image = verified.body;
  }
  const record = await tabReview(tab, url, true);
  if (preview.reviewId && preview.reviewId !== record.id) throw Error('The review changed. Capture this page again.');
  if (!preview.reviewId) await write(chrome.storage.session, captureKey(tab.id), {...preview, reviewId: record.id});
  const {data, reviewerUrl} = await board(record);
  requireOpen(data);
  const result = await api('/' + record.id + '/captures', {method: 'POST', owner: record.owner,
    body: {...image, ...capturePage(data,url), label: preview.signature ? 'Full page' : 'Desktop screenshot'}});
  const id = result.capture.id;
  await updateLink(url, record, reviewerUrl, id);
  const shared = reviewerUrl + '#shot=' + encodeURIComponent(id);
  await write(chrome.storage.session, captureKey(tab.id), {id: key, url: url.href, created: preview.created, reviewerUrl: shared});
  return {reviewerUrl: shared};
}
async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id) throw Error('Open FGS Site Review to use this action.');
  if (message?.type === 'save-note') return note(message, sender);
  if (message?.type === 'open-note-board') {
    const {url, enabled} = await enabledTab(sender);
    const record = enabled.lastNoteReviewId && (await savedReviews()).find(r => r.id === enabled.lastNoteReviewId && siteKey(new URL('https://' + r.host)) === siteKey(url));
    if (!record) throw Error('Send feedback first, or open My reviews in the extension.');
    return openNotes(record);
  }
  if (sender.url !== chrome.runtime.getURL('popup.html')) throw Error('Open the FGS extension to use this action.');
  if (message?.type === 'list-reviews') {
    return {reviews: (await savedReviews()).map(({id, host, owner, reviewerUrl, savedAt, current}) =>
      ({id, host, isOwner: !!owner, reviewerUrl, savedAt, current}))};
  }
  if (message?.type === 'open-saved-review' || message?.type === 'get-saved-reviewer-link') {
    const record = (await savedReviews()).find(r => r.id === message.id);
    if (!record) throw Error('This review is not saved in this Chrome profile.');
    if (message.type === 'get-saved-reviewer-link') {
      const {reviewerUrl} = await board(record);
      return {reviewerUrl};
    }
    return openNotes(record);
  }
  const tab = await activeTab();
  const invite = parseInvite(tab.url);
  if (invite) {
    if (message.type === 'status') return {isReviewPage: true, host: invite.host, hasReview: false, canConnect: true};
    if (message.type === 'connect-review') {
      const {reviewerUrl, siteUrl} = await connect(invite);
      return {reviewerUrl, siteUrl};
    }
    if (message.type === 'open-connected-site') return openConnectedPage(invite);
    throw Error('Open the original website to leave feedback or take a screenshot.');
  }
  const url = await reviewedPage(tab);
  if (message.type === 'begin-feedback') return beginFeedback(tab, url);
  if (message.type === 'get-reviewer-link') {
    const record = await tabReview(tab, url, true);
    const {data, reviewerUrl} = await board(record);
    requireOpen(data);
    if (reviewerUrl !== record.reviewerUrl) await updateLink(url, record, reviewerUrl);
    return {reviewerUrl};
  }
  if (message.type === 'status') {
    const record = await tabReview(tab, url);
    const binding = await read(chrome.storage.session, connectedKey(tab.id));
    return {isReviewPage: false, host: url.hostname, hasReview: !!record, isOwner: !!record?.owner,
      captureRequested: !!binding?.forCapture,
      reviewerUrl: record?.reviewerUrl || null, lastScreenshotUrl: record?.lastShot ? record.reviewerUrl + '#shot=' + record.lastShot : null};
  }
  if (message.type === 'start' || message.type === 'new-review') {
    return start(tab, url, message.type === 'new-review', message.type === 'new-review' ? message.previousReviewerUrl : undefined);
  }
  if (message.type === 'capture') return withSiteLock('capture-window:' + tab.windowId, () => capture(tab, url, message.area));
  if (message.type === 'share-capture') return shareCapture(tab, url, message.captureKey, message.fullImage);
  if (message.type === 'discard-capture') {
    const key = captureKey(tab.id);
    const preview = await read(chrome.storage.session, key);
    if (preview && preview.id === message.captureKey) await chrome.storage.session.remove(key);
    return {};
  }
  if (message.type === 'open-review') {
    const record = await tabReview(tab, url);
    if (!record) throw Error('Send feedback or copy a client link to start a review.');
    return openNotes(record);
  }
  throw Error('This action is unavailable.');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  handle(message, sender).then(value => reply({ok: true, ...value})).catch(error => {
    reply({ok: false, error: error.message || 'FGS Site Review could not complete this action.'});
  });
  return true;
});
// The hosted board can open an original page for a review. Taking or sharing
// the screenshot still needs the user to invoke the extension on that tab.
chrome.runtime.onMessageExternal.addListener((message, sender, reply) => {
  (async () => {
    const invite = parseInvite(sender.url);
    if (message?.type !== 'open-capture-page' || sender.id || sender.frameId !== 0 || !sender.tab?.id ||
        sender.origin !== REVIEW_ORIGIN || !invite) throw Error('Open the shared review to connect its website.');
    const foreground = await activeTab();
    if (foreground.id !== sender.tab.id || parseInvite(foreground.url)?.id !== invite.id) throw Error('Open the extension from the active review.');
    if (typeof message.url !== 'string' || message.url.length > 2048) throw Error('Choose a valid page address.');
    await openConnectedPage(invite, publicPage(message.url,true), true);
    reply({ok:true});
  })().catch(error => reply({ok:false,error:error.message || 'Could not connect this review.'}));
  return true;
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status !== 'complete') return;
  (async () => {
    const selected = await read(chrome.storage.session, activeKey(tabId));
    if (!selected) return;
    let url;
    try { url = publicPage(tab.url); } catch { /* Chrome revoked this tab's grant. */ }
    if (!url || url.origin !== selected.origin) return chrome.storage.session.remove(activeKey(tabId));
    const record = await tabReview(tab, url);
    if (!selected.drafting && record?.id !== selected.reviewId) return chrome.storage.session.remove(activeKey(tabId));
    await inject(tabId);
  })().catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove([activeKey(tabId), captureKey(tabId), connectedKey(tabId)]).catch(() => {});
});
