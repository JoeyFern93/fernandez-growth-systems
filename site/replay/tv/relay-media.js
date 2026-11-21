(() => {
  'use strict';
  const jpeg = 'image/jpeg';
  const videoFormats = ['video/webm;codecs=vp8', 'video/mp4;codecs=avc1.42e01e', 'video/mp4', 'video/webm'];
  const maxPlainBytes = 240 * 1024;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function sendFormats() {
    if (!globalThis.crypto?.subtle) return [];
    const supported = videoFormats.filter(mime => globalThis.MediaRecorder?.isTypeSupported(mime));
    if (HTMLCanvasElement.prototype.toBlob) supported.push(jpeg);
    return supported;
  }
  function receiveFormats() {
    if (!globalThis.crypto?.subtle || !HTMLCanvasElement.prototype.captureStream) return [];
    return [...videoFormats.filter(mime => globalThis.MediaSource?.isTypeSupported(mime)), jpeg];
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
    let seq = 0;
    return async blob => {
      for (let pos = 0; pos < blob.size; pos += maxPlainBytes) {
        const plain = await blob.slice(pos, pos + maxPlainBytes).arrayBuffer();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const cipher = await crypto.subtle.encrypt(encryptionOptions(session, seq, iv), key, plain);
        const bytes = new Uint8Array(iv.length + cipher.byteLength);
        bytes.set(iv); bytes.set(new Uint8Array(cipher), iv.length);
        await request(session, seq, bytes);
        seq++;
      }
    };
  }
  function recorderLoop(session, upload) {
    return new Promise((resolve, reject) => {
      const recorder = new MediaRecorder(session.stream, {mimeType:session.mimeType, videoBitsPerSecond:600000});
      let pending = Promise.resolve(), count = 0, finished = false;
      function finish(error) {
        if (finished) return;
        finished = true;
        session.signal.removeEventListener('abort', stop);
        recorder.ondataavailable = recorder.onerror = recorder.onstop = null;
        if (recorder.state !== 'inactive') recorder.stop();
        if (error && !session.signal.aborted) reject(error); else resolve();
      }
      const stop = () => finish();
      recorder.onerror = e => finish(e.error || new Error('The phone stopped producing relay video.'));
      recorder.onstop = () => finish(new Error('Relay recording stopped on the phone.'));
      recorder.ondataavailable = e => {
        if (!e.data.size || finished) return;
        if (++count > 6) { finish(new Error('The connection is too slow for relay video.')); return; }
        pending = pending.then(() => finished ? undefined : upload(e.data))
          .then(() => { count--; }, finish);
      };
      session.signal.addEventListener('abort', stop, {once:true});
      if (session.signal.aborted) { finish(); return; }
      try { recorder.start(850); } catch (error) { finish(error); }
    });
  }
  function decoder() {
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.autoplay = true;
    return video;
  }
  function dimensions(canvas, width, height) {
    const scale = Math.min(1, 960 / Math.max(width, height));
    const w = Math.max(2, Math.round(width * scale)), h = Math.max(2, Math.round(height * scale));
    if (w !== canvas.width || h !== canvas.height) { canvas.width = w; canvas.height = h; }
  }
  async function send(session) {
    const upload = await transmitter(session);
    if (session.mimeType !== jpeg) return recorderLoop(session, upload);
    const video = decoder(), canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    video.srcObject = session.stream;
    try {
      await video.play();
      while (!session.signal.aborted) {
        if (video.videoWidth) {
          dimensions(canvas,video.videoWidth,video.videoHeight);
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
    const key = await importVideoKey(session.key);
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    const video = decoder();
    let mediaUrl, sourceBuffer, output, drawing, decodes = 0;
    function draw(frame, w, h) {
      if (!w || !h || session.signal.aborted) return;
      dimensions(canvas,w,h);
      ctx.drawImage(frame,0,0,canvas.width,canvas.height);
      if (!output) {
        output = canvas.captureStream(15);
        Promise.resolve(session.onStream(output)).catch(session.onError);
      }
    }
    try {
      if (session.mimeType !== jpeg) {
        const source = new MediaSource();
        mediaUrl = URL.createObjectURL(source);
        await waitFor(source, 'sourceopen', session.signal, () => { video.src = mediaUrl; });
        sourceBuffer = source.addSourceBuffer(session.mimeType);
        video.play().catch(error => { if (!session.signal.aborted) session.onError(error); });
        drawing = setInterval(() => { if (video.readyState >= 2) draw(video,video.videoWidth,video.videoHeight); },66);
      }
      let lastPacket = Date.now();
      for (let seq = 0; !session.signal.aborted;) {
        const wire = await request(session,seq);
        if (!wire) {
          if (Date.now() - lastPacket > 30000) throw new Error('The phone stopped sending relay video.');
          await sleep(280); continue;
        }
        const plain = await crypto.subtle.decrypt(encryptionOptions(session,seq,wire.subarray(0,12)),key,wire.subarray(12));
        lastPacket = Date.now(); seq++;
        if (sourceBuffer) {
          if (++decodes % 10 === 0 && video.currentTime > 15 && sourceBuffer.buffered.length && sourceBuffer.buffered.start(0) < video.currentTime - 10) {
            await waitFor(sourceBuffer,'updateend',session.signal,() => sourceBuffer.remove(0,video.currentTime - 8));
          }
          await waitFor(sourceBuffer,'updateend',session.signal,() => sourceBuffer.appendBuffer(plain));
        } else {
          const img = new Image(), imageUrl = URL.createObjectURL(new Blob([plain],{type:jpeg}));
          try {
            await waitFor(img,'load',session.signal,() => { img.src = imageUrl; });
            draw(img,img.naturalWidth,img.naturalHeight);
          } finally { URL.revokeObjectURL(imageUrl); }
        }
      }
    } finally {
      clearInterval(drawing);
      output?.getTracks().forEach(track => track.stop());
      video.pause(); video.removeAttribute('src'); video.load();
      if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    }
  }
  window.FGSReplayRelay = {sendFormats, receiveFormats, send, receive};
})();
