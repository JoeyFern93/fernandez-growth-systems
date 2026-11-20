/* global chrome, OffscreenCanvas, createImageBitmap */
'use strict';

const REVIEW_ORIGIN = 'https://sitereview.fernandezgrowthsystems.com';
const INVITE = /^[A-Za-z0-9_-]{24}$/;
const OWNER = /^[A-Za-z0-9_-]{43}$/;
const SITE_KEY = 'site:';
const activeKey = id => 'active:' + id;
const captureKey = id => 'capture:' + id;
const locks = new Map();
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
function publicPage(address) {
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
  url.search = '';
  url.hash = '';
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
  const url = publicPage(data.review.url);
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
    await chrome.storage.local.set({[key]: record, [pendingKey]: null});
    return record;
  });
}
async function updateLink(url, record, latest, screenshotId) {
  return withSiteLock(siteKey(url), async () => {
    const current = await read(chrome.storage.local, siteKey(url));
    if (!current || current.id !== record.id) return;
    await write(chrome.storage.local, siteKey(url), {...current, reviewerUrl: latest, lastShot: screenshotId || current.lastShot});
  });
}
function requireOpen(data) {
  if (data.review.closed) throw Error('This review is closed. Open the extension and choose Start a new review, or ask the owner to reopen it.');
}
async function connect(tab, invite) {
  const record = {id: invite.id, host: invite.host, owner: invite.owner};
  const {data, url, reviewerUrl} = await board(record);
  requireOpen(data);
  const key = siteKey(url);
  await withSiteLock(key, async () => {
    const old = await read(chrome.storage.local, key);
    // Opening the guest version of your own round should keep your owner access.
    const same = old?.reviewerUrl === reviewerUrl;
    const preferred = !record.owner && same && old.owner ? old : record;
    await write(chrome.storage.local, key, {...preferred, reviewerUrl, lastShot: same ? old.lastShot : undefined});
  });
  return {reviewerUrl, siteUrl: url.href};
}
async function inject(tabId) {
  try { await chrome.scripting.executeScript({target: {tabId}, files: ['overlay.js']}); }
  catch { throw Error('Chrome could not add the feedback button. Click the extension on the website itself and try again.'); }
}
async function start(tab, url, replace, previousReviewerUrl) {
  // Check Chrome grants before creating any review on the server.
  try { await chrome.scripting.executeScript({target: {tabId: tab.id}, func: () => true}); }
  catch { throw Error('Chrome does not allow the feedback button on this page. Open the original website in a regular tab.'); }
  const record = await reviewFor(url, true, replace, previousReviewerUrl);
  const {data, reviewerUrl} = await board(record);
  requireOpen(data);
  if (reviewerUrl !== record.reviewerUrl) await updateLink(url, record, reviewerUrl);
  const now = await chrome.tabs.get(tab.id);
  if (publicPage(now.url).origin !== url.origin) throw Error('The tab changed. Click the extension on the page you want to review.');
  await write(chrome.storage.session, activeKey(tab.id), {origin: url.origin, reviewId: record.id});
  await inject(tab.id);
  return {reviewerUrl};
}
async function ensurePage(data, url, record) {
  const existing = data.pages.find(page => {
    const pageUrl = new URL(page.url);
    return siteKey(pageUrl) === siteKey(url) && pageUrl.pathname === url.pathname && !pageUrl.search;
  });
  if (existing) return existing.id;
  if (!record.owner) throw Error('This page has not been added to the review. Leave a page note here first, then share the screenshot.');
  return (await api('/' + record.id + '/pages', {method: 'POST', owner: record.owner, body: {url: url.href}})).page.id;
}
async function note(message, sender) {
  if (!sender.tab?.id || sender.frameId !== 0) throw Error('Start feedback in the active website tab.');
  const tab = await chrome.tabs.get(sender.tab.id);
  const url = publicPage(tab.url);
  const enabled = await read(chrome.storage.session, activeKey(tab.id));
  if (!enabled || enabled.origin !== url.origin || new URL(sender.url).origin !== url.origin) throw Error('Click the extension on this site to reconnect the feedback button.');
  if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 3000 || !/^[\w-]{8,80}$/.test(message.clientId || '')) throw Error('Enter a note of up to 3,000 characters.');
  const record = await reviewFor(url, false);
  if (enabled.reviewId !== record.id) throw Error('A different review is active. Open the extension to start feedback on this page again.');
  const {data, reviewerUrl} = await board(record);
  requireOpen(data);
  const context = message.context || {};
  const bounded = value => typeof value === 'string' ? value.slice(0, 350) : '';
  const element = context.mode === 'live' && typeof context.elementLabel === 'string'
    ? {tag: bounded(context.element?.tag), label: bounded(context.elementLabel), selector: bounded(context.selector)}
    : null;
  const clean = {source: 'Chrome extension', mode: element ? 'live' : 'page', pageUrl: url.href, browser: 'Chrome'};
  if (element) Object.assign(clean, {element, selector: element.selector, elementLabel: element.label});
  if (Number.isFinite(context.viewport?.width) && Number.isFinite(context.viewport?.height)) {
    clean.liveViewport = clean.viewport = {width: context.viewport.width, height: context.viewport.height};
  }
  for (const k of ['scrollX', 'scrollY']) if (Number.isFinite(context[k])) clean[k] = context[k];
  await api('/' + record.id + '/notes', {method: 'POST', owner: record.owner,
    body: {pageId: data.pages[0].id, name: String(message.name || '').trim().slice(0, 80) || 'Guest', text: message.text.trim(), clientId: message.clientId, context: clean}});
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
async function capture(tab, url) {
  await chrome.tabs.sendMessage(tab.id, {type: 'capture-visibility', hidden: true}).catch(() => {});
  let raw;
  try {
    const before = await activeTab();
    if (before.id !== tab.id || before.url !== tab.url) throw Error('The tab changed. Capture the page again.');
    raw = await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'jpeg', quality: 82});
    const after = await activeTab();
    if (after.id !== tab.id || after.url !== tab.url) throw Error('The tab changed. Capture the page again.');
  } finally {
    await chrome.tabs.sendMessage(tab.id, {type: 'capture-visibility', hidden: false}).catch(() => {});
  }
  const dataUrl = await prepareImage(raw);
  const id = crypto.randomUUID();
  const record = await read(chrome.storage.local, siteKey(url));
  await write(chrome.storage.session, captureKey(tab.id), {id, url: url.href, dataUrl, reviewId: record?.id || null, created: Date.now()});
  return {dataUrl, captureKey: id, host: url.hostname, path: url.pathname};
}
async function shareCapture(tab, url, key) {
  const preview = await read(chrome.storage.session, captureKey(tab.id));
  if (!preview || preview.id !== key || preview.url !== url.href || Date.now() - preview.created > 15 * 60 * 1000) {
    throw Error('Please capture this page again before sharing.');
  }
  if (preview.reviewerUrl) return {reviewerUrl: preview.reviewerUrl};
  const record = await reviewFor(url, true);
  if (preview.reviewId && preview.reviewId !== record.id) throw Error('The review changed. Capture this page again.');
  if (!preview.reviewId) await write(chrome.storage.session, captureKey(tab.id), {...preview, reviewId: record.id});
  const {data, reviewerUrl} = await board(record);
  requireOpen(data);
  const pageId = await ensurePage(data, url, record);
  const result = await api('/' + record.id + '/captures', {method: 'POST', owner: record.owner, body: {dataUrl: preview.dataUrl, pageId, label: 'Desktop screenshot'}});
  const id = result.capture.id;
  await updateLink(url, record, reviewerUrl, id);
  const shared = reviewerUrl + '#shot=' + encodeURIComponent(id);
  await write(chrome.storage.session, captureKey(tab.id), {id: key, url: url.href, created: preview.created, reviewerUrl: shared});
  return {reviewerUrl: shared};
}
async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id) throw Error('Open FGS Site Review to use this action.');
  if (message?.type === 'save-note') return note(message, sender);
  if (sender.url !== chrome.runtime.getURL('popup.html')) throw Error('Open the FGS extension to use this action.');
  const tab = await activeTab();
  const invite = parseInvite(tab.url);
  if (invite) {
    if (message.type === 'status') return {isReviewPage: true, host: invite.host, hasReview: false, canConnect: true};
    if (message.type === 'connect-review') return connect(tab, invite);
    if (message.type === 'open-connected-site') {
      const {url} = await board(invite);
      await chrome.tabs.create({url: url.href});
      return {};
    }
    throw Error('Open the original website to leave feedback or take a screenshot.');
  }
  const url = publicPage(tab.url);
  if (message.type === 'status') {
    const record = await read(chrome.storage.local, siteKey(url));
    return {isReviewPage: false, host: url.hostname, hasReview: !!record, isOwner: !!record?.owner,
      reviewerUrl: record?.reviewerUrl || null, lastScreenshotUrl: record?.lastShot ? record.reviewerUrl + '#shot=' + record.lastShot : null};
  }
  if (message.type === 'start' || message.type === 'new-review') {
    return start(tab, url, message.type === 'new-review', message.type === 'new-review' ? message.previousReviewerUrl : undefined);
  }
  if (message.type === 'capture') return capture(tab, url);
  if (message.type === 'share-capture') return shareCapture(tab, url, message.captureKey);
  if (message.type === 'discard-capture') {
    const key = captureKey(tab.id);
    const preview = await read(chrome.storage.session, key);
    if (preview && preview.id === message.captureKey) await chrome.storage.session.remove(key);
    return {};
  }
  if (message.type === 'open-review') {
    const record = await reviewFor(url, false);
    const destination = record.owner ? REVIEW_ORIGIN + '/' + record.host + '/' + record.id + '#owner=' + record.owner + '&panel=notes' : record.reviewerUrl + '#panel=notes';
    await chrome.tabs.create({url: destination});
    return {};
  }
  throw Error('This action is unavailable.');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  handle(message, sender).then(value => reply({ok: true, ...value})).catch(error => {
    reply({ok: false, error: error.message || 'FGS Site Review could not complete this action.'});
  });
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
    const record = await read(chrome.storage.local, siteKey(url));
    if (record?.id !== selected.reviewId) return chrome.storage.session.remove(activeKey(tabId));
    await inject(tabId);
  })().catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove([activeKey(tabId), captureKey(tabId)]).catch(() => {});
});
