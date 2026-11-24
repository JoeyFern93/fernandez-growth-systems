import '../js/frame-export-v1.js';

// These timestamps are local to the TV's received pictures. Do not use them
// for matching a play to another angle or trimming a phone's original.
const maxBytes = 32 * 1024 * 1024;
function showPicture(canvas, bitmap) {
  const ctx = canvas.getContext('2d', {alpha:false});
  const scale = Math.min(1, canvas.width / bitmap.width, canvas.height / bitmap.height);
  const w = bitmap.width * scale, h = bitmap.height * scale;
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, (canvas.width-w)/2, (canvas.height-h)/2, w, h);
}

function until(target, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(done, Math.max(0, target - performance.now()));
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', cancel, {once:true});
  });
}

// Use the same frame-timed encoder as the single-camera clip editor. The
// last entry is the observed end boundary, not a fabricated frame interval.
export async function exportRelayClip(frames, signal) {
  if (frames.length < 3) throw Error('Select at least two received pictures.');
  const start = frames[0].time, end = frames.at(-1).time;
  const duration = (end-start)/1000;
  if (!Number.isFinite(duration) || duration < .25 || duration > 20.001)
    throw Error('Choose between 0.25 and 20 seconds of received footage.');
  for (let i=0; i<frames.length; i++) {
    const f = frames[i];
    if (!f.receipt || f.epoch !== frames[0].epoch || !Number.isFinite(f.time) || !(f.blob instanceof Blob))
      throw Error('Choose footage from a single relay connection.');
    if (i && (f.time <= frames[i-1].time || f.time-frames[i-1].time > 1500))
      throw Error('This range includes a break in received video. Shorten the selection.');
  }
  signal.throwIfAborted();
  const first = await createImageBitmap(frames[0].blob);
  const canvas = document.createElement('canvas');
  canvas.width = first.width; canvas.height = first.height;
  first.close();
  const rate = Math.max(1,Math.min(120,(frames.length-1)/duration));
  const bitrate = Math.max(250000,Math.min(8000000,Math.round(canvas.width*canvas.height*rate*.18)));
  const encoder = await window.ReplayFrameExport.create({width:canvas.width,height:canvas.height,rate,bitrate,duration,maxBytes});
  let recorder, stream, complete, stopped, timer, tooLarge = false;
  try {
    signal.throwIfAborted();
    if (!encoder) {
      if (!canvas.captureStream || typeof MediaRecorder !== 'function') throw Error('This browser cannot export TV clips.');
      stream = canvas.captureStream(0);
      if (!stream.getVideoTracks()[0]?.requestFrame) {
        stream.getTracks().forEach(track => track.stop());
        stream = canvas.captureStream();
      }
      const mimeType = ['video/webm;codecs=vp8','video/webm','video/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(stream, {videoBitsPerSecond:bitrate,...(mimeType && {mimeType})});
      const parts = [];
      let bytes = 0;
      complete = new Promise(resolve => { stopped = resolve; });
      recorder.ondataavailable = e => {
        bytes += e.data.size;
        if (bytes > maxBytes) tooLarge = true;
        if (!tooLarge && e.data.size) parts.push(e.data);
      };
      recorder.onerror = () => stopped(null);
      recorder.onstop = () => stopped(tooLarge || !parts.length ? null : new Blob(parts,{type:recorder.mimeType}));
    }
    let wallStart;
    for (let i=0; i<frames.length-1; i++) {
      signal.throwIfAborted();
      const bitmap = await createImageBitmap(frames[i].blob);
      try {
        const ms = frames[i].time-start;
        signal.throwIfAborted();
        if (recorder && i) {
          await until(wallStart+ms, signal);
          if (performance.now() - wallStart - ms > 400 || tooLarge)
            throw Error('This browser could not keep up with the clip. Try a shorter range.');
        }
        showPicture(canvas, bitmap);
        if (encoder) {
          await encoder.write(canvas, ms/1000, (frames[i+1].time-frames[i].time)/1000);
        } else {
          if (!i) {recorder.start(250); wallStart = performance.now();}
          stream.getVideoTracks()[0].requestFrame?.();
        }
      } finally {bitmap.close();}
    }
    if (encoder) return await encoder.finish();
    await until(wallStart+duration*1000,signal);
    recorder.stop();
    timer = setTimeout(() => stopped(null),5000);
    const result = await complete;
    if (!result) throw Error('The TV clip could not be completed. Try a shorter range.');
    return result;
  } finally {
    clearTimeout(timer);
    encoder?.close();
    if (recorder?.state === 'recording') recorder.stop();
    stream?.getTracks().forEach(track => track.stop());
    canvas.width = canvas.height = 1;
  }
}

export function bindRelayClips(slot) {
  const editor = document.createElement('details');
  editor.hidden = true;
  editor.className = 'relay-clip-editor';
  editor.innerHTML = '<summary>Save TV relay clip</summary><div class="tools">' +
    '<label>Start <input type="range" step="1"></label><label>End <input type="range" step="1"></label>' +
    '<button type="button">Preview clip</button><a hidden>Download TV clip</a></div>' +
    '<output role="status"></output><img alt="Selected relay frame" hidden><video controls playsinline muted hidden></video>';
  slot.node.append(editor);
  const [from,to] = editor.querySelectorAll('input');
  const status = editor.querySelector('output'), prepare = editor.querySelector('button');
  const img = editor.querySelector('img'), video = editor.querySelector('video'), save = editor.querySelector('a');
  let snapshot = [], epoch = slot.epoch, frameUrl, clipUrl, activeJob;
  from.disabled=to.disabled=prepare.disabled=true;
  for (const input of [from,to]) input.setAttribute('aria-label', slot.label+' relay clip '+input.parentElement.textContent.trim().toLowerCase());
  for (const media of [img,video]) {media.style.maxWidth='100%';media.style.maxHeight='30vh';}
  function clearClip() {
    activeJob?.abort(); activeJob = null;
    save.hidden = true; save.removeAttribute('href');
    if (clipUrl) {
      video.pause(); video.removeAttribute('src'); video.load();
      URL.revokeObjectURL(clipUrl); clipUrl = null;
    }
    video.hidden = true;
  }
  function clearFrame() {
    img.hidden = true; img.removeAttribute('src');
    if (frameUrl) URL.revokeObjectURL(frameUrl);
    frameUrl = null;
  }
  function reset() {clearClip(); clearFrame(); snapshot=[];from.disabled=to.disabled=prepare.disabled=true;}
  function selection(endpoint=from) {
    clearClip(); clearFrame();
    const a = Number(from.value), b = Number(to.value);
    if (!snapshot.length) return;
    frameUrl = URL.createObjectURL(snapshot[Number(endpoint.value)].blob);
    img.src = frameUrl; img.hidden = false;
    const seconds = (snapshot[b+1].time-snapshot[a].time)/1000;
    prepare.disabled = seconds < .25 || b <= a;
    status.textContent = prepare.disabled ? 'Select at least 0.25 seconds with two pictures.' :
      ((snapshot[a].time-snapshot[0].time)/1000).toFixed(2)+'–'+
      ((snapshot[b+1].time-snapshot[0].time)/1000).toFixed(2)+' s · '+seconds.toFixed(2)+' s of TV footage';
  }
  function capture() {
    // Keep these Blob references while the user trims. The live rolling buffer
    // can continue recording and evicting old frames independently.
    const frames = slot.buffer.frames.filter(f=>f.epoch===epoch && f.receipt);
    if (frames.length < 3 || frames.at(-1).time-frames[0].time < 250) {
      from.disabled = to.disabled = prepare.disabled = true;
      status.textContent = 'Waiting for received video to save.';
      return;
    }
    snapshot = frames;
    const last = frames.length-2;
    from.disabled = to.disabled = false;
    for (const input of [from,to]) {input.min=0;input.max=last;}
    from.value = frames.findIndex(f=>f.time >= frames.at(-1).time-5000);
    to.value = last;
    selection();
  }
  editor.addEventListener('toggle',()=>{
    if (!editor.open || editor.hidden) reset();
    else if (!snapshot.length) capture();
  });
  from.oninput = () => {if (+from.value > +to.value) to.value=from.value;selection(from);};
  to.oninput = () => {if (+to.value < +from.value) from.value=to.value;selection(to);};
  prepare.onclick = async () => {
    if (activeJob || prepare.disabled) return;
    const job = new AbortController();
    activeJob = job; prepare.disabled = true;
    status.textContent = 'Preparing the selected TV footage.';
    try {
      const frames = snapshot.slice(+from.value,+to.value+2);
      const file = await exportRelayClip(frames,job.signal);
      if (job.signal.aborted) return;
      clipUrl = URL.createObjectURL(file);
      img.hidden = true; video.hidden = false; video.src = clipUrl;
      save.href=clipUrl;save.download='FGS-'+slot.label.replaceAll(' ','-')+'-TV-relay-'+Date.now()+(file.type.includes('mp4')?'.mp4':'.webm');
      save.hidden=false;status.textContent='Ready · '+((frames.at(-1).time-frames[0].time)/1000).toFixed(2)+' s of TV footage';
      await video.play().catch(()=>{});
    } catch (error) {
      if (!job.signal.aborted) {status.textContent=error.message;prepare.disabled=false;}
    } finally {if (activeJob===job) activeJob=null;}
  };
  return {
    update(enabled) {
      const latest=slot.buffer.frames.at(-1);
      const current=(!slot.room && latest?.receipt) ? latest.epoch : slot.epoch;
      if (epoch!==current || (!enabled && !editor.hidden)) {
        reset(); editor.open=false; epoch=current;
      }
      editor.hidden = !enabled;
      if (enabled && editor.open && !snapshot.length) capture();
    }
  };
}
