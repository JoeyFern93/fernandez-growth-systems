(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const court = window.FGSVolleyball;
  const video = $('video'), stage = $('local-stage'), picture = $('picture');
  const overlay = $('tracked'), ring = $('ring'), scrub = $('scrub');
  const wide = { x: 0, y: 0, size: 1 };
  const director = new window.VolleyballDirector();
  const remembered = new Map();
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const rate = () => Number($('fps').value);
  const angle = () => $('angle').value === 'sideline' ? 'sideline' : 'baseline';
  let runner = null, snapshot = { crop: wide, ball: null, state: 'searching' };
  let url = '', view = 'follow', epoch = 0, playing = false;
  let animation = null, sampling = null, previousDecoded = -1, lastTimeline = -Infinity;
  let apertureWidth = 0, apertureHeight = 0;
  let mockTime = 3.6, mockStart = 0, failed = false;
  let marking = false, aim = null, markTime = null, resumeAfterMark = false;
  let pictureTimer = 0, noPicture = false, sawFrame = false;

  function duration() {
    return url ? (Number.isFinite(video.duration) ? video.duration : 0) : court.duration;
  }
  function now() {
    return url ? video.currentTime : Math.min(duration(), mockTime + (playing ? (performance.now() - mockStart) / 1000 : 0));
  }
  function timeline() {
    const length = duration(), time = now();
    scrub.disabled = !length;
    scrub.max = length || 1;
    scrub.value = time;
    $('time').textContent = time.toFixed(2) + ' / ' + (length ? length.toFixed(2) : '-') + ' s';
  }
  function note() {
    let text;
    if (!url) text = 'This mock rally uses synthetic tracks. Open a local video to follow its ball on this device.';
    else if (noPicture || video.error) text = 'This browser could not decode the picture in this file. Open a local H.264 MP4 copy, or try a browser with support for the original codec.';
    else if (marking) text = 'Tap the center of the ball in the paused picture. You can also use the arrow keys and Enter. Escape cancels.';
    else if (failed) text = 'Frame analysis is unavailable for this file. Full Court playback is available.';
    else if (view === 'full') text = 'Full Court · Local original. Choose Follow Play for automatic framing.';
    else if (video.seeking) text = 'Seeking · Follow Play will check the new position.';
    else if (markTime !== null && !snapshot.ball) text = playing ? 'Searching near your mark · Waiting for the ball to move.' : 'Ball marked · Press Play to follow it.';
    else if (snapshot.state === 'tracking') text = 'Following play · The ring marks a confirmed ball estimate.';
    else if (snapshot.state === 'lost') text = 'Ball lost · Returning to Full Court.';
    else if (!playing) text = 'Follow Play ready · Press Play to find the moving ball, or use Mark ball.';
    else text = 'Searching for the ball · Showing Full Court.';
    if ($('note').textContent !== text) $('note').textContent = text;
  }
  function controls() {
    const local = Boolean(url), both = !local && $('angle').value === 'both';
    $('viewer').classList.toggle('pair', both);
    $('second').hidden = !both;
    $('primary').hidden = local;
    stage.hidden = video.hidden = !local;
    overlay.hidden = !local || view === 'full';
    $('mark').hidden = !local || failed || view !== 'follow';
    $('mark').disabled = !video.videoWidth || video.readyState < 2;
    $('mark').textContent = marking ? 'Cancel mark' : 'Mark ball';
    $('mark').setAttribute('aria-pressed', String(marking));
    overlay.classList.toggle('marking', marking);
    if (marking) overlay.tabIndex = 0;
    else overlay.removeAttribute('tabindex');
    $('wide').setAttribute('aria-pressed', String(view === 'full'));
    $('follow').setAttribute('aria-pressed', String(view === 'follow'));
    $('follow-label').textContent = local ? 'Follow Play (beta)' : 'Follow Play';
    $('follow').disabled = local && failed;
    $('angle').querySelector('[value="both"]').disabled = local;
    $('reset').hidden = !local;
    $('play').disabled = local && (noPicture || Boolean(video.error));
    $('play').textContent = playing ? 'Pause' : 'Play';
    const selection = view === 'follow' ? 'Follow Play' : 'Full Court';
    $('caption').textContent = local ? (marking ? 'Mark ball · Full Court' : selection) : (angle() === 'sideline' ? 'Raised sideline' : 'Baseline') + ' · ' + selection;
    note();
  }

  // Letterbox once, then move the native video inside that aperture. CSS
  // transforms do not read, copy, or paint the decoded pixels into a canvas.
  function layout() {
    if (!url || !video.videoWidth || !video.videoHeight) return;
    const scale = Math.min(stage.clientWidth / video.videoWidth, stage.clientHeight / video.videoHeight);
    apertureWidth = video.videoWidth * scale;
    apertureHeight = video.videoHeight * scale;
    picture.style.width = apertureWidth + 'px';
    picture.style.height = apertureHeight + 'px';
  }
  function showLocalFrame() {
    const follow = view === 'follow' && !marking;
    const crop = follow ? snapshot.crop : wide;
    const transform = crop.size >= .999999 ? 'none'
      : 'scale(' + (1 / crop.size) + ') translate(' + (-100 * crop.x) + '%,' + (-100 * crop.y) + '%)';
    if (video.style.transform !== transform) video.style.transform = transform;
    const point = marking ? aim : follow ? snapshot.ball : null;
    ring.hidden = !point;
    if (point) {
      const x = (point.x - crop.x) / crop.size * apertureWidth;
      const y = (point.y - crop.y) / crop.size * apertureHeight;
      ring.style.transform = 'translate(' + x + 'px,' + y + 'px) translate(-50%,-50%)';
    }
  }
  function draw(time = now()) {
    if (!url) {
      court.renderMock($('primary'), time, { angle: angle(), view, fps: rate() });
      if (!$('second').hidden) court.renderMock($('secondary'), time, { angle: 'sideline', view: 'full', fps: rate() });
      return;
    }
    if (!marking && view === 'follow' && !video.seeking) {
      snapshot = director.frame(time);
      // Store what was displayed at that replay time, independent of worker latency.
      if (playing) {
        remembered.set(Math.round(time * 60), { time, snapshot });
        if (remembered.size > 60000) remembered.delete(remembered.keys().next().value);
      }
    }
    showLocalFrame();
  }
  function receive(observations, time) {
    if (!url || failed || video.seeking || marking || view !== 'follow' || Math.abs(time - now()) > .20) return;
    director.observe(observations, time, angle());
    if (observations.ball || (markTime !== null && time - markTime >= 1)) markTime = null;
    if (!playing) { draw(); note(); }
  }
  function analysisFailed() {
    if (!url || failed) return;
    failed = true; view = 'full';
    controls(); draw();
  }
  function resetAnalysis() {
    runner?.reset();
    previousDecoded = -1;
    director.reset();
    snapshot = { crop: wide, ball: null, state: 'searching' };
    markTime = null;
  }
  function restore(time) {
    resetAnalysis();
    const bin = Math.round(time * 60);
    const match = [bin, bin - 1, bin + 1].map(key => remembered.get(key)).filter(Boolean)
      .sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time))[0];
    if (!match || Math.abs(time - match.time) > .025) return;
    snapshot = match.snapshot;
    director.restore(snapshot, time);
    if (snapshot.ball) runner?.seed(snapshot.ball.x, snapshot.ball.y, time);
  }
  function sample(time) {
    if (!playing || !runner || marking || failed || view !== 'follow' || video.seeking || !video.videoWidth || video.readyState < 2) return;
    runner.analyze(video, time, rate());
  }
  function cancel() {
    if (animation !== null) cancelAnimationFrame(animation);
    if (sampling !== null) video.cancelVideoFrameCallback(sampling);
    animation = sampling = null;
  }
  function scheduleVideo() {
    if (!url || !playing || sampling !== null || !video.requestVideoFrameCallback) return;
    const version = epoch;
    sampling = video.requestVideoFrameCallback((_, frame) => {
      sampling = null;
      if (version !== epoch || !playing) return;
      sawFrame = true;
      scheduleVideo();
      sample(frame.mediaTime);
    });
  }
  function schedule() {
    if (!playing || animation !== null) return;
    scheduleVideo();
    const version = epoch;
    animation = requestAnimationFrame(stamp => {
      animation = null;
      if (!playing || version !== epoch) return;
      const time = now();
      if (url && !video.requestVideoFrameCallback) {
        const count = video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.webkitDecodedFrameCount;
        if (count === undefined || count !== previousDecoded) {
          previousDecoded = count;
          sample(time);
        }
      }
      draw(time);
      if (stamp - lastTimeline >= 90) { timeline(); note(); lastTimeline = stamp; }
      if (!url && time >= duration()) pause();
      else schedule();
    });
  }
  function pause() {
    if (!url) mockTime = now();
    playing = false;
    video.pause();
    cancel();
    controls(); timeline();
  }
  function start() {
    clearMark();
    if (url) {
      if (video.ended) video.currentTime = 0;
      const version = epoch;
      video.play().catch(() => { if (version === epoch && video.paused) { playing = false; controls(); } });
    } else {
      if (now() >= duration()) mockTime = 0;
      playing = true; mockStart = performance.now(); controls(); schedule();
    }
  }
  $('play').onclick = () => playing ? pause() : start();

  scrub.oninput = () => {
    const time = Number(scrub.value);
    clearMark();
    if (url && duration()) {
      restore(time);
      video.currentTime = time;
    } else { mockTime = time; mockStart = performance.now(); }
    controls(); draw(); timeline();
  };
  $('angle').onchange = $('fps').onchange = () => {
    if (url) { remembered.clear(); resetAnalysis(); }
    controls(); draw();
  };
  function select(viewName) {
    clearMark();
    if (url && view !== viewName) {
      if (viewName === 'follow') restore(now());
      else runner?.reset();
    }
    view = viewName; controls(); draw();
  }
  $('wide').onclick = () => select('full');
  $('follow').onclick = () => select('follow');
  function clearMark() {
    marking = false; aim = null; resumeAfterMark = false;
  }
  function endMark(commit) {
    if (!marking) return;
    if (commit && aim) {
      resetAnalysis(); remembered.clear();
      runner?.seed(aim.x, aim.y, video.currentTime);
      markTime = video.currentTime;
    }
    const resume = resumeAfterMark;
    clearMark(); controls(); draw();
    if (resume) start();
  }
  $('mark').onclick = () => {
    if (marking) { endMark(false); return; }
    resumeAfterMark = playing;
    pause(); marking = true; aim = snapshot.ball || { x: .5, y: .5 };
    controls(); draw(); overlay.focus();
  };
  overlay.onpointerdown = event => {
    if (!marking) return;
    const rect = overlay.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height;
    if (x < 0 || y < 0 || x > 1 || y > 1) return;
    aim = { x, y }; endMark(true);
  };
  overlay.onkeydown = event => {
    if (!marking) return;
    if (event.key === 'Escape') endMark(false);
    else if (event.key === 'Enter' || event.key === ' ') endMark(true);
    else {
      const delta = event.shiftKey ? .03 : .003;
      const shift = { ArrowLeft: [-delta, 0], ArrowRight: [delta, 0], ArrowUp: [0, -delta], ArrowDown: [0, delta] }[event.key];
      if (!shift) return;
      aim = { x: clamp(aim.x + shift[0], 0, 1), y: clamp(aim.y + shift[1], 0, 1) };
      draw();
    }
    event.preventDefault();
  };
  function setSource(file) {
    pause(); epoch++; clearTimeout(pictureTimer); pictureTimer = 0;
    noPicture = sawFrame = failed = false; clearMark(); remembered.clear();
    runner?.close(); runner = null; resetAnalysis();
    const previous = url;
    url = file ? URL.createObjectURL(file) : '';
    video.removeAttribute('src');
    if (previous) URL.revokeObjectURL(previous);
    view = 'follow'; mockTime = 3.6; lastTimeline = -Infinity;
    $('source').textContent = file ? file.name : 'Mock rally';
    if ($('angle').value === 'both' && file) $('angle').value = 'baseline';
    if (file) {
      const version = epoch;
      runner = new window.TrackAnalysisRunner(
        (result, time) => { if (version === epoch) receive(result, time); },
        () => { if (version === epoch) analysisFailed(); }
      );
      video.src = url;
    } else $('file').value = '';
    video.load(); controls(); layout(); draw(); timeline();
    if (file) start();
  }
  $('file').onchange = () => { const file = $('file').files[0]; if (file) setSource(file); };
  $('reset').onclick = () => setSource(null);
  function verifyPicture() {
    if (!url || noPicture || sawFrame || pictureTimer) return;
    const version = epoch, initialTime = video.currentTime;
    pictureTimer = setTimeout(() => {
      pictureTimer = 0;
      if (!url || version !== epoch || sawFrame || video.seeking || video.readyState < 2 || document.hidden) return;
      const decoded = video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.webkitDecodedFrameCount;
      if (!video.videoWidth || (!video.paused && video.currentTime - initialTime > .4 && decoded === 0)) {
        noPicture = true; failed = true; view = 'full'; pause();
      }
    }, 3000);
  }
  video.onplaying = () => { if (url && !video.paused) { playing = true; controls(); schedule(); verifyPicture(); } };
  video.onpause = () => { if (url && video.paused) { playing = false; cancel(); controls(); timeline(); } };
  video.onended = () => { if (url) pause(); };
  video.onseeking = () => { if (url) { runner?.reset(); controls(); } };
  video.onseeked = () => { if (url) { restore(video.currentTime); controls(); draw(); timeline(); } };
  video.onloadeddata = video.onloadedmetadata = video.onresize = video.ondurationchange = () => {
    if (url) { controls(); layout(); draw(); timeline(); if (video.readyState >= 2) verifyPicture(); }
  };
  video.onerror = () => { if (url && video.error) { failed = true; view = 'full'; pause(); controls(); } };
  const resize = () => { layout(); draw(); };
  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
  window.addEventListener('pagehide', event => {
    pause();
    if (url && !event.persisted) {
      epoch++; runner?.close(); runner = null; clearTimeout(pictureTimer);
      video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); url = '';
    }
  });
  controls(); draw(); timeline();
})();
