// Run with Node 24, OpenSSL and Puppeteer 25.12.0. The browser, website,
// database and TLS identity are disposable. No request goes to the live app.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, createPublicKey} from 'node:crypto';
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
const siteHost = 'client-site.example';
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
async function until(test, describe) {
  const limit = Date.now() + 15000;
  while (Date.now() < limit) { const value = await test(); if (value) return value; await pause(100); }
  throw Error('Timed out waiting for ' + describe);
}
const formMarkup = '<!doctype html><meta charset="utf-8"><title>FGS test fixture</title>' +
  '<style>body{font:24px system-ui;margin:60px;color:#183d2a}</style>' +
  '<h1>Review this headline</h1><p>This page contains only synthetic test content.</p>' +
  '<a href="/details">Browse details</a>';
const apiTraffic = [];
async function requestHandler(req, res) {
  try {
    const host = req.headers.host.split(':')[0];
    if (host === siteHost) {
      res.writeHead(200, {'Content-Type':'text/html', 'X-Frame-Options':'DENY'});
      res.end(formMarkup); return;
    }
    assert.equal(host, reviewHost);
    const body = []; for await (const c of req) body.push(c);
    const request = new Request(service + req.url, {method:req.method, headers:req.headers,
      body:body.length ? Buffer.concat(body) : undefined});
    const response = await app.fetch(request, env);
    if (req.url.startsWith('/api/')) apiTraffic.push([req.method, req.url.split('/').slice(4).join('/'), response.status]);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) { console.error('Fixture server:', e.message); res.writeHead(500); res.end(); }
}
function count(table) { return db.prepare('SELECT COUNT(*) n FROM ' + table).get().n; }
async function clickInOverlay(page, session, attr, value) {
  // The extension intentionally uses a closed shadow root. Get its visible
  // control's rectangle and use genuine browser input, including isTrusted.
  const rect = await until(async () => {
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
  await page.mouse.click((rect[0]+rect[4])/2, (rect[1]+rect[5])/2);
}
let browser, server;
try {
  const keyPath = path.join(temp, 'fixture.key'), certPath = path.join(temp, 'fixture.pem');
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,
    '-out',certPath,'-days','1','-subj','/CN='+siteHost,'-addext','subjectAltName=DNS:'+siteHost+',DNS:'+reviewHost], {stdio:'ignore'});
  const cert = await readFile(certPath);
  const pin = createHash('sha256').update(createPublicKey(cert).export({format:'der',type:'spki'})).digest('base64');
  server = https.createServer({key:await readFile(keyPath),cert}, requestHandler);
  await new Promise((resolve,reject) => server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port = server.address().port;
  const mappings = [siteHost,reviewHost].map(host => 'MAP '+host+' 127.0.0.1:'+port).join(', ');
  browser = await puppeteer.launch({enableExtensions:true, pipe:true, headless:process.env.FGS_HEADLESS==='1',
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
  async function popup() {
    await page.bringToFront();
    const targetPromise = browser.waitForTarget(t => t.type() === 'page' && t.url() === 'chrome-extension://'+id+'/popup.html', {timeout:12000});
    await page.triggerExtensionAction(extension);
    const target = await targetPromise;
    const ui = await target.asPage();
    await ui.waitForSelector('#home:not([hidden])', {timeout:12000}).catch(async () => {
      throw Error('Extension popup: ' + (await ui.evaluate(() => document.body.innerText)));
    });
    return ui;
  }
  let ui = await popup();
  assert.equal(count('reviews'),0,'Opening the extension alone must not create a review');
  await ui.click('#start');
  await clickInOverlay(page, session, 'aria-label', 'Leave feedback');
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
  assert(!JSON.stringify(live).includes('privateValue'));
  console.log('Saved selected heading from the live original site, with private URL fields excluded.');

  ui = await popup();
  await ui.click('#capture');
  await ui.waitForSelector('#preview:not([hidden])');
  assert.equal(count('captures'),0, 'A preview should stay private until Share is pressed');
  await ui.click('#share');
  await ui.waitForSelector('#shared:not([hidden])', {timeout:15000}).catch(async () => {
    throw Error('Screenshot share: '+ await ui.$eval('#error',el=>el.textContent)); });
  const link = await ui.$eval('#share-link',el=>el.value);
  assert(link.startsWith(service+'/'+siteHost+'/')); assert.match(new URL(link).hash,/^#shot=[\w-]+$/);
  assert.equal(count('captures'),1); assert.equal(count('reviews'),1);
  console.log('Captured real tab pixels, checked the private preview, and obtained a screenshot-only guest link.');

  const guestContext = await browser.createBrowserContext();
  const guest = await guestContext.newPage(); await guest.setViewport({width:390,height:844});
  await guest.goto(link);
  await guest.waitForFunction(() => document.querySelector('#capture-image')?.naturalWidth > 0);
  if (process.env.FGS_PROOF_DIR) {
    await guest.screenshot({path:path.join(process.env.FGS_PROOF_DIR,'phone-screenshot-review.png')});
  }
  await guest.click('#leave-feedback');
  await guest.click('#capture-image');
  await guest.waitForSelector('#composer[open]');
  await guest.type('#feedback','Please enlarge this section.');
  await guest.click('#note-form button[type=submit]');
  await until(() => count('notes')===2,'guest screenshot note');
  const note = db.prepare('SELECT capture_id AS captureId,x,y,name FROM notes WHERE capture_id IS NOT NULL').get();
  assert(note.captureId && note.x >= 0 && note.x <= 1 && note.y >= 0 && note.y <= 1);
  assert.equal(note.name,'Guest');
  assert(apiTraffic.some(([m,,s])=>m==='POST' && s===201));
  console.log('Independent guest at 390x844 opened the exact image and pinned an anonymous note in the same review.');
} catch (error) {
  console.error('Local API call outcomes (no credentials):', JSON.stringify(apiTraffic));
  throw error;
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
  db.close();
  await rm(temp, {recursive:true,force:true,maxRetries:3,retryDelay:100});
}
