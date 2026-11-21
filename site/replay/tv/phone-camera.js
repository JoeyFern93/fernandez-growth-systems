(() => {
  'use strict';

  function setup() {
    const element = id => document.getElementById('phone-' + id);
    const lens = element('lens'), size = element('resolution'), fps = element('fps');
    const rotate = element('rotate'), mirror = element('mirror'), zoom = element('zoom');
    const readout = element('camera-readout'), status = element('camera-status'), preview = element('preview');
    if (!lens || !size || !fps || !rotate || !mirror || !zoom || !readout || !status || !preview) return null;

    const devices = navigator.mediaDevices;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', {alpha:false});
    const canCompose = Boolean(context && canvas.captureStream);
    const input = document.createElement('video');
    input.autoplay = true;
    input.playsInline = true;
    input.muted = true;
    input.hidden = true;
    preview.after(input);
    let source, rendered, sender, onLost, outputBounds;
    let angle = 0, flipped = false, busy = false, stopped = false, relayMime = '';
    let lensChoice = lens.value, resolution = size.value, rate = fps.value;
    let frameCallback, timer, lastPaint = -Infinity;
    function track() { return source?.getVideoTracks()[0]; }
    function settings() { return track()?.getSettings?.() || {}; }
    function capabilities() {
      try { return track()?.getCapabilities?.() || {}; } catch { return {}; }
    }
    function stopTracks(stream) { stream?.getTracks().forEach(item => item.stop()); }

    function constraints(choice, strict) {
      const height = Number(resolution) || 720, selectedFps = Number(rate);
      const video = {width:{ideal:2 * Math.round(height * 8 / 9)}, height:{ideal:height},
        frameRate:selectedFps ? {ideal:selectedFps, max:selectedFps} : {ideal:240}};
      if (choice === 'environment' || choice === 'user') {
        video.facingMode = strict ? {exact:choice} : {ideal:choice};
      } else if (choice) video.deviceId = {exact:choice};
      return video;
    }
    function refresh() {
      const current = settings();
      const hardwareZoom = capabilities().zoom;
      const zoomAvailable = Number.isFinite(hardwareZoom?.min) && hardwareZoom.max > hardwareZoom.min;
      const locked = busy || stopped;
      lens.disabled = locked || Boolean(relayMime && !canCompose);
      size.disabled = fps.disabled = locked || Boolean(track() && !track().applyConstraints);
      rotate.disabled = mirror.disabled = locked || !canCompose;
      lens.value = lensChoice;
      size.value = resolution;
      fps.value = rate;
      element('angle').textContent = angle + '°';
      mirror.setAttribute('aria-pressed', String(flipped));
      element('zoom-row').hidden = !zoomAvailable;
      zoom.disabled = locked || !zoomAvailable;
      if (zoomAvailable) {
        zoom.min = hardwareZoom.min;
        zoom.max = hardwareZoom.max;
        zoom.step = hardwareZoom.step || 0.1;
        zoom.value = current.zoom ?? hardwareZoom.min;
        element('zoom-value').textContent = Number(zoom.value).toFixed(1) + '×';
      }
      if (!track()) return;
      const info = [];
      const width = current.width || input.videoWidth, height = current.height || input.videoHeight;
      if (width && height) info.push(width + ' × ' + height);
      if (current.frameRate) info.push(Number(current.frameRate.toFixed(1)) + ' fps');
      if (typeof current.zoom === 'number' && zoomAvailable) info.push(current.zoom.toFixed(1) + '× zoom');
      const label = track().label;
      if (label) info.unshift(label);
      readout.textContent = info.length ? 'Camera reports ' + info.join(' · ') + '.' : 'Camera active. This device does not report capture settings.';
      if (relayMime) readout.textContent += relayMime === 'image/jpeg'
        ? ' Image relay sends up to about 3 fps, with a 960-pixel limit on the longer edge.'
        : ' TV relay playback supports up to 15 fps, with a 960-pixel limit on the longer edge.';
    }
    async function listCameras() {
      if (!devices?.enumerateDevices) return;
      try {
        const list = await devices.enumerateDevices();
        if (stopped) return;
        Array.from(lens.options).filter(option => option.dataset.camera).forEach(option => option.remove());
        let number = 0;
        for (const item of list) {
          if (item.kind !== 'videoinput' || !item.deviceId) continue;
          number++;
          const option = new Option(item.label || 'Camera ' + number, item.deviceId);
          option.dataset.camera = 'true';
          lens.add(option);
        }
        if (!Array.from(lens.options).some(option => option.value === lensChoice)) {
          lensChoice = settings().facingMode === 'user' ? 'user' : 'environment';
        }
        refresh();
      } catch { /* The facing-camera preferences remain available. */ }
    }

    function paint(force = false) {
      if (!context || !source || !input.videoWidth || input.readyState < 2) return;
      if (!force && relayMime && performance.now() - lastPaint < 1000 / (relayMime === 'image/jpeg' ? 4 : 15) - 2) return;
      const w = input.videoWidth, h = input.videoHeight;
      const sideways = angle % 180 !== 0;
      const width = sideways ? h : w, height = sideways ? w : h;
      const shrink = relayMime ? Math.min(1, 960 / Math.max(width, height)) : 1;
      const cw = outputBounds?.width || Math.max(2, Math.round(width * shrink / 2) * 2);
      const ch = outputBounds?.height || Math.max(2, Math.round(height * shrink / 2) * 2);
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      const scale = Math.min(cw / width, ch / height);
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = '#000';
      context.fillRect(0, 0, cw, ch);
      context.translate(cw / 2, ch / 2);
      context.scale(flipped ? -scale : scale, scale);
      context.rotate(angle * Math.PI / 180);
      context.drawImage(input, -w / 2, -h / 2, w, h);
      lastPaint = performance.now();
    }
    function frame() {
      if (stopped || !rendered) return;
      paint();
      frameCallback = input.requestVideoFrameCallback(frame);
    }
    function composedStream() {
      if (!rendered) {
        const native = settings();
        const w = input.videoWidth || native.width || 1280, h = input.videoHeight || native.height || 720;
        canvas.width = angle % 180 ? h : w;
        canvas.height = angle % 180 ? w : h;
        rendered = canvas.captureStream();
        if (input.requestVideoFrameCallback) frameCallback = input.requestVideoFrameCallback(frame);
        // Some mobile browsers throttle frame callbacks on an auxiliary video.
        const period = input.requestVideoFrameCallback ? 100 : 1000 / 60;
        timer = setInterval(() => { if (performance.now() - lastPaint >= period - 1) paint(); }, period);
      }
      paint(true);
      return rendered;
    }
    function directStream() {
      return canCompose && (angle || flipped) ? composedStream() : source;
    }
    function updatePreview() {
      const stream = directStream();
      if (preview.srcObject !== stream) {
        preview.srcObject = stream;
        preview.hidden = !stream;
        if (stream) preview.play().catch(() => {});
      }
    }
    function stopDrawingWhenUnused() {
      if (relayMime || angle || flipped || !rendered) return;
      clearInterval(timer);
      if (frameCallback !== undefined) input.cancelVideoFrameCallback?.(frameCallback);
      stopTracks(rendered);
      rendered = null;
    }
    async function updateOutput() {
      const stream = directStream();
      const output = stream?.getVideoTracks()[0];
      const currentSender = sender;
      if (output && currentSender && currentSender.track !== output) {
        try { await currentSender.replaceTrack(output); }
        catch (error) { if (!stopped && sender === currentSender) throw error; }
      }
      if (stopped) return;
      updatePreview();
      stopDrawingWhenUnused();
      refresh();
    }
    async function install(candidate) {
      if (stopped) { stopTracks(candidate); return; }
      if (!candidate.getVideoTracks()[0]) { stopTracks(candidate); throw new Error('No video track'); }
      const previous = source;
      source = candidate;
      input.srcObject = candidate;
      input.play().catch(() => {});
      candidate.getVideoTracks()[0].addEventListener('ended', () => {
        if (!stopped && source === candidate) onLost?.();
      }, {once:true});
      try { await updateOutput(); }
      catch (error) {
        source = previous;
        input.srcObject = previous || null;
        if (previous) input.play().catch(() => {});
        stopTracks(candidate);
        throw error;
      }
      if (previous !== candidate) stopTracks(previous);
    }
    async function acquire(choice, strict) {
      return devices.getUserMedia({audio:false, video:constraints(choice, strict)});
    }
    async function switchLens(choice) {
      if (!source) { lensChoice = choice; return; }
      const previous = source, previousLens = settings().deviceId || lensChoice;
      try { await install(await acquire(choice, true)); }
      catch (error) {
        // Some mobile cameras cannot open a second lens while the first is in use.
        if (stopped || !['NotReadableError','AbortError'].includes(error.name)) throw error;
        source = null;
        stopTracks(previous);
        try { await install(await acquire(choice, true)); }
        catch (switchError) {
          if (stopped) return;
          try { await install(await acquire(previousLens, false)); }
          catch { if (!stopped) onLost?.(); }
          throw switchError;
        }
      }
      if (stopped) return;
      lensChoice = choice;
      await listCameras();
    }
    async function change(action, success, failure) {
      if (busy || stopped) { refresh(); return; }
      busy = true; refresh();
      try { await action(); if (!stopped) status.textContent = success; }
      catch { if (!stopped) status.textContent = failure; }
      finally { busy = false; refresh(); }
    }
    lens.onchange = () => {
      const choice = lens.value;
      return change(() => switchLens(choice), 'Camera selected.', 'This camera could not be opened. Check the selected camera below.');
    };
    function changeFormat() {
      const wantedSize = size.value, wantedRate = fps.value;
      return change(async () => {
        const oldSize = resolution, oldRate = rate;
        resolution = wantedSize; rate = wantedRate;
        if (!track()) return;
        try {
          const video = constraints(lensChoice, false);
          const hardwareZoom = settings().zoom;
          if (typeof hardwareZoom === 'number') video.advanced = [{zoom:hardwareZoom}];
          await track().applyConstraints(video);
        } catch (error) { resolution = oldSize; rate = oldRate; throw error; }
      }, 'Capture preference saved. The camera may use the closest available setting.', 'The camera could not use those settings. Your previous preferences are selected.');
    }
    size.onchange = fps.onchange = changeFormat;
    function changeView(rotation, mirrorView) {
      return change(async () => {
        const oldAngle = angle, oldFlip = flipped;
        angle = rotation; flipped = mirrorView;
        try { if (source) await updateOutput(); }
        catch (error) {
          angle = oldAngle; flipped = oldFlip;
          if (source) await updateOutput();
          throw error;
        }
      }, 'Camera view updated.', 'The camera could not switch views. Your previous view is selected.');
    }
    rotate.onclick = () => changeView((angle + 90) % 360, flipped);
    mirror.onclick = () => changeView(angle, !flipped);
    zoom.oninput = () => { element('zoom-value').textContent = Number(zoom.value).toFixed(1) + '×'; };
    zoom.onchange = () => {
      const value = Number(zoom.value);
      return change(async () => {
        await track().applyConstraints({...track().getConstraints?.(), advanced:[{zoom:value}]});
      }, 'Zoom updated.', 'This camera could not apply that zoom.');
    };
    input.addEventListener('resize', refresh);
    devices?.addEventListener?.('devicechange', listCameras);
    refresh();
    return {
      async start(lost) {
        onLost = lost; busy = true; refresh();
        try {
          await install(await acquire(lensChoice, false));
          if (!stopped) await listCameras();
          return source;
        } finally { busy = false; refresh(); }
      },
      directStream,
      setSender(value) { sender = value; },
      forRelay(mime) {
        relayMime = mime;
        // MP4 encoders can require one fixed size for a recording session.
        if (mime.startsWith('video/mp4') && canCompose) {
          const s = settings(), w = input.videoWidth || s.width || 1280, h = input.videoHeight || s.height || 720;
          const scale = Math.min(1, 960 / Math.max(w,h));
          const width = Math.max(2,Math.round(w * scale / 2) * 2), height = Math.max(2,Math.round(h * scale / 2) * 2);
          outputBounds = angle % 180 ? {width:height,height:width} : {width,height};
        }
        refresh();
        return canCompose ? composedStream() : source;
      },
      stop() {
        stopped = true; sender = null;
        devices?.removeEventListener?.('devicechange', listCameras);
        clearInterval(timer);
        if (frameCallback !== undefined) input.cancelVideoFrameCallback?.(frameCallback);
        stopTracks(source); stopTracks(rendered);
        source = rendered = null;
        input.pause(); input.srcObject = null; input.remove();
        preview.pause(); preview.srcObject = null;
        readout.textContent = 'Camera disconnected.';
        status.textContent = '';
        refresh();
      }
    };
  }
  window.FGSPhoneCamera = {setup};
})();
