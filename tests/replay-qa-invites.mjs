import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';

// Deliberately pinned to this test branch. Never follow a room API redirect.
const site = 'https://qa-replay-audit-fixes-202611.fernandez-growth-systems.pages.dev';
const service = 'https://qa-replay-audit-fixes-202611.fgs-site-review.pages.dev';
const api = service + '/api/replay-pair';
const require = createRequire(path.join(process.env.REPLAY_QA_PACKAGES, 'package.json'));
const {chromium} = require('playwright-core');
const {PNG} = require('pngjs');
const decodeQR = require('jsqr');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let phase = 'waiting for hosted test assets';

async function waitForDeployments() {
  const assets = ['/replay/tv/pair-endpoint.js', '/replay/tv/pair.js', '/replay/multicam/tv.mjs', '/replay/multicam/signaling.mjs'];
  const expected = await Promise.all(assets.map(url => readFile('site' + url, 'utf8')));
  const until = Date.now() + 300000;
  do {
    try {
      const matching = await Promise.all(assets.map(async (url, i) => {
        const response = await fetch(site + url + '?qa=' + (process.env.GITHUB_SHA || Date.now()), {
          redirect:'error', cache:'no-store', signal:AbortSignal.timeout(7000)
        });
        const text = await response.text();
        return response.ok && text.replaceAll('\r\n','\n') === expected[i].replaceAll('\r\n','\n');
      }));
      const preflight = await fetch(api, {
        method:'OPTIONS', redirect:'error', signal:AbortSignal.timeout(7000), headers:{
          Origin:site, 'Access-Control-Request-Method':'POST', 'Access-Control-Request-Headers':'content-type'
        }
      });
      if(matching.every(Boolean) && preflight.ok && preflight.headers.get('access-control-allow-origin') === site) return;
    } catch { /* The two preview deployments finish independently. */ }
    await delay(6000);
  } while(Date.now() < until);
  throw new Error('Preview assets or preview-origin preflight have not reached this commit.');
}

async function newDevice(browser, viewport) {
  const context = await browser.newContext({viewport, deviceScaleFactor:2, serviceWorkers:'block'});
  await context.grantPermissions(['camera'],{origin:site});
  // Keep this smoke test isolated even if the deployed frontend is misconfigured.
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === site || (url.origin === service && /^\/api\/replay-pair(?:\/|$)/.test(url.pathname))) {
      await route.continue();
    } else {
      await route.abort();
    }
  });
  return {context, page:await context.newPage()};
}

function sampleRemoteVideo(selector) {
  const video = document.querySelector(selector);
  if (!video || video.readyState < 2 || video.videoWidth < 16 ||
      !video.srcObject?.getVideoTracks().some(track => track.readyState === 'live')) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 36;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video,0,0,canvas.width,canvas.height);
  const pixels = ctx.getImageData(0,0,canvas.width,canvas.height).data;
  let fingerprint = 2166136261;
  for (const channel of pixels) fingerprint = Math.imul(fingerprint ^ channel, 16777619);
  return {fingerprint, width:video.videoWidth, height:video.videoHeight};
}

async function verifyMoving(page, selector) {
  const frames = new Set();
  const until = Date.now() + 42000;
  do {
    const frame = await page.evaluate(sampleRemoteVideo, selector);
    if (frame) {
      frames.add(frame.fingerprint);
      if (frames.size >= 3) return frame;
    }
    await delay(200);
  } while (Date.now() < until);
  throw new Error('No changing camera pictures reached the display.');
}

