(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const video = el('video');
  const results = [];
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 54;
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  let run, timerStart, timerElapsed = 0, animation;

  function sample() {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const luma = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0; i < luma.length; i++) {
      const k = i * 4;
      luma[i] = (54 * pixels[k] + 183 * pixels[k + 1] + 19 * pixels[k + 2]) >> 8;
    }
    return luma;
  }
  function differs(left, right) {
    if (!left) return false;
    let n = 0, sum = 0;
    for (let i = 0; i < right.length; i++) {
      const delta = Math.abs(left[i] - right[i]);
      if (delta >= 9) n++;
      sum += delta;
    }
    return n >= 16 && sum >= right.length * 0.32;
  }
  function stop(message) {
    if (!run) return;
    if (run.callback !== undefined) video.cancelVideoFrameCallback(run.callback);
    clearTimeout(run.watchdog);
    video.onended = video.onerror = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(run.url);
    run = null;
    el('analyze').disabled = false;
    el('cancel').disabled = true;
    el('status').textContent = message;
  }
  const rateText = v => v == null ? '—' : v.toFixed(1);
  function finish(state) {
    if (state !== run) return;
    if (state.count < 2 || state.lastTime <= state.firstTime)
      return stop('Too few decoded frames. Try a longer clip or a browser that plays this format.');
    const span = state.lastTime - state.firstTime;
    const quality = video.getVideoPlaybackQuality?.();
    const drops = quality ? Math.max(0, quality.droppedVideoFrames - state.startDrops) : null;
    const duration = Number.isFinite(video.duration) ? video.duration : null;
    const tol = Math.max(0.08, 2 * span / (state.count - 1));
    const missedEnds = duration != null && (state.firstTime > tol || duration - state.lastTime > tol);
    const coverage = state.skipped || drops || missedEnds || state.hidden ? 'Partial observation' : 'Observed interval';
    const entry = {stage: state.stage, setting: state.setting, resolution: state.width + ' × ' + state.height,
      decodedSamples: state.count, adjacentVisibleChanges: state.changes, firstMediaSec: state.firstTime,
      lastMediaSec: state.lastTime, fileDurationSec: duration, suppliedCaptureDurationSec: state.actual,
      changesPerMediaSecond: state.changes / span, changesPerCaptureSecond: state.actual ? state.changes / state.actual : null,
      skippedPresentedFrames: state.skipped, browserDroppedFrames: drops, coverage,
      method: 'Adjacent 96×54 luma images; at least 16 pixels with delta ≥9 and mean delta ≥0.32. Optical estimate for moving subjects.'};
    results.push(entry);
    const row = el('rows').insertRow();
    for (const v of [entry.stage + (entry.setting ? ' · ' + entry.setting : ''), entry.resolution,
      entry.adjacentVisibleChanges + ' / ' + entry.decodedSamples + ' samples', rateText(entry.changesPerMediaSecond),
      rateText(entry.changesPerCaptureSecond), coverage + ' · ' + state.skipped + ' skipped callbacks']) row.insertCell().textContent = v;
    el('results').hidden = false;
    stop('Finished. Measurements are below.');
  }
  function watch(state) {
    clearTimeout(state.watchdog);
    state.watchdog = setTimeout(() => { if (run === state) stop('Playback stalled. Check the file format and keep this tab visible.'); }, 15000);
  }
  function frame(state, meta) {
    if (state !== run) return;
    watch(state);
    if (meta.mediaTime !== state.lastTime) {
      const pixels = sample();
      if (differs(state.previous, pixels)) state.changes++;
      state.previous = pixels;
      if (state.firstTime === undefined) state.firstTime = meta.mediaTime;
      if (state.presented !== undefined) state.skipped += Math.max(0, meta.presentedFrames - state.presented - 1);
      state.width = video.videoWidth; state.height = video.videoHeight;
      state.lastTime = meta.mediaTime; state.presented = meta.presentedFrames;
      state.count++;
      if (state.count === 1 || state.count % 15 === 0)
        el('status').textContent = 'Analyzing ' + meta.mediaTime.toFixed(1) + ' s of footage · ' + state.count + ' decoded samples';
    }
    state.callback = video.requestVideoFrameCallback((_, metadata) => frame(state, metadata));
  }
  el('analyze').onclick = async () => {
    const file = el('file').files[0];
    if (!file || !video.requestVideoFrameCallback || !el('seconds').reportValidity()) {
      el('status').textContent = file ? 'Use a current browser with video frame callbacks and enter a positive duration if measured.' : 'Choose a video file first.';
      return;
    }
    const state = {url: URL.createObjectURL(file), stage: el('stage').value, setting: el('setting').value.trim(),
      actual: el('seconds').valueAsNumber || null, count: 0, changes: 0, skipped: 0, hidden: document.hidden};
    run = state;
    el('analyze').disabled = true; el('cancel').disabled = false;
    el('status').textContent = 'Opening file…';
    video.defaultPlaybackRate = 0.25;
    video.src = state.url; video.playbackRate = 0.25;
    state.startDrops = video.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0;
    watch(state);
    video.onended = () => finish(state);
    video.onerror = () => { if (run === state) stop('This browser could not decode the selected file. Try the original on the recording device.'); };
    state.callback = video.requestVideoFrameCallback((_, metadata) => frame(state, metadata));
    try { await video.play(); } catch { if (run === state) stop('The file could not start. Try a supported video file.'); }
  };
  el('cancel').onclick = () => stop('Analysis canceled.');
  document.addEventListener('visibilitychange', () => { if (run && document.hidden) run.hidden = true; });
  el('save').onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(results, null, 2)], {type:'application/json'}));
    const link = document.createElement('a');
    link.download = 'replay-studio-frame-check.json'; link.href = url; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  function drawTimer() {
    const ms = Math.floor(timerElapsed + (timerStart == null ? 0 : performance.now() - timerStart));
    el('meter').textContent = String(Math.floor(ms / 60000)).padStart(2, '0') + ':' +
      String(Math.floor(ms / 1000) % 60).padStart(2, '0') + '.' + String(ms % 1000).padStart(3, '0');
    el('bar').style.transform = 'scaleX(' + (ms % 1000) / 1000 + ')';
    if (timerStart != null) animation = requestAnimationFrame(drawTimer);
  }
  el('timer-toggle').onclick = () => {
    if (timerStart != null) { timerElapsed += performance.now() - timerStart; timerStart = null; cancelAnimationFrame(animation); }
    else timerStart = performance.now();
    el('timer-toggle').textContent = timerStart == null ? 'Resume timer' : 'Pause timer';
    drawTimer();
  };
  el('timer-reset').onclick = () => { timerStart = null; timerElapsed = 0; cancelAnimationFrame(animation); drawTimer(); el('timer-toggle').textContent = 'Start timer'; };
  el('expand').onclick = () => el('timer').requestFullscreen?.().catch(() => {});
})();
