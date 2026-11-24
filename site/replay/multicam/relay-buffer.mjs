import {createLivePreview,playIncomingVideo} from './live-preview.mjs';

// Receipt-timed relay pictures can be much farther apart than direct frames.
// Keep the last received picture until the next one, with a bounded gap.
export function relayFrameAt(frames,time){
  let lo=0,hi=frames.length;
  while(lo<hi){
    const mid=(lo+hi)>>>1;
    if(frames[mid].time<=time)lo=mid+1;else hi=mid;
  }
  const frame=frames[lo-1];
  return frame?.receipt && time-frame.time<=1000 ? frame : null;
}

// Relay packets have no sender capture timestamp. Tag each buffered picture
// with the TV's observation time so it can be scrubbed without claiming sync.
export function receiveRelayVideo(slot,room,stream,mime){
  const signal=room.controller.signal;
  if(signal.aborted || slot.room!==room)return Promise.reject(new DOMException('Camera disconnected.','AbortError'));
  const video=document.createElement('video');
  Object.assign(video,{autoplay:true,muted:true,playsInline:true,srcObject:stream});
  slot.node.querySelector('.picture').append(video);
  room.video=video;
  const preview=createLivePreview(video);
  let firstReceipt;
  room.preview={...preview,liveReason(time){
    return firstReceipt===undefined || time<firstReceipt ? 'Live · building relay delay (TV receipt time)' : null;
  }};
  const canvas=document.createElement('canvas');
  const ctx=canvas.getContext('2d',{alpha:false});
  const label=mime==='image/jpeg'?'Internet relay · low-quality images':'Internet relay';
  const epoch=slot.epoch;
  let closing=false,busy=false,callback,poll,deadline,stopPlayback,lastStored=-Infinity,pictures=0,transportState;
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
      if(room.video===video){room.video=null;room.preview=null;}
      if(error)reject(error);
    }
    const abort=()=>close(new DOMException('Camera disconnected.','AbortError'));
    signal.addEventListener('abort',abort,{once:true});
    function take(){
      if(closing)return;
      if(slot.room!==room || slot.epoch!==epoch){abort();return;}
      const live=preview.state(),at=preview.lastFrameAt();
      if(live==='stalled'){status('stalled');return;}
      if(live!=='live' || busy || at-lastStored<28)return;
      const w=video.videoWidth,h=video.videoHeight,scale=Math.min(1,960/Math.max(w,h));
      const width=Math.max(1,Math.round(w*scale)),height=Math.max(1,Math.round(h*scale));
      if(canvas.width!==width || canvas.height!==height){canvas.width=width;canvas.height=height;}
      busy=true;lastStored=at;
      try{
        ctx.drawImage(video,0,0,width,height);
        canvas.toBlob(blob=>{
          busy=false;
          if(!blob || closing || slot.room!==room || slot.epoch!==epoch)return;
          slot.buffer.add({time:at,size:blob.size,blob,epoch,receipt:true});
          firstReceipt??=at;
          room.replayStatus=label+' · '+w+'×'+h+' · TV receipt time';
          if(++pictures>=2){clearTimeout(deadline);status('receiving');resolve();}
        },'image/jpeg',.82);
      }catch(error){close(error);}
    }
    function presented(_,info){
      if(closing)return;
      preview.frame(info);
      callback=video.requestVideoFrameCallback(presented);
      take();
    }
    callback=video.requestVideoFrameCallback?.(presented);
    // Some displays suspend presentation callbacks. Poll independently
    // advancing decoder counts or changed pixels without inventing frames.
    poll=setInterval(take,130);
    function armDeadline(){
      if(closing || pictures>=2)return;
      clearTimeout(deadline);
      deadline=setTimeout(()=>{
        if(room.playBlocked)video.addEventListener('playing',armDeadline,{once:true});
        else close(new Error('The display did not receive playable relay frames.'));
      },18000);
    }
    armDeadline();stopPlayback=playIncomingVideo(slot,room,close);
  });
}