async function checkInvite(browser, camera) {
  const multi = camera !== null;
  const label = multi ? 'Camera ' + camera : 'Single camera';
  const tv = await newDevice(browser, {width:1280,height:800});
  const phone = await newDevice(browser, {width:390,height:844});
  const statuses = new Set();
  for (const page of [tv.page,phone.page]) {
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== service || !url.pathname.startsWith('/api/replay-pair')) return;
      const action = url.pathname.split('/')[4] || (url.pathname === '/api/replay-pair' ? 'create' : 'poll');
      if (['create','claim','offer','answer','poll','end','candidates','relay','ice-servers','relay-chunk'].includes(action)) {
        statuses.add(response.request().method()+' '+action+': '+response.status());
      }
    });
  }
  let room, token, createRead;
  tv.page.on('response', response => {
    const request = response.request();
    if (request.url() !== api || request.method() !== 'POST' || response.status() !== 201) return;
    createRead = (async () => {
      token = request.postDataJSON().tvToken;
      room = (await response.json()).id;
    })().catch(() => {});
  });
  try {
    phase = label + ' opening the invite dialog';
    await tv.page.goto(site + (multi ? '/replay/multicam/' : '/replay/'), {waitUntil:'domcontentloaded'});
    const button = tv.page.locator(multi ? '#camera-' + camera + '-invite' : '#pairTvBtn');
    if (!multi && !await button.isVisible()) {
      const open = tv.page.locator('#toggleReplayControls[aria-expanded="false"]');
      if (await open.isVisible()) await open.click();
      if (await tv.page.locator('#cameraTab').isVisible()) await tv.page.locator('#cameraTab').click();
    }
    await button.click({timeout:12000});
    const dialog = tv.page.locator(multi ? '#invite-dialog[open]' : '#tv-pair-dialog[open]');
    const code = dialog.locator(multi ? '#qr svg' : '#tv-qr svg');
    await code.waitFor({state:'visible',timeout:25000});
    await delay(900); // The reported regression briefly flashed then dismissed.
    phase = label + ' decoding visible QR pixels';
    const png = PNG.sync.read(await code.screenshot({timeout:6000}));
    const decoded = decodeQR(new Uint8ClampedArray(png.data), png.width, png.height);
    assert.ok(decoded, 'QR pixels are unreadable.');
    const link = await dialog.locator(multi ? '#phone-link' : '#tv-phone-link').getAttribute('href');
    assert.ok(decoded.data === link, 'Scanned QR differs from phone link.');
    const url = new URL(link);
    assert.ok(url.origin === site && url.pathname === (multi ? '/replay/multicam/phone' : '/replay/tv/phone'));
    await createRead;
    assert.ok(typeof room === 'string' && room.length === 22 && token?.length === 43, 'Room creation was not observed on the isolated API.');
    const hash = new URLSearchParams(url.hash.slice(1));
    assert.ok(multi ? hash.get('room') === room && hash.get('camera') === String(camera) && hash.has('invite') :
      hash.get('pair')?.startsWith(room + '.') && hash.has('key'), 'Invite details do not match the new room.');
    phase = label + ' claiming room and starting camera';
    await phone.page.goto(decoded.data,{waitUntil:'domcontentloaded'});
    const claim = phone.page.waitForResponse(r => r.url() === api + '/' + room + '/claim' && r.request().method() === 'POST', {timeout:18000});
    const [response] = await Promise.all([claim, phone.page.locator(multi ? '#start' : '#phone-start').click({timeout:12000})]);
    assert.ok(response.ok(), 'Preview room claim failed.');
    phase = label + ' waiting for changing video on display';
    const slot = camera === 2 ? '#sideline' : '#baseline';
    const frame = await verifyMoving(tv.page, multi ? slot + ' .picture video' : '#liveVideo');
    console.log(label + ': QR decoded, phone started once, three distinct pictures reached display at ' + frame.width + 'x' + frame.height + '.');
    phase = label + ' stopping phone camera';
    await phone.page.locator(multi ? '#stop' : '#phone-stop').click({timeout:8000});
  } catch (error) {
    console.error(label + ' HTTP results: ' + (Array.from(statuses).join(', ') || 'no preview API response'));
    throw error;
  } finally {
    try {
      await createRead;
      if (room && token) {
        const resource = api + '/' + room;
        const headers = {Origin:site, Authorization:'Bearer '+token, 'Content-Type':'application/json'};
        const closed = await fetch(resource + '/end', {method:'POST', headers, body:'{}', redirect:'error', signal:AbortSignal.timeout(8000)});
        assert.ok(closed.ok || closed.status === 410, 'Could not revoke the isolated test room.');
        const status = await fetch(resource, {headers, redirect:'error', signal:AbortSignal.timeout(8000)});
        assert.ok(status.status === 410, 'Revoked room is still active.');
      }
    } finally {
      await Promise.all([tv.context.close(),phone.context.close()]);
    }
  }
}

let browser;
try {
  await waitForDeployments();
  browser = await chromium.launch({executablePath:process.env.FGS_CHROME_BIN, args:[
    '--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',
    '--allow-loopback-in-peer-connection','--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling','--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding','--disable-features=WebRtcHideLocalIpsWithMdns'
  ]});
  for (const camera of [1,2,null]) await checkInvite(browser,camera);
} catch (error) {
  // Playwright errors can contain the phone's private fragment. Log only
  // the stage and the safe assertion text defined here, never browser URLs.
  console.error('Hosted Replay Cam test failed while ' + phase + '.');
  if (error instanceof assert.AssertionError && !String(error.message).includes('http')) console.error(error.message);
  process.exitCode = 1;
} finally { await browser?.close(); }
