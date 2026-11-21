// Run with Node 24, OpenSSL and Puppeteer 25.12.0. The browser, website,
// database and TLS identity are disposable. No request goes to the live app.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, createPublicKey, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import https from 'node:https';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import puppeteer from 'puppeteer';
import app from '../worker.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'fgs-chrome-test-'));
const reviewHost = 'sitereview.fernandezgrowthsystems.com';
// Both hostnames resolve to the loopback test server within this Chrome profile.
const siteHost = 'coastaltidelabs.com';
const otherSiteHost = 'second-client.example';
const sharedIp = '203.0.113.14';
const legacyWebRounds = 100;
const service = 'https://' + reviewHost;
const origin = 'https://' + siteHost;
const inviteId = 'knbdankbggjcdbdjcdgacibgbjiaffhg';
const db = new DatabaseSync(':memory:');
db.exec(await readFile(path.join(root, 'schema.sql'), 'utf8'));
class Statement {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.sql, args); }
  first() { return db.prepare(this.sql).get(...this.args) ?? null; }
  run() {
    const before = db.prepare('SELECT total_changes() n').get().n;
    const results = db.prepare(this.sql).all(...this.args);
    return {results, meta:{changes:db.prepare('SELECT total_changes() n').get().n - before}};
  }
}
const env = {
  DB: {
    prepare(sql) { return new Statement(sql); },
    batch(statements) {
      db.exec('BEGIN');
      try { const results = statements.map(s => s.run()); db.exec('COMMIT'); return results; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    }
  },
  ASSETS: {
    async fetch(req) {
      const route = new URL(req.url).pathname;
      const dist = path.join(root, 'dist');
      const file = path.resolve(dist, '.' + (route === '/' ? '/index.html' : route));
      assert(file.startsWith(dist + path.sep));
      const types = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.webp':'image/webp',
        '.png':'image/png', '.ico':'image/x-icon', '.webmanifest':'application/manifest+json'};
      try { return new Response(await readFile(file), {headers:{'Content-Type':types[path.extname(file)] ?? 'application/octet-stream'}}); }
      catch { return new Response('', {status:404}); }
    }
  }
};
const pause = ms => new Promise(r => setTimeout(r, ms));
async function seedLegacyRounds() {
  // The old service allowed 12 creations per IP and 100 in total per UTC day.
  // Leave enough time since midnight for this traffic to be outside a one-minute burst.
  let day = new Date().toISOString().slice(0,10);
  const elapsedToday = Date.now() - Date.parse(day + 'T00:00:00Z');
  if (elapsedToday < 61000) await pause(61000 - elapsedToday);
  day = new Date().toISOString().slice(0,10);
  const created = day + 'T00:00:00.000Z';
  const hash = value => createHash('sha256').update(value).digest('hex');
  const addReview = db.prepare('INSERT INTO reviews(id,owner_hash,host,url,title,created_at,creation_bucket) VALUES(?,?,?,?,?,?,?)');
  const addPage = db.prepare('INSERT INTO pages(id,review_id,url,label) VALUES(?,?,?,?)');
  const seedHost = 'earlier-web-review.example';
  const seedUrl = 'https://' + seedHost + '/';
  for (let i = 0; i < legacyWebRounds; i++) {
    const ip = i < 12 ? sharedIp : '198.51.100.' + i;
    const id = hash('legacy-review-' + i).slice(0,24);
    addReview.run(id, hash('legacy-owner-' + i), seedHost, seedUrl, 'Earlier web review', created, hash(day + '/' + ip));
    addPage.run(randomUUID(), id, seedUrl, 'Homepage');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE creation_bucket=?').get(hash(day + '/' + sharedIp)).n,12);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE created_at>=?').get(day).n,legacyWebRounds);
}
async function until(test, describe) {
  const limit = Date.now() + 15000;
  while (Date.now() < limit) { const value = await test(); if (value) return value; await pause(100); }
  throw Error('Timed out waiting for ' + describe);
}
const formMarkup = '<!doctype html><meta charset="utf-8"><title>FGS test fixture</title>' +
  '<style>body{font:24px system-ui;margin:0;color:#183d2a}main{box-sizing:border-box;min-height:2800px;padding:60px}' +
  'footer{box-sizing:border-box;height:440px;padding:50px;background:rgb(22,92,156);color:white}</style>' +
  '<main><h1>Review this headline</h1><p>This page contains only synthetic test content.</p>' +
  '<a href="/details">Browse details</a></main><footer>End of the test page</footer>';
