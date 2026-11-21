(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const ui = {
    live: $('liveVideo'), delayedVideo: $('delayedVideo'), delayedCanvas: $('delayedCanvas'),
    processingCanvas: $('processingCanvas'), clipCanvas: $('clipCanvas'), viewer: $('viewer'),
    viewerMessage: $('viewerMessage'), start: $('startBtn'), demo: $('startDemoBtn'), stop: $('stopBtn'), flip: $('flipBtn'),
    mirror: $('mirrorBtn'), fullscreen: $('fullscreenBtn'), install: $('installBtn'),
    delay: $('delayRange'), delayValue: $('delayValue'), delayBadge: $('delayBadge'), restartNote: $('restartNote'),
    camera: $('cameraSelect'), captureResolution: $('captureResolution'), replayResolution: $('replayResolution'),
    captureFps: $('captureFps'), clipLength: $('clipLength'), recordClip: $('recordClipBtn'),
    download: $('downloadLink'), toast: $('toast'), connectionBadge: $('connectionBadge'),
    engineBadge: $('engineBadge'), actualBadge: $('actualBadge'), cameraStatus: $('cameraStatus'),
    replayStatus: $('replayStatus'), bufferStatus: $('bufferStatus'), stage: $('replayStage'),
    review: $('reviewRange'), reviewPosition: $('reviewPosition'), historyStart: $('historyStart'),
    historyEnd: $('historyEnd'), rewind: $('rewindBtn'), playPause: $('playPauseBtn'),
    forward: $('forwardBtn'), returnDelay: $('returnDelayBtn'), speed: $('playbackSpeed'),
    prevFrame: $('prevFrameBtn'), nextFrame: $('nextFrameBtn'),
    trimPrevFrame: $('trimPrevFrameBtn'), trimNextFrame: $('trimNextFrameBtn'), trimSpeed: $('trimPreviewSpeed'),
    timeline: $('timelineCanvas'), timelineTrack: $('timelineTrack'),
    trimPanel: $('trimPanel'), trimTimeline: $('trimTimelineCanvas'),
    trimStart: $('trimStartRange'), trimEnd: $('trimEndRange'), trimSelection: $('trimSelection'),
    trimStartTime: $('trimStartTime'), trimEndTime: $('trimEndTime'), trimDuration: $('trimDuration'),
    trimHelp: $('trimHelp'), trimStatus: $('trimStatus'), trimPreview: $('trimPreviewBtn'),
    trimExport: $('trimExportBtn'), trimCancel: $('trimCancelBtn'),
    trimCancelExport: $('trimCancelExportBtn'), trimProgress: $('trimProgress'),
    trimPreviewCanvas: $('trimPreviewCanvas'), trimPreviewFrame: $('trimPreviewFrame'),
    trimPreviewPosition: $('trimPreviewPosition'), trimPreviewSeek: $('trimPreviewSeek'), trimPreviewState: $('trimPreviewState'),
    sessionRecord: $('sessionRecordBtn'), sessionStatus: $('sessionStatus'),
    sessionDownload: $('sessionDownloadLink'), reviewSession: $('reviewSessionBtn'),
    returnRecent: $('returnRecentBtn'), sessionVideo: $('sessionVideo')
  };
  const state = {
    stream: null, recorder: null, encoderStream: null, mediaSource: null, sourceBuffer: null,
    mediaSourceUrl: '', downloadUrl: '', chunks: [], queuedBytes: 0, appendPending: false,
    frameCallback: null, frameTimer: null, playbackTimer: null, sourceTimer: null,
    fallbackFrames: [], fallbackWrite: 0, facingMode: 'environment', mirrored: false,
    running: false, starting: false, generation: 0, cameraRequest: 0,
    sourceMode: 'none', demoCanvas: null, demoFrame: null,
    replayFps: 0, sourceFps: 0, observedFps: 0, capabilityFps: 0, sessionFps: 0,
    nativeReplay: false, historySeconds: 120, delaySeconds: 10, replayReady: false, playbackStarted: false,
    lastDataAt: 0, lastCleanupAt: 0, clip: null, deferredInstall: null,
    wakeLock: null, wakeRequest: 0, toastTimer: null, engine: 'none',
    reviewing: false, reviewPaused: false, reviewTime: 0, reviewSpeed: 1,
    scrubbing: false, scrubWindow: null, reviewExpired: false,
    trim: null, thumbnails: [], lastThumbnailAt: 0,
    session: null, sessionBlob: null, sessionUrl: '', sessionReview: false,
    sessionDuration: 0, sessionThumbnails: [], encoderStartedAt: 0, fallbackStartedAt: 0,
    replayContentAspect: 0, sessionContentAspect: 0
  };
  const MAX_QUEUED_BYTES = 32 * 1024 * 1024;
  const HISTORY_BUDGET_BITS = 64 * 1024 * 1024 * 8;
  const MIN_CLIP_SECONDS = 0.25;
  const MAX_CLIP_SECONDS = 120;
  const TRIM_HOLD_MS = 180_000;
  const MAX_SESSION_MS = 10 * 60 * 1000;
  const MAX_SESSION_BYTES = 128 * 1024 * 1024;
  const now = () => performance.now();
  const plural = (value, word) => `${value} ${word}${value === 1 ? '' : 's'}`;
  const parseResolution = value => {
    const [width, height] = value.split('x').map(Number);
    return { width, height };
  };

  function selectedRate() {
    const fps = Number(ui.captureFps.value);
    return Number.isFinite(fps) && fps > 0 ? fps : 0;
  }
  function rateLabel(fps) {
    return Number(fps.toFixed(1)).toString();
  }
  function reportFrameRates() {
    const detail = $('frameRateStatus');
    if (!detail) return;
    if (!state.running) {
      detail.textContent = 'Start the camera to see its frame rate.';
      return;
    }
    const source = state.sourceMode === 'demo' ? 'Demo track' : state.sourceMode === 'remote' ? 'Phone video track' : 'Camera track';
    const parts = [state.sourceFps ? `${source} reports ${rateLabel(state.sourceFps)} FPS.` : `${source} does not report a frame rate.`];
    if (state.capabilityFps) parts.push(`Camera offers up to ${rateLabel(state.capabilityFps)} FPS across its modes.`);
    if (state.observedFps) parts.push(`Preview measured ${rateLabel(state.observedFps)} FPS.`);
    if (state.engine === 'compressed' && replayFrames?.times?.length > 1) {
      const times = replayFrames.times, last = times.length - 1;
      let first = last;
      while (first > 0 && times[first] > times[last] - 2) first--;
      const span = times[last] - times[first];
      if (span >= 1) parts.push(`Replay encoded ${rateLabel((last - first) / span)} FPS.`);
    }
    if (state.engine === 'fallback') parts.push('Compatibility replay samples up to 10 FPS.');
    else if (state.nativeReplay) parts.push('Replay records the original video track.');
    else parts.push('Replay records the processed preview.');
    detail.textContent = parts.join(' ');
  }
  function preferOriginalTrack() {
    return state.sourceFps ? state.sourceFps > 30 : state.sourceMode === 'remote' || !selectedRate() || selectedRate() > 30;
  }
  function cloneCameraVideo() {
    const track = state.stream?.getVideoTracks()[0];
    if (!track || track.readyState === 'ended') throw new Error('Video source unavailable');
    return new MediaStream([track.clone()]);
  }
  function canRecordSession() {
    return !!window.MediaRecorder && (!!ui.clipCanvas.captureStream ||
      (!state.mirrored && typeof state.stream?.getVideoTracks()[0]?.clone === 'function'));
  }
  function recordingBitrate(width, height, rate) {
    return Math.round(Math.min(20_000_000, Math.max(1_800_000, width * height * (rate || 60) * 0.095)));
  }
  function canvasVideo(canvas, rate) {
    // Omitting a requested rate lets new paints flow when the source omits FPS.
    return rate > 0 ? canvas.captureStream(rate) : canvas.captureStream();
  }
  function playedVideoStream(video) {
    const capture = video.captureStream || video.mozCaptureStream;
    if (!capture) return null;
    try {
      const stream = capture.call(video);
      if (stream.getVideoTracks().length) return stream;
      stream.getTracks().forEach(track => track.stop());
    } catch { /* A MediaSource player cannot be captured in every browser. */ }
    return null;
  }

  function showToast(message, duration = 6000) {
    clearTimeout(state.toastTimer);
    ui.toast.textContent = message;
    ui.toast.hidden = false;
    state.toastTimer = setTimeout(() => { ui.toast.hidden = true; }, duration);
  }
  function showViewerMessage(title, detail) {
    ui.viewerMessage.replaceChildren();
    const strong = document.createElement('strong');
    const span = document.createElement('span');
    strong.textContent = title;
    span.textContent = detail;
    ui.viewerMessage.append(strong, span);
    ui.viewerMessage.hidden = false;
  }
  function updateDelayText() {
    const seconds = Number(ui.delay.value);
    ui.delayValue.textContent = plural(seconds, 'second');
    ui.delayBadge.textContent = state.running
      ? `≈ ${plural(seconds, 'second')} behind` : `${plural(seconds, 'second')} delay`;
  }
  function updateControls() {
    const busy = !!state.clip;
    const source = getReplayWindow();
    ui.start.disabled = state.running || state.starting || busy;
    ui.demo.disabled = state.running || state.starting || busy;
    ui.stop.disabled = !state.running && !state.starting;
    ui.flip.disabled = !state.running || state.starting || state.sourceMode !== 'camera' || busy || !!state.trim;
    ui.camera.disabled = state.starting || ['demo','remote'].includes(state.sourceMode) || busy || !!state.trim;
    ui.recordClip.disabled = !source || (!state.sessionReview && !state.replayReady) || busy || !!state.trim
      || !window.MediaRecorder || !ui.clipCanvas.captureStream;
    ui.clipLength.disabled = busy;
    ui.mirror.disabled = busy || !!state.trim;
    ui.delay.disabled = busy || !!state.trim;
    ui.connectionBadge.textContent = state.starting ? (state.sourceMode === 'demo' ? 'Starting demo' : 'Starting camera')
      : state.running ? (state.sourceMode === 'demo' ? 'Demo active' : 'Camera active') : 'Ready';
    if (state.sourceMode === 'remote') ui.connectionBadge.textContent = state.starting ? 'Connecting phone' : 'Phone camera active';
    ui.recordClip.textContent = 'Save clip';
    if (ui.sessionRecord) {
      ui.sessionRecord.disabled = busy || !!state.trim || !!state.session?.stopping
        || (!state.running && !state.session) || (!state.session && !canRecordSession());
      ui.sessionRecord.textContent = state.session?.stopping ? 'Finishing recording…'
        : state.session ? 'Stop session recording' : state.sessionBlob ? 'Record another session' : 'Start session recording';
      ui.sessionRecord.setAttribute('aria-pressed', String(!!state.session && !state.session.stopping));
    }
    if (ui.reviewSession) {
      ui.reviewSession.hidden = !state.sessionBlob;
      ui.reviewSession.disabled = !state.sessionBlob || !!state.session || busy || !!state.trim;
    }
    if (ui.returnRecent) { ui.returnRecent.hidden = !state.sessionReview; ui.returnRecent.disabled = busy || !!state.trim; }
    updateReviewControls();
    updateTrimControls();
  }
  function setReplayReady(ready) {
    if (state.replayReady === ready) return;
    state.replayReady = ready;
    if (ready) {
      ui.viewerMessage.hidden = true;
      ui.replayStatus.textContent = state.reviewing ? (state.reviewPaused ? 'Paused review' : 'Reviewing') : 'Delayed playback';
    }
    updateControls();
  }
  function savePreferences() {
    try {
      localStorage.setItem('replay-preferences', JSON.stringify({
        delay: ui.delay.value, captureResolution: ui.captureResolution.value,
        replayResolution: ui.replayResolution.value, captureFps: ui.captureFps.value
      }));
    } catch { /* Storage may be blocked; camera use does not depend on it. */ }
  }
  const reviewSpeeds = [0.125, 0.25, 0.5, 1];
  let slowClock = null, reviewPlayVersion = 0;
  let replayFrames = null, indexedSession = null;
  function frameIndexFor(session = false) {
    return session ? indexedSession?.index : replayFrames;
  }
  async function indexSavedFrames(blob) {
    if (!blob || !window.ReplayFrameTimes) return null;
    if (indexedSession?.blob === blob) return indexedSession.ready;
    const record = {blob, index: new window.ReplayFrameTimes(), ready: null};
    indexedSession = record;
    record.ready = (async () => {
      try {
        for (let pos=0; pos<blob.size && indexedSession===record && !record.index.disabled; pos+=512*1024) {
          record.index.push(await blob.slice(pos,pos+512*1024).arrayBuffer());
        }
      } catch { /* A playable recording can still be stepped at its measured rate. */ }
      const pts = record.index.times;
      const span = pts.length ? pts[pts.length - 1] - pts[0] : 0;
      if (state.sessionBlob === blob && pts.length >= 3 && span > 0) state.sessionFps = (pts.length - 1) / span;
      return record.index;
    })();
    return record.ready;
  }
  function recordingRate(session = state.sessionReview) {
    const fps = session ? state.sessionFps : state.replayFps;
    return Math.max(1, Math.min(1000, fps || state.observedFps || state.sourceFps || 30));
  }
  function stopSlowClock() {
    if (!slowClock) return;
    cancelAnimationFrame(slowClock.frame);
    slowClock = null;
  }
  async function playMediaAtSpeed(video, speed, valid, endAt, onEnd) {
    stopSlowClock();
    let nativeRate = false;
    try { video.playbackRate = speed; nativeRate = Math.abs(video.playbackRate - speed) < 0.001; }
    catch { /* Some mobile players limit native slow motion. */ }
    if (nativeRate) {
      try { await video.play(); return; }
      catch (error) { if (speed >= 1 || error.name === 'NotAllowedError') throw error; }
    }
    if (!valid()) return;
    // Advance the paused media clock when the browser cannot play this rate itself.
    // Wait for each decoded seek before requesting the next presentation time.
    video.pause();
    const clock = {start: now(), position: video.currentTime, frame: 0};
    slowClock = clock;
    const tick = () => {
      if (slowClock !== clock) return;
      if (!valid()) { stopSlowClock(); return; }
      const end = endAt();
      const time = Math.min(end, clock.position + (now() - clock.start) * speed / 1000);
      if (!video.seeking && (time - video.currentTime >= 0.5 / recordingRate() ||
          (time >= end && video.currentTime < end - 0.0005))) video.currentTime = time;
      if (time >= end && !video.seeking && video.currentTime >= end - 0.0005) { stopSlowClock(); onEnd(); return; }
      clock.frame = requestAnimationFrame(tick);
    };
    clock.frame = requestAnimationFrame(tick);
  }
  function resumeReviewVideo() {
    const version = ++reviewPlayVersion, session = state.sessionReview;
    const video = session ? ui.sessionVideo : ui.delayedVideo;
    const valid = () => version === reviewPlayVersion && session === state.sessionReview &&
      state.reviewing && !state.reviewPaused && !state.trim && !state.clip && (session || state.running);
    const pause = () => { if (valid()) { video.pause(); state.reviewPaused = true; updateControls(); } };
    playMediaAtSpeed(video, state.reviewSpeed, valid, () => getReplayWindow()?.end ?? video.currentTime, pause)
      .catch(() => { if (valid()) { pause(); showToast('Tap Play to resume this recording.'); } });
  }

  function getReplayWindow() {
    if (state.sessionReview && state.sessionBlob) {
      const end = Number.isFinite(ui.sessionVideo.duration) ? ui.sessionVideo.duration : state.sessionDuration;
      return end > MIN_CLIP_SECONDS ? { start: 0, end: Math.max(0, end - Math.min(0.003, 0.25 / recordingRate(true))) } : null;
    }
    if (state.engine === 'compressed') {
      const ranges = ui.delayedVideo.buffered;
      if (!ranges.length) return null;
      const index = ranges.length - 1;
      const start = ranges.start(index);
      const end = Math.max(start, ranges.end(index) - Math.min(0.003, 0.25 / recordingRate(false)));
      return end > start ? { start, end } : null;
    }
    if (state.engine === 'fallback') {
      const frames = state.fallbackFrames.filter(frame => Number.isFinite(frame.at));
      if (frames.length < 2) return null;
      return { start: Math.min(...frames.map(frame => frame.at)) / 1000,
        end: Math.max(...frames.map(frame => frame.at)) / 1000 };
    }
    return null;
  }
  function reviewPosition() {
    return state.sessionReview ? ui.sessionVideo.currentTime : state.engine === 'compressed' ? ui.delayedVideo.currentTime : state.reviewTime;
  }
  function formatTime(seconds) {
    const value = Math.max(0, Math.round(seconds));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
  }
  function updateReviewControls() {
    const available = getReplayWindow();
    const enabled = !!available && (state.sessionReview || (state.running && state.replayReady));
    const locked = !enabled || !!state.clip || !!state.trim;
    for (const control of [ui.review, ui.rewind, ui.playPause, ui.forward, ui.speed, ui.prevFrame, ui.nextFrame].filter(Boolean)) control.disabled = locked;
    ui.returnDelay.disabled = locked || !state.reviewing;
    ui.playPause.textContent = state.reviewPaused ? 'Play' : 'Pause';
    ui.playPause.setAttribute('aria-label', state.reviewPaused ? 'Play recorded video' : 'Pause replay');
    ui.playPause.setAttribute('aria-pressed', String(state.reviewPaused));
    ui.speed.value = String(state.reviewSpeed);
    if (!enabled) {
      ui.reviewPosition.textContent = state.running ? 'Building recent history…' : 'Start camera to build history';
      ui.review.min = '0'; ui.review.max = '1'; ui.review.value = '0';
      ui.historyStart.textContent = 'Oldest'; ui.historyEnd.textContent = 'Newest';
      return;
    }
    const range = state.scrubbing && state.scrubWindow ? state.scrubWindow : available;
    if (!state.scrubbing) {
      ui.review.min = range.start.toFixed(3);
      ui.review.max = range.end.toFixed(3);
      ui.review.value = String(Math.max(range.start, Math.min(range.end, reviewPosition())));
    }
    const behind = Math.max(0, available.end - reviewPosition());
    if (ui.prevFrame) ui.prevFrame.disabled = locked || reviewPosition() <= range.start + 0.0001;
    if (ui.nextFrame) ui.nextFrame.disabled = locked || reviewPosition() >= range.end - 0.0001;
    const mode = !state.reviewing ? 'Delayed view' : state.reviewPaused ? 'Paused' : 'Reviewing';
    ui.reviewPosition.textContent = state.reviewExpired ? 'Older footage cleared · choose a new point'
      : `${mode} · ${state.reviewPaused ? formatFrameTime(behind) : formatTime(behind)} behind newest`;
    ui.review.setAttribute('aria-valuetext', `${formatTime(behind)} behind newest recorded footage`);
    ui.historyStart.textContent = `${formatTime(range.end - range.start)} history`;
    ui.historyEnd.textContent = state.sessionReview ? formatTime(range.end) : 'Newest';
    if (state.sessionReview) {
      ui.reviewPosition.textContent = `${state.reviewPaused ? 'Paused session' : 'Recorded session'} · ${state.reviewPaused ? formatFrameTime(reviewPosition()) : formatTime(reviewPosition())} / ${formatTime(range.end)}`;
      ui.historyStart.textContent = '0:00';
      ui.review.setAttribute('aria-valuetext', `${formatTime(reviewPosition())} of ${formatTime(range.end)} recorded session`);
    }
    ui.replayStatus.textContent = state.sessionReview ? 'Recorded session'
      : state.reviewing ? (state.reviewPaused ? 'Paused review' : `${state.reviewSpeed}x review`) : 'Delayed playback';
    renderTimeline(ui.timeline, range, state.sessionReview ? state.sessionThumbnails : state.thumbnails, state.sessionReview ? false : state.mirrored);
    if (ui.timelineTrack) ui.timelineTrack.style.setProperty('--playhead', `${100 * Math.max(0, Math.min(1, (reviewPosition() - range.start) / (range.end - range.start)))}%`);
  }
  function drawFallbackAt(seconds) {
    let candidate = null;
    for (const frame of state.fallbackFrames) {
      if (Number.isFinite(frame.at) && frame.at / 1000 <= seconds + 0.001
        && (!candidate || frame.at > candidate.at)) candidate = frame;
    }
    if (candidate) drawContained(candidate.canvas, ui.delayedCanvas);
  }
  function seekReplayTo(seconds) {
    ++reviewPlayVersion; stopSlowClock();
    const range = getReplayWindow();
    if (!range || (!state.sessionReview && (!state.running || !state.replayReady)) || state.clip || !Number.isFinite(Number(seconds))) return;
    state.reviewing = true; state.reviewPaused = true; state.reviewExpired = false;
    state.reviewTime = Math.max(range.start, Math.min(range.end, Number(seconds)));
    if (state.sessionReview || state.engine === 'compressed') {
      const video = state.sessionReview ? ui.sessionVideo : ui.delayedVideo;
      video.pause();
      video.currentTime = state.reviewTime;
    } else drawFallbackAt(state.reviewTime);
    ui.viewerMessage.hidden = true;
    updateControls();
  }
  function toggleReviewPlayback() {
    if ((!state.sessionReview && (!state.running || !state.replayReady)) || state.clip || state.trim || state.scrubbing) return;
    if (!state.reviewing || !state.reviewPaused) { seekReplayTo(reviewPosition()); return; }
    const range = getReplayWindow();
    if (!range) return;
    state.reviewTime = Math.max(range.start, Math.min(range.end, reviewPosition()));
    state.reviewPaused = false; state.reviewExpired = false;
    if (state.sessionReview || state.engine === 'compressed') {
      const video = state.sessionReview ? ui.sessionVideo : ui.delayedVideo;
      video.currentTime = state.reviewTime;
      resumeReviewVideo();
    }
    updateControls();
  }
  function returnToDelay() {
    if (state.clip || state.trim) return;
    ++reviewPlayVersion; stopSlowClock();
    if (state.sessionReview) {
      state.sessionReview = false;
      ui.sessionVideo.pause(); ui.sessionVideo.hidden = true;
      ui.delayedVideo.hidden = state.engine === 'fallback';
      ui.delayedCanvas.hidden = state.engine !== 'fallback';
      if (!state.running) {
        showViewerMessage('Camera is stopped', 'Your session recording is still available below. Start the camera for fresh recent footage.');
        updateControls(); return;
      }
    }
    if (!state.running) return;
    state.reviewing = false; state.reviewPaused = false; state.reviewExpired = false;
    state.scrubbing = false; state.scrubWindow = null; state.reviewSpeed = 1;
    ui.delayedVideo.playbackRate = 1;
    state.playbackStarted = false;
    if (state.engine === 'compressed') updateCompressedPlayback(state.generation);
    updateControls();
  }
  function stepReplay(delta) {
    if (!Number.isFinite(Number(delta))) return;
    seekReplayTo(reviewPosition() + Number(delta));
  }
  function adjacentTime(position, direction, range, trim) {
    const session = trim ? trim.sourceType === 'session' : state.sessionReview;
    const fallback = trim ? trim.engine === 'fallback' : !session && state.engine === 'fallback';
    if (fallback) {
      const frames = trim ? trim.frames.map(frame => frame.at) : state.fallbackFrames.map(frame => frame.at / 1000);
      const times = frames.filter(t => Number.isFinite(t) && t >= range.start && t <= range.end).sort((a,b)=>a-b);
      let current = 0;
      while (current + 1 < times.length && times[current+1] <= position + 0.00005) current++;
      const next = times[Math.max(0,Math.min(times.length-1,current+direction))];
      if (Number.isFinite(next)) return next;
    }
    const exact = frameIndexFor(session)?.frameAt(position, direction, range.start, range.end);
    return exact ?? Math.max(range.start, Math.min(range.end, position + direction / recordingRate(session)));
  }
  function stepFrame(direction, inPreview) {
    if (state.clip) return;
    const trim = state.trim;
    if (inPreview) {
      if (!trim) return;
      const time = adjacentTime(trim.previewTime,direction,{start:trim.start,end:trim.end},trim);
      stopTrimPreview(); seekTrimPreview(time);
    } else {
      const range = getReplayWindow();
      if (!range || trim || (!state.sessionReview && !state.replayReady)) return;
      seekReplayTo(adjacentTime(reviewPosition(), direction, range));
    }
  }
  function setReviewSpeed(value) {
    const speed = Number(value);
    if (!reviewSpeeds.includes(speed) || (!state.sessionReview && (!state.running || !state.replayReady)) || state.clip || state.trim || state.scrubbing) return;
    if (!state.reviewing) { state.reviewing = true; state.reviewTime = reviewPosition(); }
    state.reviewSpeed = speed;
    if (!state.reviewPaused && (state.sessionReview || state.engine === 'compressed')) resumeReviewVideo();
    updateControls();
  }
  function beginScrub() {
    if ((!state.sessionReview && (!state.running || !state.replayReady)) || state.clip || state.trim) return;
    state.scrubWindow = getReplayWindow();
    state.scrubbing = true;
    seekReplayTo(reviewPosition());
  }
  function endScrub() {
    state.scrubbing = false; state.scrubWindow = null;
    updateControls();
  }
  function compatibleMimeTypes() {
    const Source = window.ManagedMediaSource || window.MediaSource;
    if (!window.MediaRecorder || !Source
      || !MediaRecorder.isTypeSupported || !Source.isTypeSupported) return [];
    return ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm',
      'video/mp4;codecs="avc1.42E01E"', 'video/mp4']
      .filter(type => MediaRecorder.isTypeSupported(type) && Source.isTypeSupported(type));
  }
  async function enumerateCameras(selectedId = '', request = state.cameraRequest) {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
      if (request !== state.cameraRequest) return;
      ui.camera.replaceChildren();
      for (const [index, device] of devices.entries()) {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Camera ${index + 1}`;
        option.selected = device.deviceId === selectedId;
        ui.camera.append(option);
      }
      if (!devices.length) ui.camera.add(new Option('Default camera', ''));
    } catch (error) { console.info('Could not list cameras', error); }
  }
  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || !state.running
      || document.visibilityState !== 'visible' || state.wakeLock) return;
    const request = ++state.wakeRequest;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (request !== state.wakeRequest || !state.running || document.visibilityState !== 'visible') {
        await lock.release();
        return;
      }
      state.wakeLock = lock;
      lock.addEventListener('release', () => {
        if (state.wakeLock === lock) state.wakeLock = null;
      }, { once: true });
    } catch (error) { console.info('Wake lock unavailable', error); }
  }
  function releaseWakeLock() {
    state.wakeRequest += 1;
    const lock = state.wakeLock;
    state.wakeLock = null;
    try { Promise.resolve(lock?.release()).catch(() => {}); } catch {}
  }
  function stopFramePump() {
    if (state.frameCallback !== null && ui.live.cancelVideoFrameCallback) ui.live.cancelVideoFrameCallback(state.frameCallback);
    clearInterval(state.frameTimer);
    state.frameCallback = null;
    state.frameTimer = null;
  }
  function drawContained(source, canvas, mirrored = false) {
    const sourceWidth = source.videoWidth || source.width;
    const sourceHeight = source.videoHeight || source.height;
    if (!sourceWidth || !sourceHeight || ('readyState' in source && source.readyState < 2)) return false;
    const context = canvas.getContext('2d', { alpha: false });
    const scale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
    const width = Math.round(sourceWidth * scale);
    const height = Math.round(sourceHeight * scale);
    context.save();
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (mirrored) { context.translate(canvas.width, 0); context.scale(-1, 1); }
    try {
      context.drawImage(source, 0, 0, sourceWidth, sourceHeight,
        Math.round((canvas.width - width) / 2), Math.round((canvas.height - height) / 2), width, height);
      return true;
    } catch { return false; }
    finally { context.restore(); }
  }
  function startFramePump() {
    stopFramePump();
    const generation = state.generation;
    let sampleTime = null;
    let sampleFrames = 0;
    const draw = (timestamp, metadata) => {
      if (!state.running || generation !== state.generation) return;
      if (!state.nativeReplay) drawContained(ui.live, ui.processingCanvas);
      if (metadata && Number.isFinite(metadata.mediaTime)) {
        if (sampleTime === null || metadata.mediaTime < sampleTime) {
          sampleTime = metadata.mediaTime;
          sampleFrames = 0;
        } else {
          sampleFrames++;
          if (metadata.mediaTime - sampleTime >= 1.5) {
            // Count distinct frames actually delivered to the preview callback.
            state.observedFps = sampleFrames / (metadata.mediaTime - sampleTime);
            reportFrameRates();
            sampleTime = metadata.mediaTime;
            sampleFrames = 0;
          }
        }
      }
      captureTimelineThumbnail(timestamp);
      if (ui.live.requestVideoFrameCallback) state.frameCallback = ui.live.requestVideoFrameCallback(draw);
    };
    if (ui.live.requestVideoFrameCallback) state.frameCallback = ui.live.requestVideoFrameCallback(draw);
    else state.frameTimer = setInterval(() => draw(now()), 1000 / (state.replayFps || 60));
  }
  function clearRecordingFlush(recording) {
    if (recording.flushFrame != null) cancelAnimationFrame(recording.flushFrame);
    clearTimeout(recording.flushPaintTimer); clearTimeout(recording.flushTimer);
    recording.flushFrame = null; recording.flushPaintTimer = null; recording.flushTimer = null;
  }
  function scheduleVideoFrame(recording, video, draw) {
    recording.frameSource = video?.requestVideoFrameCallback ? video : null;
    recording.frame = recording.frameSource
      ? recording.frameSource.requestVideoFrameCallback(draw)
      : requestAnimationFrame(draw);
  }
  function cancelRecordingFrame(recording) {
    if (recording.frame == null) return;
    if (recording.frameSource) recording.frameSource.cancelVideoFrameCallback(recording.frame);
    else cancelAnimationFrame(recording.frame);
    recording.frame = null;
  }
  function requestCanvasFrame(recording) {
    // requestFrame requests capture on the next canvas paint. It does not make
    // recorder.stop() in this same callback safe: the encoder still needs that paint.
    try { recording.stream?.getVideoTracks?.()[0]?.requestFrame?.(); } catch { /* Automatic capture remains available. */ }
  }
  function flushCanvasRecording(recording, complete) {
    clearRecordingFlush(recording);
    requestCanvasFrame(recording);
    let presented = false;
    const afterPaint = () => {
      if (presented || recording.finished || recording.cancelled) return;
      presented = true;
      if (recording.flushFrame != null) cancelAnimationFrame(recording.flushFrame);
      clearTimeout(recording.flushPaintTimer);
      recording.flushFrame = null; recording.flushPaintTimer = null;
      // Keep the final pixels unchanged while the captured frame is delivered.
      // Drawing again here would give the same endpoint a later timestamp.
      try { if (recording.recorder.state === 'recording') recording.recorder.requestData(); } catch { /* onstop still supplies the final data. */ }
      recording.flushTimer = setTimeout(() => {
        recording.flushTimer = null;
        if (!recording.finished && !recording.cancelled) complete();
      }, 100);
    };
    recording.flushFrame = requestAnimationFrame(afterPaint);
    // A hidden/occluded tab may suspend animation frames. Cancellation remains
    // immediate, and ordinary completion has a bounded drain in that case.
    recording.flushPaintTimer = setTimeout(afterPaint, 250);
  }
  function disposeClip(clip) {
    clearInterval(clip.countdown); clearTimeout(clip.timer); clearTimeout(clip.stopTimer);
    clearRecordingFlush(clip);
    clip.frameEncoder?.close(); clip.frameEncoder = null;
    clip.cancelSeek?.(); clip.cancelSeek = null;
    cancelRecordingFrame(clip);
    clip.stream?.getTracks().forEach(track => track.stop());
  }
  function finalizeClip(clip) {
    if (clip.finished) return;
    clip.finished = true;
    disposeClip(clip);
    const current = state.clip === clip;
    if (current) state.clip = null;
    if (clip.generation === state.generation && current) restorePlayback(clip.restore);
    if (clip.cancelled || clip.generation !== state.generation) {
      if (clip.previousDownloadVisible && state.downloadUrl) { ui.download.hidden = false; ui.download.textContent = 'Download previous clip'; }
      updateControls(); return;
    }
    if (clip.error) {
      if (clip.previousDownloadVisible && state.downloadUrl) { ui.download.hidden = false; ui.download.textContent = 'Download previous clip'; }
      ui.trimStatus.textContent = 'Export stopped because the selected footage could not be read. Your selection was not saved.';
      ui.trimProgress.hidden = true;
      showToast('Could not export that selection. Choose footage still available and try again.');
      updateControls(); return;
    }
    const blob = clip.result || new Blob(clip.chunks, { type: clip.recorder?.mimeType || clip.mimeType || 'video/webm' });
    if (!blob.size) { ui.trimStatus.textContent = 'The export was empty. No clip was saved.'; updateControls(); return; }
    if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = URL.createObjectURL(blob);
    const extension = blob.type.includes('mp4') ? 'mp4' : 'webm';
    ui.download.href = state.downloadUrl;
    ui.download.download = `replay-${clip.sourceType}-${clip.start.toFixed(1)}-${clip.end.toFixed(1)}-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
    ui.download.hidden = false;
    ui.download.textContent = `Download clip (${formatPrecise(clip.end - clip.start)})`;
    ui.trimProgress.value = 100;
    ui.trimStatus.textContent = `Clip ready: ${formatPrecise(clip.start)}–${formatPrecise(clip.end)} (${formatPrecise(clip.end - clip.start)}). Download it to keep it.`;
    showToast('Your selected clip is ready to download.');
    updateControls();
    ui.download.focus();
    if (state.trim?.expiresAt <= now()) closeTrim();
  }
  function finishClip(clip, cancelled = false, error = false) {
    if (!clip || clip.stopping || clip.finished) return;
    clip.stopping = true; clip.cancelled = cancelled; clip.error = error;
    clearRecordingFlush(clip);
    clearInterval(clip.countdown); clearTimeout(clip.timer);
    cancelRecordingFrame(clip);
    if (!clip.recorder) { finalizeClip(clip); return; }
    try {
      if (clip.recorder.state !== 'inactive') {
        clip.recorder.stop();
        clip.stopTimer = setTimeout(() => { clip.error = true; finalizeClip(clip); }, 3000);
      } else finalizeClip(clip);
    } catch { clip.error = true; finalizeClip(clip); }
  }
  function cancelClip() {
    const clip = state.clip;
    if (!clip) return;
    // onstop is asynchronous, so cancellation must also win after stop() was
    // requested but before its final data event has arrived.
    clip.cancelled = true;
    finishClip(clip, true);
    disposeClip(clip);
    if (state.clip === clip) state.clip = null;
    if (clip.generation === state.generation) restorePlayback(clip.restore);
    if (ui.trimStatus) ui.trimStatus.textContent = 'Export cancelled. The selected clip was not saved.';
    if (ui.trimProgress) ui.trimProgress.hidden = true;
    if (clip.previousDownloadVisible && state.downloadUrl) { ui.download.hidden = false; ui.download.textContent = 'Download previous clip'; }
    updateControls();
  }
  function stopReplayEngine() {
    replayFrames = null;
    ++reviewPlayVersion; stopSlowClock();
    state.generation += 1;
    cancelClip();
    closeTrim(false);
    clearThumbnailFrames(state.thumbnails); state.thumbnails = []; state.lastThumbnailAt = 0;
    stopFramePump();
    clearInterval(state.playbackTimer);
    clearTimeout(state.sourceTimer);
    state.playbackTimer = null;
    state.sourceTimer = null;
    if (state.recorder) {
      state.recorder.ondataavailable = null;
      state.recorder.onerror = null;
      try { if (state.recorder.state !== 'inactive') state.recorder.stop(); } catch {}
    }
    state.encoderStream?.getTracks().forEach(track => track.stop());
    state.encoderStream = null;
    state.recorder = null;
    if (state.sourceBuffer) {
      state.sourceBuffer.removeEventListener('updateend', pumpCompressedReplay);
      state.sourceBuffer.removeEventListener('error', compressedBufferError);
      try { if (state.mediaSource?.readyState === 'open') state.sourceBuffer.abort(); } catch {}
    }
    state.sourceBuffer = null;
    try { if (state.mediaSource?.readyState === 'open') state.mediaSource.endOfStream(); } catch {}
    state.mediaSource = null;
    if (state.mediaSourceUrl) URL.revokeObjectURL(state.mediaSourceUrl);
    state.mediaSourceUrl = '';
    state.chunks = [];
    state.queuedBytes = 0;
    state.appendPending = false;
    for (const frame of state.fallbackFrames) { frame.canvas.width = 0; frame.canvas.height = 0; }
    state.fallbackFrames = [];
    state.fallbackWrite = 0;
    state.engine = 'none';
    state.replayReady = false;
    state.playbackStarted = false;
    state.reviewing = false; state.reviewPaused = false; state.reviewTime = 0;
    state.reviewSpeed = 1; state.scrubbing = false; state.scrubWindow = null; state.reviewExpired = false;
    ui.delayedVideo.playbackRate = 1;
    ui.delayedVideo.pause();
    ui.delayedVideo.removeAttribute('src');
    ui.delayedVideo.load();
    ui.delayedCanvas.hidden = true;
    ui.delayedVideo.hidden = false;
    ui.delay.max = '120';
    updateControls();
  }
  function compressedBufferError() {
    if (state.running && state.engine === 'compressed') startFallbackReplay('The compressed video format stopped playing.');
  }
  async function pumpCompressedReplay() {
    const buffer = state.sourceBuffer;
    const generation = state.generation;
    if (!buffer || buffer.updating || state.appendPending || state.mediaSource?.readyState !== 'open') return;
    try {
      if (now() - state.lastCleanupAt > 1000 && buffer.buffered.length) {
        const newest = buffer.buffered.end(buffer.buffered.length - 1);
        const normalBoundary = Math.max(0, newest - state.historySeconds);
        const pin = state.trim?.sourceType === 'recent' && state.trim.engine === 'compressed' ? state.trim.range.start : null;
        const removeBefore = pin === null ? normalBoundary : Math.min(normalBoundary, Math.max(0, pin - 0.25));
        if (buffer.buffered.start(0) < removeBefore - 1) {
          state.lastCleanupAt = now();
          buffer.remove(buffer.buffered.start(0), removeBefore);
          return;
        }
      }
      const chunk = state.chunks[0];
      if (!chunk) return;
      state.appendPending = true;
      const data = await chunk.arrayBuffer();
      if (generation !== state.generation || buffer !== state.sourceBuffer) return;
      if (buffer.updating || state.mediaSource?.readyState !== 'open') return;
      buffer.appendBuffer(data);
      if (window.ReplayFrameTimes) {
        replayFrames ||= new window.ReplayFrameTimes();
        replayFrames.push(data);
        if (buffer.buffered.length) replayFrames.discardBefore(buffer.buffered.start(0));
      }
      state.chunks.shift();
      state.queuedBytes -= chunk.size;
    } catch (error) {
      if (generation === state.generation && buffer === state.sourceBuffer) {
        console.warn('Compressed replay could not continue', error);
        startFallbackReplay('The browser reached its compressed replay limit.');
      }
    } finally {
      if (generation === state.generation) state.appendPending = false;
    }
  }
  function updateCompressedPlayback(generation) {
    if (generation !== state.generation || !state.running || state.engine !== 'compressed') return;
    if (state.recorder?.state !== 'paused' && now() - state.lastDataAt > 10000) {
      startFallbackReplay('The video encoder stopped supplying replay frames.');
      return;
    }
    pumpCompressedReplay();
    const ranges = ui.delayedVideo.buffered;
    if (!ranges.length) return;
    const start = ranges.start(ranges.length - 1);
    const end = ranges.end(ranges.length - 1);
    const span = end - start;
    ui.bufferStatus.textContent = `${span.toFixed(1)} seconds available`;
    validateTrimHistory();
    if (state.sessionReview) { updateControls(); return; }
    if (state.reviewing) {
      const window = getReplayWindow();
      if (!window) return;
      if (ui.delayedVideo.currentTime < window.start) {
        if (state.clip) cancelClip();
        ui.delayedVideo.pause();
        ui.delayedVideo.currentTime = window.start;
        state.reviewPaused = true;
        if (!state.reviewExpired) showToast('That older footage has left the rolling history. Choose another point or go back to delay.');
        state.reviewExpired = true;
      }
      state.reviewTime = ui.delayedVideo.currentTime;
      updateControls();
      return;
    }
    // MediaRecorder timeslices are not clock ticks. Gate playback using the
    // encoded media timeline instead of counting dataavailable events.
    if (span < state.delaySeconds) {
      if (state.playbackStarted) {
        ui.delayedVideo.pause();
        state.playbackStarted = false;
        setReplayReady(false);
        showViewerMessage('Rebuilding replay buffer', 'The browser paused the replay. Wait for the delay buffer to refill.');
      }
      ui.replayStatus.textContent = `Warming up ${Math.ceil(state.delaySeconds - span)}s`;
      return;
    }
    const target = Math.max(start, end - state.delaySeconds);
    const lag = end - ui.delayedVideo.currentTime;
    if (!state.playbackStarted || Math.abs(lag - state.delaySeconds) > 2.5) {
      ui.delayedVideo.currentTime = target;
      state.playbackStarted = true;
    }
    if (ui.delayedVideo.paused) {
      ui.delayedVideo.play().then(() => {
        if (generation === state.generation && ui.delayedVideo.readyState >= 2) setReplayReady(true);
      }).catch(() => {
        if (generation !== state.generation) return;
        setReplayReady(false);
        showViewerMessage('Tap the replay to play', 'Your browser paused playback. Tap the video to resume.');
      });
    } else if (ui.delayedVideo.readyState >= 2) setReplayReady(true);
    updateReviewControls();
  }
  function startCompressedReplay(mimeType, allowNative = true) {
    state.engine = 'compressed';
    state.encoderStartedAt = now();
    state.lastDataAt = now();
    state.lastCleanupAt = 0;
    ui.engineBadge.textContent = 'Compressed replay';
    ui.delayedCanvas.hidden = true;
    ui.delayedVideo.hidden = false;
    const generation = state.generation;
    const encoderFailed = () => {
      if (generation !== state.generation || !state.running) return;
      if (state.nativeReplay && ui.processingCanvas.captureStream) {
        stopReplayEngine();
        startCompressedReplay(mimeType, false);
      } else startFallbackReplay('The browser could not continue compressed recording.');
    };
    const Source = window.ManagedMediaSource || window.MediaSource;
    // iPhone ManagedMediaSource requires opting this local-only player out of AirPlay.
    ui.delayedVideo.disableRemotePlayback = true;
    state.mediaSource = new Source();
    const mediaSource = state.mediaSource;
    state.mediaSourceUrl = URL.createObjectURL(mediaSource);
    ui.delayedVideo.src = state.mediaSourceUrl;
    mediaSource.addEventListener('sourceopen', () => {
      if (generation !== state.generation || mediaSource !== state.mediaSource) return;
      clearTimeout(state.sourceTimer);
      try {
        state.sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        state.sourceBuffer.mode = 'sequence';
        state.sourceBuffer.addEventListener('updateend', pumpCompressedReplay);
        state.sourceBuffer.addEventListener('error', compressedBufferError);
        pumpCompressedReplay();
      } catch { startFallbackReplay('This browser could not open its compressed replay format.'); }
    }, { once: true });
    state.sourceTimer = setTimeout(() => {
      if (generation === state.generation) startFallbackReplay('The browser did not open compressed playback.');
    }, 8000);
    try {
      state.nativeReplay = allowNative && (preferOriginalTrack() || !ui.processingCanvas.captureStream) &&
        typeof state.stream?.getVideoTracks()[0]?.clone === 'function';
      state.encoderStream = state.nativeReplay ? cloneCameraVideo() : canvasVideo(ui.processingCanvas, state.replayFps);
      const width = state.nativeReplay ? ui.live.videoWidth : ui.processingCanvas.width;
      const height = state.nativeReplay ? ui.live.videoHeight : ui.processingCanvas.height;
      const videoBitsPerSecond = Math.round(Math.min(recordingBitrate(width, height, state.replayFps),
        HISTORY_BUDGET_BITS / (state.delaySeconds + 20)));
      state.historySeconds = Math.min(Math.max(120, state.delaySeconds + 20), HISTORY_BUDGET_BITS / videoBitsPerSecond);
      state.recorder = new MediaRecorder(state.encoderStream, { mimeType, videoBitsPerSecond });
      reportFrameRates();
      state.recorder.ondataavailable = event => {
        if (generation !== state.generation || !event.data?.size) return;
        state.lastDataAt = now();
        state.chunks.push(event.data);
        state.queuedBytes += event.data.size;
        if (state.queuedBytes > MAX_QUEUED_BYTES) {
          startFallbackReplay('The browser could not keep up with compressed replay.');
          return;
        }
        pumpCompressedReplay();
      };
      state.recorder.onerror = encoderFailed;
      state.recorder.start(1000);
      startFramePump();
      state.playbackTimer = setInterval(() => updateCompressedPlayback(generation), 250);
      ui.replayStatus.textContent = 'Warming up';
      showViewerMessage('Building replay buffer', `Replay will start after about ${plural(state.delaySeconds, 'second')}.`);
    } catch { encoderFailed(); }
  }
  function startFallbackReplay(reason = '') {
    stopReplayEngine();
    if (!state.running) return;
    state.engine = 'fallback';
    state.delaySeconds = Math.min(Number(ui.delay.value), 3);
    ui.delay.max = '3';
    ui.delay.value = String(state.delaySeconds);
    updateDelayText();
    const generation = state.generation;
    const width = 320;
    const height = 180;
    const fps = 10;
    state.nativeReplay = false;
    state.replayFps = fps;
    reportFrameRates();
    ui.processingCanvas.width = ui.delayedCanvas.width = width;
    ui.processingCanvas.height = ui.delayedCanvas.height = height;
    ui.delayedVideo.hidden = true;
    ui.delayedCanvas.hidden = false;
    ui.engineBadge.textContent = 'Compatibility · 180p · 6s history';
    try {
      // 63 canvases use about 14 MB of pixel storage, below the previous 240p ring.
      state.fallbackFrames = Array.from({ length: 63 }, () => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return { canvas, at: -Infinity };
      });
      let started = now();
      state.fallbackStartedAt = started;
      let lastTick = started;
      state.frameTimer = setInterval(() => {
        if (!state.running || generation !== state.generation) return;
        const timestamp = now();
        if (timestamp - lastTick > 750) {
          for (const saved of state.fallbackFrames) saved.at = -Infinity;
          started = timestamp;
          setReplayReady(false);
          state.reviewing = false; state.reviewPaused = false; state.scrubbing = false; state.scrubWindow = null;
          showViewerMessage('Rebuilding compatibility replay', 'Replay paused briefly. Waiting for fresh delayed frames.');
        }
        const elapsed = (timestamp - lastTick) / 1000;
        lastTick = timestamp;
        const frame = state.fallbackFrames[state.fallbackWrite];
        if (!drawContained(ui.live, frame.canvas)) return;
        frame.at = timestamp - state.fallbackStartedAt;
        state.fallbackWrite = (state.fallbackWrite + 1) % state.fallbackFrames.length;
        const target = timestamp - state.fallbackStartedAt - state.delaySeconds * 1000;
        let candidate = null;
        for (const saved of state.fallbackFrames) {
          if (Number.isFinite(saved.at) && saved.at <= target && (!candidate || saved.at > candidate.at)) candidate = saved;
        }
        ui.bufferStatus.textContent = `${Math.min(6.2, (timestamp - started) / 1000).toFixed(1)} seconds available`;
        captureTimelineThumbnail(timestamp);
        if (state.sessionReview || state.clip?.engine === 'fallback' || state.trim) { updateControls(); return; }
        if (state.reviewing) {
          const range = getReplayWindow();
          if (!range) return;
          if (state.reviewTime < range.start) {
            if (state.clip) cancelClip();
            state.reviewTime = range.start; state.reviewPaused = true;
            if (!state.reviewExpired) showToast('That frame has left the short compatibility history. Choose a new point or go back to delay.');
            state.reviewExpired = true;
            drawFallbackAt(state.reviewTime);
          } else if (!state.reviewPaused) {
            state.reviewTime = Math.min(range.end, state.reviewTime + elapsed * state.reviewSpeed);
            drawFallbackAt(state.reviewTime);
          }
          updateControls();
          return;
        }
        if (!candidate) return;
        drawContained(candidate.canvas, ui.delayedCanvas);
        state.reviewTime = candidate.at / 1000;
        setReplayReady(true);
        updateReviewControls();
      }, 1000 / fps);
      showViewerMessage('Building compatibility replay', `This browser uses 180p replay with up to 3 seconds of delay and about 6 seconds of review history.`);
      if (reason) showToast(`${reason} Using lower-resolution replay with a short 6-second history.`, 9000);
    } catch {
      stopCamera();
      showViewerMessage('Replay could not start', 'Close other tabs and try again.');
    }
  }
  function startReplayEngine() {
    state.delaySeconds = Number(ui.delay.value);
    state.replayContentAspect = ui.live.videoWidth / ui.live.videoHeight || 0;
    const replay = parseResolution(ui.replayResolution.value);
    ui.processingCanvas.width = replay.width;
    ui.processingCanvas.height = replay.height;
    state.replayFps = state.sourceFps;
    updateDelayText();
    setReplayReady(false);
    const mimeType = compatibleMimeTypes()[0];
    if (mimeType && (ui.processingCanvas.captureStream || typeof state.stream?.getVideoTracks()[0]?.clone === 'function')) startCompressedReplay(mimeType);
    else startFallbackReplay('Compressed replay is unavailable in this browser.');
  }
  function waitForCameraMetadata() {
    if (ui.live.videoWidth) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ready = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        ui.live.removeEventListener('loadedmetadata', ready);
        reject(new Error('Camera metadata timed out'));
      }, 8000);
      ui.live.addEventListener('loadedmetadata', ready, { once: true });
    });
  }
  function stopDemoSource() {
    if (state.demoFrame !== null) cancelAnimationFrame(state.demoFrame);
    state.demoFrame = null;
    if (state.demoCanvas) {
      state.demoCanvas.width = 0;
      state.demoCanvas.height = 0;
    }
    state.demoCanvas = null;
  }
  async function startDemo() {
    stopCamera();
    state.sessionReview = false;
    ui.sessionVideo.pause(); ui.sessionVideo.hidden = true;
    state.reviewing = false; state.reviewPaused = false; state.reviewSpeed = 1;
    const request = ++state.cameraRequest;
    if (!window.isSecureContext || !ui.processingCanvas.captureStream) {
      showViewerMessage('Demo unavailable', 'This browser needs secure canvas video capture. Open Replay Cam over HTTPS in a current browser.');
      return;
    }
    state.sourceMode = 'demo';
    state.starting = true;
    updateControls();
    showViewerMessage('Starting demo', 'Generated timer video uses the same replay pipeline. Your camera stays off.');
    let acquired = null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      state.demoCanvas = canvas;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Canvas unavailable');
      const fps = selectedRate();
      const started = now();
      let lastFrame = -Infinity;
      const colors = ['#a9e68d', '#78c9ec', '#edbc73', '#dca4e9'];
      const draw = timestamp => {
        if (request !== state.cameraRequest || state.demoCanvas !== canvas || state.sourceMode !== 'demo') return;
        if (!fps || timestamp - lastFrame >= 1000 / fps - 1) {
          const seconds = Math.max(0, (timestamp - started) / 1000);
          const whole = Math.floor(seconds);
          const color = colors[whole % colors.length];
          const clock = `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}.${Math.floor(seconds * 10) % 10}`;
          context.fillStyle = '#10251c';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.textAlign = 'center';
          context.fillStyle = '#d7e9cf';
          context.font = 'bold 24px system-ui, sans-serif';
          context.fillText('DEMO - CAMERA OFF', 320, 48);
          context.fillStyle = color;
          context.font = 'bold 88px ui-monospace, monospace';
          context.fillText(clock, 320, 166);
          context.fillStyle = '#d7e9cf';
          context.font = '22px system-ui, sans-serif';
          context.fillText(`Generated footage - second ${whole}`, 320, 214);
          context.fillStyle = '#31503d';
          context.fillRect(40, 252, 560, 48);
          context.fillStyle = color;
          const travel = (Math.sin(seconds * Math.PI / 2) + 1) / 2;
          context.fillRect(40 + travel * 480, 252, 80, 48);
          context.fillStyle = '#d7e9cf';
          context.font = '18px system-ui, sans-serif';
          context.fillText('Pause, drag back, then replay at a slower speed.', 320, 335);
          lastFrame = timestamp;
        }
        state.demoFrame = requestAnimationFrame(draw);
      };
      draw(started);
      acquired = canvasVideo(canvas, fps);
      const track = acquired.getVideoTracks()[0];
      if (!track) throw new Error('Demo video capture unavailable');
      state.stream = acquired;
      ui.live.srcObject = acquired;
      await ui.live.play();
      if (request !== state.cameraRequest) return;
      await waitForCameraMetadata();
      if (request !== state.cameraRequest) return;
      track.addEventListener('ended', () => {
        if (state.stream !== acquired) return;
        stopCamera();
        showViewerMessage('Demo stopped', 'Choose Try demo to rebuild its replay history.');
      }, { once: true });
      state.running = true;
      state.starting = false;
      state.generation += 1;
      // A generated animation follows available paints. Its captureStream
      // setting is a target, not a measured camera frequency.
      state.sourceFps = 0;
      ui.actualBadge.textContent = 'Demo · 640×360';
      ui.cameraStatus.textContent = 'Demo (no camera)';
      updateControls();
      applyMirror();
      startReplayEngine();
      requestWakeLock();
    } catch (error) {
      if (request !== state.cameraRequest) { acquired?.getTracks().forEach(track => track.stop()); return; }
      stopCamera();
      showViewerMessage('Could not start demo', 'This browser could not capture the generated video. Try a current Safari, Chrome, or Edge browser.');
      showToast('Demo could not start. Your camera was not requested.');
    }
  }
  async function negotiateCameraRate(track, request, initialConstraints) {
    let cameraMax = 0;
    try { cameraMax = Number(track.getCapabilities?.().frameRate?.max) || 0; } catch { /* Optional camera API. */ }
    const settings = () => track.getSettings?.() || {};
    const asked = selectedRate();
    const target = Math.min(asked || cameraMax || 240, cameraMax || Infinity);
    // Keep resolution optional while trying faster sensor modes. A rejection
    // leaves the active, successfully negotiated track in place.
    if (track.applyConstraints && target > 30 && target > (settings().frameRate || 0) + 1) {
      const candidates = [...new Set([target, 240, 120, 60])].filter(rate => rate <= target);
      for (const fps of candidates) {
        if (request !== state.cameraRequest || fps <= (settings().frameRate || 0) + 1) break;
        try {
          await track.applyConstraints({ ...initialConstraints, frameRate: { min: fps, ideal: fps } });
          break;
        } catch { /* Reported capabilities can span incompatible combinations. */ }
      }
    }
    if (request === state.cameraRequest) {
      state.capabilityFps = cameraMax;
      state.sourceFps = Number(settings().frameRate) || 0;
    }
    return settings();
  }
  async function startCamera() {
    stopCamera();
    state.sessionReview = false;
    ui.sessionVideo.pause(); ui.sessionVideo.hidden = true;
    state.reviewing = false; state.reviewPaused = false; state.reviewSpeed = 1;
    const request = ++state.cameraRequest;
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      showViewerMessage('Camera unavailable', 'Open this page over HTTPS in Safari, Chrome, or Edge.');
      return;
    }
    state.sourceMode = 'camera';
    state.starting = true;
    updateControls();
    const capture = parseResolution(ui.captureResolution.value);
    const selectedDevice = ui.camera.value;
    const wanted = selectedRate();
    const video = {
      width: { ideal: capture.width }, height: { ideal: capture.height },
      frameRate: wanted && wanted <= 30 ? { ideal: wanted, max: wanted } : { ideal: wanted || 240 }
    };
    if (selectedDevice) video.deviceId = { exact: selectedDevice };
    else video.facingMode = { ideal: state.facingMode };
    showViewerMessage('Starting camera', 'Approve camera access if your browser asks. You can press Stop to cancel.');
    let acquired = null;
    try {
      try {
        acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video });
      } catch (error) {
        if (request !== state.cameraRequest || error.name !== 'OverconstrainedError') throw error;
        const relaxed = { ...video };
        delete relaxed.frameRate;
        acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: relaxed });
      }
      if (request !== state.cameraRequest) { acquired.getTracks().forEach(track => track.stop()); return; }
      state.stream = acquired;
      const track = acquired.getVideoTracks()[0];
      const settings = await negotiateCameraRate(track, request, video);
      if (request !== state.cameraRequest) { acquired.getTracks().forEach(track => track.stop()); return; }
      ui.live.srcObject = acquired;
      await ui.live.play();
      if (request !== state.cameraRequest) return;
      await waitForCameraMetadata();
      if (request !== state.cameraRequest) return;
      track.addEventListener('ended', () => {
        if (state.stream !== acquired) return;
        stopCamera();
        showViewerMessage('Camera disconnected', 'Start the camera again to rebuild your replay.');
      }, { once: true });
      state.running = true;
      state.starting = false;
      state.generation += 1;
      enumerateCameras(settings.deviceId || selectedDevice, request);
      const dimensions = `${settings.width || ui.live.videoWidth}×${settings.height || ui.live.videoHeight}`;
      ui.actualBadge.textContent = state.sourceFps ? `${dimensions} · ${rateLabel(state.sourceFps)} FPS` : dimensions;
      ui.cameraStatus.textContent = track.label || 'Active';
      updateControls();
      applyMirror();
      startReplayEngine();
      requestWakeLock();
      savePreferences();
    } catch (error) {
      if (request !== state.cameraRequest) { acquired?.getTracks().forEach(track => track.stop()); return; }
      stopCamera();
      const messages = {
        NotAllowedError: 'Camera permission was denied. Allow camera access in browser settings and try again.',
        NotFoundError: 'No camera was found on this device.',
        NotReadableError: 'Another app may be using the camera. Close it and try again.',
        OverconstrainedError: 'This camera could not start with those settings. Choose another camera or a lower resolution.',
        SecurityError: 'Camera access requires a secure HTTPS page.'
      };
      const message = messages[error.name] || 'Check camera permission and try again.';
      showViewerMessage('Could not start camera', message);
      showToast(message);
    }
  }
  async function startRemote(stream) {
    if (state.running || state.starting) throw new Error('Stop the current camera or demo before connecting a phone.');
    if (state.trim || state.clip || state.session) throw new Error('Finish reviewing or saving the current recording first.');
    const track = stream?.getVideoTracks?.().find(item => item.readyState === 'live');
    if (!track) throw new Error('The phone has not supplied a live video track.');
    state.sessionReview = false;
    ui.sessionVideo.pause(); ui.sessionVideo.hidden = true;
    state.reviewing = false; state.reviewPaused = false; state.reviewSpeed = 1;
    const request = ++state.cameraRequest;
    const received = new MediaStream([track]);
    state.stream = received; state.remoteSource = stream;
    state.sourceMode = 'remote'; state.starting = true;
    ui.live.srcObject = received;
    updateControls();
    showViewerMessage('Connecting phone camera', 'Waiting for the first video frame from your phone.');
    const disconnected = () => {
      if (request !== state.cameraRequest || state.sourceMode !== 'remote') return;
      stopCamera();
      showViewerMessage('Phone camera disconnected', 'Connect the phone again to start a new replay.');
    };
    track.addEventListener('ended',disconnected,{ once:true });
    state.removeRemoteListener = () => track.removeEventListener('ended',disconnected);
    try {
      await ui.live.play();
      await waitForCameraMetadata();
      if (request !== state.cameraRequest || track.readyState !== 'live') throw new Error('The phone disconnected before replay started.');
      const settings = track.getSettings?.() || {};
      state.sourceFps = Number(settings.frameRate) || 0;
      state.generation++;
      state.running = true; state.starting = false;
      ui.actualBadge.textContent = `Phone · ${ui.live.videoWidth}×${ui.live.videoHeight}` +
        (state.sourceFps ? ` · ${rateLabel(state.sourceFps)} FPS` : '');
      ui.cameraStatus.textContent = 'Connected phone';
      applyMirror(); startReplayEngine(); updateControls(); requestWakeLock();
    } catch (error) {
      if (request === state.cameraRequest) stopCamera();
      throw error;
    }
  }
  window.FGSReplayCamera = Object.freeze({
    startRemote,
    endRemote(stream) {
      if (state.sourceMode === 'remote' && (!stream || stream === state.remoteSource)) stopCamera();
    },
    get isRemote() { return state.sourceMode === 'remote'; }
  });
  function stopCamera() {
    const wasRemote = state.sourceMode === 'remote';
    state.removeRemoteListener?.(); state.removeRemoteListener = null; state.remoteSource = null;
    state.cameraRequest += 1;
    state.running = false;
    state.starting = false;
    state.sourceMode = 'none';
    state.sourceFps = 0; state.capabilityFps = 0; state.observedFps = 0;
    reportFrameRates();
    if (state.session && !state.session.stopping) finishSessionRecording();
    stopReplayEngine();
    const stream = state.stream;
    state.stream = null;
    stream?.getTracks().forEach(track => track.stop());
    ui.live.srcObject = null;
    stopDemoSource();
    releaseWakeLock();
    updateControls();
    updateDelayText();
    ui.restartNote.hidden = true;
    ui.cameraStatus.textContent = 'Stopped';
    ui.replayStatus.textContent = 'Waiting';
    ui.bufferStatus.textContent = '0 seconds';
    ui.actualBadge.textContent = 'No camera';
    ui.engineBadge.textContent = 'On-device';
    showViewerMessage('Replay is stopped', 'Choose a delay, then start the camera or try the demo.');
    if (state.sessionReview && state.sessionBlob) {
      ui.viewerMessage.hidden = true;
      state.reviewing = true;
      state.reviewPaused = ui.sessionVideo.paused;
      updateControls();
    }
    if (wasRemote) window.dispatchEvent(new Event('fgs:remote-stopped'));
  }
  function applyMirror() {
    ui.delayedVideo.classList.toggle('mirrored', state.mirrored);
    ui.delayedCanvas.classList.toggle('mirrored', state.mirrored);
    ui.sessionVideo?.classList.toggle('mirrored', false);
    ui.mirror.textContent = `Mirror: ${state.mirrored ? 'on' : 'off'}`;
    ui.mirror.setAttribute('aria-pressed', String(state.mirrored));
  }
  function switchCamera() {
    if (state.sourceMode !== 'camera') return;
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    ui.camera.value = '';
    startCamera();
  }
  function pickClipMime() {
    if (!window.MediaRecorder?.isTypeSupported) return '';
    return ['video/mp4;codecs="avc1.42E01E"', 'video/webm;codecs=vp8', 'video/webm']
      .find(type => MediaRecorder.isTypeSupported(type)) || '';
  }
  function formatFrameTime(seconds) {
    const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
    return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  }
  function formatPrecise(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    return `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, '0')}`;
  }
  function copyFrame(source, width = 144, height = 81) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    return drawContained(source, canvas) ? canvas : null;
  }
  function sourceContentRect(source, aspect = 0) {
    const width = source.videoWidth || source.width, height = source.videoHeight || source.height;
    if (!width || !height || ('readyState' in source && source.readyState < 2)) return null;
    // The replay/session encoder preserves portrait video inside a landscape
    // canvas. Remove only that known padding, never crop the full-frame video.
    let contentWidth = width, contentHeight = height;
    if (Number.isFinite(aspect) && aspect > 0) {
      if (width / height > aspect) contentWidth = height * aspect;
      else contentHeight = width / aspect;
    }
    return { x: (width - contentWidth) / 2, y: (height - contentHeight) / 2, width: contentWidth, height: contentHeight };
  }
  function copyThumbnail(source, contentAspect = 0, mirrored = false) {
    const content = sourceContentRect(source, contentAspect);
    if (!content) return null;
    // Keep each sample's real scene aspect. The strip's CSS size changes between
    // phone and desktop, so crop to cover each actual tile at paint time.
    const scale = Math.min(1, 150 / Math.max(content.width, content.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(content.width * scale));
    canvas.height = Math.max(1, Math.round(content.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return null;
    context.save();
    if (mirrored) { context.translate(canvas.width, 0); context.scale(-1, 1); }
    context.drawImage(source, content.x, content.y, content.width, content.height, 0, 0, canvas.width, canvas.height);
    context.restore();
    return canvas;
  }
  function clearThumbnailFrames(frames) {
    for (const item of frames || []) { item.canvas.width = 0; item.canvas.height = 0; }
  }
  function captureTimelineThumbnail(timestamp) {
    if (timestamp - state.lastThumbnailAt < 1000 || !state.running) return;
    const range = getRecentWindow();
    if (!range) return;
    const compressed = state.engine === 'compressed';
    const source = compressed ? ui.delayedVideo : ui.live;
    // Encoder buffering can put the live canvas seconds ahead of MSE time.
    // Sample decoded replay pixels at their actual media position instead of
    // assigning a live frame to buffered.end. Unsampled tail tiles use the
    // nearest known replay sample until those frames have been played.
    const at = compressed ? source.currentTime : range.end;
    if (!Number.isFinite(at) || at < range.start || at > range.end
      || (compressed && (source.seeking || source.readyState < 2))) return;
    const canvas = copyThumbnail(source, compressed ? state.replayContentAspect : 0);
    if (!canvas) return;
    state.lastThumbnailAt = timestamp;
    const previous = state.thumbnails.findIndex(frame => Math.abs(frame.at - at) < 0.25);
    if (previous >= 0) {
      state.thumbnails[previous].canvas.width = 0; state.thumbnails[previous].canvas.height = 0;
      state.thumbnails.splice(previous, 1);
    }
    state.thumbnails.push({ at, canvas });
    // Reviewing can seek backwards, so keep cleanup ordered by media time.
    state.thumbnails.sort((first, second) => first.at - second.at);
    while (state.thumbnails.length > 150 || state.thumbnails[0]?.at < range.start - 2) {
      const old = state.thumbnails.shift(); old.canvas.width = 0; old.canvas.height = 0;
    }
  }
  function getRecentWindow() {
    const sessionReview = state.sessionReview;
    state.sessionReview = false;
    const range = getReplayWindow();
    state.sessionReview = sessionReview;
    return range;
  }
  function renderTimeline(canvas, range, frames, mirrored = false) {
    if (!canvas || !range) return;
    const bounds = canvas.getBoundingClientRect?.();
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const width = bounds?.width > 0 ? Math.round(bounds.width * pixelRatio) : canvas.width || 960;
    const height = bounds?.height > 0 ? Math.round(bounds.height * pixelRatio) : canvas.height || 96;
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;
    context.fillStyle = '#14261f'; context.fillRect(0, 0, width, height);
    const count = 8, labelHeight = Math.round(17 * pixelRatio), fontSize = Math.round(10 * pixelRatio);
    for (let index = 0; index < count; index++) {
      const left = Math.round(index * width / count), tile = Math.round((index + 1) * width / count) - left;
      const time = range.start + (range.end - range.start) * (index + 0.5) / count;
      let nearest = null;
      for (const frame of frames || []) if (!nearest || Math.abs(frame.at - time) < Math.abs(nearest.at - time)) nearest = frame;
      if (nearest?.canvas.width) {
        const sample = nearest.canvas;
        let cropWidth = sample.width, cropHeight = sample.height;
        if (cropWidth / cropHeight > tile / height) cropWidth = cropHeight * tile / height;
        else cropHeight = cropWidth * height / tile;
        context.save();
        if (mirrored) { context.translate(left + tile, 0); context.scale(-1, 1); }
        context.drawImage(sample, (sample.width - cropWidth) / 2, (sample.height - cropHeight) / 2,
          cropWidth, cropHeight, mirrored ? 0 : left, 0, tile, height);
        context.restore();
      }
      context.fillStyle = 'rgba(0,0,0,.64)'; context.fillRect(left, height - labelHeight, tile, labelHeight);
      context.fillStyle = '#fff'; context.font = `${fontSize}px system-ui, sans-serif`;
      context.fillText(formatTime(time), left + 3 * pixelRatio, height - 4 * pixelRatio);
    }
  }
  function playbackSnapshot() {
    return { sessionReview: state.sessionReview, reviewing: state.reviewing, paused: state.reviewPaused,
      time: reviewPosition(), speed: state.reviewSpeed, generation: state.generation };
  }
  function restorePlayback(saved) {
    if (!saved || saved.generation !== state.generation) return;
    state.reviewing = saved.reviewing; state.reviewPaused = saved.paused; state.reviewSpeed = saved.speed;
    const video = saved.sessionReview ? ui.sessionVideo : state.engine === 'compressed' ? ui.delayedVideo : null;
    const range = getReplayWindow();
    state.reviewTime = range ? Math.max(range.start, Math.min(range.end, saved.time)) : saved.time;
    if (video && range) {
      stopSlowClock();
      video.currentTime = state.reviewTime;
      if (saved.paused) video.pause();
      else if (saved.reviewing) resumeReviewVideo();
      else video.playbackRate = 1;
    } else if (range) drawFallbackAt(state.reviewTime);
    if (!saved.reviewing && state.running && !saved.sessionReview) {
      state.playbackStarted = false;
      if (state.engine === 'compressed') updateCompressedPlayback(state.generation);
    }
  }
  function snapshotFallback(range) {
    const frames = [];
    for (const frame of state.fallbackFrames) if (Number.isFinite(frame.at) && frame.at / 1000 >= range.start - 0.2 && frame.at / 1000 <= range.end + 0.2) {
      const canvas = copyFrame(frame.canvas, frame.canvas.width, frame.canvas.height);
      if (canvas) frames.push({ at: frame.at / 1000, canvas });
    }
    return frames.sort((a, b) => a.at - b.at);
  }
  function recordClip() {
    const range = getReplayWindow();
    if (!range || state.clip || state.trim || range.end - range.start < MIN_CLIP_SECONDS) return;
    const sourceType = state.sessionReview ? 'session' : 'recent';
    const seconds = Math.max(MIN_CLIP_SECONDS, Math.min(MAX_CLIP_SECONDS, Number(ui.clipLength.value) || 8));
    const visible = Math.max(range.start, Math.min(range.end, reviewPosition()));
    const end = visible > range.start + MIN_CLIP_SECONDS ? visible : Math.min(range.end, range.start + seconds);
    const start = Math.max(range.start, end - seconds);
    state.trim = { sourceType, engine: state.sessionReview ? 'session' : state.engine,
      range: { ...range }, start, end, restore: playbackSnapshot(), mirrored: sourceType === 'session' ? false : state.mirrored,
      frames: sourceType === 'recent' && state.engine === 'fallback' ? snapshotFallback(range) : [],
      thumbnails: (state.sessionReview ? state.sessionThumbnails : state.thumbnails).map(frame => ({ at: frame.at, canvas: copyFrame(frame.canvas, frame.canvas.width, frame.canvas.height) })).filter(frame => frame.canvas),
      contentAspect: sourceType === 'session' ? state.sessionContentAspect : state.replayContentAspect,
      previewing: false, previewFrame: null, previewSeek: null, previewTime: start, previewSpeed: state.reviewSpeed, previewVersion: 0,
      previewStartupTimer: null, timer: null, expiresAt: now() + TRIM_HOLD_MS };
    seekReplayTo(start);
    ui.trimPanel.hidden = false;
    ui.trimProgress.hidden = true; ui.trimProgress.value = 0;
    ui.trimStatus.textContent = 'Drag the two edge handles to choose footage that is already available. Nothing new is being recorded by Save clip.';
    ui.trimHelp.textContent = sourceType === 'session'
      ? 'Choose up to 2 minutes from your completed session recording. The clip exports at normal speed.'
      : `Recent history is held for up to 3 minutes while you choose. Select up to 2 minutes. ${state.engine === 'fallback' ? 'Compatibility mode only has about 6 seconds of low-resolution history.' : 'Older footage outside this strip has already cleared.'}`;
    const heldTrim = state.trim;
    const expireHeldHistory = () => {
      if (state.trim !== heldTrim) return;
      // An active export has its own bounded watchdog. Recheck after it exits so
      // success, cancellation, decode errors and empty output all release the pin.
      if (state.clip) { heldTrim.timer = setTimeout(expireHeldHistory, 1000); return; }
      closeTrim();
      showToast('The clip picker closed to release its held history. Choose a fresh section.');
    };
    heldTrim.timer = setTimeout(expireHeldHistory, TRIM_HOLD_MS);
    updateControls();
    seekTrimPreview(start);
    // Open at the editor's preview, not at handles farther down the phone page.
    // Keep subsequent handle drags and preview scrubbing free of scroll jumps.
    ui.trimPanel.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    $('trimTitle').focus({ preventScroll: true });
  }
  function updateTrimPreviewControls() {
    const trim = state.trim;
    if (!trim) return;
    const time = Math.max(trim.start, Math.min(trim.end, Number.isFinite(trim.previewTime) ? trim.previewTime : trim.start));
    if (ui.trimPrevFrame) ui.trimPrevFrame.disabled = !!state.clip || time <= trim.start + 0.0001;
    if (ui.trimNextFrame) ui.trimNextFrame.disabled = !!state.clip || time >= trim.end - 0.0001;
    if (ui.trimSpeed) { ui.trimSpeed.disabled = !!state.clip; ui.trimSpeed.value = String(trim.previewSpeed); }
    if (ui.trimPreviewSeek) {
      ui.trimPreviewSeek.min = String(trim.start); ui.trimPreviewSeek.max = String(trim.end);
      ui.trimPreviewSeek.value = String(time); ui.trimPreviewSeek.disabled = !!state.clip;
      ui.trimPreviewSeek.setAttribute('aria-valuetext', `${formatPrecise(time - trim.start)} of ${formatPrecise(trim.end - trim.start)} selected`);
    }
    if (ui.trimPreviewPosition) ui.trimPreviewPosition.textContent = `${formatFrameTime(time - trim.start)} / ${formatFrameTime(trim.end - trim.start)}`;
    if (ui.trimPreviewState) ui.trimPreviewState.textContent = trim.previewError || (state.clip ? 'Creating clip'
      : trim.previewLoading ? 'Loading selected frame' : trim.previewing ? 'Playing selection' : 'Paused');
  }
  function drawTrimPreview(trim, seconds) {
    if (!ui.trimPreviewCanvas || state.trim !== trim || ui.trimPanel.hidden) return false;
    let source = trim.sourceType === 'session' ? ui.sessionVideo : ui.delayedVideo;
    if (trim.engine === 'fallback') {
      let frame = trim.frames[0];
      for (const item of trim.frames) if (item.at <= seconds + 0.001) frame = item;
      source = frame?.canvas;
    }
    if (!source) return false;
    const content = sourceContentRect(source, trim.contentAspect);
    if (!content) return false;
    const scale = Math.min(1, 640 / Math.max(content.width, content.height));
    const width = Math.max(1, Math.round(content.width * scale)), height = Math.max(1, Math.round(content.height * scale));
    const canvas = ui.trimPreviewCanvas;
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    ui.trimPreviewFrame?.style.setProperty('--clip-preview-aspect', `${width} / ${height}`);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return false;
    context.save();
    if (trim.mirrored) { context.translate(width, 0); context.scale(-1, 1); }
    // Unlike thumbnails, the inline player preserves the complete camera scene.
    context.drawImage(source, content.x, content.y, content.width, content.height, 0, 0, width, height);
    context.restore();
    trim.previewTime = Math.max(trim.start, Math.min(trim.end, seconds));
    trim.previewLoading = false; trim.previewError = '';
    updateTrimPreviewControls();
    return true;
  }
  async function seekTrimPreview(seconds) {
    const trim = state.trim;
    if (!trim || state.clip || !Number.isFinite(Number(seconds))) return;
    const time = Math.max(trim.start, Math.min(trim.end, Number(seconds)));
    trim.previewSeek?.cancelSeek?.();
    const request = { cancelSeek: null }; trim.previewSeek = request;
    trim.previewTime = time; trim.previewLoading = true; trim.previewError = '';
    state.reviewing = true; state.reviewPaused = true; state.reviewTime = time;
    updateTrimPreviewControls();
    try {
      if (trim.engine === 'fallback') drawTrimFrame(trim, time, ui.delayedCanvas);
      else await seekVideo(trim.sourceType === 'session' ? ui.sessionVideo : ui.delayedVideo, time, request);
      if (state.trim !== trim || trim.previewSeek !== request || state.clip || trim.previewing) return;
      drawTrimPreview(trim, time);
    } catch {
      if (state.trim === trim && trim.previewSeek === request) {
        trim.previewLoading = false; trim.previewError = 'Could not show this frame. Try another point.';
        updateTrimPreviewControls();
      }
    } finally { if (trim.previewSeek === request) trim.previewSeek = null; }
  }
  function updateTrimControls() {
    const trim = state.trim;
    if (!ui.trimPanel) return;
    const busy = !!state.clip;
    if (!trim) { ui.trimPanel.hidden = true; return; }
    // Both native ranges use the same full strip domain, so their thumb positions
    // line up with the thumbnails and selection overlay. changeTrim clamps overlap.
    ui.trimStart.min = ui.trimEnd.min = String(trim.range.start);
    ui.trimStart.max = ui.trimEnd.max = String(trim.range.end);
    ui.trimStart.value = String(trim.start); ui.trimEnd.value = String(trim.end);
    ui.trimStart.disabled = busy; ui.trimEnd.disabled = busy;
    ui.trimPreview.disabled = busy; ui.trimExport.disabled = busy || trim.end - trim.start < MIN_CLIP_SECONDS;
    ui.trimCancel.disabled = busy; ui.trimCancelExport.hidden = !busy;
    ui.trimStart.setAttribute('aria-valuetext', formatPrecise(trim.start));
    ui.trimEnd.setAttribute('aria-valuetext', formatPrecise(trim.end));
    ui.trimStartTime.textContent = formatPrecise(trim.start); ui.trimEndTime.textContent = formatPrecise(trim.end);
    ui.trimDuration.textContent = `${formatPrecise(trim.end - trim.start)} selected`;
    ui.trimPreview.textContent = trim.previewing ? 'Pause selection' : 'Preview selection';
    const track = ui.trimTimeline.parentElement;
    const span = trim.range.end - trim.range.start;
    track.style.setProperty('--trim-start', `${100 * (trim.start - trim.range.start) / span}%`);
    track.style.setProperty('--trim-end', `${100 * (trim.end - trim.range.start) / span}%`);
    track.style.setProperty('--playhead', `${100 * Math.max(0, Math.min(1, (reviewPosition() - trim.range.start) / span))}%`);
    renderTimeline(ui.trimTimeline, trim.range, trim.thumbnails, trim.mirrored);
    updateTrimPreviewControls();
  }
  function stopTrimPreview() {
    const trim = state.trim;
    if (!trim) return;
    stopSlowClock();
    trim.previewing = false;
    trim.previewLoading = false;
    trim.previewVersion = (trim.previewVersion || 0) + 1;
    clearTimeout(trim.previewStartupTimer); trim.previewStartupTimer = null;
    trim.previewSeek?.cancelSeek?.(); trim.previewSeek = null;
    if (trim.previewFrame !== null) cancelAnimationFrame(trim.previewFrame);
    trim.previewFrame = null;
    (trim.sourceType === 'session' ? ui.sessionVideo : ui.delayedVideo).pause();
    state.reviewPaused = true;
    updateTrimPreviewControls();
  }
  function closeTrim(restore = true) {
    const trim = state.trim;
    if (!trim) return;
    stopTrimPreview(); clearTimeout(trim.timer);
    if (state.clip) cancelClip();
    state.trim = null;
    clearThumbnailFrames(trim.frames); clearThumbnailFrames(trim.thumbnails);
    if (ui.trimPreviewCanvas) { ui.trimPreviewCanvas.width = 0; ui.trimPreviewCanvas.height = 0; }
    if (ui.trimPanel) ui.trimPanel.hidden = true;
    if (restore) restorePlayback(trim.restore);
    updateControls();
  }
  function validateTrimHistory() {
    const trim = state.trim;
    if (!trim || trim.sourceType !== 'recent' || trim.engine !== 'compressed') return true;
    const ranges = ui.delayedVideo.buffered;
    let contains = false;
    for (let index = 0; index < ranges.length; index++) if (ranges.start(index) <= trim.start + 0.04 && ranges.end(index) >= trim.end - 0.04) contains = true;
    if (!contains) { closeTrim(false); showToast('The browser released that footage. Choose a section still in recent history.'); }
    return contains;
  }
  function seekVideo(video, seconds, clip = null) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const clear = () => { clearTimeout(timer); video.removeEventListener('seeked', ready); video.removeEventListener('loadeddata', ready); video.removeEventListener('error', fail); if (clip) clip.cancelSeek = null; };
      const fail = () => { if (settled) return; settled = true; clear(); reject(new Error('Selected video could not be decoded')); };
      const ready = () => {
        if (settled || video.seeking || video.readyState < 2 || Math.abs(video.currentTime - seconds) > 0.12) return;
        settled = true; clear(); requestAnimationFrame(resolve);
      };
      const timer = setTimeout(fail, 8000);
      if (clip) clip.cancelSeek = fail;
      video.addEventListener('seeked', ready); video.addEventListener('loadeddata', ready); video.addEventListener('error', fail);
      video.pause(); video.currentTime = seconds; ready();
    });
  }
  function drawTrimFrame(trim, seconds, target) {
    let frame = trim.frames[0];
    for (const item of trim.frames) if (item.at <= seconds + 0.001) frame = item;
    return !!frame && drawContained(frame.canvas, target, target === ui.clipCanvas && trim.mirrored);
  }
  async function previewSelection() {
    const trim = state.trim;
    if (!trim || state.clip) return;
    if (trim.previewing) { stopTrimPreview(); updateControls(); return; }
    if (!validateTrimHistory()) return;
    stopTrimPreview();
    const version = ++trim.previewVersion;
    const start = trim.previewTime >= trim.end - 0.0005 ? trim.start : Math.max(trim.start, trim.previewTime);
    const request = { cancelSeek: null }; trim.previewSeek = request;
    trim.previewing = true; trim.previewLoading = true; trim.previewError = ''; trim.previewTime = start;
    state.reviewing = true; state.reviewPaused = false;
    const video = trim.sourceType === 'session' ? ui.sessionVideo : ui.delayedVideo;
    const current = () => state.trim === trim && trim.previewVersion === version && trim.previewing && !state.clip;
    trim.previewStartupTimer = setTimeout(() => {
      if (!current()) return;
      stopTrimPreview(); trim.previewLoading = false; trim.previewError = 'Preview could not start. Try again.';
      updateControls();
    }, 10000);
    updateControls();
    try {
      if (trim.engine !== 'fallback') {
        await seekVideo(video, start, request);
        if (!current()) return;
        trim.previewSeek = null; drawTrimPreview(trim, start);
        await playMediaAtSpeed(video, trim.previewSpeed, current, () => trim.end, () => {});
        if (!current()) {
          // A delayed play promise must not restart a cancelled, paused editor.
          // A new preview/export or resumed delayed playback owns the video now.
          if (!state.clip && !state.trim?.previewing && (video.hidden || state.reviewPaused)) video.pause();
          return;
        }
      } else { trim.previewSeek = null; drawTrimPreview(trim, start); }
      clearTimeout(trim.previewStartupTimer); trim.previewStartupTimer = null;
      const started = now(); let lastPosition = start, lastAdvance = started;
      const draw = () => {
        if (!current()) return;
        const time = trim.engine === 'fallback' ? Math.min(trim.end, start + (now() - started) * trim.previewSpeed / 1000) : Math.min(trim.end, video.currentTime);
        state.reviewTime = time;
        if (time > lastPosition + 0.005) { lastPosition = time; lastAdvance = now(); }
        if (now() - lastAdvance > 8000) { stopTrimPreview(); trim.previewError = 'Preview paused because the video stopped. Try again.'; updateControls(); return; }
        if (trim.engine === 'fallback') drawTrimFrame(trim, time, ui.delayedCanvas);
        drawTrimPreview(trim, time);
        if (time >= trim.end - 0.001) { stopTrimPreview(); trim.previewTime = trim.end; updateControls(); return; }
        updateTrimControls(); trim.previewFrame = requestAnimationFrame(draw);
      };
      trim.previewFrame = requestAnimationFrame(draw); updateControls();
    } catch {
      if (!current()) return;
      stopTrimPreview(); trim.previewLoading = false; trim.previewError = 'Could not preview that selection. Try another point.';
      ui.trimStatus.textContent = 'Could not preview that selection. Try a smaller section.'; updateControls();
    }
  }
  function changeTrim(which, value) {
    const trim = state.trim;
    if (!trim || state.clip || !Number.isFinite(Number(value))) return;
    stopTrimPreview();
    if (which === 'start') trim.start = Math.max(trim.range.start, trim.end - MAX_CLIP_SECONDS, Math.min(trim.end - MIN_CLIP_SECONDS, Number(value)));
    else trim.end = Math.min(trim.range.end, trim.start + MAX_CLIP_SECONDS, Math.max(trim.start + MIN_CLIP_SECONDS, Number(value)));
    const selected = which === 'start' ? trim.start : trim.end;
    seekTrimPreview(selected);
    ui.trimStatus.textContent = 'Selection updated. Preview it, then export the selected clip.';
    updateControls();
  }
  async function exportOriginalFrames(clip, trim, source, rate) {
    if (!window.ReplayFrameExport || !window.VideoEncoder || trim.engine === 'fallback' || typeof frameIndexFor !== 'function') return false;
    const index = trim.sourceType === 'session' && typeof indexSavedFrames === 'function'
      ? await indexSavedFrames(state.sessionBlob) : frameIndexFor(false);
    if (!index?.times?.length || state.clip !== clip) return false;
    const times = index.times.slice();
    let first = times.findIndex(stamp => stamp >= clip.start);
    if (first < 0) return false;
    if (first && times[first] > clip.start) first--;
    let last = first;
    while (last + 1 < times.length && times[last + 1] < clip.end) last++;
    const length = clip.end - clip.start;
    const sampleRate = (last - first + 1) / length;
    if (Math.max(rate, sampleRate) < 36 || last <= first ||
        times[first] > clip.start + 0.1 || times[last] < clip.end - Math.max(0.15, 3 / sampleRate)) return false;
    const width = ui.clipCanvas.width, height = ui.clipCanvas.height;
    const encoder = await window.ReplayFrameExport.create({width,height,rate:Math.max(1,sampleRate),duration:length,
      bitrate:Math.min(recordingBitrate(width,height,sampleRate),Math.floor(0.9 * MAX_SESSION_BYTES * 8 / length)),
      maxBytes:MAX_SESSION_BYTES});
    if (!encoder) return false;
    if (state.clip !== clip || clip.cancelled || clip.generation !== state.generation) {
      encoder.close();
      return true;
    }
    clip.frameEncoder = encoder;
    let heldRecorder = null;
    if (trim.sourceType === 'recent' && state.recorder?.state === 'recording') {
      // Freeze the pinned rolling buffer while seeking back through it. The
      // independent session recorder, if running, keeps recording the camera.
      try { state.recorder.pause(); heldRecorder = state.recorder; } catch { /* Normal bounded MSE cleanup remains active. */ }
    }
    const active = () => state.clip === clip && !clip.cancelled && !clip.finished && clip.generation === state.generation;
    let lastUi = -Infinity;
    clearTimeout(clip.timer);
    try {
      for (let i = first; i <= last; i++) {
        if (!active()) return true;
        const start = i === first ? clip.start : times[i];
        const end = i === last ? clip.end : times[i + 1];
        if (end <= start) continue;
        if (now() - lastUi > 200) {
          clearTimeout(clip.timer);
          clip.timer = setTimeout(() => finishClip(clip,false,true), 20000);
          ui.trimProgress.value = 100 * (i - first) / (last - first + 1);
          ui.trimStatus.textContent = `Saving original frames · ${i - first + 1} of ${last - first + 1}.` +
            (heldRecorder ? ' Recent history pauses until export finishes.' : ' Keep this page open.');
          lastUi = now();
        }
        // The midpoint selects the decoded image inside this actual sample,
        // including the first/last partial frame of an arbitrary selection.
        await seekVideo(source, (start + end) / 2, clip);
        if (!active()) return true;
        if (clip.mirrored && !drawContained(source, ui.clipCanvas, true)) throw new Error('Frame unavailable');
        await encoder.write(clip.mirrored ? ui.clipCanvas : source,start - clip.start,end - start);
      }
      if (!active()) return true;
      clip.result = await encoder.finish();
      if (active()) finishClip(clip);
      return true;
    } catch {
      // Keep the normal MediaRecorder export available on restrictive devices.
      return !active();
    } finally {
      encoder.close();
      clip.frameEncoder = null;
      if (state.running && heldRecorder && heldRecorder === state.recorder && heldRecorder.state === 'paused') {
        state.lastDataAt = now();
        try { heldRecorder.resume(); } catch { /* The source may have stopped during cancellation. */ }
      }
    }
  }
  async function exportSelection() {
    const trim = state.trim;
    if (!trim || state.clip || trim.end - trim.start < MIN_CLIP_SECONDS || !validateTrimHistory()) return;
    stopTrimPreview();
    const clip = { generation: state.generation, mimeType: pickClipMime(), chunks: [], stream: null,
      recorder: null, frame: null, timer: null, countdown: null, stopTimer: null, stopping: false,
      finished: false, cancelled: false, error: false, mirrored: trim.mirrored, start: trim.start,
      end: trim.end, sourceType: trim.sourceType, engine: trim.engine, restore: playbackSnapshot(), cancelSeek: null,
      previousDownloadVisible: !ui.download.hidden };
    state.clip = clip;
    // Cover decoding and play() as well as rendering; a stalled play promise
    // must not leave the held source pinned indefinitely.
    clip.timer = setTimeout(() => finishClip(clip, false, true), (clip.end - clip.start + 25) * 1000);
    ui.trimProgress.hidden = false; ui.trimProgress.value = 0;
    ui.trimStatus.textContent = `Preparing ${formatPrecise(clip.end - clip.start)} of selected footage. Keep this page open; export takes about the clip length.`;
    ui.download.hidden = true;
    updateControls();
    const source = trim.sourceType === 'session' ? ui.sessionVideo : ui.delayedVideo;
    ui.clipCanvas.width = trim.engine === 'fallback' ? 320 : source.videoWidth || ui.processingCanvas.width;
    ui.clipCanvas.height = trim.engine === 'fallback' ? 180 : source.videoHeight || ui.processingCanvas.height;
    try {
      const rate = trim.sourceType === 'session' ? state.sessionFps : state.replayFps || state.observedFps;
      if (await exportOriginalFrames(clip, trim, source, rate)) return;
      if (state.clip !== clip || clip.cancelled) return;
      clearTimeout(clip.timer);
      clip.timer = setTimeout(() => finishClip(clip, false, true), (clip.end - clip.start + 25) * 1000);
      if (trim.engine !== 'fallback') await seekVideo(source, clip.start, clip);
      if (state.clip !== clip || clip.cancelled || clip.generation !== state.generation) return;
      const first = trim.engine === 'fallback' ? drawTrimFrame(trim, clip.start, ui.clipCanvas) : drawContained(source, ui.clipCanvas, clip.mirrored);
      if (!first) throw new Error('No selected frame');
      drawTrimPreview(trim, clip.start);
      if (trim.engine !== 'fallback' && !clip.mirrored && (rate > 30 || !rate)) {
        clip.stream = playedVideoStream(source);
      }
      clip.native = !!clip.stream;
      if (!clip.stream) clip.stream = canvasVideo(ui.clipCanvas, rate);
      const options = { videoBitsPerSecond: Math.min(recordingBitrate(ui.clipCanvas.width, ui.clipCanvas.height, rate),
        Math.floor(0.9 * MAX_SESSION_BYTES * 8 / (clip.end - clip.start))) };
      if (clip.mimeType) options.mimeType = clip.mimeType;
      clip.recorder = new MediaRecorder(clip.stream, options);
      clip.bytes = 0;
      clip.recorder.ondataavailable = event => {
        if (!event.data?.size || clip.cancelled || clip.error) return;
        clip.bytes += event.data.size;
        if (clip.bytes > MAX_SESSION_BYTES) {
          clip.error = true;
          if (!clip.stopping) finishClip(clip, false, true);
        } else clip.chunks.push(event.data);
      };
      clip.recorder.onstop = () => finalizeClip(clip);
      clip.recorder.onerror = () => finishClip(clip, false, true);
      clip.recorder.start(500);
      // Paint after recording starts as well as before captureStream is created.
      // This makes the selected first frame available to the first capture.
      if (!clip.native) {
        if (trim.engine === 'fallback') drawTrimFrame(trim, clip.start, ui.clipCanvas);
        else drawContained(source, ui.clipCanvas, clip.mirrored);
        requestCanvasFrame(clip);
      }
      state.reviewing = true; state.reviewPaused = false; state.reviewSpeed = 1;
      if (trim.engine !== 'fallback') { source.playbackRate = 1; await source.play(); }
      if (state.clip !== clip || clip.cancelled || clip.generation !== state.generation) return;
      const started = now(); let lastPosition = clip.start, lastAdvance = started, lastUi = -Infinity;
      const frameVideo = trim.engine === 'fallback' ? null : source;
      const draw = (timestamp, metadata) => {
        if (state.clip !== clip || clip.stopping || clip.finishing || clip.finished) return;
        if (clip.generation !== state.generation || state.trim !== trim) { finishClip(clip, true); return; }
        if (trim.engine === 'compressed' && !validateTrimHistory()) return;
        const position = trim.engine === 'fallback' ? Math.min(clip.end, clip.start + (now() - started) / 1000) : metadata?.mediaTime ?? source.currentTime;
        if (position > lastPosition + 0.005) { lastPosition = position; lastAdvance = now(); }
        if (position < clip.start - 0.12 || position > clip.end + 0.3 || now() - lastAdvance > 3000) { finishClip(clip, false, true); return; }
        const drawn = clip.native || (trim.engine === 'fallback' ? drawTrimFrame(trim, position, ui.clipCanvas) : drawContained(source, ui.clipCanvas, clip.mirrored));
        if (!drawn) { finishClip(clip, false, true); return; }
        if (timestamp - lastUi >= 100) {
          drawTrimPreview(trim, Math.min(clip.end, position));
          lastUi = timestamp;
        }
        state.reviewTime = position;
        const progress = Math.max(0, Math.min(100, 100 * (position - clip.start) / (clip.end - clip.start)));
        ui.trimProgress.value = progress;
        ui.trimStatus.textContent = `Exporting selected clip… ${Math.round(progress)}%. Keep this page open.`;
        updateTrimControls();
        if (position >= clip.end - Math.min(0.025, 0.5 / (rate || 60)) || source.ended) {
          source.pause(); state.reviewPaused = true; clip.finishing = true; clip.frame = null;
          ui.trimStatus.textContent = 'Finalizing selected clip. Keep this page open.';
          // The endpoint was just drawn. Stop only after its paint and a short
          // encoder drain, without drawing any footage outside the selection.
          if (clip.native) finishClip(clip);
          else flushCanvasRecording(clip, () => finishClip(clip));
          return;
        }
        scheduleVideoFrame(clip, frameVideo, draw);
      };
      scheduleVideoFrame(clip, frameVideo, draw);
      updateControls();
    } catch {
      if (state.clip === clip && !clip.cancelled) finishClip(clip, false, true);
    }
  }
  function finishSessionRecording(error = false) {
    const session = state.session;
    if (!session || session.stopping) return;
    session.stopping = true; session.error = error;
    session.endedAt = now();
    clearTimeout(session.timer); clearInterval(session.clock);
    cancelRecordingFrame(session);
    const stop = () => {
      clearRecordingFlush(session);
      try {
        if (session.recorder.state !== 'inactive') {
          session.recorder.stop();
          session.stopTimer = setTimeout(() => { session.error = true; finalizeSession(session); }, 3000);
        } else finalizeSession(session);
      } catch { session.error = true; finalizeSession(session); }
    };
    if (!session.native && !error && drawContained(ui.live, session.canvas, session.mirrored)) {
      ui.sessionStatus.textContent = 'Finishing session recording. The final frame is being saved.';
      flushCanvasRecording(session, stop);
    } else stop();
    updateControls();
  }
  function finalizeSession(session) {
    if (session.finished) return;
    session.finished = true; clearTimeout(session.timer); clearTimeout(session.stopTimer); clearInterval(session.clock);
    clearRecordingFlush(session);
    cancelRecordingFrame(session);
    session.stream?.getTracks().forEach(track => track.stop());
    session.canvas.width = 0; session.canvas.height = 0;
    if (state.session === session) state.session = null;
    const blob = new Blob(session.chunks, { type: session.recorder.mimeType || session.mimeType || 'video/webm' });
    if (session.error || !blob.size) {
      clearThumbnailFrames(session.thumbnails);
      ui.sessionStatus.textContent = 'This session recording could not be saved. Any previous completed recording is still available.';
      updateControls(); return;
    }
    state.sessionReview = false; ui.sessionVideo.pause(); ui.sessionVideo.hidden = true;
    ui.delayedVideo.hidden = state.engine === 'fallback';
    ui.delayedCanvas.hidden = state.engine !== 'fallback';
    if (state.sessionUrl) URL.revokeObjectURL(state.sessionUrl);
    clearThumbnailFrames(state.sessionThumbnails);
    state.sessionBlob = blob; state.sessionUrl = URL.createObjectURL(blob);
    state.sessionDuration = Math.max(0.25, ((session.endedAt || now()) - session.started) / 1000);
    state.sessionContentAspect = session.contentAspect;
    state.sessionFps = session.fps;
    state.sessionThumbnails = session.thumbnails;
    ui.sessionVideo.src = state.sessionUrl; ui.sessionVideo.load();
    ui.sessionDownload.href = state.sessionUrl;
    ui.sessionDownload.download = `replay-session-${new Date().toISOString().replace(/[:.]/g, '-')}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`;
    ui.sessionDownload.hidden = false;
    ui.sessionStatus.textContent = `Recording ready: about ${formatTime(state.sessionDuration)}, ${(blob.size / 1024 / 1024).toFixed(1)} MB. Download to keep it, or review and trim a clip. It stays available after stopping the camera.`;
    showToast('Session recording ready. Download it or choose Review recording to trim a clip.');
    updateControls();
  }
  function toggleSessionRecording() {
    if (state.session) { finishSessionRecording(); return; }
    if (!state.running || state.clip || state.trim || !canRecordSession()) return;
    if (state.sessionReview) returnToDelay();
    const session = { chunks: [], bytes: 0, canvas: document.createElement('canvas'), stream: null,
      recorder: null, mimeType: pickClipMime(), started: now(), frame: null, timer: null, clock: null,
      stopping: false, finished: false, error: false, mirrored: state.mirrored,
      contentAspect: ui.live.videoWidth / ui.live.videoHeight || 0, thumbnails: [], lastThumbnailAt: -Infinity, lastDrawAt: -Infinity };
    session.canvas.width = ui.processingCanvas.width || 854; session.canvas.height = ui.processingCanvas.height || 480;
    try {
      session.native = !session.mirrored && (preferOriginalTrack() || !ui.clipCanvas.captureStream) &&
        typeof state.stream.getVideoTracks()[0]?.clone === 'function';
      session.fps = session.native ? state.sourceFps || state.observedFps
        : state.observedFps || state.sourceFps;
      if (!session.native && !drawContained(ui.live, session.canvas, session.mirrored)) throw new Error('Camera not ready');
      session.stream = session.native ? cloneCameraVideo() : canvasVideo(session.canvas, state.sourceFps);
      const width = session.native ? ui.live.videoWidth : session.canvas.width;
      const height = session.native ? ui.live.videoHeight : session.canvas.height;
      const options = { videoBitsPerSecond: recordingBitrate(width, height, session.fps) };
      if (session.mimeType) options.mimeType = session.mimeType;
      session.recorder = new MediaRecorder(session.stream, options);
      session.recorder.ondataavailable = event => {
        if (event.data?.size) { session.chunks.push(event.data); session.bytes += event.data.size; }
        if (!session.stopping && session.bytes >= MAX_SESSION_BYTES) { showToast('Recording reached the 128 MB limit and was stopped safely.'); finishSessionRecording(); }
      };
      session.recorder.onstop = () => finalizeSession(session);
      session.recorder.onerror = () => finishSessionRecording(true);
      state.session = session; session.recorder.start(1000);
      if (!session.native) {
        drawContained(ui.live, session.canvas, session.mirrored);
        requestCanvasFrame(session);
      }
      const draw = timestamp => {
        if (state.session !== session || session.stopping) return;
        if (!state.running || !state.stream) { finishSessionRecording(); return; }
        if (!session.native) {
          drawContained(ui.live, session.canvas, session.mirrored);
        }
        if (timestamp - session.lastThumbnailAt >= 5000) {
          const canvas = copyThumbnail(ui.live, 0, session.mirrored);
          if (canvas) session.thumbnails.push({ at: (timestamp - session.started) / 1000, canvas });
          session.lastThumbnailAt = timestamp;
        }
        scheduleVideoFrame(session, ui.live, draw);
      };
      scheduleVideoFrame(session, ui.live, draw);
      const clock = () => { ui.sessionStatus.textContent = `Recording session · ${formatTime((now() - session.started) / 1000)} · ${(session.bytes / 1024 / 1024).toFixed(1)} MB. Up to 10 minutes / 128 MB. Camera footage from before this button is only in recent history.`; };
      clock(); session.clock = setInterval(clock, 500);
      session.timer = setTimeout(() => { showToast('Recording reached 10 minutes and was stopped safely.'); finishSessionRecording(); }, MAX_SESSION_MS);
      updateControls();
    } catch {
      session.stream?.getTracks().forEach(track => track.stop());
      if (state.session === session) state.session = null;
      ui.sessionStatus.textContent = 'Session recording is unavailable in this browser. Recent replay can still be reviewed.';
      updateControls();
    }
  }
  async function reviewSavedSession() {
    if (!state.sessionBlob || state.session || state.clip || state.trim) return;
    indexSavedFrames(state.sessionBlob);
    ++reviewPlayVersion; stopSlowClock();
    state.sessionReview = true; state.reviewing = true; state.reviewPaused = true; state.reviewSpeed = 1;
    ui.delayedVideo.pause(); ui.delayedVideo.hidden = true; ui.delayedCanvas.hidden = true;
    ui.sessionVideo.hidden = false; ui.viewerMessage.hidden = true;
    try { await seekVideo(ui.sessionVideo, 0); } catch { /* A complete WebM may report duration late; use the recorded duration until metadata catches up. */ }
    updateControls();
  }
  function restorePreferences() {
    try {
      const saved = JSON.parse(localStorage.getItem('replay-preferences') || '{}');
      const delay = Number(saved.delay);
      if (Number.isFinite(delay) && delay >= 1 && delay <= 120) ui.delay.value = String(Math.round(delay));
      for (const key of ['captureResolution', 'replayResolution', 'captureFps']) {
        if (Array.from(ui[key].options).some(option => option.value === saved[key])) ui[key].value = saved[key];
      }
    } catch {}
    updateDelayText();
  }

  ui.start.addEventListener('click', startCamera);
  ui.demo.addEventListener('click', startDemo);
  ui.stop.addEventListener('click', stopCamera);
  ui.flip.addEventListener('click', switchCamera);
  ui.mirror.addEventListener('click', () => { state.mirrored = !state.mirrored; applyMirror(); });
  ui.delay.addEventListener('input', () => { updateDelayText(); ui.restartNote.hidden = !state.running; });
  ui.delay.addEventListener('change', () => {
    ui.restartNote.hidden = true;
    if (state.running) {
      const cancelledClip = !!state.clip;
      stopReplayEngine();
      startReplayEngine();
      if (cancelledClip) showToast('Clip cancelled because the replay delay changed.');
    }
    savePreferences();
  });
  ui.clipLength.addEventListener('change', () => {
    if (state.trim && !state.clip) changeTrim('start', state.trim.end - Number(ui.clipLength.value));
    else updateControls();
  });
  ui.trimStart?.addEventListener('input', () => changeTrim('start', ui.trimStart.value));
  ui.trimEnd?.addEventListener('input', () => changeTrim('end', ui.trimEnd.value));
  ui.trimPreview?.addEventListener('click', previewSelection);
  ui.trimSpeed?.addEventListener('change', () => {
    const trim = state.trim, speed = Number(ui.trimSpeed.value);
    if (!trim || state.clip || !reviewSpeeds.includes(speed)) return;
    const playing = trim.previewing;
    if (playing) stopTrimPreview();
    trim.previewSpeed = speed;
    if (playing) previewSelection(); else updateTrimControls();
  });
  ui.trimPreviewSeek?.addEventListener('input', () => {
    if (!state.trim || state.clip) return;
    const seconds = Number(ui.trimPreviewSeek.value);
    stopTrimPreview(); seekTrimPreview(seconds);
  });
  ui.trimExport?.addEventListener('click', exportSelection);
  ui.trimCancel?.addEventListener('click', () => { closeTrim(); ui.recordClip.focus(); });
  ui.trimCancelExport?.addEventListener('click', cancelClip);
  ui.sessionRecord?.addEventListener('click', toggleSessionRecording);
  ui.reviewSession?.addEventListener('click', reviewSavedSession);
  ui.returnRecent?.addEventListener('click', returnToDelay);
  ui.sessionVideo?.addEventListener('timeupdate', () => { if (state.sessionReview) { state.reviewTime = ui.sessionVideo.currentTime; updateReviewControls(); } });
  ui.sessionVideo?.addEventListener('ended', () => { if (state.sessionReview) { state.reviewPaused = true; updateControls(); } });
  if (ui.trimTimeline) {
    const track = ui.trimTimeline.parentElement;
    let drag = null;
    const valueAt = event => {
      const trim = state.trim, bounds = track.getBoundingClientRect();
      if (!trim || !bounds.width) return null;
      return trim.range.start + Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * (trim.range.end - trim.range.start);
    };
    track.addEventListener('pointerdown', event => {
      if (!state.trim || state.clip || event.button > 0) return;
      const value = valueAt(event);
      if (value === null) return;
      // The handles can overlap on a narrow phone. Pick the nearest actual edge
      // rather than whichever 44px native thumb happens to be stacked on top.
      const which = Math.abs(value - state.trim.start) <= Math.abs(value - state.trim.end) ? 'start' : 'end';
      drag = { id: event.pointerId, which };
      event.preventDefault(); event.stopPropagation();
      (which === 'start' ? ui.trimStart : ui.trimEnd).focus({ preventScroll: true });
      track.setPointerCapture(event.pointerId);
      changeTrim(which, value);
    }, { capture: true });
    track.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id || !state.trim || state.clip) return;
      event.preventDefault();
      const value = valueAt(event);
      if (value !== null) changeTrim(drag.which, value);
    });
    const release = event => {
      if (!drag || event.pointerId !== drag.id) return;
      if (track.hasPointerCapture?.(event.pointerId)) track.releasePointerCapture(event.pointerId);
      drag = null;
    };
    track.addEventListener('pointerup', release); track.addEventListener('pointercancel', release);
  }
  if (ui.timelineTrack) {
    let pointer = null;
    const seekFromPointer = event => {
      const range = getReplayWindow(), bounds = ui.timelineTrack.getBoundingClientRect();
      if (!range || !bounds.width || state.clip || state.trim) return;
      event.preventDefault();
      seekReplayTo(range.start + Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * (range.end - range.start));
    };
    ui.timelineTrack.addEventListener('pointerdown', event => {
      if (!getReplayWindow() || state.clip || state.trim || event.button > 0) return;
      pointer = event.pointerId;
      ui.timelineTrack.setPointerCapture(event.pointerId);
      beginScrub(); seekFromPointer(event);
    });
    ui.timelineTrack.addEventListener('pointermove', event => { if (event.pointerId === pointer) seekFromPointer(event); });
    const release = event => {
      if (event.pointerId !== pointer) return;
      if (ui.timelineTrack.hasPointerCapture?.(pointer)) ui.timelineTrack.releasePointerCapture(pointer);
      pointer = null; endScrub();
    };
    ui.timelineTrack.addEventListener('pointerup', release); ui.timelineTrack.addEventListener('pointercancel', release);
  }
  ui.recordClip.addEventListener('click', recordClip);
  ui.review.addEventListener('pointerdown', beginScrub);
  ui.review.addEventListener('input', () => {
    const seconds = Number(ui.review.value);
    if (!state.scrubbing) beginScrub();
    seekReplayTo(seconds);
  });
  ui.review.addEventListener('change', endScrub);
  ui.review.addEventListener('pointerup', endScrub);
  ui.review.addEventListener('pointercancel', endScrub);
  ui.review.addEventListener('blur', endScrub);
  window.addEventListener('pointerup', () => { if (state.scrubbing) endScrub(); });
  window.addEventListener('pointercancel', () => { if (state.scrubbing) endScrub(); });
  ui.prevFrame?.addEventListener('click', () => stepFrame(-1,false));
  ui.nextFrame?.addEventListener('click', () => stepFrame(1,false));
  ui.trimPrevFrame?.addEventListener('click', () => stepFrame(-1,true));
  ui.trimNextFrame?.addEventListener('click', () => stepFrame(1,true));
  ui.rewind.addEventListener('click', () => stepReplay(-5));
  ui.forward.addEventListener('click', () => stepReplay(5));
  ui.playPause.addEventListener('click', toggleReviewPlayback);
  ui.returnDelay.addEventListener('click', returnToDelay);
  ui.speed.addEventListener('change', () => setReviewSpeed(ui.speed.value));
  ui.camera.addEventListener('change', () => { if (state.running && state.sourceMode === 'camera') startCamera(); });
  ui.delayedVideo.addEventListener('error', compressedBufferError);
  ui.viewer.addEventListener('click', () => {
    if (state.clip || state.trim) return;
    if (state.reviewing) { toggleReviewPlayback(); return; }
    if (state.running && state.engine === 'compressed' && state.playbackStarted) {
      const generation = state.generation;
      ui.delayedVideo.play().then(() => {
        if (generation === state.generation && state.running) setReplayReady(true);
      }).catch(() => {
        if (generation === state.generation && state.running) showToast('The browser could not resume replay. Stop and start the camera.');
      });
    }
  });
  function updateFullscreenControls() {
    const expanded = !!document.fullscreenElement || ui.stage.classList.contains('expanded');
    ui.fullscreen.textContent = expanded ? 'Exit full screen' : 'Full screen';
    $('exitFullscreenBtn').hidden = !expanded;
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (ui.stage.classList.contains('expanded')) {
        ui.stage.classList.remove('expanded'); document.body.classList.remove('replay-expanded');
      } else if (ui.stage.requestFullscreen) await ui.stage.requestFullscreen();
      else throw new Error('Use page expansion');
    } catch {
      ui.stage.classList.add('expanded'); document.body.classList.add('replay-expanded');
    }
    updateFullscreenControls();
  }
  ui.fullscreen.addEventListener('click', toggleFullscreen);
  $('exitFullscreenBtn').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', updateFullscreenControls);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.trim) { event.preventDefault(); if (state.clip) cancelClip(); else { closeTrim(); ui.recordClip.focus(); } return; }
    if (event.key === 'Escape' && ui.stage.classList.contains('expanded')) {
      ui.stage.classList.remove('expanded'); document.body.classList.remove('replay-expanded'); updateFullscreenControls();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      cancelClip();
      stopTrimPreview();
      ui.sessionVideo.pause();
      if (state.sessionReview) state.reviewPaused = true;
    }
    if (document.visibilityState === 'hidden' && (state.running || state.starting)) {
      const demo = state.sourceMode === 'demo';
      stopCamera();
      showViewerMessage(demo ? 'Demo stopped while away' : 'Camera stopped while away', 'Start again to rebuild a fresh replay buffer.');
      showToast(`${demo ? 'Demo' : 'Camera'} stopped when this page went into the background.`);
    } else if (document.visibilityState === 'visible' && state.running) requestWakeLock();
  });
  window.addEventListener('pagehide', () => {
    stopCamera();
    if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = '';
    ui.download.hidden = true;
    if (state.sessionUrl) URL.revokeObjectURL(state.sessionUrl);
    state.sessionUrl = ''; state.sessionBlob = null;
    clearThumbnailFrames(state.sessionThumbnails); state.sessionThumbnails = [];
  });
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(error => console.info('Service worker unavailable', error)));
  restorePreferences();
  updateControls();
  enumerateCameras();
})();
