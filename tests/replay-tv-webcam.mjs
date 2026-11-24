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
  await tv.until('!document.getElementById("save").disabled', 'matching original coverage', 20000);
  await tv.get('document.querySelector("#save").click()');
  for (const [page, selector] of [[tv, '#clip-downloads a'], [phone, '#clips a']]) {
    await page.until('document.querySelector(' + JSON.stringify(selector) + ')?.href.startsWith("blob:")', 'local matching clip', 35000);
    const clip = await page.get('(' + decodeClip.toString() + ')(' + JSON.stringify(selector) + ')');
    assert(clip.frames >= 5 && clip.duration > 0.65, 'Each saved interval must decode moving video');
  }

  await tv.click('follow');
  await selectWebcam('');
  await tv.until('!' + showing(0) + ' && ' + showing(1), 'phone replay continues after webcam stops');
  await tv.until('__inspectMedia().then(s => s.tracks.length && s.tracks.every(t => t.state === "ended"))', 'released webcam');
  await checkMoving([1]);
  await selectWebcam(device);
  await tv.until(showing(0), 'reopened selected webcam');
  await phone.click('stop');
  await tv.until(showing(0) + ' && !' + showing(1), 'webcam replay continues after phone disconnects');
  await checkMoving([0]);
  await selectWebcam('');
  await tv.until('__inspectMedia().then(s => s.tracks.every(t => t.state === "ended"))', 'released all webcam tracks');
  await phone.until('__inspectMedia().then(s => s.tracks.every(t => t.state === "ended"))', 'released phone camera');
  assert.equal(rounds.length, 1);
  assert(!requests.some(r => r.op === 'relay-chunk' && r.verb === 'POST'));
  assert.deepEqual(taskErrors, []);
  console.log('PASS local webcam and paired phone: moving replay, pause, scrub, two decoded clips, independent source recovery');
}
