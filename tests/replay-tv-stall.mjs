import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';

// Run with the existing Chrome harness: node tests/replay-tv-e2e.mjs --audit=stall.
// Real canvas capture tracks, decoders and recorders. The provider can suspend
// delivery without ending or muting the track, then resume with a known color.
function installSource(fallback) {
  if (fallback) {
    window.MediaSource.isTypeSupported = () => false;
    if (window.ManagedMediaSource) window.ManagedMediaSource.isTypeSupported = () => false;
  }
  const sources = window.stallSources = [];
  const devices = navigator.mediaDevices;
  devices.enumerateDevices = async () => [{kind: 'videoinput', deviceId: 'fixture', label: 'Court camera'}];
  devices.getUserMedia = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d'), stream = canvas.captureStream(30);
    const track = stream.getVideoTracks()[0], settings = track.getSettings.bind(track);
    track.getSettings = () => ({...settings(), deviceId: 'fixture'});
    let timer;
    const device = {
      stream,
      resume(color = '#00aa33') {
        clearInterval(timer);
        const draw = () => { ctx.fillStyle = color; ctx.fillRect(0, 0, canvas.width, canvas.height); };
        draw(); timer = setInterval(draw, 33);
      },
      freeze() { clearInterval(timer); }
    };
    sources.push(device);
    if (!window.emptyNextSource) device.resume();
    return stream;
  };
  const delay = document.getElementById('delayRange');
  delay.value = '1'; delay.dispatchEvent(new Event('change'));
}

function snapshot() {
  const el = id => document.getElementById(id);
  const live = el('liveVideo'), range = el('reviewRange');
  return {
    stalled: !el('retryCameraBtn').hidden, frames: live.getVideoPlaybackQuality().totalVideoFrames,
    first: +range.min, last: +range.max, canSave: !el('recordClipBtn').disabled,
    originalActive: live.srcObject === window.stallSources[0].stream,
    recording: el('sessionRecordBtn').getAttribute('aria-pressed') === 'true'
  };
}

function resumedColor(fallback) {
  const source = document.getElementById(fallback ? 'delayedCanvas' : 'delayedVideo');
  if (!fallback && source.readyState < 2) return false;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, 1, 1);
  const [red, green] = ctx.getImageData(0, 0, 1, 1).data;
  return red > green + 80;
}

async function exercise({tv, site, delay}, fallback) {
  const run = (fn, ...args) => tv.get('(' + fn + ')(' + args.map(v => JSON.stringify(v)).join(',') + ')');
  const click = id => run(id => document.getElementById(id).click(), id);
  await tv.send('Page.bringToFront');
  await tv.navigate(site + '/replay/?audit=' + (fallback ? 'compatibility' : 'compressed'));
  await tv.until("document.readyState==='complete' && !!document.querySelector('#startBtn')", 'camera dashboard');
  await run(installSource, fallback);
  await click('startBtn');
  await tv.until("!document.querySelector('#recordClipBtn').disabled", 'buffered frames');
  assert.equal((await tv.get("document.querySelector('#engineBadge').textContent")).includes('Compatibility'), fallback);
  await click('sessionRecordBtn');
  await delay(6500);
  const healthy = await run(snapshot);
  assert(healthy.frames > 20 && healthy.recording && !healthy.stalled, 'a still scene supplying frames stays active');
  await tv.get('stallSources[0].freeze()');
  await tv.until("document.querySelector('#connectionBadge').textContent==='Camera stalled'", 'delivery stall');
  const stalled = await run(snapshot);
  await delay(2400);
  const held = await run(snapshot);
  assert(held.canSave && held.originalActive && held.recording);
  assert.equal(held.frames, stalled.frames);
  assert.deepEqual([held.first, held.last], [stalled.first, stalled.last]);
  assert(held.first <= healthy.first + .75 && held.last >= healthy.last);
  await tv.get("stallSources[0].resume('#ee3322')");
  await tv.until("document.querySelector('#retryCameraBtn').hidden", 'automatic recovery');
  await tv.until('(' + resumedColor + ')(' + fallback + ')', 'new red source frame in delayed replay');
  const resumed = await run(snapshot);
  assert(resumed.originalActive && resumed.recording && resumed.frames > held.frames && resumed.last > held.last);
  const report = {healthy, stalled, held, resumed};
  if (fallback) return report;

  await tv.get('stallSources[0].freeze()');
  await tv.until("!document.querySelector('#retryCameraBtn').hidden", 'second stall');
  await tv.get('window.emptyNextSource=true');
  await click('retryCameraBtn');
  await tv.until("stallSources.length===2 && !stallSources[1].stream.active && !document.querySelector('#retryCameraBtn').disabled", 'failed retry released');
  const rejected = await run(snapshot);
  assert(rejected.stalled && rejected.canSave && rejected.recording && rejected.originalActive);
  await tv.get('window.emptyNextSource=false');
  await click('retryCameraBtn');
  await tv.until("stallSources.length===3 && document.querySelector('#liveVideo').srcObject===stallSources[2].stream && !document.querySelector('#recordClipBtn').disabled", 'verified new capture');
  await tv.until("document.querySelector('#sessionDownloadLink').href.startsWith('blob:')", 'prior session finalized');
  assert.deepEqual(await tv.get('stallSources.map(camera=>camera.stream.active)'), [false, false, true]);
  await click('stopBtn');
  await tv.get('window.emptyNextSource=true');
  await click('startBtn');
  await tv.until("stallSources.length===4 && !stallSources[3].stream.active && !document.querySelector('#startBtn').disabled", 'empty initial source released');
  assert(await tv.get("document.querySelector('#recordClipBtn').disabled"));
  return {...report, rejected, previousSessionAvailable: true, emptyStartRetryable: true};
}

export async function runStallAudit(context) {
  const compressed = await exercise(context, false), compatibility = await exercise(context, true);
  await writeFile(path.join(context.output, 'audit-stall.json'), JSON.stringify({compressed, compatibility}, null, 2));
  console.log('Passed stall and recovery on compressed and compatibility replay');
}
