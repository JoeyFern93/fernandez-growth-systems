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
    timeline: $('timelineCanvas'), timelineTrack: $('timelineTrack'),
    trimPanel: $('trimPanel'), trimTimeline: $('trimTimelineCanvas'),
    trimStart: $('trimStartRange'), trimEnd: $('trimEndRange'), trimSelection: $('trimSelection'),
    trimStartTime: $('trimStartTime'), trimEndTime: $('trimEndTime'), trimDuration: $('trimDuration'),
    trimHelp: $('trimHelp'), trimStatus: $('trimStatus'), trimPreview: $('trimPreviewBtn'),
    trimExport: $('trimExportBtn'), trimCancel: $('trimCancelBtn'),
    trimCancelExport: $('trimCancelExportBtn'), trimProgress: $('trimProgress'),
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
    replayFps: 30, delaySeconds: 10, replayReady: false, playbackStarted: false,
    lastDataAt: 0, lastCleanupAt: 0, clip: null, deferredInstall: null,
    wakeLock: null, wakeRequest: 0, toastTimer: null, engine: 'none',
    reviewing: false, reviewPaused: false, reviewTime: 0, reviewSpeed: 1,
    scrubbing: false, scrubWindow: null, reviewExpired: false,
    trim: null, thumbnails: [], lastThumbnailAt: 0,
    session: null, sessionBlob: null, sessionUrl: '', sessionReview: false,
    sessionDuration: 0, sessionThumbnails: [], encoderStartedAt: 0, fallbackStartedAt: 0
  };
  const MAX_QUEUED_BYTES = 32 * 1024 * 1024;
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
    ui.flip.disabled = !state.running || state.starting || state.sourceMode === 'demo' || busy || !!state.trim;
    ui.camera.disabled = state.starting || state.sourceMode === 'demo' || busy || !!state.trim;
    ui.recordClip.disabled = !source || (!state.sessionReview && !state.replayReady) || busy || !!state.trim
      || !window.MediaRecorder || !ui.clipCanvas.captureStream;
    ui.clipLength.disabled = busy;
    ui.mirror.disabled = busy || !!state.trim;
    ui.delay.disabled = busy || !!state.trim;
    ui.connectionBadge.textContent = state.starting ? (state.sourceMode === 'demo' ? 'Starting demo' : 'Starting camera')
      : state.running ? (state.sourceMode === 'demo' ? 'Demo active' : 'Camera active') : 'Ready';
    ui.recordClip.textContent = 'Save clip';
    if (ui.sessionRecord) {
      ui.sessionRecord.disabled = busy || !!state.trim || !!state.session?.stopping
        || (!state.running && !state.session) || !window.MediaRecorder || !ui.clipCanvas.captureStream;
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
  function getReplayWindow() {
    if (state.sessionReview && state.sessionBlob) {
      const end = Number.isFinite(ui.sessionVideo.duration) ? ui.sessionVideo.duration : state.sessionDuration;
      return end > MIN_CLIP_SECONDS ? { start: 0, end: Math.max(0, end - 0.04) } : null;
    }
    if (state.engine === 'compressed') {
      const ranges = ui.delayedVideo.buffered;
      if (!ranges.length) return null;
      const index = ranges.length - 1;
      const start = ranges.start(index);
      const end = Math.max(start, ranges.end(index) - 0.08);
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
    for (const control of [ui.review, ui.rewind, ui.playPause, ui.forward, ui.speed]) control.disabled = locked;
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
    const mode = !state.reviewing ? 'Delayed view' : state.reviewPaused ? 'Paused' : 'Reviewing';
    ui.reviewPosition.textContent = state.reviewExpired ? 'Older footage cleared · choose a new point'
      : `${mode} · ${formatTime(behind)} behind newest`;
    ui.review.setAttribute('aria-valuetext', `${formatTime(behind)} behind newest recorded footage`);
    ui.historyStart.textContent = `${formatTime(range.end - range.start)} history`;
    ui.historyEnd.textContent = state.sessionReview ? formatTime(range.end) : 'Newest';
    if (state.sessionReview) {
      ui.reviewPosition.textContent = `${state.reviewPaused ? 'Paused session' : 'Recorded session'} · ${formatTime(reviewPosition())} / ${formatTime(range.end)}`;
      ui.historyStart.textContent = '0:00';
      ui.review.setAttribute('aria-valuetext', `${formatTime(reviewPosition())} of ${formatTime(range.end)} recorded session`);
    }
    ui.replayStatus.textContent = state.sessionReview ? 'Recorded session'
      : state.reviewing ? (state.reviewPaused ? 'Paused review' : `${state.reviewSpeed}x review`) : 'Delayed playback';
    renderTimeline(ui.timeline, range, state.sessionReview ? state.sessionThumbnails : state.thumbnails);
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
      video.playbackRate = state.reviewSpeed;
      const generation = state.generation;
      video.play().catch(() => {
        if (generation !== state.generation || !state.reviewing) return;
        state.reviewPaused = true; updateControls();
        showToast('Tap Play to resume this recording.');
      });
    }
    updateControls();
  }
  function returnToDelay() {
    if (state.clip || state.trim) return;
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
  function setReviewSpeed(value) {
    const speed = Number(value);
    if (![0.25, 0.5, 1].includes(speed) || (!state.sessionReview && (!state.running || !state.replayReady)) || state.clip || state.trim || state.scrubbing) return;
    if (!state.reviewing) { state.reviewing = true; state.reviewTime = reviewPosition(); }
    state.reviewSpeed = speed;
    (state.sessionReview ? ui.sessionVideo : ui.delayedVideo).playbackRate = speed;
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
    let lastFrame = -Infinity;
    const draw = timestamp => {
      if (!state.running || generation !== state.generation) return;
      if (timestamp - lastFrame >= 1000 / state.replayFps - 1) {
        drawContained(ui.live, ui.processingCanvas);
        captureTimelineThumbnail(timestamp);
        lastFrame = timestamp;
      }
      if (ui.live.requestVideoFrameCallback) state.frameCallback = ui.live.requestVideoFrameCallback(draw);
    };
    if (ui.live.requestVideoFrameCallback) state.frameCallback = ui.live.requestVideoFrameCallback(draw);
    else state.frameTimer = setInterval(() => draw(now()), 1000 / state.replayFps);
  }
  function disposeClip(clip) {
    clearInterval(clip.countdown); clearTimeout(clip.timer); clearTimeout(clip.stopTimer);
    clip.cancelSeek?.(); clip.cancelSeek = null;
    if (clip.frame !== null) cancelAnimationFrame(clip.frame);
    clip.frame = null;
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
    const blob = new Blob(clip.chunks, { type: clip.recorder.mimeType || clip.mimeType || 'video/webm' });
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
    clearInterval(clip.countdown); clearTimeout(clip.timer);
    if (clip.frame !== null) cancelAnimationFrame(clip.frame);
    clip.frame = null;
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
        const normalBoundary = Math.max(0, newest - Math.max(120, state.delaySeconds + 20));
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
    if (now() - state.lastDataAt > 10000) {
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
  function startCompressedReplay(mimeType) {
    state.engine = 'compressed';
    state.encoderStartedAt = now();
    state.lastDataAt = now();
    state.lastCleanupAt = 0;
    ui.engineBadge.textContent = 'Compressed replay';
    ui.delayedCanvas.hidden = true;
    ui.delayedVideo.hidden = false;
    const generation = state.generation;
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
      state.encoderStream = ui.processingCanvas.captureStream(state.replayFps);
      state.recorder = new MediaRecorder(state.encoderStream, { mimeType, videoBitsPerSecond: 1_800_000 });
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
      state.recorder.onerror = () => {
        if (generation === state.generation) startFallbackReplay('The camera encoder stopped.');
      };
      state.recorder.start(1000);
      startFramePump();
      state.playbackTimer = setInterval(() => updateCompressedPlayback(generation), 250);
      ui.replayStatus.textContent = 'Warming up';
      showViewerMessage('Building replay buffer', `Replay will start after about ${plural(state.delaySeconds, 'second')}.`);
    } catch { startFallbackReplay('This browser could not start compressed recording.'); }
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
    state.replayFps = fps;
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
        if (state.sessionReview || state.clip?.engine === 'fallback' || state.trim?.previewing) { updateControls(); return; }
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
    const replay = parseResolution(ui.replayResolution.value);
    ui.processingCanvas.width = replay.width;
    ui.processingCanvas.height = replay.height;
    state.replayFps = Math.min(Number(ui.captureFps.value), 30);
    updateDelayText();
    setReplayReady(false);
    const mimeType = compatibleMimeTypes()[0];
    if (mimeType && ui.processingCanvas.captureStream) startCompressedReplay(mimeType);
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
      const fps = Math.min(Number(ui.captureFps.value) || 30, 30);
      const started = now();
      let lastFrame = -Infinity;
      const colors = ['#a9e68d', '#78c9ec', '#edbc73', '#dca4e9'];
      const draw = timestamp => {
        if (request !== state.cameraRequest || state.demoCanvas !== canvas || state.sourceMode !== 'demo') return;
        if (timestamp - lastFrame >= 1000 / fps - 1) {
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
      acquired = canvas.captureStream(fps);
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
      ui.actualBadge.textContent = `Demo - 640x360 @ ${fps} FPS`;
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
  async function startCamera() {
    stopCamera();
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
    const video = {
      width: { ideal: capture.width }, height: { ideal: capture.height },
      frameRate: { ideal: Number(ui.captureFps.value), max: Number(ui.captureFps.value) }
    };
    if (selectedDevice) video.deviceId = { exact: selectedDevice };
    else video.facingMode = { ideal: state.facingMode };
    showViewerMessage('Starting camera', 'Approve camera access if your browser asks. You can press Stop to cancel.');
    let acquired = null;
    try {
      acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video });
      if (request !== state.cameraRequest) { acquired.getTracks().forEach(track => track.stop()); return; }
      state.stream = acquired;
      ui.live.srcObject = acquired;
      await ui.live.play();
      if (request !== state.cameraRequest) return;
      await waitForCameraMetadata();
      if (request !== state.cameraRequest) return;
      const track = acquired.getVideoTracks()[0];
      const settings = track.getSettings();
      track.addEventListener('ended', () => {
        if (state.stream !== acquired) return;
        stopCamera();
        showViewerMessage('Camera disconnected', 'Start the camera again to rebuild your replay.');
      }, { once: true });
      state.running = true;
      state.starting = false;
      state.generation += 1;
      enumerateCameras(settings.deviceId || selectedDevice, request);
      ui.actualBadge.textContent = `${settings.width || ui.live.videoWidth}×${settings.height || ui.live.videoHeight} @ ${Math.round(settings.frameRate || Number(ui.captureFps.value))} FPS`;
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
        OverconstrainedError: 'The selected camera setting is unsupported. Choose 720p at 30 FPS.',
        SecurityError: 'Camera access requires a secure HTTPS page.'
      };
      const message = messages[error.name] || 'Check camera permission and try again.';
      showViewerMessage('Could not start camera', message);
      showToast(message);
    }
  }
  function stopCamera() {
    state.cameraRequest += 1;
    state.running = false;
    state.starting = false;
    state.sourceMode = 'none';
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
  }
  function applyMirror() {
    ui.delayedVideo.classList.toggle('mirrored', state.mirrored);
    ui.delayedCanvas.classList.toggle('mirrored', state.mirrored);
    ui.sessionVideo?.classList.toggle('mirrored', false);
    ui.mirror.textContent = `Mirror: ${state.mirrored ? 'on' : 'off'}`;
    ui.mirror.setAttribute('aria-pressed', String(state.mirrored));
  }
  function switchCamera() {
    if (state.sourceMode === 'demo') return;
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    ui.camera.value = '';
    startCamera();
  }
  function pickClipMime() {
    if (!window.MediaRecorder?.isTypeSupported) return '';
    return ['video/mp4;codecs="avc1.42E01E"', 'video/webm;codecs=vp8', 'video/webm']
      .find(type => MediaRecorder.isTypeSupported(type)) || '';
  }
  function formatPrecise(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    return `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, '0')}`;
  }
  function copyFrame(source, width = 144, height = 81) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    return drawContained(source, canvas) ? canvas : null;
  }
  function clearThumbnailFrames(frames) {
    for (const item of frames || []) { item.canvas.width = 0; item.canvas.height = 0; }
  }
  function captureTimelineThumbnail(timestamp) {
    if (timestamp - state.lastThumbnailAt < 1000 || !state.running) return;
    const range = getRecentWindow();
    if (!range) return;
    const canvas = copyFrame(state.engine === 'fallback' ? ui.live : ui.processingCanvas);
    if (!canvas) return;
    state.lastThumbnailAt = timestamp;
    state.thumbnails.push({ at: range.end, canvas });
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
  function renderTimeline(canvas, range, frames) {
    if (!canvas || !range) return;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;
    const width = canvas.width || 960, height = canvas.height || 96;
    context.fillStyle = '#14261f'; context.fillRect(0, 0, width, height);
    const count = 8, tile = width / count;
    for (let index = 0; index < count; index++) {
      const time = range.start + (range.end - range.start) * (index + 0.5) / count;
      let nearest = null;
      for (const frame of frames || []) if (!nearest || Math.abs(frame.at - time) < Math.abs(nearest.at - time)) nearest = frame;
      if (nearest?.canvas.width) context.drawImage(nearest.canvas, index * tile, 0, tile - 1, height);
      context.fillStyle = 'rgba(0,0,0,.64)'; context.fillRect(index * tile, height - 20, tile, 20);
      context.fillStyle = '#fff'; context.font = '13px system-ui, sans-serif';
      context.fillText(formatTime(time), index * tile + 5, height - 5);
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
      video.playbackRate = saved.speed; video.currentTime = state.reviewTime;
      if (saved.paused) video.pause(); else video.play().catch(() => { state.reviewPaused = true; updateControls(); });
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
      thumbnails: (state.sessionReview ? state.sessionThumbnails : state.thumbnails).map(frame => ({ at: frame.at, canvas: copyFrame(frame.canvas) })).filter(frame => frame.canvas),
      previewing: false, previewFrame: null, timer: null, expiresAt: now() + TRIM_HOLD_MS };
    seekReplayTo(end);
    ui.trimPanel.hidden = false;
    ui.trimProgress.hidden = true; ui.trimProgress.value = 0;
    ui.trimStatus.textContent = 'Drag the two edge handles to choose footage that is already available. Nothing new is being recorded by Save clip.';
    ui.trimHelp.textContent = sourceType === 'session'
      ? 'Choose up to 2 minutes from your completed session recording. The clip exports at normal speed.'
      : `Recent history is held for up to 3 minutes while you choose. Select up to 2 minutes. ${state.engine === 'fallback' ? 'Compatibility mode only has about 6 seconds of low-resolution history.' : 'Older footage outside this strip has already cleared.'}`;
    state.trim.timer = setTimeout(() => {
      if (!state.clip && state.trim) { closeTrim(); showToast('The clip picker closed to release its held history. Choose a fresh section.'); }
    }, TRIM_HOLD_MS);
    updateControls();
    ui.trimStart.focus();
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
    renderTimeline(ui.trimTimeline, trim.range, trim.thumbnails);
  }
  function stopTrimPreview() {
    const trim = state.trim;
    if (!trim) return;
    trim.previewing = false;
    if (trim.previewFrame !== null) cancelAnimationFrame(trim.previewFrame);
    trim.previewFrame = null;
    (trim.sourceType === 'session' ? ui.sessionVideo : ui.delayedVideo).pause();
    state.reviewPaused = true;
  }
  function closeTrim(restore = true) {
    const trim = state.trim;
    if (!trim) return;
    stopTrimPreview(); clearTimeout(trim.timer);
    if (state.clip) cancelClip();
    state.trim = null;
    clearThumbnailFrames(trim.frames); clearThumbnailFrames(trim.thumbnails);
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
    trim.previewing = true;
    state.reviewing = true; state.reviewPaused = false; state.reviewSpeed = 1;
    const video = trim.sourceType === 'session' ? ui.sessionVideo : ui.delayedVideo;
    try {
      if (trim.engine !== 'fallback') { await seekVideo(video, trim.start); if (state.trim !== trim || !trim.previewing) return; video.playbackRate = 1; await video.play(); }
      const started = now();
      const draw = () => {
        if (state.trim !== trim || !trim.previewing) return;
        const time = trim.engine === 'fallback' ? Math.min(trim.end, trim.start + (now() - started) / 1000) : video.currentTime;
        state.reviewTime = time;
        if (trim.engine === 'fallback') drawTrimFrame(trim, time, ui.delayedCanvas);
        if (time >= trim.end - 0.025) { stopTrimPreview(); updateControls(); return; }
        updateTrimControls(); trim.previewFrame = requestAnimationFrame(draw);
      };
      trim.previewFrame = requestAnimationFrame(draw); updateControls();
    } catch { stopTrimPreview(); ui.trimStatus.textContent = 'Could not preview that selection. Try a smaller section.'; updateControls(); }
  }
  function changeTrim(which, value) {
    const trim = state.trim;
    if (!trim || state.clip || !Number.isFinite(Number(value))) return;
    stopTrimPreview();
    if (which === 'start') trim.start = Math.max(trim.range.start, trim.end - MAX_CLIP_SECONDS, Math.min(trim.end - MIN_CLIP_SECONDS, Number(value)));
    else trim.end = Math.min(trim.range.end, trim.start + MAX_CLIP_SECONDS, Math.max(trim.start + MIN_CLIP_SECONDS, Number(value)));
    const selected = which === 'start' ? trim.start : trim.end;
    if (trim.engine === 'fallback') { drawTrimFrame(trim, selected, ui.delayedCanvas); state.reviewTime = selected; }
    else seekReplayTo(selected);
    ui.trimStatus.textContent = 'Selection updated. Preview it, then export the selected clip.';
    updateControls();
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
    ui.trimProgress.hidden = false; ui.trimProgress.value = 0;
    ui.trimStatus.textContent = `Preparing ${formatPrecise(clip.end - clip.start)} of selected footage. Keep this page open; export takes about the clip length.`;
    ui.download.hidden = true;
    updateControls();
    const source = trim.sourceType === 'session' ? ui.sessionVideo : ui.delayedVideo;
    ui.clipCanvas.width = trim.engine === 'fallback' ? 320 : source.videoWidth || ui.processingCanvas.width;
    ui.clipCanvas.height = trim.engine === 'fallback' ? 180 : source.videoHeight || ui.processingCanvas.height;
    try {
      if (trim.engine !== 'fallback') await seekVideo(source, clip.start, clip);
      if (state.clip !== clip || clip.cancelled || clip.generation !== state.generation) return;
      const first = trim.engine === 'fallback' ? drawTrimFrame(trim, clip.start, ui.clipCanvas) : drawContained(source, ui.clipCanvas, clip.mirrored);
      if (!first) throw new Error('No selected frame');
      clip.stream = ui.clipCanvas.captureStream(state.replayFps || 30);
      clip.recorder = clip.mimeType ? new MediaRecorder(clip.stream, { mimeType: clip.mimeType, videoBitsPerSecond: 2_000_000 }) : new MediaRecorder(clip.stream);
      clip.recorder.ondataavailable = event => { if (event.data?.size) clip.chunks.push(event.data); };
      clip.recorder.onstop = () => finalizeClip(clip);
      clip.recorder.onerror = () => finishClip(clip, false, true);
      clip.recorder.start(500);
      state.reviewing = true; state.reviewPaused = false; state.reviewSpeed = 1;
      if (trim.engine !== 'fallback') { source.playbackRate = 1; await source.play(); }
      const started = now(); let lastPosition = clip.start, lastAdvance = started;
      const draw = () => {
        if (state.clip !== clip || clip.stopping || clip.finished) return;
        if (clip.generation !== state.generation || state.trim !== trim) { finishClip(clip, true); return; }
        if (trim.engine === 'compressed' && !validateTrimHistory()) return;
        const position = trim.engine === 'fallback' ? Math.min(clip.end, clip.start + (now() - started) / 1000) : source.currentTime;
        if (position > lastPosition + 0.005) { lastPosition = position; lastAdvance = now(); }
        if (position < clip.start - 0.12 || position > clip.end + 0.3 || now() - lastAdvance > 3000) { finishClip(clip, false, true); return; }
        const drawn = trim.engine === 'fallback' ? drawTrimFrame(trim, position, ui.clipCanvas) : drawContained(source, ui.clipCanvas, clip.mirrored);
        if (!drawn) { finishClip(clip, false, true); return; }
        state.reviewTime = position;
        const progress = Math.max(0, Math.min(100, 100 * (position - clip.start) / (clip.end - clip.start)));
        ui.trimProgress.value = progress;
        ui.trimStatus.textContent = `Exporting selected clip… ${Math.round(progress)}%. Keep this page open.`;
        updateTrimControls();
        if (position >= clip.end - 0.025) { source.pause(); state.reviewPaused = true; finishClip(clip); return; }
        clip.frame = requestAnimationFrame(draw);
      };
      clip.frame = requestAnimationFrame(draw);
      clip.timer = setTimeout(() => finishClip(clip, false, true), (clip.end - clip.start + 15) * 1000);
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
    if (session.frame !== null) cancelAnimationFrame(session.frame);
    session.frame = null;
    try { if (session.recorder.state !== 'inactive') session.recorder.stop(); else finalizeSession(session); }
    catch { session.error = true; finalizeSession(session); }
    updateControls();
  }
  function finalizeSession(session) {
    if (session.finished) return;
    session.finished = true; clearTimeout(session.timer); clearInterval(session.clock);
    if (session.frame !== null) cancelAnimationFrame(session.frame);
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
    if (!state.running || state.clip || state.trim || !window.MediaRecorder || !ui.clipCanvas.captureStream) return;
    if (state.sessionReview) returnToDelay();
    const session = { chunks: [], bytes: 0, canvas: document.createElement('canvas'), stream: null,
      recorder: null, mimeType: pickClipMime(), started: now(), frame: null, timer: null, clock: null,
      stopping: false, finished: false, error: false, mirrored: state.mirrored, thumbnails: [], lastThumbnailAt: -Infinity };
    session.canvas.width = ui.processingCanvas.width || 854; session.canvas.height = ui.processingCanvas.height || 480;
    try {
      if (!drawContained(ui.live, session.canvas, session.mirrored)) throw new Error('Camera not ready');
      session.stream = session.canvas.captureStream(state.replayFps || 30);
      session.recorder = session.mimeType ? new MediaRecorder(session.stream, { mimeType: session.mimeType, videoBitsPerSecond: 1_800_000 }) : new MediaRecorder(session.stream);
      session.recorder.ondataavailable = event => {
        if (event.data?.size) { session.chunks.push(event.data); session.bytes += event.data.size; }
        if (!session.stopping && session.bytes >= MAX_SESSION_BYTES) { showToast('Recording reached the 128 MB limit and was stopped safely.'); finishSessionRecording(); }
      };
      session.recorder.onstop = () => finalizeSession(session);
      session.recorder.onerror = () => finishSessionRecording(true);
      state.session = session; session.recorder.start(1000);
      const draw = timestamp => {
        if (state.session !== session || session.stopping) return;
        if (!state.running || !state.stream) { finishSessionRecording(); return; }
        drawContained(ui.live, session.canvas, session.mirrored);
        if (timestamp - session.lastThumbnailAt >= 5000) {
          const canvas = copyFrame(session.canvas);
          if (canvas) session.thumbnails.push({ at: (timestamp - session.started) / 1000, canvas });
          session.lastThumbnailAt = timestamp;
        }
        session.frame = requestAnimationFrame(draw);
      };
      session.frame = requestAnimationFrame(draw);
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
