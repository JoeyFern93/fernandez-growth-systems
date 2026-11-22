(() => {
  'use strict';
  const panel = document.getElementById('quality-panel');
  if (!panel) return;
  const field = id => document.getElementById('quality-' + id);
  const phone = !!document.getElementById('phone-preview');
  let source, cameraVideo, peer, transport = 'Disconnected', previousStats, channel;
  let opticalStop = [], clock, generation = 0, recorder, originalUrl, recordTimer;
  let packets = [], queue = null, relayProfile = null, recordTrack, bufferProbe;
  const lastSample = new Map(), observations=[];
  const openedAt=performance.now();
  let numericRtp=null, senderTrack=null, senderVideo=null;

  function set(id, text) {const node = field(id); if (node) node.textContent = text;}
  function size(w, h) {return w && h ? w + ' × ' + h : 'Size unavailable';}
  function formatRate(n) {return Number.isFinite(n) ? n.toFixed(1) : '—';}
  function imageChanges() {
    let previous;
    return pixels => {
      let changes = 0;
      if (previous) {
        for (let i=0;i<pixels.length;i+=4) {
          const delta = Math.abs(pixels[i]-previous[i]) + Math.abs(pixels[i+1]-previous[i+1]) + Math.abs(pixels[i+2]-previous[i+2]);
          if (delta >= 22) changes++;
        }
        if (changes < 5) return false;
      }
      previous = pixels;
      return true;
    };
  }
  function optical(name) {
    const canvas = document.createElement('canvas');
    canvas.width = 40; canvas.height = 24;
    const ctx = canvas.getContext('2d', {alpha:false,willReadFrequently:true});
    const changedPicture = imageChanges();
    let points = [], gap = 0, lastStamp;
    return function sample(image, w, h, stamp, skipped = 0) {
      if (!panel.open || !w || !h || !ctx || stamp === lastStamp) return;
      lastStamp = stamp;
      try {
        ctx.drawImage(image,0,0,40,24);
        const changed = changedPicture(ctx.getImageData(0,0,40,24).data);
        const now = performance.now();
        lastSample.set(name, now);
        points.push({at:now,changed,skipped});
        while (points.length > 1 && points[0].at < now-4000) points.shift();
        if (now-gap<480 || points.length<2) return;
        gap=now;
        const sec=(now-points[0].at)/1000;
        const motion=points.slice(1).reduce((sum,p)=>sum+Number(p.changed),0);
        const missed=points.slice(1).reduce((sum,p)=>sum+p.skipped,0);
        set(name, size(w,h) + ' · ' + formatRate(motion/sec) + ' changed/s · ' + formatRate((points.length-1)/sec) + ' sampled/s'
          + (missed ? ' · '+missed+' skipped between callbacks' : ''));
      } catch { set(name,'Frame pixels unavailable'); }
    };
  }
  function watchVideo(video,name) {
    if (!video) return;
    const sample=optical(name);
    let callback, lastCount=0, timer;
    if(video.requestVideoFrameCallback) {
      const draw=(now,meta)=>{
        if(!panel.open) return;
        if(video.readyState>=2)sample(video,video.videoWidth,video.videoHeight,meta.mediaTime,lastCount?Math.max(0,meta.presentedFrames-lastCount-1):0);
        lastCount=meta.presentedFrames;
        callback=video.requestVideoFrameCallback(draw);
      };
      callback=video.requestVideoFrameCallback(draw);
    } else {
      timer=setInterval(()=>{
        if(!video.paused && video.readyState>=2) sample(video,video.videoWidth,video.videoHeight,video.currentTime);
      },1000/60);
    }
    opticalStop.push(()=>{if(callback!==undefined)video.cancelVideoFrameCallback?.(callback);clearInterval(timer);});
  }
  function watchTrack(track, name, fallback) {
    if(!track || !window.MediaStreamTrackProcessor) return false;
    let reader;
    try { reader=new MediaStreamTrackProcessor({track,maxBufferSize:2}).readable.getReader(); }
    catch { return false; }
    const sample=optical(name), token=generation;
    opticalStop.push(()=>reader.cancel().catch(()=>{}));
    (async()=>{
      try{
        while(panel.open && generation===token){
          const {value:frame,done}=await reader.read();
          if(done)break;
          try { sample(frame,frame.displayWidth,frame.displayHeight,frame.timestamp); } finally { frame.close(); }
        }
      }catch{if(generation===token && panel.open)watchVideo(fallback,name);}
      finally{reader.releaseLock();}
    })();
    return true;
  }
  function stopWatching() {
    generation++;
    opticalStop.splice(0).forEach(fn=>fn());
    clearInterval(clock); clock=undefined; previousStats=null; bufferProbe=null;
  }
  function beginWatching() {
    stopWatching();
    if(!panel.open)return;
    lastSample.clear();
    for(const name of ['capture','preview','replay'])set(name,'Waiting for changing video');
    if(phone){
      const native=source?.getVideoTracks()[0];
      if(!watchTrack(native,'capture',cameraVideo))watchVideo(cameraVideo,'capture');
      if(senderTrack && senderTrack!==native && !watchTrack(senderTrack,'preview',senderVideo))watchVideo(senderVideo,'preview');
    } else {
      watchVideo(document.getElementById('liveVideo'),'capture');
      watchVideo(document.getElementById('delayedVideo'),'replay');
      bufferProbe=optical('replay');
    }
    clock=setInterval(refresh,1000);
    refresh();
  }
  async function refresh() {
    for(const [name,last] of lastSample) {
      const elapsed=(performance.now()-last)/1000;
      if(elapsed>2)set(name,'No fresh sample for '+Math.floor(elapsed)+' s');
    }
    if(phone && peer && transport==='Direct WebRTC'){
      const track=peer.getSenders().find(item=>item.track?.kind==='video')?.track || null;
      if(track!==senderTrack){outgoing(track,document.getElementById('phone-preview'));return;}
    }
    if(phone && senderTrack && senderTrack===source?.getVideoTracks()[0])set('preview',field('capture').textContent);
    const token=generation;
    let summary = 'Waiting for packets';
    if (peer && transport==='Direct WebRTC') {
      try {
        const reports=await peer.getStats();
        if(token!==generation || !panel.open || transport!=='Direct WebRTC')return;
        const kind=phone?'outbound-rtp':'inbound-rtp';
        const stat=[...reports.values()].find(report=>report.type===kind && (report.kind||report.mediaType)==='video');
        if(stat){
          set('codec',reports.get(stat.codecId)?.mimeType || 'Video codec unavailable');
          const frames = phone ? stat.framesEncoded : stat.framesDecoded;
          const dropped = phone ? undefined : stat.framesDropped;
          const bytes = phone ? stat.bytesSent : stat.bytesReceived;
          const dt=previousStats ? (stat.timestamp-previousStats.time)/1000 : 0;
          const info=[size(stat.frameWidth,stat.frameHeight)];
          if(dt>0 && stat.id===previousStats.id) {
            if(Number.isFinite(frames) && Number.isFinite(previousStats.frames))info.push(formatRate((frames-previousStats.frames)/dt)+(phone?' encoded/s':' decoded/s'));
            if(Number.isFinite(bytes) && Number.isFinite(previousStats.bytes))info.push(Math.round((bytes-previousStats.bytes)*8/dt/1000)+' kb/s');
          }
          if(Number.isFinite(dropped))info.push(dropped+' decoder drops');
          if(Number.isFinite(stat.packetsLost))info.push(stat.packetsLost+' lost packets');
          if(stat.qualityLimitationReason && stat.qualityLimitationReason!=='none')info.push('Limited by '+stat.qualityLimitationReason);
          numericRtp={direction:kind,codec:reports.get(stat.codecId)?.mimeType||null,
            width:stat.frameWidth??null,height:stat.frameHeight??null,framesEncoded:stat.framesEncoded??null,
            framesSent:stat.framesSent??null,framesReceived:stat.framesReceived??null,framesDecoded:stat.framesDecoded??null,
            framesDropped:stat.framesDropped??null,packetsLost:stat.packetsLost??null,
            bytes:bytes??null,limitation:stat.qualityLimitationReason||null,
            meanJitterBufferMs:stat.jitterBufferEmittedCount>0?Math.round(1000*stat.jitterBufferDelay/stat.jitterBufferEmittedCount):null};
          previousStats={id:stat.id,time:stat.timestamp,frames,bytes};
          summary=info.join(' · ');
        } else summary='Waiting for RTP video statistics';
      } catch {summary='Transport statistics unavailable';}
    } else if(channel){
      const now=performance.now();
      packets=packets.filter(p=>now-p.at<=5000);
      const rate=packets.length>=2 && packets.at(-1).at>packets[0].at
        ? Math.round(packets.slice(1).reduce((n,p)=>n+p.bytes,0)*8/(packets.at(-1).at-packets[0].at)) : null;
      summary=channel + (phone && relayProfile && !transport.startsWith('JPEG') ? ' · target '+relayProfile.edge+'px / '+relayProfile.fps+' fps' : '') + (rate!==null?' · '+rate+' kb/s':'')
        +(queue!==null?' · '+queue.toFixed(2)+' s queued at decoder':'');
    }
    set('channel',summary);
    if(phone){
      const native=source?.getVideoTracks()[0]?.getSettings()||{};
      const requested=[document.getElementById('phone-resolution')?.value,document.getElementById('phone-fps')?.value];
      set('requested',requested[0]==='auto'?'Auto resolution':requested[0]+'p');
      field('requested').textContent+=' / '+(requested[1]==='auto'?'auto rate':requested[1]+' fps')+' requested · '+size(native.width,native.height)
        +(native.frameRate?' / '+formatRate(native.frameRate)+' fps reported':'');
    }
    const get = name => field(name)?.textContent || null;
    const native=phone?source?.getVideoTracks()[0]?.getSettings():null;
    observations.push({elapsedMs:Math.round(performance.now()-openedAt),transport,codec:get('codec'),
      requested:get('requested'),input:get('capture'),encoderInput:get('preview'),replay:get('replay'),
      connection:summary,rtc:transport==='Direct WebRTC'?numericRtp:null,
      captureSettings:native?{width:native.width??null,height:native.height??null,frameRate:native.frameRate??null}:null,
      relayDecoderQueueSeconds:queue,sourceToTVLatencyMs:null,exportProbe:get('export')});
    if(observations.length>1800)observations.shift();
  }
  function outgoing(track,video) {
    senderTrack=track;senderVideo=video;
    if(panel.open)beginWatching();
  }
  function capture(video,stream) {
    const track=stream?.getVideoTracks()[0];
    if(recorder?.state==='recording' && recordTrack!==track)recorder.stop();
    cameraVideo=video;source=stream;
    const button=field('record');
    if(button)button.disabled=!track || !window.MediaRecorder || (recorder && recorder.state==='inactive');
    if(panel.open)beginWatching();
  }
  function recordOriginal() {
    if(recorder?.state==='inactive')return;
    const track=source?.getVideoTracks()[0];
    if(recorder?.state==='recording'){recorder.stop();return;}
    if(!track || !window.MediaRecorder)return;
    const options=['video/webm;codecs=vp8','video/mp4','video/webm'].find(type=>MediaRecorder.isTypeSupported(type));
    const cfg=track.getSettings(), bitrate=Math.round(Math.min(48000000,Math.max(8000000,(cfg.width||1280)*(cfg.height||720)*(cfg.frameRate||30)*.20)));
    const chunks=[];let bytes=0,started=performance.now();
    try {
      const instance=new MediaRecorder(new MediaStream([track]),{...(options?{mimeType:options}:{}),videoBitsPerSecond:bitrate});
      recorder=instance;recordTrack=track;
      instance.ondataavailable=({data})=>{
        if(!data?.size)return;
        chunks.push(data);bytes+=data.size;
        if(bytes>=240*1024*1024 && instance.state==='recording')instance.stop();
      };
      instance.onerror=e=>set('original',e.error?.message || 'Recording interrupted');
      instance.onstop=()=>{
        clearTimeout(recordTimer);
        const download=field('download');
        if(chunks.length){
          if(originalUrl)URL.revokeObjectURL(originalUrl);
          const type=instance.mimeType||chunks[0].type;
          originalUrl=URL.createObjectURL(new Blob(chunks,{type}));
          download.href=originalUrl;
          download.download='FGS-studio-phone-original-'+new Date().toISOString().replace(/[:.]/g,'-')+(type.includes('mp4')?'.mp4':'.webm');
          download.hidden=false;
          set('original',size(cfg.width,cfg.height)+' source · '+((performance.now()-started)/1000).toFixed(1)+' s elapsed · '+(bytes/1048576).toFixed(1)+' MiB');
        }else set('original','No frames were saved');
        recorder=recordTrack=null;
        field('record').textContent='Record original';field('record').disabled=!source?.active;
      };
      instance.start(1000);
      field('record').textContent='Finish original';set('original','Recording the phone camera track');
      recordTimer=setTimeout(()=>{if(instance.state==='recording')instance.stop();},120000);
    }catch(error){recorder=recordTrack=null;set('original','Recording unavailable · '+error.message);}
  }
  let cancelExport;
  function inspectExport() {
    const file = document.getElementById(phone ? 'quality-download' : 'downloadLink');
    if(!file?.href?.startsWith('blob:')) {set('export','Save a clip here first');return;}
    const video=document.createElement('video'), canvas=document.createElement('canvas');
    if(!video.requestVideoFrameCallback){set('export','This browser cannot inspect individual playback frames');return;}
    cancelExport?.();
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    canvas.width=40;canvas.height=24;
    const changedPicture=imageChanges();
    const button=field('inspect');
    let first=null,last=null,changed=0,frames=0,callback,timer;
    function stop(){
      clearTimeout(timer);
      if(callback!==undefined)video.cancelVideoFrameCallback(callback);
      video.onended=video.onerror=null;
      video.pause();video.removeAttribute('src');video.load();video.remove();
      button.disabled=false;cancelExport=null;
    }
    function finish(){
      if(last!==null && last>first) {
        set('export',size(video.videoWidth,video.videoHeight)+' · '+formatRate(changed/(last-first))+' changed/s · '
          +formatRate((frames-1)/(last-first))+' sampled/s over '+(last-first).toFixed(2)+' s of file time');
      }else set('export','Could not read enough frames from this file');
      stop();
    }
    function sample(now,meta) {
      if(last!==meta.mediaTime){
        ctx.drawImage(video,0,0,40,24);
        const moving=changedPicture(ctx.getImageData(0,0,40,24).data);
        if(first!==null && moving)changed++;
        first??=meta.mediaTime; last=meta.mediaTime; frames++;
      }
      if(last-first>=3)finish();
      else callback=video.requestVideoFrameCallback(sample);
    }
    cancelExport=stop;
    video.muted=true;video.playsInline=true;video.defaultPlaybackRate=.25;
    video.className='quality-file-probe';video.setAttribute('aria-hidden','true');button.after(video);
    button.disabled=true;set('export','Reading the first three seconds at quarter speed…');
    video.onended=finish;video.onerror=finish;video.src=file.href;video.playbackRate=.25;
    callback=video.requestVideoFrameCallback(sample);
    timer=setTimeout(finish,18000);
    video.play().catch(()=>{if(cancelExport===stop)finish();});
  }
  field('inspect')?.addEventListener('click',inspectExport);
  panel.addEventListener('toggle',()=>{if(!panel.open)cancelExport?.();});
  field('readings')?.addEventListener('click',()=>{
    const record={version:1,deviceRole:phone?'phone':'display',
      notes:'Changed/s compares sampled picture content. A still scene can read zero. Decoder queue is buffered media ahead. Source-to-TV latency requires a filmed timer or synchronized capture clocks.',
      readings:observations.slice()};
    const url=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;
    link.download='FGS-replay-studio-'+record.deviceRole+'-readings.json';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),15000);
  });
  field('record')?.addEventListener('click',recordOriginal);
  panel.addEventListener('toggle',beginWatching);
  window.addEventListener('pagehide',()=>{cancelExport?.();stopWatching();if(recorder?.state==='recording')recorder.stop();if(originalUrl)URL.revokeObjectURL(originalUrl);});
  window.FGSReplayQuality={
    capture,outgoing,
    peer(value){peer=value;previousStats=null;},
    transport(label){
      if(label!==transport){packets=[];channel=null;queue=null;previousStats=numericRtp=null;if(label==='Disconnected'||label==='Direct WebRTC')set('codec','—');}
      if(label==='Disconnected'){peer=null;senderTrack=senderVideo=null;}
      transport=label;set('transport',label);
    },
    packet(bytes,direction){channel=direction;if(panel.open){packets.push({bytes,at:performance.now()});if(packets.length>100)packets.shift();}},
    queue(seconds){queue=seconds;},
    profile(profile){relayProfile=profile;},
    codec(mime){set('codec',mime==='image/jpeg'?'JPEG · low quality':mime);},
    bufferFrame(frame,stamp){bufferProbe?.(frame,frame.width,frame.height,stamp);}
  };
})();
