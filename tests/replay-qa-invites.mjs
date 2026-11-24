import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {installPhoneCounter,verifyMoving,verifyMixedReplay} from './replay-qa-pictures.mjs';

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

export async function checkInvite(browser, camera, relay = false) {
  const multi = camera !== null;
  const multiSender = multi && !relay;
  const label = relay ? 'USB webcam and relayed phone' : multi ? 'Camera ' + camera : 'Single camera';
  const tv = await newDevice(browser, {width:1280,height:800});
  const phone = await newDevice(browser, {width:390,height:844});
  let acceptedChunks = 0, largestChunk = 0, offers = 0, starts = 0, rooms = 0, claims = 0;
  let webcamTrack;
  if(relay) {
    await phone.page.addInitScript(installPhoneCounter);
    // ICE is available in the browser but cannot produce a usable address.
    await phone.page.addInitScript(blockDirectNetwork);
    phone.page.on('response', response => {
      const req=response.request(), url=new URL(response.url());
      if(url.origin!==service || req.method()!=='POST' || !response.ok())return;
      if(url.pathname.endsWith('/relay-chunk')){
        acceptedChunks++;
        largestChunk=Math.max(largestChunk,req.postDataBuffer()?.length || 0);
      } else if(url.pathname.endsWith('/claim'))claims++;
      else if(url.pathname.endsWith('/offer'))offers++;
      else if(url.pathname.endsWith('/relay') && req.postDataJSON()?.action==='start')starts++;
    });
  }
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
    rooms++;
    createRead = (async () => {
      token = request.postDataJSON().tvToken;
      room = (await response.json()).id;
    })().catch(() => {});
  });
  try {
    phase = label + ' opening the invite dialog';
    await tv.page.goto(site + (multi ? '/replay/multicam/' : '/replay/'), {waitUntil:'domcontentloaded'});
    if(relay) {
      phase=label+' selecting the display webcam';
      await tv.page.waitForFunction(()=>typeof document.querySelector('#baseline .webcam')?.onchange==='function',null,{timeout:12000});
      await tv.page.locator('#baseline .webcam').selectOption('default');
      await verifyMoving(tv.page,'#baseline .picture');
      webcamTrack=await tv.page.locator('#baseline .picture video').evaluate(video=>video.srcObject.getVideoTracks()[0].id);
    }
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
    assert.ok(url.origin === site && url.pathname === (multiSender ? '/replay/multicam/phone' : '/replay/tv/phone'),
      'The primary phone invite must select a working transport for the current setup.');
    await createRead;
    assert.ok(typeof room === 'string' && room.length === 22 && token?.length === 43, 'Room creation was not observed on the isolated API.');
    const hash = new URLSearchParams(url.hash.slice(1));
    assert.ok(multiSender ? hash.get('room') === room && hash.get('camera') === String(camera) && hash.has('invite') :
      hash.get('pair')?.startsWith(room + '.') && hash.has('key'), 'Invite details do not match the new room.');
    if(relay)assert.equal(hash.get('transport'),'relay');
    phase = label + ' claiming room and starting camera';
    await phone.page.goto(decoded.data,{waitUntil:'domcontentloaded'});
    const claim = phone.page.waitForResponse(r => r.url() === api + '/' + room + '/claim' && r.request().method() === 'POST', {timeout:18000});
    const [response] = await Promise.all([claim, phone.page.locator(multiSender ? '#start' : '#phone-start').click({timeout:12000})]);
    assert.ok(response.ok(), 'Preview room claim failed.');
    phase = label + ' waiting for changing video on display';
    const slot = camera === 2 ? '#sideline' : '#baseline';
    const frame = await verifyMoving(tv.page, multi ? slot + ' .picture' : '#viewer');
    console.log(label + ': QR decoded, phone started once, three distinct pictures reached display at ' + frame.width + 'x' + frame.height + '.');
    if(relay) {
      phase=label+' reading delayed phone marker, pause and scrub';
      await tv.page.waitForFunction(()=>/internet relay/i.test(document.querySelector('#sideline .status').textContent),null,{timeout:9000});
      const replay=await verifyMixedReplay(tv.page,phone.page);
      await phone.page.waitForFunction(()=>/recording/i.test(document.querySelector('#relay-original-status')?.textContent),null,{timeout:9000});
      assert.equal(await phone.page.evaluate(()=>testCamera.opens),1,'Camera opened more than once');
      assert.ok(acceptedChunks>=2 && largestChunk>0 && largestChunk<=256*1024,'Expected capped encrypted packets');
      assert.equal(offers,0,'Relay selection sent a direct offer');
      assert.equal(rooms,1,'The mixed setup required a second invite');
      assert.equal(claims,1,'The phone had to join more than once');
      assert.equal(starts,1,'Relay started more than once');
      console.log(label+': selected transport active; delayed optical picture '+replay.lagMs+' ms behind phone; pause held and scrub restored the chosen marker.');
    }
    phase = label + ' stopping phone camera';
    await phone.page.locator(multiSender ? '#stop' : '#phone-stop').click({timeout:8000});
    if(relay) {
      await phone.page.waitForFunction(()=>testCamera.tracks.every(t=>t.readyState==='ended'),null,{timeout:8000});
      const original=phone.page.locator('#relay-originals');
      await original.locator('summary').click();
      await original.locator('button').first().click();
      await original.locator('a[href^="blob:"]').first().waitFor({timeout:10000});
      assert.equal(await tv.page.locator('#baseline .webcam').inputValue(),'default');
      assert.equal(await tv.page.locator('#baseline .picture video').evaluate(video=>video.srcObject.getVideoTracks()[0].id),webcamTrack,
        'Phone pairing or disconnection replaced the active webcam');
      await verifyMoving(tv.page,'#baseline .picture',10000);
      const finished=acceptedChunks;
      await delay(1500);
      assert.equal(acceptedChunks,finished,'Relay uploads continued after the phone stopped');
      console.log(label+': phone released, original available on phone, USB picture still changing, relay stopped uploading.');
    }
  } catch (error) {
    console.error(label + ' HTTP results: ' + (Array.from(statuses).join(', ') || 'no preview API response'));
    throw error;
  } finally {
    try {
      await createRead;
      if (room && token) {
        const resource = api + '/' + room;
        const [closed,status] = await tv.page.evaluate(async ({resource,token})=>{
          const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
          const end=await fetch(resource+'/end',{method:'POST',headers,body:'{}',redirect:'error',signal:AbortSignal.timeout(8000)});
          const check=await fetch(resource,{headers,redirect:'error',signal:AbortSignal.timeout(8000)});
          return [end.status,check.status];
        },{resource,token});
        assert.ok(closed===200 || closed===410,'Could not revoke the isolated test room.');
        assert.equal(status,410,'Revoked room is still active.');
      }
    } finally {
      await Promise.all([tv.context.close(),phone.context.close()]);
    }
  }
}

