(() => {
  'use strict';
  const jpeg = 'image/jpeg';
  const videoFormats = ['video/webm;codecs=vp8', 'video/mp4;codecs=avc1.42e01e', 'video/mp4', 'video/webm'];
  const maxPlainBytes = 240 * 1024;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function sendFormats() {
    if (!globalThis.crypto?.subtle) return [];
    const supported = videoFormats.filter(mime => globalThis.MediaRecorder?.isTypeSupported?.(mime));
    if (HTMLCanvasElement.prototype.toBlob) supported.push(jpeg);
    return supported;
  }
  function receiveFormats() {
    if (!globalThis.crypto?.subtle || !HTMLCanvasElement.prototype.captureStream) return [];
    return [...videoFormats.filter(mime => globalThis.MediaSource?.isTypeSupported?.(mime)), jpeg];
  }
  function importVideoKey(encoded) {
    const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
    return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  function encryptionOptions(session, seq, iv) {
    const additionalData = new TextEncoder().encode([session.id, session.mimeType, seq].join('/'));
    return {name:'AES-GCM', iv, additionalData};
  }
  function url(session, seq) {
    return session.origin + '/' + encodeURIComponent(session.id) + '/relay-chunk?seq=' + seq;
  }
  async function request(session, seq, body) {
    const headers = {Authorization:'Bearer ' + session.token};
    if (body) headers['Content-Type'] = 'application/octet-stream';
    const options = {method:body ? 'POST' : 'GET', headers, body, credentials:'omit', cache:'no-store', referrerPolicy:'no-referrer'};
    for (let attempt = 0; attempt < 4; attempt++) {
      session.signal.throwIfAborted();
      const controller = new AbortController();
      const abort = () => controller.abort();
      session.signal.addEventListener('abort', abort, {once:true});
      const timeout = setTimeout(abort, 8500);
      try {
        const response = await fetch(url(session, seq), {...options, signal:controller.signal});
        // Read the body while the request is still covered by the timeout.
        const data = new Uint8Array(await response.arrayBuffer());
        if (response.ok) return response.status === 204 ? null : data;
        if (response.status === 429) {
          let retry;
          try { retry = JSON.parse(new TextDecoder().decode(data)).retryAfterMs; } catch {}
          if (Number.isFinite(retry)) { await sleep(Math.min(1200, Math.max(60, retry + 20))); continue; }
        }
        if (response.status >= 500 && attempt < 3) { await sleep(250 * (attempt + 1)); continue; }
        throw new Error(response.status === 410 ? 'Encrypted sharing has ended.' :
          response.status === 409 ? 'The TV fell behind the encrypted video. Reconnect to resume.' :
          response.status === 429 ? 'The encrypted relay has reached its usage limit.' :
          'The video relay could not deliver this packet.');
      } catch (error) {
        session.signal.throwIfAborted();
        if ((error.name !== 'AbortError' && !(error instanceof TypeError)) || attempt === 3) throw error;
        await sleep(250 * (attempt + 1));
      } finally {
        clearTimeout(timeout);
        session.signal.removeEventListener('abort', abort);
      }
    }
    throw new Error('The video relay is too busy. Reconnect to resume.');
  }
  async function transmitter(session) {
    const key = await importVideoKey(session.key);
    let seq = 0, nextPost = 0, nextBudget = 0;
    // 1.35 Mb/s per room with a single packet of burst room. Capacity is shared across rooms.
    const bytesPerMs = 1350000 / 8000;
    const minPostInterval = session.mimeType === jpeg ? 145 : 305;
    async function pace(bytes) {
      const now = performance.now();
      const due = Math.max(now, nextPost, nextBudget);
      if (due > now) {
        await new Promise((resolve,reject) => {
          const complete = () => { session.signal.removeEventListener('abort',cancel); resolve(); };
          const timer = setTimeout(complete,due-now);
          const cancel = () => { clearTimeout(timer); reject(new DOMException('Aborted','AbortError')); };
          session.signal.addEventListener('abort',cancel,{once:true});
          if (session.signal.aborted) cancel();
        });
      }
      session.signal.throwIfAborted();
      nextBudget = performance.now() + bytes / bytesPerMs;
    }
    return async blob => {
      for (let pos = 0; pos < blob.size; pos += maxPlainBytes) {
        const plain = await blob.slice(pos, pos + maxPlainBytes).arrayBuffer();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const cipher = await crypto.subtle.encrypt(encryptionOptions(session, seq, iv), key, plain);
        const bytes = new Uint8Array(iv.length + cipher.byteLength);
        bytes.set(iv); bytes.set(new Uint8Array(cipher), iv.length);
        await pace(bytes.length);
        await request(session, seq, bytes);
        nextPost = performance.now() + minPostInterval;
        window.FGSReplayQuality?.packet(bytes.length, 'Upload');
        seq++;
      }
    };
  }
  function recorderLoop(session, upload) {
    return new Promise((resolve, reject) => {
      const track = session.stream.getVideoTracks()[0];
      const monitor = decoder();
      let recorder, pending = Promise.resolve(), queued = 0, pendingBytes = 0, epoch = 0, finished = false, shape = '';
      const profiles = [
        {edge:1280, fps:30, bitrate:1100000},
        {edge:960, fps:22, bitrate:720000},
        {edge:854, fps:16, bitrate:480000},
        {edge:640, fps:12, bitrate:320000}
      ];
      let level = 0, windowStart = performance.now(), windowBytes = 0;
      function adjustProfile(bytes) {
        windowBytes += bytes;
        const elapsed = performance.now()-windowStart;
        if (elapsed < (level ? 3500 : 1300)) return;
        const overBudget = windowBytes*8/elapsed > 1330 || queued >= 2;
        windowBytes = 0; windowStart = performance.now();
        if (!overBudget || level === profiles.length-1) return;
        const profile = profiles[++level];
        track.dispatchEvent(new CustomEvent('fgs-relay-profile',{detail:profile}));
        window.FGSReplayQuality?.profile(profile);
        if (recorder?.state === 'recording') recorder.stop();
      }
      function finish(error) {
        if (finished) return;
        finished = true;
        session.signal.removeEventListener('abort', stop);
        track.removeEventListener('fgs-resize', resize);
        monitor.removeEventListener('resize', resize);
        monitor.pause(); monitor.srcObject = null;
        if (recorder?.state === 'recording') recorder.stop();
        if (error && !session.signal.aborted) reject(error); else resolve();
      }
      const stop = () => finish();
      function resize(event) {
        const dimensions = event.detail || track.getSettings();
        const width = event.type === 'resize' ? monitor.videoWidth : dimensions.width;
        const height = event.type === 'resize' ? monitor.videoHeight : dimensions.height;
        if (!width || !height) return;
        const current = width + 'x' + height;
        if (shape && current !== shape && recorder?.state === 'recording') recorder.stop();
        shape = current;
      }
      function record() {
        if (finished) return;
        try {
          const currentEpoch = ++epoch;
          const options = {mimeType:session.mimeType, videoBitsPerSecond:profiles[level].bitrate};
          try { recorder = new MediaRecorder(session.stream,{...options,videoKeyFrameIntervalDuration:700}); }
          catch { recorder = new MediaRecorder(session.stream,options); }
          recorder.onerror = e => finish(e.error || new Error('The phone stopped producing relay video.'));
          recorder.onstop = record;
          recorder.ondataavailable = e => {
            if (!e.data.size || finished) return;
            adjustProfile(e.data.size);
            queued++;
            pendingBytes += e.data.size;
            if (pendingBytes > 2*1024*1024 || queued > 16) { finish(new Error('The relay cannot keep up with this connection.')); return; }
            // A replacement encoder begins with a complete initialization segment. Send any
            // in-flight blob in full, then skip stale queued blobs from the previous profile.
            pending = pending.then(() => finished || currentEpoch !== epoch ? undefined : upload(e.data))
              .then(() => { queued--; pendingBytes -= e.data.size; }, finish);
          };
          recorder.start(700);
        } catch (error) { finish(error); }
      }
      window.FGSReplayQuality?.outgoing?.(track,monitor);
      monitor.srcObject = session.stream;
      monitor.addEventListener('resize', resize);
      monitor.play().catch(() => {});
      const initial = track.getSettings();
      if (initial.width && initial.height) shape = initial.width + 'x' + initial.height;
      track.addEventListener('fgs-resize', resize);
      session.signal.addEventListener('abort', stop, {once:true});
      if (session.signal.aborted) { finish(); return; }
      window.FGSReplayQuality?.profile(profiles[0]);
      record();
    });
  }
  function decoder() {
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.autoplay = true;
    return video;
  }
  function dimensions(canvas, width, height, limit = Infinity) {
    const scale = Math.min(1, limit / Math.max(width, height));
    const w = Math.max(2, Math.round(width * scale)), h = Math.max(2, Math.round(height * scale));
    if (w !== canvas.width || h !== canvas.height) { canvas.width = w; canvas.height = h; }
  }
  async function send(session) {
    window.FGSReplayQuality?.codec(session.mimeType);
    const upload = await transmitter(session);
    if (session.mimeType !== jpeg) return recorderLoop(session, upload);
    const video = decoder(), canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    window.FGSReplayQuality?.outgoing?.(session.stream.getVideoTracks()[0],video);
    video.srcObject = session.stream;
    try {
      await video.play();
      while (!session.signal.aborted) {
        if (video.videoWidth) {
          // The composed timing stream already bounds the picture to 960px.
          // Preserve its extra rows so the strip geometry survives JPEG.
          dimensions(canvas,video.videoWidth,video.videoHeight,session.timed ? Infinity : 960);
          ctx.drawImage(video,0,0,canvas.width,canvas.height);
          const blob = await new Promise(resolve => canvas.toBlob(resolve,jpeg,.62));
          if (blob && blob.size <= maxPlainBytes) await upload(blob);
        }
        await sleep(360);
      }
    } finally { video.pause(); video.srcObject = null; }
  }
  function waitFor(target, name, signal, action) {
    return new Promise((resolve,reject) => {
      const cleanup = () => { clearTimeout(timer); target.removeEventListener(name,success); target.removeEventListener('error',error); signal.removeEventListener('abort',error); };
      const success = () => { cleanup(); resolve(); };
      const error = () => { cleanup(); reject(new Error('The TV could not decode the relay video.')); };
      const timer = setTimeout(error,15000);
      target.addEventListener(name,success,{once:true}); target.addEventListener('error',error,{once:true});
      signal.addEventListener('abort',error,{once:true});
      if (signal.aborted) { error(); return; }
      try { action(); } catch (e) { cleanup(); reject(e); }
    });
  }
  async function receive(session) {
    window.FGSReplayQuality?.codec(session.mimeType);
    const key = await importVideoKey(session.key);
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    const video = decoder();
    let mediaUrl, sourceBuffer, output, poll, callback, decodes = 0;
    let previousFrame = -1, lastPresentation = -1, manualOutput = false, initialized = false;
    let inspect;
    if (session.timed) {
      try { inspect=(await import('/replay/tv/frame-stamp.mjs')).createStampReader(); }
      catch { /* Video is still decodable if timing support did not load. */ }
    }
    function draw(frame, w, h) {
      if (!w || !h || session.signal.aborted) return;
      const picture=inspect ? inspect(frame,w,h) : {height:h,stamp:null};
      dimensions(canvas,w,picture.height);
      let first = !output;
      if (first) {
        output = canvas.captureStream(0);
        manualOutput = !!output.getVideoTracks()[0].requestFrame;
        if (!manualOutput) {
          output.getTracks().forEach(track => track.stop());
          output = canvas.captureStream();
        }
      }
      ctx.drawImage(frame,0,0,w,picture.height,0,0,canvas.width,canvas.height);
      if (manualOutput) output.getVideoTracks()[0].requestFrame();
      if (first) Promise.resolve(session.onStream(output)).catch(session.onError);
      session.onPicture?.(canvas,picture.stamp);
    }
    function presented(now, metadata) {
      if (session.signal.aborted) return;
      if (metadata.mediaTime !== lastPresentation) draw(video,video.videoWidth,video.videoHeight);
      lastPresentation = metadata.mediaTime;
      callback = video.requestVideoFrameCallback(presented);
    }
    async function openDecoder() {
      if (callback !== undefined) video.cancelVideoFrameCallback?.(callback);
      clearInterval(poll);
      video.pause(); video.removeAttribute('src'); video.load();
      if (mediaUrl) URL.revokeObjectURL(mediaUrl);
      const source = new MediaSource();
      mediaUrl = URL.createObjectURL(source);
      await waitFor(source, 'sourceopen', session.signal, () => { video.src = mediaUrl; });
      sourceBuffer = source.addSourceBuffer(session.mimeType);
      // MP4 and WebM encoders may restart their timestamps at zero after rotation.
      previousFrame = lastPresentation = -1;
      video.play().catch(error => { if (!session.signal.aborted && error.name !== 'AbortError') session.onError(error); });
      if (video.requestVideoFrameCallback) callback = video.requestVideoFrameCallback(presented);
      else poll = setInterval(() => {
        const quality = video.getVideoPlaybackQuality?.();
        const frame = quality ? quality.totalVideoFrames - quality.droppedVideoFrames : video.currentTime;
        if (video.readyState >= 2 && frame !== previousFrame) draw(video,video.videoWidth,video.videoHeight);
        previousFrame = frame;
      }, 1000 / 30);
    }
    try {
      if (session.mimeType !== jpeg) await openDecoder();
      let lastPacket = Date.now();
      for (let seq = 0; !session.signal.aborted;) {
        const wire = await request(session,seq);
        if (!wire) {
          if (Date.now() - lastPacket > 30000) throw new Error('The phone stopped sending relay video.');
          await sleep(280); continue;
        }
        const plain = await crypto.subtle.decrypt(encryptionOptions(session,seq,wire.subarray(0,12)),key,wire.subarray(12));
        lastPacket = Date.now(); seq++;
        window.FGSReplayQuality?.packet(wire.length, 'Download');
        if (sourceBuffer) {
          const head = new Uint8Array(plain,0,Math.min(8,plain.byteLength));
          const init = (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3)
            || (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70);
          if (init && initialized) await openDecoder();
          if (init) initialized = true;
          if (++decodes % 10 === 0 && video.currentTime > 15 && sourceBuffer.buffered.length && sourceBuffer.buffered.start(0) < video.currentTime - 10) {
            await waitFor(sourceBuffer,'updateend',session.signal,() => sourceBuffer.remove(0,video.currentTime - 8));
          }
          await waitFor(sourceBuffer,'updateend',session.signal,() => sourceBuffer.appendBuffer(plain));
          // Jump only when streaming backlog has crossed several complete chunks.
          if (sourceBuffer.buffered.length && video.readyState >= 2) {
            const edge = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
            const ahead = edge - video.currentTime;
            if (ahead > 3.5) video.currentTime = Math.max(sourceBuffer.buffered.start(0), edge - 1);
            window.FGSReplayQuality?.queue(ahead);
          }
        } else {
          const img = new Image(), imageUrl = URL.createObjectURL(new Blob([plain],{type:jpeg}));
          try {
            await waitFor(img,'load',session.signal,() => { img.src = imageUrl; });
            draw(img,img.naturalWidth,img.naturalHeight);
          } finally { URL.revokeObjectURL(imageUrl); }
        }
      }
    } finally {
      clearInterval(poll);
      if (callback !== undefined) video.cancelVideoFrameCallback?.(callback);
      output?.getTracks().forEach(track => track.stop());
      video.pause(); video.removeAttribute('src'); video.load();
      if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    }
  }
  window.FGSReplayRelay = {sendFormats, receiveFormats, send, receive};
})();
