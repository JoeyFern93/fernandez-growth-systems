import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {test} from 'node:test';

const source = readFileSync(new URL('../extension/worker.js', import.meta.url), 'utf8');
const service = 'https://sitereview.fernandezgrowthsystems.com';
const id = 'knbdankbggjcdbdjcdgacibgbjiaffhg';
const invite = 'A'.repeat(24);
const owner = 'B'.repeat(43);
const path = '/example.com/' + invite;
const shareLink = service + path;
const shot = '5809deff-b4df-43f0-b32e-1157b1bbf9eb';
const pageId = '2edf25b4-cbe3-4773-9e51-d116f2b1e145';
const raw = 'data:image/jpeg;base64,/9j/2Q==';
function store() {
  const items = new Map();
  return {items, accessLevel: null, async get(key) { return {[key]: items.get(key)}; },
    async set(entries) { for (const [key, value] of Object.entries(entries)) items.set(key, value); },
    async remove(key) { for (const item of [].concat(key)) items.delete(item); },
    async setAccessLevel({accessLevel}) { this.accessLevel = accessLevel; }};
}
function event() {
  return {addListener(f) { this.listener = f; }};
}
function harness({local = store(), state = {closed: false, switchCapture: false}, issued = new Map()} = {}) {
  const popup = {id, url: 'chrome-extension://' + id + '/popup.html'};
  const tab = {id: 42, windowId: 1, url: 'https://example.com/home?secret=TOKEN#secret'};
  const session = store();
  const calls = [], opened = [], injections = [], hidden = [];
  const pages = [{id: pageId, url: 'https://example.com/home'}];
  const runtime = {id, onMessage: event(), getURL: name => 'chrome-extension://' + id + '/' + name};
  const chrome = {runtime, storage: {local, session}, tabs: {query: async () => [{...tab}], get: async () => ({...tab}),
    create: async obj => { opened.push(obj.url); }, onRemoved: event(), onUpdated: event(),
    sendMessage: async (_id, message) => hidden.push(message.hidden),
    captureVisibleTab: async () => { if (state.switchCapture) tab.id++; return raw; }},
    scripting: {executeScript: async args => { injections.push(args); }}};
  async function transport(url, options) {
    if (url === raw) return new Response(new Uint8Array([255, 216, 255, 217]));
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({url, options, body});
    const route = new URL(url).pathname.replace('/api/reviews', '');
    let result;
    if (route === '') {
      if (!issued.has(body.creationKey)) {
        const newPath = issued.size === 0 ? path : '/example.com/' + ('C' + issued.size).padEnd(24, 'C');
        issued.set(body.creationKey, {ownerPath: newPath + '#owner=' + owner, reviewerPath: newPath});
      }
      result = issued.get(body.creationKey);
      if (state.dropCreateResponse) {
        state.dropCreateResponse = false;
        throw Error('Network response lost after commit');
      }
    }
    else if (/^\/[\w-]{24}$/.test(route)) result = {review: {host: 'example.com', url: 'https://example.com/home', reviewerPath: '/example.com' + route, closed: state.closed}, pages};
    else if (route.endsWith('/pages')) {
      assert.equal(options.headers.Authorization, 'Bearer ' + owner);
      const p = {id: 'page-two', url: body.url}; pages.push(p); result = {page: p};
    }
    else if (route.endsWith('/notes')) result = {note: {}};
    else if (route.endsWith('/captures')) result = {capture: {id: shot}};
    else throw Error('Unexpected request');
    return Response.json(result);
  }
  runInNewContext(source, {chrome, URL, URLSearchParams, crypto: webcrypto, fetch: transport,
    createImageBitmap: async () => ({width: 800, height: 600, close() {}})});
  const send = (type, rest = {}, sender = popup) => new Promise(resolve => runtime.onMessage.listener({type, ...rest}, sender, resolve));
  const fromPage = () => ({id, url: tab.url, tab: {...tab}, frameId: 0});
  return {send, fromPage, local, session, calls, tab, injections, hidden, opened, state, issued};
}
test('interrupted creation survives a worker restart, another page and simultaneous Start clicks', async () => {
  const first = harness();
  first.state.dropCreateResponse = true;
  assert.match((await first.send('start')).error, /could not reach/i);
  assert.equal((await first.send('status')).hasReview, false);
  const before = first.calls[0].body;
  assert.match(before.creationKey, /^[0-9a-f]{64}$/);
  assert.match(before.creatorId, /^[0-9a-f-]{36}$/);
  const retry = harness(first);
  retry.tab.url = 'https://example.com/other';
  const starts = await Promise.all([retry.send('start'), retry.send('start')]);
  assert(starts.every(r => r.reviewerUrl === shareLink));
  const creates = retry.calls.filter(c => c.url.endsWith('/api/reviews'));
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].body, before);
  assert.equal(first.issued.size, 1);
  assert(!JSON.stringify(await retry.send('status')).includes(before.creationKey));
  assert(!JSON.stringify([...retry.local.items.values()]).includes(before.creationKey));

  const replacement = await Promise.all([retry.send('new-review', {previousReviewerUrl: shareLink}),
    retry.send('new-review', {previousReviewerUrl: shareLink})]);
  assert(replacement[0].ok && replacement[0].reviewerUrl !== shareLink);
  assert.equal(replacement[0].reviewerUrl, replacement[1].reviewerUrl);
  assert.equal(first.issued.size, 2);
});
test('explicit website feedback keeps credentials in trusted storage, strips URL secrets and preserves the selected element', async () => {
  const h = harness();
  assert.equal((await h.send('status')).hasReview, false);
  assert.equal(h.calls.length, 0);
  const started = await h.send('start');
  assert.equal(started.reviewerUrl, shareLink);
  assert.equal(h.local.accessLevel, 'TRUSTED_CONTEXTS');
  assert.equal(h.calls[0].body.url, 'https://example.com/home');
  assert.ok(h.injections.some(i => i.files?.includes('overlay.js')));
  h.tab.url = 'https://example.com/about?invite=SECRET#private';
  const message = {text: 'Make this easier to find.', clientId: 'one-note-key',
    context: {mode: 'live', elementLabel: 'Book a session', selector: 'main > button', viewport: {width: 900, height: 600}, scrollY: 24}};
  assert.equal((await h.send('save-note', message, h.fromPage())).ok, true);
  const note = h.calls.at(-1).body;
  assert.equal(note.context.mode, 'live');
  assert.equal(note.context.element.label, 'Book a session');
  assert.equal(note.context.selector, 'main > button');
  assert.equal(note.context.pageUrl, 'https://example.com/about');
  assert.equal(note.name, 'Guest');
  assert.equal(note.clientId, message.clientId);
  assert.equal(JSON.stringify(h.calls).includes('SECRET'), false);
  assert.equal((await h.send('open-review', {}, h.fromPage())).ok, false);
  await h.send('open-review');
  assert.equal(h.opened[0], shareLink + '#owner=' + owner + '&panel=notes');
  assert.equal(JSON.stringify(await h.send('status')).includes(owner), false);
  h.state.closed = true;
  assert.match((await h.send('start')).error, /closed/);
});
test('local screenshot preview can be canceled, then confirmed and retried without retaining image bytes', async () => {
  const h = harness();
  const preview = await h.send('capture');
  assert.equal(preview.dataUrl, raw);
  assert.deepEqual(h.hidden, [true, false]);
  assert.equal(h.calls.length, 0);
  await h.send('discard-capture', {captureKey: preview.captureKey});
  assert.equal(h.session.items.has('capture:42'), false);
  assert.equal((await h.send('share-capture', {captureKey: preview.captureKey})).ok, false);
  const current = await h.send('capture');
  const shared = await h.send('share-capture', {captureKey: current.captureKey});
  assert.equal(shared.reviewerUrl, shareLink + '#shot=' + shot);
  assert.ok(!JSON.stringify(h.session.items.get('capture:42')).includes('data:image'));
  assert.equal((await h.send('share-capture', {captureKey: current.captureKey})).reviewerUrl, shared.reviewerUrl);
  assert.equal(h.calls.filter(c => c.url.endsWith('/captures')).length, 1);
  assert.equal((await h.send('status')).lastScreenshotUrl, shared.reviewerUrl);
  h.state.switchCapture = true;
  assert.match((await h.send('capture')).error, /tab changed/);
});
test('a connected existing guest round can receive whole-page notes on a second URL without creating another round', async () => {
  const h = harness();
  h.tab.url = shareLink + '#shot=' + shot;
  assert.equal((await h.send('status')).isReviewPage, true);
  assert.equal((await h.send('connect-review')).reviewerUrl, shareLink);
  await h.send('open-connected-site');
  assert.equal(h.opened[0], 'https://example.com/home');
  assert.ok(!h.local.items.get('site:example.com').owner);
  h.tab.url = 'https://example.com/another-page';
  await h.send('start');
  const message = {text: 'Page suggestion', clientId: 'second-page-key', context: {mode: 'page'}};
  assert.equal((await h.send('save-note', message, h.fromPage())).ok, true);
  assert.equal(h.calls.at(-1).body.context.pageUrl, h.tab.url);
  assert.equal(h.calls.at(-1).body.pageId, pageId);
  assert.equal(h.calls.at(-1).body.context.mode, 'page');
  assert.equal(h.calls.at(-1).options.headers.Authorization, undefined);
  assert.ok(!h.calls.some(c => c.url.endsWith('/api/reviews')));
  const screenshot = await h.send('capture');
  assert.match((await h.send('share-capture', {captureKey: screenshot.captureKey})).error, /page note here first/);
});
