import assert from 'node:assert/strict';
import path from 'node:path';
import {open, writeFile} from 'node:fs/promises';

// Run with Node 24 and Chrome. In the repo root set REPLAY_SITE_ROOT=site and
// REPLAY_WORKER_ROOT=apps/site-review, then run node tests/replay-tv-e2e.mjs
// --audit=single. Cases: single, direct, relay, disconnect, quiet-stop, still,
// replacement. The existing e2e runner blocks outbound requests and uses a
// temporary local SQLite database. No camera hardware or hosted API is used.
const width = 320;
const height = 180;
const pictures = 720;
const markerCount = pictures / 3;

export async function writeHistoryCamera(filename, still) {
  const output = await open(filename, 'w');
  const frame = Buffer.alloc(width * height * 1.5, 128);
  const row = Buffer.alloc(width);
  try {
    await output.write(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`);
    for (let i = 0; i < (still ? 2 : pictures); i++) {
      // A stable 100-ms optical marker survives codec drops and the sampling
      // cadence of the independent player used to decode the saved selection.
      const marker = Math.floor(i / 3);
      for (let x = 0; x < width; x++) {
        const stripe = Math.floor(x * 12 / width);
        const white = stripe === 0 || (stripe < 11 && (marker & (1 << (stripe - 1))));
        row[x] = still ? 98 : white ? 215 : 32;
      }
      for (let y = 0; y < height; y++) row.copy(frame, y * width);
      await output.write('FRAME\n');
      await output.write(frame);
    }
  } finally { await output.close(); }
}

// Browser-side functions. Keep the readout independent of app state/timestamps.
function readMarker(video) {
  if (video.readyState < 2) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 120;
  canvas.height = 3;
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const pixels = ctx.getImageData(0, 1, canvas.width, 1).data;
  const bits = Array.from({length: 12}, (_, i) => pixels[(5 + 10 * i) * 4] > 135 ? 1 : 0);
  if (!bits[0] && bits[11]) bits.reverse();
  if (!bits[0] || bits[11]) return null;
  return bits.slice(1, -1).reduce((n, bit, i) => n + (bit << i), 0);
}

function readReplay() {
  const el = id => document.getElementById(id);
  const video = el('delayedVideo'), buffered = video.buffered, range = el('reviewRange');
  return {
    span: buffered.length ? buffered.end(buffered.length - 1) - buffered.start(0) : 0,
    oldest: Number(range.min), newest: Number(range.max), playhead: video.currentTime,
    seek: !range.disabled, save: !el('recordClipBtn').disabled, retry: !el('startBtn').disabled,
    cameraDisconnected: el('cameraStatus').textContent === 'Camera disconnected',
    status: el('replayStatus').textContent, message: el('bufferStatus').textContent,
    live: el('liveVideo').srcObject?.getVideoTracks()[0]?.readyState === 'live',
    replacementSelected: el('cameraSelect').value === 'fixture-unavailable'
  };
}

function setControl(id, value) {
  const control = document.getElementById(id);
  control.value = String(value);
  for (const event of ['input', 'change']) control.dispatchEvent(new Event(event, {bubbles: true}));
}

async function readSavedClip() {
  const player = document.createElement('video');
  player.muted = true;
  player.playsInline = true;
  player.style.cssText = 'position:fixed;bottom:0;right:0;width:90px;height:50px';
  player.src = document.getElementById('downloadLink').href;
  document.body.append(player);
  const markers = [];
  let callback, timeout;
  function sample() {
    const marker = window.readAuditMarker(player);
    if (marker !== null) markers.push(marker);
    if (!player.ended) callback = player.requestVideoFrameCallback(sample);
  }
  const ended = new Promise(resolve => player.addEventListener('ended', () => resolve(true), {once: true}));
  const limit = new Promise(resolve => { timeout = setTimeout(() => resolve(false), 10000); });
  try {
    callback = player.requestVideoFrameCallback(sample);
    await player.play();
    return {ended: await Promise.race([ended, limit]), width: player.videoWidth, height: player.videoHeight, markers};
  } finally {
    clearTimeout(timeout);
    player.cancelVideoFrameCallback(callback);
    player.pause();
    player.remove();
  }
}

const evaluate = (tab, fn, ...args) =>
  tab.get('(' + fn.toString() + ')(' + args.map(arg => JSON.stringify(arg)).join(',') + ')');
const click = (tab, id) => evaluate(tab, id => document.getElementById(id).click(), id);
const state = tab => evaluate(tab, readReplay);

async function pair({tv, phone, requests}, transport) {
  const invite = await tv.until("document.querySelector('#tv-phone-link')?.href?.includes('#pair=') && document.querySelector('#tv-phone-link').href", 'pairing invite');
  await phone.navigate(invite);
  await phone.until("typeof document.querySelector('#phone-start')?.onclick === 'function'", 'phone start');
  await phone.click('phone-start');
  if (transport === 'direct') {
    return tv.until("__inspectMedia().then(s=>s.received.find(v=>v.frames>=12))", 'decoded direct video', 35000);
  }
  const status = await phone.until("document.querySelector('#phone-status')?.textContent.match(/Encrypted video relay.*Sending video/i)?.[0]", 'automatic encrypted video', 55000);
  await tv.until("document.querySelector('#liveVideo')?.readyState>=2", 'rendered relay video');
  assert(requests.some(r => r.op === 'relay-chunk' && r.verb === 'POST' && r.status < 300));
  return status;
}

async function disconnectDuringStartup(tv, sendsEvent) {
  await evaluate(tv, sendsEvent => {
    const devices = navigator.mediaDevices;
    const get = devices.getUserMedia.bind(devices);
    devices.getUserMedia = async constraints => {
      const stream = await get(constraints);
      devices.getUserMedia = get;
      const track = stream.getVideoTracks()[0];
      // stop() does not itself fire ended. Exercise both failure signals.
      setTimeout(() => {
        track.stop();
        if (sendsEvent) track.dispatchEvent(new Event('ended'));
      }, 60);
      return stream;
    };
  }, sendsEvent);
  await click(tv, 'startBtn');
  await tv.until("document.querySelector('#cameraStatus')?.textContent==='Camera disconnected'", 'disconnected indication');
  const stopped = await state(tv);
  assert(stopped.retry && !stopped.seek && !stopped.save && stopped.span === 0);
  return stopped;
}

async function checkCameraChoice(tv, baseline, withFailure, delay) {
  const opened = await tv.get("window.auditOriginalStream=document.querySelector('#liveVideo').srcObject; __inspectMedia().then(s=>s.requests.length)");
  assert.equal(await tv.get("document.querySelector('#cameraSelect').options.length"), 1);
  await click(tv, 'flipBtn');
  await delay(300);
  assert.equal((await tv.get('__inspectMedia()')).requests.length, opened);
  assert(await tv.get("document.querySelector('#liveVideo').srcObject===window.auditOriginalStream"));
  const after = await state(tv);
  assert(after.live && after.save && after.span >= baseline.span - .1);
  if (!withFailure) return {single: after};
  await evaluate(tv, () => {
    const devices = navigator.mediaDevices;
    const enumerate = devices.enumerateDevices.bind(devices);
    devices.enumerateDevices = async () => [...await enumerate(), {kind: 'videoinput', deviceId: 'fixture-unavailable', label: 'Second camera'}];
    const get = devices.getUserMedia.bind(devices);
    devices.getUserMedia = async constraints => {
      if (constraints.video?.deviceId?.exact === 'fixture-unavailable') {
        const mode = window.auditSecondCameraMode || 'busy';
        window.auditReplacementAttempted = mode;
        if (mode === 'busy') throw new DOMException('Camera occupied', 'NotReadableError');
        // An open track without a single decoded frame, then a separate working
        // track carrying the optical fixture. Keep both trials on the same ID.
        const candidate = mode === 'silent'
          ? new MediaStreamTrackGenerator({kind: 'video'})
          : window.auditOriginalStream.getVideoTracks()[0].clone();
        const settings = candidate.getSettings.bind(candidate);
        candidate.getSettings = () => ({...settings(), deviceId: 'fixture-unavailable', frameRate: 30});
        window.auditCandidate = candidate;
        return new MediaStream([candidate]);
      }
      return get(constraints);
    };
    devices.dispatchEvent(new Event('devicechange'));
  });
  await tv.until("document.querySelector('#cameraSelect').options.length===2", 'second input listed');
  await evaluate(tv, setControl, 'cameraSelect', 'fixture-unavailable');
  await tv.until("window.auditReplacementAttempted && document.querySelector('#cameraSelect').value!=='fixture-unavailable'", 'first camera restored');
  assert(await tv.get("document.querySelector('#liveVideo').srcObject===window.auditOriginalStream"));
  const failed = await state(tv);
  assert(failed.live && failed.save && failed.seek && failed.span >= baseline.span - .1);
  await tv.get("window.auditSecondCameraMode='silent'");
  await evaluate(tv, setControl, 'cameraSelect', 'fixture-unavailable');
  await tv.until("window.auditReplacementAttempted==='silent'", 'second camera opened');
  await delay(500);
  assert(await tv.get("window.auditCandidate.readyState==='live' && document.querySelector('#liveVideo').srcObject===window.auditOriginalStream"));
  await tv.until("window.auditCandidate.readyState==='ended' && document.querySelector('#cameraSelect').value!=='fixture-unavailable'", 'nonproducing second source released', 15000);
  const silent = await state(tv);
  assert(silent.live && silent.save && silent.seek && silent.span >= failed.span);
  return {single: after, rejectedReplacement: failed, emptyReplacement: silent};
}

async function scrub(tv, seconds, delay) {
  await evaluate(tv, setControl, 'reviewRange', seconds);
  await tv.until(`!document.querySelector('#delayedVideo').seeking && Math.abs(document.querySelector('#delayedVideo').currentTime-${seconds})<.08`, 'seek to identified play');
  await delay(180);
  return tv.get("window.readAuditMarker(document.querySelector('#delayedVideo'))");
}

export async function runHistoryAudit(context, auditCase) {
  const {tv, phone, site, requests, output, delay} = context;
  const report = {auditCase};
  const isPaired = ['direct', 'relay'].includes(auditCase);
  const retry = ['disconnect', 'quiet-stop'].includes(auditCase);
  const changeDelay = isPaired || ['single', 'replacement'].includes(auditCase);
  await tv.navigate(site + (isPaired ? '/replay/?mode=tv' : '/replay/'));
  await tv.until("document.querySelector('#startBtn') && document.readyState==='complete'", 'dashboard');
  await tv.get('window.readAuditMarker=' + readMarker.toString());
  await evaluate(tv, setControl, 'delayRange', changeDelay ? 10 : 1);
  if (retry) report.disconnected = await disconnectDuringStartup(tv, auditCase === 'disconnect');
  if (isPaired) report.transport = await pair(context, auditCase);
  else await click(tv, 'startBtn');
  await tv.until("!document.querySelector('#reviewRange').disabled", 'usable history after start', 30000);
  const needed = changeDelay ? 12 : 6;
  await tv.until('(' + readReplay.toString() + ')().span>' + needed, 'enough history to inspect', 30000);
  report.before = await state(tv);
  assert(report.before.live && report.before.save && report.before.seek);

  if (auditCase !== 'still') {
    if (auditCase === 'single' || auditCase === 'replacement') {
      report.cameraChoice = await checkCameraChoice(tv, report.before, auditCase === 'replacement', delay);
    }
    const target = Number((report.before.oldest + .4 * (report.before.newest - report.before.oldest)).toFixed(2));
    const marker = await scrub(tv, target, delay);
    assert(marker !== null, 'a visible marker identifies the original play');
    report.marked = {target, marker};
    if (changeDelay) {
      await click(tv, 'returnDelayBtn');
      report.afterDelay = [];
      for (const seconds of [5, 1]) {
        await evaluate(tv, setControl, 'delayRange', seconds);
        await delay(140);
        const after = await state(tv);
        assert(after.seek && after.save && after.span >= report.before.span - .1);
        assert(Math.abs((after.newest - after.playhead) - seconds) < 1.5, 'requested delay applies to playhead');
        report.afterDelay.push({seconds, ...after});
      }
      assert.equal(await scrub(tv, target, delay), marker);
      await click(tv, 'returnDelayBtn');
      await evaluate(tv, setControl, 'delayRange', 60);
      await delay(300);
      report.longerDelay = await state(tv);
      assert(report.longerDelay.seek && report.longerDelay.save && report.longerDelay.span >= report.before.span - .1);
      const remaining = report.longerDelay.status.match(/Waiting (\d+)s for delay/);
      assert(remaining && Math.abs(Number(remaining[1]) - (60 - report.longerDelay.span)) < 2,
        'a longer delay reports its remaining wait while retaining history');
      await scrub(tv, target, delay);
    }

    await click(tv, 'recordClipBtn');
    await tv.until("!document.querySelector('#trimPanel').hidden", 'clip editor');
    await evaluate(tv, setControl, 'trimStartRange', target - .75);
    await evaluate(tv, setControl, 'trimEndRange', target + .75);
    await click(tv, 'trimExportBtn');
    await tv.until("document.querySelector('#downloadLink').href.startsWith('blob:')", 'exported file', 30000);
    const decoded = await evaluate(tv, readSavedClip);
    const range = decoded.markers;
    assert(decoded.ended && decoded.width && decoded.height && new Set(range).size >= 6);
    assert(range.includes(marker), 'saved file contains the original marked play');
    const distance = n => (n - marker + markerCount * 1.5) % markerCount - markerCount / 2;
    assert(range.some(n => distance(n) < 0) && range.some(n => distance(n) > 0), 'saved file moves across the play');
    report.export = decoded;
    if (retry) {
      await tv.get("document.querySelector('#liveVideo').srcObject.getVideoTracks()[0].stop()");
      await tv.until("document.querySelector('#cameraStatus').textContent==='Camera disconnected'", 'silent stop during playback');
      report.stoppedAgain = await state(tv);
      assert(report.stoppedAgain.retry && !report.stoppedAgain.save);
    }
    if (auditCase === 'replacement') {
      await click(tv, 'trimCancelBtn');
      await tv.until("document.querySelector('#trimPanel').hidden", 'clip editor closed');
      await tv.get("window.auditSecondCameraMode='healthy'");
      await evaluate(tv, setControl, 'cameraSelect', 'fixture-unavailable');
      await tv.until("window.auditReplacementAttempted==='healthy' && window.auditOriginalStream.getTracks().every(t=>t.readyState==='ended') && document.querySelector('#liveVideo').srcObject?.getVideoTracks()[0]===window.auditCandidate", 'working replacement promoted');
      await evaluate(tv, setControl, 'delayRange', 1);
      await tv.until("!document.querySelector('#reviewRange').disabled", 'recording from replacement', 20000);
      report.workingReplacement = await state(tv);
      assert(report.workingReplacement.live && report.workingReplacement.save);
    }
    if (isPaired) {
      assert((await phone.get('__inspectMedia()')).tracks.some(track => track.state === 'live'));
      if (auditCase === 'direct') assert(!requests.some(r => r.op === 'relay-chunk' && r.verb === 'POST'));
    }
  }
  const name = 'audit-' + auditCase + '.json';
  await writeFile(path.join(output, name), JSON.stringify(report, null, 2));
  console.log('Passed', auditCase, name);
}
