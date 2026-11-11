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
    forward: $('forwardBtn'), returnDelay: $('returnDelayBtn'), speed: $('playbackSpeed')
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
    scrubbing: false, scrubWindow: null, reviewExpired: false
  };
  const MAX_QUEUED_BYTES = 32 * 1024 * 1024;
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
    ui.start.disabled = state.running || state.starting;
    ui.demo.disabled = state.running || state.starting;
    ui.stop.disabled = !state.running && !state.starting;
    ui.flip.disabled = !state.running || state.starting || state.sourceMode === 'demo';
    ui.camera.disabled = state.starting || state.sourceMode === 'demo';
    ui.recordClip.disabled = !state.running || !state.replayReady || !!state.clip
      || state.reviewPaused || state.scrubbing
      || !window.MediaRecorder || !ui.clipCanvas.captureStream;
    ui.clipLength.disabled = !!state.clip;
    ui.mirror.disabled = !!state.clip;
    ui.connectionBadge.textContent = state.starting ? (state.sourceMode === 'demo' ? 'Starting demo' : 'Starting camera')
      : state.running ? (state.sourceMode === 'demo' ? 'Demo active' : 'Camera active') : 'Ready';
    if (!state.clip) ui.recordClip.textContent = `Record next ${plural(Number(ui.clipLength.value), 'second')}`;
    updateReviewControls();
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
    return state.engine === 'compressed' ? ui.delayedVideo.currentTime : state.reviewTime;
  }
  function formatTime(seconds) {
    const value = Math.max(0, Math.round(seconds));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
  }
  function updateReviewControls() {
    const available = getReplayWindow();
    const enabled = !!available && state.running && state.replayReady;
    const locked = !enabled || !!state.clip;
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
    ui.historyEnd.textContent = 'Newest';
    ui.replayStatus.textContent = state.reviewing ? (state.reviewPaused ? 'Paused review' : `${state.reviewSpeed}× review`) : 'Delayed playback';
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
    if (!range || !state.running || !state.replayReady || state.clip || !Number.isFinite(Number(seconds))) return;
    state.reviewing = true; state.reviewPaused = true; state.reviewExpired = false;
    state.reviewTime = Math.max(range.start, Math.min(range.end, Number(seconds)));
    if (state.engine === 'compressed') {
      ui.delayedVideo.pause();
      ui.delayedVideo.currentTime = state.reviewTime;
    } else drawFallbackAt(state.reviewTime);
    ui.viewerMessage.hidden = true;
    updateControls();
  }
  function toggleReviewPlayback() {
    if (!state.running || !state.replayReady || state.clip || state.scrubbing) return;
    if (!state.reviewing || !state.reviewPaused) { seekReplayTo(reviewPosition()); return; }
    const range = getReplayWindow();
    if (!range) return;
    state.reviewTime = Math.max(range.start, Math.min(range.end, reviewPosition()));
    state.reviewPaused = false; state.reviewExpired = false;
    if (state.engine === 'compressed') {
      ui.delayedVideo.currentTime = state.reviewTime;
      ui.delayedVideo.playbackRate = state.reviewSpeed;
      const generation = state.generation;
      ui.delayedVideo.play().catch(() => {
        if (generation !== state.generation || !state.reviewing) return;
        state.reviewPaused = true; updateControls();
        showToast('Tap Play to resume this recording.');
      });
    }
    updateControls();
  }
  function returnToDelay() {
    if (!state.running || state.clip) return;
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
    if (![0.25, 0.5, 1].includes(speed) || !state.running || !state.replayReady || state.clip || state.scrubbing) return;
    if (!state.reviewing) { state.reviewing = true; state.reviewTime = reviewPosition(); }
    state.reviewSpeed = speed;
    ui.delayedVideo.playbackRate = speed;
    updateControls();
  }
  function beginScrub() {
    if (!state.running || !state.replayReady || state.clip) return;
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
        lastFrame = timestamp;
      }
      if (ui.live.requestVideoFrameCallback) state.frameCallback = ui.live.requestVideoFrameCallback(draw);
    };
    if (ui.live.requestVideoFrameCallback) state.frameCallback = ui.live.requestVideoFrameCallback(draw);
    else state.frameTimer = setInterval(() => draw(now()), 1000 / state.replayFps);
  }
  function disposeClip(clip) {
    clearInterval(clip.countdown);
    clearTimeout(clip.timer);
    clearTimeout(clip.stopTimer);
    if (clip.frame !== null) cancelAnimationFrame(clip.frame);
    clip.frame = null;
    clip.stream?.getTracks().forEach(track => track.stop());
  }
  function finalizeClip(clip) {
    if (clip.finished) return;
    clip.finished = true;
    disposeClip(clip);
    const current = state.clip === clip;
    if (current) { state.clip = null; updateControls(); }
    if (clip.cancelled || clip.generation !== state.generation) return;
    if (clip.error) { showToast('The clip could not be recorded. Please try again.'); return; }
    const blob = new Blob(clip.chunks, { type: clip.recorder.mimeType || clip.mimeType || 'video/webm' });
    if (!blob.size) { showToast('The recorded clip was empty. Please try again.'); return; }
    if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = URL.createObjectURL(blob);
    const extension = blob.type.includes('mp4') ? 'mp4' : 'webm';
    ui.download.href = state.downloadUrl;
    ui.download.download = `replay-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
    ui.download.hidden = false;
    showToast('Clip is ready to download.');
  }
  function finishClip(clip, cancelled = false, error = false) {
    if (!clip || clip.stopping || clip.finished) return;
    clip.stopping = true;
    clip.cancelled = cancelled;
    clip.error = error;
    clearInterval(clip.countdown);
    clearTimeout(clip.timer);
    if (clip.frame !== null) cancelAnimationFrame(clip.frame);
    clip.frame = null;
    try {
      if (clip.recorder.state !== 'inactive') {
        clip.recorder.stop();
        clip.stopTimer = setTimeout(() => { clip.error = true; finalizeClip(clip); }, 2000);
      } else finalizeClip(clip);
    } catch { clip.error = true; finalizeClip(clip); }
  }
  function cancelClip() {
    const clip = state.clip;
    if (!clip) return;
    clip.cancelled = true;
    finishClip(clip, true);
    disposeClip(clip);
    if (state.clip === clip) state.clip = null;
  }
  function stopReplayEngine() {
    state.generation += 1;
    cancelClip();
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
        const removeBefore = Math.max(0, newest - Math.max(120, state.delaySeconds + 20));
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
        frame.at = timestamp;
        state.fallbackWrite = (state.fallbackWrite + 1) % state.fallbackFrames.length;
        const target = timestamp - state.delaySeconds * 1000;
        let candidate = null;
        for (const saved of state.fallbackFrames) {
          if (Number.isFinite(saved.at) && saved.at <= target && (!candidate || saved.at > candidate.at)) candidate = saved;
        }
        ui.bufferStatus.textContent = `${Math.min(6.2, (timestamp - started) / 1000).toFixed(1)} seconds available`;
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
  }
  function applyMirror() {
    ui.delayedVideo.classList.toggle('mirrored', state.mirrored);
    ui.delayedCanvas.classList.toggle('mirrored', state.mirrored);
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
  function recordClip() {
    if (!state.running || !state.replayReady || state.clip
      || state.reviewPaused || state.scrubbing
      || !window.MediaRecorder || !ui.clipCanvas.captureStream) return;
    const seconds = Number(ui.clipLength.value);
    ui.clipCanvas.width = ui.processingCanvas.width;
    ui.clipCanvas.height = ui.processingCanvas.height;
    const source = state.engine === 'compressed' ? ui.delayedVideo : ui.delayedCanvas;
    const clip = {
      generation: state.generation, mimeType: pickClipMime(), chunks: [],
      stream: null, recorder: null, frame: null, timer: null, countdown: null,
      stopTimer: null, stopping: false, finished: false, cancelled: false,
      error: false, mirrored: state.mirrored
    };
    if (!drawContained(source, ui.clipCanvas, clip.mirrored)) {
      showToast('Wait until the delayed replay is playing before recording.');
      return;
    }
    try {
      clip.stream = ui.clipCanvas.captureStream(state.replayFps);
      clip.recorder = clip.mimeType
        ? new MediaRecorder(clip.stream, { mimeType: clip.mimeType, videoBitsPerSecond: 2_000_000 })
        : new MediaRecorder(clip.stream);
      clip.recorder.ondataavailable = event => { if (event.data?.size) clip.chunks.push(event.data); };
      clip.recorder.onstop = () => finalizeClip(clip);
      clip.recorder.onerror = () => finishClip(clip, false, true);
      state.clip = clip;
      clip.recorder.start(1000);
      const draw = () => {
        if (clip.stopping || clip.finished) return;
        if (clip.generation !== state.generation || !state.running || !state.replayReady) {
          finishClip(clip, true);
          return;
        }
        drawContained(source, ui.clipCanvas, clip.mirrored);
        clip.frame = requestAnimationFrame(draw);
      };
      clip.frame = requestAnimationFrame(draw);
      const ends = now() + seconds * 1000;
      const countdown = () => { ui.recordClip.textContent = `Recording… ${Math.max(1, Math.ceil((ends - now()) / 1000))}s`; };
      updateControls();
      countdown();
      clip.countdown = setInterval(countdown, 200);
      clip.timer = setTimeout(() => finishClip(clip), seconds * 1000);
    } catch (error) {
      disposeClip(clip);
      if (state.clip === clip) state.clip = null;
      updateControls();
      showToast('This browser could not start the clip recorder.');
    }
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
  ui.clipLength.addEventListener('change', updateControls);
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
    if (event.key === 'Escape' && ui.stage.classList.contains('expanded')) {
      ui.stage.classList.remove('expanded'); document.body.classList.remove('replay-expanded'); updateFullscreenControls();
    }
  });
  document.addEventListener('visibilitychange', () => {
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
  });
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    state.deferredInstall = event;
    ui.install.hidden = false;
  });
  ui.install.addEventListener('click', async () => {
    if (!state.deferredInstall) return;
    try { state.deferredInstall.prompt(); await state.deferredInstall.userChoice; } catch {}
    state.deferredInstall = null;
    ui.install.hidden = true;
  });
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(error => console.info('Service worker unavailable', error)));
  restorePreferences();
  updateControls();
  enumerateCameras();
})();
