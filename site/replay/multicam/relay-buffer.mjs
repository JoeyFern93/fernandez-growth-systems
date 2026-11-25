import {createLivePreview,playIncomingVideo} from './live-preview.mjs';

// Hold a low-rate picture until its successor. For capture-timed footage the
// display can select the webcam frame at this exact picture's mapped time.
export function relayFrameAt(frames,time){
  let lo=0,hi=frames.length;
  while(lo<hi){
    const mid=(lo+hi)>>>1;
    if(frames[mid].time<=time)lo=mid+1;else hi=mid;
  }
  const frame=frames[lo-1];
  return frame?.receipt && time-frame.time<=1000 ? frame : null;
}

// A relay stamp belongs to the pixels the decoder delivers in this callback.
// The outgoing captureStream's subsequent presentation event can describe a
// different picture, so it is used for playback health only.
export function createRelayTimeline(buffer,epoch){
  let captureTimed,segment=0,lastGoodReceipt=-Infinity,lastStored=-Infinity;
  return function store(blob,stamp,arrival){
    const good=Number.isFinite(stamp?.time) && stamp.time>0 &&
      Number.isFinite(stamp.uncertainty) && stamp.uncertainty>=0 && stamp.uncertainty<=180 &&
      stamp.time<=arrival && arrival-stamp.time<=buffer.duration;
    if(!good && captureTimed && arrival-lastGoodReceipt<1200)return null;
    const time=good?stamp.time:arrival;
    if(captureTimed===good && time-lastStored<28)return null;

    if(captureTimed!==good){
      // Switching from receipt time to capture time moves the timeline back
      // by the transit delay. Discard only pictures overlapping the new span.
      while(buffer.frames.length && buffer.frames.at(-1).time>=time){
        buffer.bytes-=buffer.frames.pop().size;
      }
      captureTimed=good;segment++;
    }
    const frame={time,size:blob.size,blob,epoch,receipt:true,captureTimed:good,estimated:good && stamp.estimated===true,
      uncertainty:good?stamp.uncertainty:undefined,arrival,timingSegment:segment};
    buffer.add(frame);
    if(buffer.frames.at(-1)!==frame)return null;
    if(good)lastGoodReceipt=arrival;
    lastStored=time;
    return frame;
  };
}

export function receiveRelayVideo(slot,room,stream,mime){
  const signal=room.controller.signal;
  if(signal.aborted || slot.room!==room)return Promise.reject(new DOMException('Camera disconnected.','AbortError'));
  const video=document.createElement('video');
  Object.assign(video,{autoplay:true,muted:true,playsInline:true,srcObject:stream});
  slot.node.querySelector('.picture').append(video);
  room.video=video;
  const preview=createLivePreview(video);
  let firstPicture;
  room.preview={...preview,liveReason(time){
    return firstPicture===undefined || time<firstPicture ? 'Live · building relay replay' : null;
  }};
  const canvas=document.createElement('canvas');
  const ctx=canvas.getContext('2d',{alpha:false});
  const label=mime==='image/jpeg'?'Internet relay · low-quality images':'Internet relay';
  const epoch=slot.epoch,store=createRelayTimeline(slot.buffer,epoch);
  let closing=false,busy=false,callback,poll,deadline,stopPlayback,lastReceipt=-Infinity;
  let pictures=0,transportState,decoderPictures=false;
  return new Promise((resolve,reject)=>{
    function status(value){
      if(value!==transportState){transportState=value;room.updateRelayVideoState?.(value);}
    }
    function close(error){
      if(closing)return;
      closing=true;
      clearTimeout(deadline);clearInterval(poll);
      if(callback!==undefined)video.cancelVideoFrameCallback?.(callback);
      signal.removeEventListener('abort',abort);
      video.removeEventListener('playing',armDeadline);stopPlayback?.();
      video.pause();video.srcObject=null;video.remove();
      if(room.video===video){room.video=null;room.preview=null;room.onRelayPicture=null;}
      if(error)reject(error);
    }
    const abort=()=>close(new DOMException('Camera disconnected.','AbortError'));
    signal.addEventListener('abort',abort,{once:true});

    function snapshot(source,stamp,arrival){
      if(closing || busy)return;
      if(slot.room!==room || slot.epoch!==epoch){abort();return;}
      const w=source.videoWidth || source.width,h=source.videoHeight || source.height;
      if(!w || !h)return;
      const scale=Math.min(1,960/Math.max(w,h));
      const width=Math.max(1,Math.round(w*scale)),height=Math.max(1,Math.round(h*scale));
      if(canvas.width!==width || canvas.height!==height){canvas.width=width;canvas.height=height;}
      busy=true;
      try{
        ctx.drawImage(source,0,0,width,height);
        canvas.toBlob(blob=>{
          busy=false;
          if(!blob || closing || slot.room!==room || slot.epoch!==epoch)return;
          const frame=store(blob,stamp,arrival);
          if(!frame)return;
          firstPicture=firstPicture===undefined?frame.time:Math.min(firstPicture,frame.time);
          room.captureTimed=frame.captureTimed;
          const timing=frame.captureTimed
            ? (frame.estimated?'estimated capture time':'capture time')+' (±'+Math.ceil(frame.uncertainty)+' ms)'
            : 'TV receipt time';
          room.replayStatus=label+' · '+w+'×'+h+' · '+timing;
          pictures++;
        },'image/jpeg',.82);
      }catch(error){close(error);}
    }
    room.onRelayPicture=(source,stamp)=>{
      decoderPictures=true;
      snapshot(source,stamp,performance.now());
    };
    function monitor(){
      if(closing)return;
      if(slot.room!==room || slot.epoch!==epoch){abort();return;}
      const live=preview.state(),at=preview.lastFrameAt();
      if(live==='stalled'){status('stalled');return;}
      if(live!=='live')return;
      if(pictures>=2){clearTimeout(deadline);status('receiving');resolve();}
      // Older decoder builds don't expose onPicture. Keep those streams
      // usable and explicitly label their footage with display receipt time.
      if(!decoderPictures && at-lastReceipt>=28 && !busy){
        lastReceipt=at;snapshot(video,null,at);
      }
    }
    function presented(_,info){
      if(closing)return;
      preview.frame(info);
      callback=video.requestVideoFrameCallback(presented);
      monitor();
    }
    callback=video.requestVideoFrameCallback?.(presented);
    poll=setInterval(monitor,130);
    function armDeadline(){
      if(closing || transportState==='receiving')return;
      clearTimeout(deadline);
      deadline=setTimeout(()=>{
        if(room.playBlocked)video.addEventListener('playing',armDeadline,{once:true});
        else close(new Error('The display did not receive playable relay frames.'));
      },18000);
    }
    armDeadline();stopPlayback=playIncomingVideo(slot,room,close);
  });
}
