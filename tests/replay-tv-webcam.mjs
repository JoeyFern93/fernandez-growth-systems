import assert from 'node:assert/strict';

function readViews() {
  return Array.from(document.querySelectorAll('#angles section'), section => {
    const video = section.querySelector('canvas');
    if (video.hidden || !section.querySelector('.missing').hidden) return null;
    const probe = document.createElement('canvas');
    probe.width = 48;
    probe.height = 32;
    const ctx = probe.getContext('2d', {willReadFrequently: true});
    ctx.drawImage(video, 0, 0, probe.width, probe.height);
    const bytes = ctx.getImageData(0, 0, probe.width, probe.height).data;
    let hash = 2166136261;
    for (const value of bytes) hash = Math.imul(hash ^ value, 16777619);
    return hash >>> 0;
  });
}

async function decodeClip(selector) {
  const video = document.createElement('video');
  video.muted = true;
  video.src = document.querySelector(selector).href;
  const ended = new Promise(resolve => video.addEventListener('ended', resolve, {once: true}));
  await video.play();
  await Promise.race([ended, new Promise(resolve => setTimeout(resolve, 4500))]);
  video.pause();
  return {frames: video.getVideoPlaybackQuality().totalVideoFrames, duration: video.currentTime};
}

export async function runWebcam({tv, phone, site, requests, rounds, taskErrors, delay}) {
  // Run with --webcam --original-only-phone or --webcam --original-only-webcam.
  const originalOnlyPhone = process.argv.includes('--original-only-phone');
  const originalOnlyWebcam = process.argv.includes('--original-only-webcam');
  for (const [page, limited] of [[tv, originalOnlyWebcam], [phone, originalOnlyPhone]]) {
    if (limited) await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "Object.defineProperty(HTMLMediaElement.prototype, 'captureStream', {value: undefined, configurable: true});"
    });
  }
  const slots = [...Array(2)].map((_, i) => 'document.querySelectorAll("#angles section")[' + i + ']');
  const showing = i => slots[i] + '.querySelector(".missing").hidden';
  const selectWebcam = async value => {
    const expression = '(' + function select(value) {
      const input = document.querySelector('#angles .webcam');
      input.value = value;
      input.dispatchEvent(new Event('change', {bubbles: true}));
      return input.value;
    }.toString() + ')(' + JSON.stringify(value) + ')';
    assert.equal(await tv.get(expression), value);
  };
  const read = '(' + readViews.toString() + ')()';
  async function checkMoving(indices) {
    const distinct = indices.map(() => new Set());
    for (let sample = 0; sample < 35 && distinct.some(ids => ids.size < 3); sample++) {
      const current = await tv.get(read);
      indices.forEach((index, j) => { if (current[index] !== null) distinct[j].add(current[index]); });
      await delay(70);
    }
    assert.ok(distinct.every(ids => ids.size >= 3), 'Each active camera must produce changing replay pixels');
  }
  const scrub = offset => tv.get('(' + function seek(ms) {
    const timeline = document.getElementById('timeline');
    timeline.value = Number(timeline.max) - ms;
    timeline.dispatchEvent(new Event('input', {bubbles: true}));
  }.toString() + ')(' + offset + ')');

  await tv.navigate(site + '/replay/multicam/');
  await tv.until('typeof document.querySelector("#angles .invite")?.onclick === "function"', 'two-camera controls');
  await tv.get('document.getElementById("delay").value = "1"');
  await selectWebcam('default');
  await tv.until(showing(0), 'local webcam in the replay buffer', 35000);
  const device = await tv.until('Array.from(document.querySelector(".webcam").options).find(o => o.value.startsWith("device:"))?.value', 'enumerated webcam');
  assert(await tv.get('Array.from(' + slots[1] + '.querySelector(".webcam").options).some(o => o.value === ' + JSON.stringify(device) + ' && o.disabled)'), 'occupied webcam must be unavailable in the second view');
  await tv.get(slots[1] + '.querySelector(".invite").click()');
  const link = await tv.until('document.querySelector("dialog").open && document.getElementById("phone-link").href', 'Camera 2 phone invite');
  assert.equal(new URLSearchParams(new URL(link).hash.slice(1)).get('camera'), '2');
  await phone.navigate(link);
  await phone.until('typeof document.getElementById("start")?.onclick === "function"', 'phone camera ready');
  await phone.click('start');
  await tv.until(showing(0) + ' && ' + showing(1), 'both buffered views', 40000);
  await tv.until('document.getElementById("alignment").textContent.includes("ms")', 'measured capture-time alignment');
  const button = originalOnlyWebcam && originalOnlyPhone ? 'Prepare clips' : originalOnlyWebcam ?
    'Prepare Camera 2 clip' : originalOnlyPhone ? 'Prepare Camera 1 clip' : 'Prepare both clips';
  await tv.until('document.getElementById("save").textContent === ' + JSON.stringify(button), 'confirmed trim support before marking');
  for (const [slot, limited, location] of [[0, originalOnlyWebcam, 'Webcam originals'], [1, originalOnlyPhone, 'Phone originals']]) {
    if (limited) assert.match(await tv.get(slots[slot] + '.querySelector(".clip-capability").textContent'), new RegExp('Original only.*' + location));
  }
  if (originalOnlyPhone) assert.match(await phone.get('document.getElementById("clip-capability").textContent'), /Original only.*Phone originals/);
  await checkMoving([0, 1]);
  // Trying the occupied webcam on Camera 2 must keep its working phone.
  await tv.get('(() => { const input = document.querySelectorAll(".webcam")[1]; input.value = "default"; input.dispatchEvent(new Event("change", {bubbles: true})); })()');
  await tv.until('document.querySelectorAll(".webcam")[1].value === ""', 'occupied source rejected');
  await checkMoving([0, 1]);
  await delay(3400);
  await tv.click('pause');
  await delay(250);
  const paused = await tv.get(read);
  await delay(220);
  assert.deepEqual(await tv.get(read), paused, 'Pause holds both captured frames');

  await scrub(2600);
  await tv.until('(' + read + ').every((value, i) => value !== null && value !== ' + JSON.stringify(paused) + '[i])', 'both views changed at the selected time');
  await tv.get('document.querySelector("#mark-in").click()');
  await scrub(1150);
  await tv.get('document.querySelector("#mark-out").click()');
  if (originalOnlyWebcam && originalOnlyPhone) {
    assert(await tv.get('document.getElementById("save").disabled'));
  } else {
    await tv.until('!document.getElementById("save").disabled', 'matching original coverage', 20000);
    await tv.get('document.querySelector("#save").click()');
  }
  for (const [page, selector, limited] of [[tv, '#clip-downloads a', originalOnlyWebcam], [phone, '#clips a', originalOnlyPhone]]) {
    if (limited) { assert.equal(await page.get('!!document.querySelector(' + JSON.stringify(selector) + ')'), false); continue; }
    await page.until('document.querySelector(' + JSON.stringify(selector) + ')?.href.startsWith("blob:")', 'local matching clip', 35000);
    const clip = await page.get('(' + decodeClip.toString() + ')(' + JSON.stringify(selector) + ')');
    assert(clip.frames >= 5 && clip.duration > 0.65, 'Each saved interval must decode moving video');
  }

  await tv.click('follow');
  await selectWebcam('');
  await tv.until('!' + showing(0) + ' && ' + showing(1), 'phone replay continues after webcam stops');
  await tv.until('document.getElementById("save").textContent === ' + JSON.stringify(originalOnlyPhone ? 'Prepare clips' : 'Prepare Camera 2 clip'), 'export choices after webcam disconnects');
  await tv.until('__inspectMedia().then(s => s.tracks.length && s.tracks.every(t => t.state === "ended"))', 'released webcam');
  await checkMoving([1]);
  await selectWebcam(device);
  await tv.until(showing(0), 'reopened selected webcam');
  await tv.until('document.getElementById("save").textContent === ' + JSON.stringify(button), 'export choices after webcam rejoins');
  await phone.click('stop');
  await tv.until(showing(0) + ' && !' + showing(1), 'webcam replay continues after phone disconnects');
  await tv.until('document.getElementById("save").textContent === ' + JSON.stringify(originalOnlyWebcam ? 'Prepare clips' : 'Prepare Camera 1 clip'), 'export choices after phone disconnects');
  await checkMoving([0]);
  await selectWebcam('');
  await tv.until('__inspectMedia().then(s => s.tracks.every(t => t.state === "ended"))', 'released all webcam tracks');
  await phone.until('__inspectMedia().then(s => s.tracks.every(t => t.state === "ended"))', 'released phone camera');
  for (const [page, selector, limited] of [[tv, '#original-list', originalOnlyWebcam], [phone, '#originals', originalOnlyPhone]]) {
    if (!limited) continue;
    await page.get('document.querySelector(' + JSON.stringify(selector) + ').closest("details").open = true');
    await page.until('document.querySelector(' + JSON.stringify(selector + ' button') + ')', 'saved original on the indicated device');
    // The first webcam recording is the older row after the reconnection test.
    await page.get('Array.from(document.querySelectorAll(' + JSON.stringify(selector + ' button') + ')).at(-1).click()');
    await page.until('document.querySelector(' + JSON.stringify(selector + ' a') + ')?.href.startsWith("blob:")', 'original download');
    const original = await page.get('(' + decodeClip.toString() + ')(' + JSON.stringify(selector + ' a') + ')');
    assert(original.frames >= 5 && original.duration > 0.65, 'Original-only angle retains decodable video');
  }
  assert.equal(rounds.length, 1);
  assert(!requests.some(r => r.op === 'relay-chunk' && r.verb === 'POST'));
  assert.deepEqual(taskErrors, []);
  console.log('PASS local webcam and paired phone: moving replay, pause, scrub, supported clips and originals, independent source recovery');
}
