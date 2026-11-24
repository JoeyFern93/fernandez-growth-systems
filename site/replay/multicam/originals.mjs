let ready;
function openDatabase() {
  return ready ||= new Promise((resolve,reject)=>{
    const request=indexedDB.open('fgs-studio-angle-originals',1);
    request.onupgradeneeded=()=>{
      const db=request.result;
      db.createObjectStore('recordings',{keyPath:'id'});
      db.createObjectStore('pieces',{keyPath:['id','seq']});
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
async function dbRequest(store,mode,fn) {
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,mode),request=fn(tx.objectStore(store));
    tx.oncomplete=()=>resolve(request.result);tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}
const put=(store,row)=>dbRequest(store,'readwrite',s=>s.put(row));
export const recordings=()=>dbRequest('recordings','readonly',s=>s.getAll());
export async function loadOriginal(meta) {
  const pieces=await dbRequest('pieces','readonly',s=>s.getAll(IDBKeyRange.bound([meta.id,0],[meta.id,Number.MAX_SAFE_INTEGER])));
  if(!pieces.length)throw Error('Original recording contains no saved video.');
  return new Blob(pieces.map(piece=>piece.blob),{type:meta.type});
}
function chooseType() {
  return ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/mp4','video/webm'].find(t=>MediaRecorder.isTypeSupported(t));
}
export async function startOriginal(stream,angle,onError,source='phone') {
  const type=chooseType();
  const rec=new MediaRecorder(stream,{...(type?{mimeType:type}:{}),videoBitsPerSecond:14000000});
  const meta={id:crypto.randomUUID(),date:Date.now(),angle,source,type:rec.mimeType,start:null};
  await put('recordings',meta);
  let seq=0,writes=Promise.resolve(),failure=null;
  function persist(blob) {
    if(!blob.size || failure)return;
    const row={id:meta.id,seq:seq++,blob};
    writes=writes.then(()=>put('pieces',row)).catch(error=>{
      if(failure)return;
      failure=error;if(rec.state==='recording')rec.stop();
      onError('Storage stopped recording. Save the available original.');
    });
  }
  rec.ondataavailable=event=>persist(event.data);
  rec.onerror=()=>onError('The recorder stopped unexpectedly.');
  const stopped=new Promise(resolve=>rec.addEventListener('stop',resolve,{once:true}));
  rec.start(1000);
  const startRequest=performance.now();
  return {
    get start(){return failure?null:meta.start;},
    anchor(capture) {
      if(meta.start!==null || !Number.isFinite(capture) || capture<startRequest)return;
      meta.start=capture;writes=writes.then(()=>put('recordings',meta)).catch(onError);
    },
    async stop(){if(rec.state==='recording')rec.stop();await stopped;await writes;},
    async clip(start,end) {
      if(failure || !Number.isFinite(meta.start) || start<meta.start || end<=start || end-start>21000 || end>performance.now()) {
        throw Error('This interval is outside the original recording.');
      }
      if(rec.state==='recording') {
        const flushed=new Promise(resolve=>rec.addEventListener('dataavailable',resolve,{once:true}));
        rec.requestData();await flushed;
      }
      await writes;
      return trimOriginal(await loadOriginal(meta),(start-meta.start)/1000,(end-meta.start)/1000);
    }
  };
}
async function trimOriginal(blob,start,end) {
  const video=document.createElement('video');
  video.muted=true;video.playsInline=true;video.preload='auto';
  if(!video.captureStream || !video.requestVideoFrameCallback)throw Error('This browser can save the original only. Use Chrome for paired trimming.');
  const url=URL.createObjectURL(blob);
  let recorder,stream,callback,safetyTimer;
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Original could not be opened for trimming.')),7000);
      video.onloadeddata=()=>{clearTimeout(timer);resolve();};
      video.onerror=()=>{clearTimeout(timer);reject(Error('Original is unreadable.'));};
      video.src=url;
    });
    if(start>0)await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('This browser could not seek the original.')),7000);
      video.onseeked=()=>{clearTimeout(timer);resolve();};video.currentTime=start;
    });
    stream=video.captureStream();
    const options={videoBitsPerSecond:14000000},mime=chooseType();
    if(mime)options.mimeType=mime;
    recorder=new MediaRecorder(stream,options);
    const parts=[];
    let lastTime=start;
    const result=new Promise((resolve,reject)=>{
      recorder.ondataavailable=e=>{if(e.data.size)parts.push(e.data);};
      recorder.onstop=()=>lastTime>=end-.1 && parts.length
        ? resolve(new Blob(parts,{type:recorder.mimeType})) : reject(Error('The selected interval was incomplete in the original.'));
      recorder.onerror=()=>reject(Error('Clip export failed.'));
      const finish=()=>{if(recorder.state==='recording')recorder.stop();};
      function frame(_,meta){
        lastTime=meta.mediaTime;
        if(lastTime>=end)finish();else callback=video.requestVideoFrameCallback(frame);
      }
      callback=video.requestVideoFrameCallback(frame);
      video.onended=finish;safetyTimer=setTimeout(finish,(end-start)*1000+7000);
    });
    // captureStream gets its video track when the element starts playing.
    if(!stream.getVideoTracks().length)throw Error('Original playback cannot be recorded in this browser.');
    recorder.start();await video.play();return await result;
  } finally {
    clearTimeout(safetyTimer);if(callback)video.cancelVideoFrameCallback(callback);
    if(recorder?.state==='recording')recorder.stop();
    stream?.getTracks().forEach(track=>track.stop());video.pause();video.removeAttribute('src');video.load();URL.revokeObjectURL(url);
  }
}