// The application can check embedding headers from its server as well as its
// browser. Resolve both paths inside the fixture, including DNS lookups.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const fixtureHosts = [siteHost, otherSiteHost];
  if (url.origin === 'https://cloudflare-dns.com' && url.pathname === '/dns-query' && fixtureHosts.includes(url.searchParams.get('name'))) {
    const Answer = url.searchParams.get('type') === 'A' ? [{type:1,data:'93.184.216.34'}] : [];
    return Response.json({Status:0,Answer});
  }
  if (fixtureHosts.includes(url.hostname)) {
    return new Response(request.method === 'HEAD' ? null : formMarkup, {headers:{'Content-Type':'text/html','X-Frame-Options':'DENY'}});
  }
  throw Error('Fixture blocked an unexpected outgoing request to ' + url.hostname);
};
const apiTraffic = [];
async function requestHandler(req, res) {
  try {
    const host = req.headers.host.split(':')[0];
    if (host === siteHost || host === otherSiteHost) {
      res.writeHead(200, {'Content-Type':'text/html', 'X-Frame-Options':'DENY'});
      res.end(formMarkup); return;
    }
    assert.equal(host, reviewHost);
    const body = []; for await (const c of req) body.push(c);
    const request = new Request(service + req.url, {method:req.method, headers:{...req.headers, 'cf-connecting-ip':sharedIp},
      body:body.length ? Buffer.concat(body) : undefined});
    const response = await app.fetch(request, env);
    if (req.url.startsWith('/api/')) apiTraffic.push([req.method, req.url.split('/').slice(4).join('/'), response.status]);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) { console.error('Fixture server:', e.message); res.writeHead(500); res.end(); }
}
function count(table) { return db.prepare('SELECT COUNT(*) n FROM ' + table).get().n; }
async function visibleOverlayControl(session, attr, value) {
  // The extension intentionally uses a closed shadow root. Get its visible
  // control's rectangle and use genuine browser input, including isTrusted.
  return until(async () => {
    const {root:html} = await session.send('DOM.getDocument', {depth:-1, pierce:true});
    const queue = [html];
    while (queue.length) {
      const n = queue.pop();
      const attrs = n.attributes || [];
      if (attrs.some((a,i) => i % 2 === 0 && a === attr && attrs[i+1] === value)) {
        const model = await session.send('DOM.getBoxModel', {nodeId:n.nodeId}).catch(() => null);
        if (model && model.model.width && model.model.height) return model.model.border;
      }
      queue.push(...(n.children || []), ...(n.shadowRoots || []));
    }
  }, 'visible review control ' + value);
}
async function clickInOverlay(page, session, attr, value) {
  const rect = await visibleOverlayControl(session, attr, value);
  await page.mouse.click((rect[0]+rect[4])/2, (rect[1]+rect[5])/2);
}
async function openNotes(browser, click) {
  const known = new Set(browser.targets());
  const opened = browser.waitForTarget(t => !known.has(t) && t.type() === 'page'
    && t.url().startsWith(service + '/') && new URLSearchParams(new URL(t.url()).hash.slice(1)).get('panel') === 'notes',
    {timeout:15000});
  await click();
  const notes = await (await opened).asPage();
  await notes.waitForSelector('#notes-dialog[open]', {visible:true});
  await notes.waitForFunction(() => document.querySelector('#note-list').textContent.includes('Please shorten this headline.'));
  return notes;
}
let browser, server;
try {
  const keyPath = path.join(temp, 'fixture.key'), certPath = path.join(temp, 'fixture.pem');
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,
    '-out',certPath,'-days','1','-subj','/CN='+siteHost,'-addext','subjectAltName=DNS:'+siteHost+',DNS:'+otherSiteHost+',DNS:'+reviewHost], {stdio:'ignore'});
  const cert = await readFile(certPath);
  const pin = createHash('sha256').update(createPublicKey(cert).export({format:'der',type:'spki'})).digest('base64');
  server = https.createServer({key:await readFile(keyPath),cert}, requestHandler);
  await new Promise((resolve,reject) => server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port = server.address().port;
  const mappings = [siteHost,otherSiteHost,reviewHost].map(host => 'MAP '+host+' 127.0.0.1:'+port).join(', ');
  browser = await puppeteer.launch({enableExtensions:true, pipe:true, defaultViewport:null, headless:process.env.FGS_HEADLESS==='1',
    userDataDir:path.join(temp,'profile'), args:['--no-proxy-server','--disable-background-networking',
      '--ignore-certificate-errors-spki-list='+pin,'--host-resolver-rules='+mappings+', MAP * ~NOTFOUND, EXCLUDE localhost']});
  const id = await browser.installExtension(process.argv[2] ?? path.join(root,'extension'));
  assert.equal(id, inviteId, 'Downloaded extension identity must match the API origin');
  const extension = (await browser.extensions()).get(id);
  assert(extension);
  console.log('Loaded packaged extension in ' + await browser.version());
  const page = await browser.newPage();
  await page.setViewport({width:1000,height:740});
  await page.goto(origin + '/details?privateValue=do-not-send#private-fragment');
  const session = await page.createCDPSession();
  await seedLegacyRounds();
  async function popup(site = page) {
    await site.bringToFront();
    const known = new Set(browser.targets());
    const targetPromise = browser.waitForTarget(t => !known.has(t) && t.type() === 'page'
      && t.url() === 'chrome-extension://'+id+'/popup.html', {timeout:12000});
    await site.triggerExtensionAction(extension);
    const target = await targetPromise;
    const ui = await target.asPage();
    await ui.waitForSelector('#home:not([hidden])', {timeout:12000}).catch(async () => {
      throw Error('Extension popup: ' + (await ui.evaluate(() => document.body.innerText)));
    });
    return ui;
  }
  let ui = await popup();
  const popupSize = await ui.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const lines = selector => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector(selector));
      return new Set(Array.from(range.getClientRects(), rect => Math.round(rect.top))).size;
    };
    const visible = selector => {
      const bounds = document.querySelector(selector).getBoundingClientRect();
      return bounds.width > 0 && bounds.height >= 40 && bounds.top >= 0 && bounds.bottom <= innerHeight + 1;
    };
    return {version:chrome.runtime.getManifest().version, width:innerWidth, bodyWidth:document.body.getBoundingClientRect().width, scrollWidth:document.documentElement.scrollWidth,
      host:document.querySelector('#host').textContent, titleLines:lines('h1'), hostLines:lines('#host'),
      startVisible:visible('#start'), captureVisible:visible('#capture')};
  });
  assert.equal(popupSize.host, siteHost);
  const legacy = process.env.FGS_LEGACY_EXTENSION === '1';
  if (legacy) {
    assert.equal(popupSize.version,'1.0.0','The compatibility check must load the originally shipped ZIP');
    console.log('Testing the original installed extension against the updated API. Original popup width: ' + popupSize.width + ' CSS pixels.');
  } else {
    assert.notEqual(popupSize.version,'1.0.0','The layout check must load the updated ZIP');
    assert(popupSize.width >= 320 && popupSize.width <= 380, 'Actual Chrome toolbar popup width: ' + JSON.stringify(popupSize));
    assert(popupSize.bodyWidth >= 320 && popupSize.scrollWidth <= popupSize.width + 1, 'Popup overflow: ' + JSON.stringify(popupSize));
    assert.equal(popupSize.titleLines,1,'FGS Site Review should fit on one line');
    assert.equal(popupSize.hostLines,1,'The Coastal Tide Labs hostname should fit on one line');
    assert(popupSize.startVisible && popupSize.captureVisible,'Both primary actions must be on screen: ' + JSON.stringify(popupSize));
    console.log('Native Chrome toolbar popup measured ' + popupSize.width + ' CSS pixels; full site address and both actions are visible.');
  }
  if (process.env.FGS_PROOF_DIR) {
    await mkdir(process.env.FGS_PROOF_DIR,{recursive:true});
    await ui.screenshot({path:path.join(process.env.FGS_PROOF_DIR,legacy ? 'coastal-tide-original-popup.png' : 'coastal-tide-first-use-popup.png')});
  }
  assert.equal(count('reviews'),legacyWebRounds,'Opening the extension alone must not create a review');
  await ui.click('#start');
  if (legacy) {
    await until(() => count('reviews') === legacyWebRounds + 1, 'legacy extension review after prior web traffic');
    await clickInOverlay(page, session, 'aria-label', 'Leave feedback');
  } else {
    await visibleOverlayControl(session, 'id', 'fgs-mode-element');
    await page.keyboard.press('Escape');
    await visibleOverlayControl(session, 'aria-label', 'Leave feedback');
    assert.equal(count('reviews'),legacyWebRounds,'Canceling the picker must not create an empty review');
    ui = await popup();
    await ui.click('#start');
    await clickInOverlay(page, session, 'id', 'fgs-mode-element');
    await visibleOverlayControl(session, 'id', 'fgs-target-surface');
  }
  await page.click('h1');
  await clickInOverlay(page, session, 'id', 'fgs-note');
  await page.keyboard.type('Please shorten this headline.');
  if (process.env.FGS_PROOF_DIR) {
    await mkdir(process.env.FGS_PROOF_DIR,{recursive:true});
    await page.screenshot({path:path.join(process.env.FGS_PROOF_DIR,'desktop-live-feedback.png')});
  }
  await clickInOverlay(page, session, 'type', 'submit');
  const live = await until(() => db.prepare('SELECT text, context FROM notes').get(), 'saved live element note');
  const ctx = JSON.parse(live.context);
  assert.equal(live.text,'Please shorten this headline.');
  assert.equal(ctx.elementLabel, 'Review this headline');
  assert.equal(count('reviews'),legacyWebRounds + 1,'First saved feedback should create exactly one review');
  assert(!JSON.stringify(live).includes('privateValue'));
  console.log('Saved selected heading from the live original site, with private URL fields excluded.');

  if (!legacy) {
    const receiptNotes = await openNotes(browser, () => clickInOverlay(page, session, 'id', 'fgs-view-notes'));
    await receiptNotes.close();

    ui = await popup();
    await ui.click('#start');
    await clickInOverlay(page, session, 'id', 'fgs-mode-page');
    await clickInOverlay(page, session, 'id', 'fgs-note');
    await page.keyboard.type('This page reads well.');
    await clickInOverlay(page, session, 'type', 'submit');
    await until(() => count('notes') === 2,'whole-page feedback');

    ui = await popup();
    await ui.click('#start');
    await clickInOverlay(page, session, 'id', 'fgs-mode-point');
    await visibleOverlayControl(session, 'id', 'fgs-target-surface');
    await page.mouse.click(250,185);
    await clickInOverlay(page, session, 'id', 'fgs-note');
    await page.keyboard.type('Move this wording.');
    await clickInOverlay(page, session, 'type', 'submit');
    const pointed = await until(() => db.prepare('SELECT context FROM notes WHERE text=?').get('Move this wording.'),'saved live point');
    const pointMark = JSON.parse(pointed.context).annotation;
    assert.equal(pointMark.kind,'point');
    assert(Math.abs(pointMark.point[0] - 250/pointMark.width) < 0.02 && Math.abs(pointMark.point[1] - 185/pointMark.height) < 0.02);

    ui = await popup();
    await ui.click('#start');
    await clickInOverlay(page, session, 'id', 'fgs-mode-draw');
    await visibleOverlayControl(session, 'id', 'fgs-target-surface');
    await page.mouse.move(110, 270);
    await page.mouse.down();
    await page.mouse.move(250, 280, {steps:8});
    await page.mouse.move(235, 260, {steps:3});
    await page.mouse.up();
    await clickInOverlay(page, session, 'id', 'fgs-draw-finish');
    await clickInOverlay(page, session, 'id', 'fgs-note');
    await page.keyboard.type('Adjust the spacing here.');
    await clickInOverlay(page, session, 'type', 'submit');
    const drawing = await until(() => db.prepare('SELECT context,capture_id AS captureId FROM notes WHERE text=?').get('Adjust the spacing here.'),'saved live drawing');
    const mark = JSON.parse(drawing.context).annotation;
    assert.equal(mark.kind, 'draw');
    assert(mark.strokes[0].length >= 3);
    assert(mark.strokes[0].every(p => p.length === 2 && p.every(n => Number.isFinite(n) && n >= 0 && n <= 1)));
    const xs = mark.strokes[0].map(p => p[0]);
    assert(Math.max(...xs) - Math.min(...xs) > .08, 'Saved path must preserve the movement of the drawn arrow.');
    console.log('Saved page, point, element and freehand feedback with real coordinates on the original website.');
    ui = await popup();
    const ownerNotes = await openNotes(browser, () => ui.click('#open-notes'));
    const notesPath = new URL(ownerNotes.url()).pathname;
    await ownerNotes.waitForSelector('#note-list figure[data-kind="draw"] svg path', {visible:true});
    await ownerNotes.waitForSelector('#note-list figure[data-kind="point"] svg circle', {visible:true});
    await ownerNotes.click('#notes-dialog [data-close]');
    await ownerNotes.waitForFunction(() => ['fallback','page-help'].some(id => document.getElementById(id)?.getClientRects().length));
    const hasBlockedNotice = await ownerNotes.$eval('#fallback', el => el.getClientRects().length > 0);
    const originalButton = hasBlockedNotice ? '#fallback-open' : '#canvas-original';
    const screenshotButton = hasBlockedNotice ? '#fallback-screenshot' : '#canvas-full';
    assert.equal(await ownerNotes.$eval(originalButton, el => new URL(el.href).host), siteHost);
    await ownerNotes.waitForSelector(screenshotButton, {visible:true});
    console.log('The site refusing to embed offers the original website and screenshot feedback.');
    await ownerNotes.goto(service + '/');
    await ownerNotes.waitForSelector('#saved-review-list li', {visible:true});
    assert((await ownerNotes.$eval('#saved-review-list', el => el.innerText)).includes(siteHost));
    const savedNotesButton = await ownerNotes.$('#saved-review-list li button');
    assert.equal(await savedNotesButton.evaluate(el => el.textContent.trim()),'Open notes');
    await savedNotesButton.click();
    await ownerNotes.waitForSelector('#notes-dialog[open]',{visible:true});
    assert.equal(new URL(ownerNotes.url()).pathname,notesPath);
    await ownerNotes.close();

    const otherSite = await browser.newPage();
    await otherSite.goto('https://' + otherSiteHost + '/');
    ui = await popup(otherSite);
    await ui.click('#my-reviews');
    await ui.waitForSelector('#review-list li', {visible:true});
    const rows = await ui.$$('#review-list li');
    assert.equal(rows.length,1,'The shelf should have one saved review after one real submission');
    assert((await rows[0].evaluate(el => el.innerText)).includes(siteHost));
    if (process.env.FGS_PROOF_DIR) await ui.screenshot({path:path.join(process.env.FGS_PROOF_DIR,'find-saved-review.png')});
    const rowButtons = await rows[0].$$('button');
    const labels = await Promise.all(rowButtons.map(button => button.evaluate(el => el.textContent.trim())));
    const notesButton = rowButtons[labels.indexOf('Open notes')];
    assert(notesButton,'A saved review should expose an Open notes action');
    const sameNotes = await openNotes(browser, () => notesButton.click());
    assert.equal(new URL(sameNotes.url()).pathname, notesPath, 'The shelf must open the original review');
    await sameNotes.close();
    await otherSite.close();
    assert.equal(count('reviews'),legacyWebRounds + 1,'Finding notes must not create a review on either website');
    console.log('Found the saved note from its site, the browser-local web list and the extension on an unrelated site.');
  }

  await page.bringToFront();
  const originalSize = await page.evaluate(() => {
    window.scrollTo(0,520);
    return {width:document.documentElement.clientWidth,height:document.documentElement.scrollHeight,scroll:scrollY};
  });
  const capturesBeforePreview = count('captures');
  ui = await popup();
  if (!legacy) await ui.select('#capture-area', 'full');
  await ui.click('#capture');
  await ui.waitForSelector('#preview:not([hidden])', {timeout:30000});
  assert.equal(count('captures'),capturesBeforePreview,'A preview should stay private until Share is pressed');
  if (!legacy) assert.equal(await page.evaluate(() => scrollY),originalSize.scroll,'Full capture restores the starting scroll position.');
  await ui.click('#share');
  await ui.waitForSelector('#shared:not([hidden])', {timeout:15000}).catch(async () => {
    throw Error('Screenshot share: '+ await ui.$eval('#error',el=>el.textContent)); });
  const link = await ui.$eval('#share-link',el=>el.value);
  assert(link.startsWith(service+'/'+siteHost+'/')); assert.match(new URL(link).hash,/^#shot=[\w-]+$/);
  const imageId = new URLSearchParams(new URL(link).hash.slice(1)).get('shot');
  assert(db.prepare('SELECT id FROM captures WHERE id=?').get(imageId));
  assert.equal(count('reviews'),legacyWebRounds + 1);
  console.log('Captured real tab pixels, checked the private preview, and obtained a link to the shared image.');

  const guestContext = await browser.createBrowserContext();
  const guest = await guestContext.newPage(); await guest.setViewport({width:390,height:844,isMobile:true,hasTouch:true,deviceScaleFactor:1});
  await guest.goto(link);
  await guest.waitForFunction(() => document.querySelector('#capture-image')?.naturalWidth > 0);
  if (process.env.FGS_PROOF_DIR) {
    await guest.screenshot({path:path.join(process.env.FGS_PROOF_DIR,'phone-screenshot-review.png')});
  }
  await guest.click('#leave-feedback');
  await guest.click('#feedback-point');
  if (legacy) {
    await guest.click('#capture-image');
  } else {
    const measured = await guest.$eval('#capture-image', img => {
      const bitmap = document.createElement('canvas');
      bitmap.width = bitmap.height = 1;
      const context = bitmap.getContext('2d');
      context.drawImage(img,Math.floor(img.naturalWidth*.5),Math.floor(img.naturalHeight*.94),1,1,0,0,1,1);
      return {height:img.naturalHeight,width:img.naturalWidth,bottomColor:[...context.getImageData(0,0,1,1).data]};
    });
    assert(Math.abs(measured.height - originalSize.height) <= 2, 'The public image must contain the complete page height.');
    assert(Math.abs(measured.width - originalSize.width) <= 20, 'The captured width must match the original page.');
    assert([22,92,156].every((v,i) => Math.abs(measured.bottomColor[i] - v) <= 12),
      'The bottom of the shared image must contain the actual footer pixels.');
    const tall = await guest.$eval('#snapshot', el => el.scrollHeight - el.clientHeight);
    assert(tall > 150,'The phone should provide a scrollable full-page image.');
    const screen = await guest.$eval('#snapshot', el => {
      const box=el.getBoundingClientRect(); return {x:Math.round(box.x+box.width/2),y:Math.round(box.y+box.height*.7)};
    });
    const guestSession = await guest.createCDPSession();
    await guestSession.send('Input.synthesizeScrollGesture',{...screen,yDistance:-(tall+250),speed:1600,gestureSourceType:'touch'});
    await guest.waitForFunction(() => document.querySelector('#snapshot').scrollTop > 0, {timeout:5000});
    const pin = await guest.$eval('#shot-stage', el => {
      const box=el.getBoundingClientRect();
      return {x:Math.round(box.left+box.width*.4),y:Math.round(box.top+box.height*.91)};
    });
    assert(pin.y>0 && pin.y<844,'The lower-page target must be visible after touch scrolling.');
    await guest.touchscreen.tap(pin.x,pin.y);
  }
  await guest.waitForSelector('#composer[open]');
  await guest.type('#feedback','Please enlarge this section.');
  await guest.click('#note-form button[type=submit]');
  const note = await until(() => db.prepare('SELECT capture_id AS captureId,x,y,name FROM notes WHERE text=?')
    .get('Please enlarge this section.'),'guest screenshot note');
  assert.equal(note.captureId,imageId);
  assert(note.x >= 0 && note.x <= 1 && note.y >= 0 && note.y <= 1);
  if (!legacy) assert(Math.abs(note.y-.91) < .025, 'Phone feedback should stay attached below the fold of the complete capture.');
  assert.equal(note.name,'Guest');
  assert(apiTraffic.some(([m,,s])=>m==='POST' && s===201));
  if (!legacy) {
    await guest.goto(service + '/');
    await guest.waitForSelector('#my-reviews');
    assert.equal(await guest.$$eval('#saved-review-list li', els => els.length),0,
      'Opening a guest invite must not make it appear in the owner review list');
  }
  console.log('Independent guest at 390x844 opened the exact image and pinned an anonymous note in the same review.');
} catch (error) {
  console.error('Local API call outcomes (no credentials):', JSON.stringify(apiTraffic));
  throw error;
} finally {
  globalThis.fetch = originalFetch;
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
  db.close();
  await rm(temp, {recursive:true,force:true,maxRetries:3,retryDelay:100});
}