function blockDirectNetwork() {
  const PeerConnection = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends PeerConnection {
    constructor(configuration) {
      super({...configuration, iceServers:[], iceTransportPolicy:'relay'});
    }
  };
}

export async function runOpticalSync(browser,options={}) {
  const {checkRelaySync}=await import('./replay-qa-sync.mjs');
  return checkRelaySync(browser,{site,service,newDevice,...options});
}

export async function checkBlockedDirectRecovery(browser) {
  const tv = await newDevice(browser,{width:1280,height:800});
  const phone = await newDevice(browser,{width:390,height:844});
  const panel = tv.page.locator('#sideline');
  const sessions = [];
  const creations = [];
  tv.page.on('response',response=>{
    if(response.url()!==api || response.request().method()!=='POST' || response.status()!==201)return;
    creations.push(response.json().then(({id})=>sessions.push({id,key:response.request().postDataJSON().tvToken})));
  });
  try {
    await phone.page.addInitScript(blockDirectNetwork);
    await phone.page.addInitScript(installPhoneCounter);
    phase='checking the phone-first USB webcam setup link';
    await tv.page.goto(site+'/replay/multicam/?setup=webcam-phone');
    await panel.locator('.invite').click();
    await tv.page.locator('#qr svg').waitFor();
    const first=await tv.page.locator('#phone-link').getAttribute('href');
    assert.equal(new URLSearchParams(new URL(first).hash.slice(1)).get('transport'),'relay');
    await tv.page.locator('#close').click();
    await tv.page.locator('#baseline .webcam').selectOption('default');
    await verifyMoving(tv.page,'#baseline .picture');
    const webcam=tv.page.locator('#baseline .picture video');
    const webcamTrack=await webcam.evaluate(v=>v.srcObject.getVideoTracks()[0].id);
    // Exercise the same failure dialog users reach on a network blocking WebRTC.
    await panel.locator('.invite').click();
    await tv.page.locator('#use-slot-direct').click();
    await tv.page.locator('#phone-link[href*="#room="]').waitFor();
    const direct=await tv.page.locator('#phone-link').getAttribute('href');
    phase='waiting for a blocked direct connection to offer relay for this camera';
    await phone.page.goto(direct);
    await phone.page.locator('#start').click();
    await tv.page.locator('#retry-invite').waitFor({timeout:55000});
    await tv.page.locator('#use-slot-relay').click();
    const code=tv.page.locator('#qr svg');
    await code.waitFor();
    const png=PNG.sync.read(await code.screenshot());
    const decoded=decodeQR(new Uint8ClampedArray(png.data),png.width,png.height);
    assert.ok(decoded,'Could not scan the replacement relay invite');
    assert.ok(decoded.data===await tv.page.locator('#phone-link').getAttribute('href'));
    const recovered=new URL(decoded.data);
    assert.equal(recovered.pathname,'/replay/tv/phone');
    assert.equal(new URLSearchParams(recovered.hash.slice(1)).get('transport'),'relay');
    phase='starting the replacement relay with the same phone and webcam';
    await phone.page.goto(decoded.data);
    await phone.page.locator('#phone-start').click();
    await verifyMoving(tv.page,'#sideline .picture');
    await verifyMoving(tv.page,'#baseline .picture');
    assert.equal(await webcam.evaluate(v=>v.srcObject.getVideoTracks()[0].id),webcamTrack);
    await phone.page.locator('#phone-stop').click();
    console.log('Phone-first setup offers relay. A blocked direct camera can rescan its replacement QR while the original webcam continues.');
  } finally {
    try {
      await Promise.all(creations);
      await tv.page.evaluate(async ({api,sessions})=>{
        for(const {id,key} of sessions) {
          await fetch(api+'/'+id+'/end',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
            body:'{}',signal:AbortSignal.timeout(8000)});
        }
      },{api,sessions});
    } finally {
      await Promise.all([tv.context.close(),phone.context.close()]);
    }
  }
}

async function main(){
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
  await checkInvite(browser,2,true);
  await checkBlockedDirectRecovery(browser);
  phase='measuring USB and relayed phone sync on the hosted preview';
  await runOpticalSync(browser,{delaySeconds:3,long:true});
  phase='measuring USB and JPEG fallback sync on the hosted preview';
  await runOpticalSync(browser,{jpeg:true,driverStamps:false});
} catch (error) {
  // Playwright errors can contain the phone's private fragment. Log only
  // the stage and the safe assertion text defined here, never browser URLs.
  console.error('Hosted Replay Cam test failed while ' + phase + '.');
  if (error instanceof assert.AssertionError && !String(error.message).includes('http')) console.error(error.message);
  process.exitCode = 1;
  } finally { await browser?.close(); }
}
if(import.meta.url===pathToFileURL(process.argv[1]).href) await main();
