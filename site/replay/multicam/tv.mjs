import {renderMock} from './demo-court.mjs';
import {ClockMap,AngleBuffer} from './clock.mjs';
import {call,token,negotiate,createPeer,directConnectionMessage} from './signaling.mjs';
import {bindWebcams,offerClip,clearClipDownloads} from './webcams.mjs';
import {createLivePreview,playIncomingVideo} from './live-preview.mjs';
import {cameras} from './cameras.mjs';
import {canTrimOriginal} from './originals.mjs';
import {startRelayAngle} from './relay-angle.mjs';
import {receiveRelayVideo,relayFrameAt} from './relay-buffer.mjs';
import {bindRelayClips} from './relay-clips.mjs';
const by=id=>document.getElementById(id);
const trimHere=canTrimOriginal();
const webcamPhoneSetup=new URLSearchParams(location.search).get('setup')==='webcam-phone';
const setupHint=webcamPhoneSetup
  ? 'Select your USB webcam in one view and invite your phone in the other.'
  : by('mode').textContent;
by('mode').textContent=setupHint;
function setText(node,text){if(node.textContent!==text)node.textContent=text;}
const slots=cameras.map(({id:cameraId,angle:name,label})=>{
  const node=by(name);
  const relayButton=document.createElement('button');
  relayButton.type='button';relayButton.id='camera-'+cameraId+'-relay';relayButton.textContent='Use internet relay';
  relayButton.setAttribute('aria-label','Use internet relay for '+label);
  node.querySelector('.invite').after(relayButton);
  return {name,cameraId,label,node,canvas:node.querySelector('canvas'),missing:node.querySelector('.missing'),status:node.querySelector('.status'),
    capability:node.querySelector('.clip-capability'),relayButton,buffer:new AngleBuffer(),room:null,rendered:null,frameJob:0,epoch:0};
});
const relayClipControls=slots.map(slot=>bindRelayClips(slot));
let demo=false,origin=0,mode='delay',cursor=0,markIn=null,markOut=null,clipId=null;
let exportJobs=[],exportOriginals=[],lastClipRefresh=-Infinity;
const session=token().slice(0,16);
const inviteDialog=by('invite-dialog'),phoneLink=by('phone-link');
let inviteSlot=null,inviteRoom=null;
if(typeof inviteDialog.showModal!=='function'){
  inviteDialog.classList.add('invite-fallback');
  inviteDialog.setAttribute('role','dialog');
  inviteDialog.showModal=()=>{inviteDialog.open=true;inviteDialog.setAttribute('open','');by('close').focus();};
  inviteDialog.close=()=>{
    inviteDialog.open=false;inviteDialog.removeAttribute('open');
    inviteSlot?.node.querySelector('.invite').focus();
    inviteDialog.dispatchEvent(new Event('close'));
  };
  inviteDialog.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();inviteDialog.close();}
  });
}
function canReceiveRelay(){
  return Boolean(window.FGSReplayRelay?.receiveFormats().length);
}
function preferRelay(slot){
  const webcamInOtherView=slots.some(other=>other!==slot && (other.room?.local || other.pendingWebcam?.local));
  return canReceiveRelay() && (webcamPhoneSetup || webcamInOtherView || typeof RTCPeerConnection!=='function');
}
function offerOtherTransport(room,visible){
  by('use-slot-relay').hidden=!visible || !room || room.relay || !canReceiveRelay();
  by('use-slot-direct').hidden=!visible || !room?.relay || typeof RTCPeerConnection!=='function';
}
function inviteState(message,retry=false) {
  by('invite-note').textContent=message;
  by('retry-invite').hidden=!retry;
  offerOtherTransport(inviteRoom,retry);
  by('qr').replaceChildren();
  phoneLink.removeAttribute('href');phoneLink.hidden=true;
}
function dispose(slot,msg,notify=true) {
  slot.relayButton.textContent='Use internet relay';slot.relayButton.setAttribute('aria-label','Use internet relay for '+slot.label);
  slot.pendingWebcam=null;
  slot.discovery?.stream?.getTracks().forEach(t=>t.stop());slot.discovery=null;
  const room=slot.room;
  if(room){
    if(room===inviteRoom && inviteDialog.open)inviteState(msg,true);
    const originalOnly=room.local ? room.original && !room.originalError && !trimHere : room.trimSupport===false;
    slot.lastOriginalLocation=originalOnly?'Original only. '+originalLocation(room,false):'';
    slot.room=null;room.controller.abort();clearInterval(room.clockTimer);clearInterval(room.videoMonitor);clearTimeout(room.watchdog);
    if(room.video){room.video.pause();room.video.srcObject=null;room.video.remove();}
    room.pc?.close();
    room.stream?.getTracks().forEach(track=>track.stop());
    room.original?.stop().catch(()=>{});
    if(notify && room.id && !room.relay)call('/'+room.id+'/end',room.key,{}).catch(()=>{});
  }
  slot.epoch++;
  slot.status.textContent=msg;
  renderWebcams();
  slot.node.querySelector('.invite').textContent=room?'New invite':'Invite phone';
}
function failedConnection(slot,room,message){
  if(slot.room!==room)return;
  dispose(slot,message);
}
function watchPhoneVideo(slot,room){
  if(room.videoMonitor || slot.room!==room)return;
  room.delivery='waiting';
  let lastProgress=performance.now(),lastCheck=lastProgress,lastCapture=-Infinity,lastDecoder=-Infinity;
  let retriedPlayback=false;
  room.videoMonitor=setInterval(()=>{
    if(slot.room!==room || room.finishing)return;
    const now=performance.now(),frames=slot.buffer.frames,latest=frames.at(-1);
    const buffered=frames.at(-2)?.epoch===slot.epoch && latest.time>lastCapture;
    const decoded=room.preview?.lastFrameAt?.();
    const live=room.preview?.state()==='live';
    const progressed=buffered || live || (Number.isFinite(decoded) && decoded>lastDecoder);
    if(buffered)lastCapture=latest.time;
    if(Number.isFinite(decoded))lastDecoder=decoded;
    if(progressed){
      lastProgress=now;retriedPlayback=false;
      if(room.delivery!=='receiving'){
        room.delivery='receiving';
        slot.node.querySelector('.invite').textContent='Replace invite';
        if(room===inviteRoom && inviteDialog.open)inviteDialog.close();
      }
    }else if(document.visibilityState!=='visible' || now-lastCheck>2500 || room.playBlocked){
      lastProgress=now;
    }else{
      const elapsed=now-lastProgress;
      if(elapsed>=4000 && room.video?.paused && !retriedPlayback){
        retriedPlayback=true;room.video.play().catch(()=>{});
      }
      if(elapsed>=14000 && room.delivery!=='stalled'){
        room.delivery='stalled';
        const message=room.video?'The phone is connected, but video is not advancing on this display. Retry this camera or use internet relay.':
          'The phone is connected, but no video track reached this display. Retry this camera or use internet relay.';
        setText(slot.status,message);slot.node.querySelector('.invite').textContent='Retry camera';
        if(room===inviteRoom && inviteDialog.open)inviteState(message,true);
      }
    }
    lastCheck=now;
  },400);
}
function receive(slot,room,track) {
  const video=document.createElement('video');
  Object.assign(video,{autoplay:true,muted:true,playsInline:true});
  room.video=video;slot.node.querySelector('.picture').append(video);video.srcObject=new MediaStream([track]);
  room.preview=createLivePreview(video);
  const scratch=document.createElement('canvas'),ctx=scratch.getContext('2d',{alpha:false});
  let busy=false,last=-Infinity;
  const next=(_,info)=>{
    if(slot.room!==room)return;
    video.requestVideoFrameCallback(next);
    // Remote WebRTC captureTime is already in the display's clock domain.
    // A local USB camera may instead expose when its picture was presented.
    const now=performance.now(),capture=info.captureTime,presentation=info.presentationTime;
    const valid=Number.isFinite(capture) && capture>0 && capture<=now+100 && now-capture<=20000;
    if(valid)room.hasCaptureTime=true;
    const usePresentation=room.local && !room.hasCaptureTime && Number.isFinite(presentation) &&
      presentation>0 && presentation<=now+100 && now-presentation<=1200;
    const t=valid?capture:usePresentation?presentation:undefined;
    room.preview.frame(info,t);
    if(t===undefined)return;
    if(valid)room.original?.anchor(t);
    if(busy || t-last<28)return;
    const w=video.videoWidth,h=video.videoHeight;if(!w || !h)return;
    const scale=Math.min(1,960/Math.max(w,h));
    const dw=Math.round(w*scale),dh=Math.round(h*scale);
    if(scratch.width!==dw || scratch.height!==dh){scratch.width=dw;scratch.height=dh;}
    ctx.drawImage(video,0,0,dw,dh);busy=true;last=t;
    scratch.toBlob(blob=>{
      busy=false;
      if(!blob || slot.room!==room)return;
      room.presentationTimed=Boolean(usePresentation);
      slot.buffer.add({time:t,size:blob.size,blob,epoch:slot.epoch,presentationTimed:room.presentationTimed});
      const fit=room.clock?.fit(performance.now());
      const detail=room.local?(room.originalError?' · '+room.originalError:''):(fit?' · clock ±'+Math.ceil(fit.uncertainty)+' ms':' · calibrating clock');
      room.replayStatus=(room.local?'Webcam':'Direct')+' · '+w+'×'+h+detail+(usePresentation?' · webcam preview time':'');
    },'image/jpeg',.82);
  };
  if(video.requestVideoFrameCallback)video.requestVideoFrameCallback(next);
  playIncomingVideo(slot,room,()=>{slot.status.textContent='TV browser could not play this camera';});
}
function control(slot,room,channel) {
  if(channel.label!=='replay-clock-v1' || room.channel){channel.close();return;}
  room.channel=channel;
  channel.addEventListener('message',event=>{
    if(!room.finishReply || typeof event.data!=='string' || event.data.length>600)return;
    let m;try{m=JSON.parse(event.data);}catch{return;}
    if(m.op==='source-stopped')room.finishReply(m.saved===true);
  });
  const probes=new Map();
  function ping() {
    if(channel.readyState!=='open' || slot.room!==room)return;
    const tv=performance.now();probes.clear();probes.set(tv,true);
    channel.send(JSON.stringify({op:'ping',tv,video:room.delivery || 'waiting'}));
  }
  channel.onopen=()=>{watchPhoneVideo(slot,room);ping();room.clockTimer=setInterval(ping,2000);};
  channel.onmessage=e=>{
    if(slot.room!==room || typeof e.data!=='string' || e.data.length>600)return;
    let m;try{m=JSON.parse(e.data);}catch{return;}
    if(m.op==='pong' && probes.delete(m.tv)){
      room.clock.add(m.tv,m.p1,m.p2,performance.now());room.originalStart=m.originalStart;
      room.trimSupport=['starting','partial','unavailable'].includes(m.originalState)?m.originalState:
        typeof m.canTrim==='boolean'?m.canTrim:'unconfirmed';
    }
    if(m.op==='clip-result' && m.id===clipId && exportJobs.some(job=>job.room===room)) {
      room.clipResult=m.ok?'ready on phone':'failed on phone';
      refreshClips();
    }
  };
  if(channel.readyState==='open')channel.onopen();
}
function showPhoneLink(slot,room,url,help){
  room.invited=true;
  if(room!==inviteRoom || !inviteDialog.open)return;
  phoneLink.href=url;phoneLink.hidden=false;by('invite-note').textContent=help;
  offerOtherTransport(room,true);
  try{
    const qr=globalThis.qrcode(0,'M');qr.addData(String(url));qr.make();
    by('qr').innerHTML=qr.createSvgTag({cellSize:5,margin:20,scalable:true});
  }catch{by('invite-note').textContent='The QR code could not load. Copy the private phone link and open it on the camera phone.';}
}
function relayInvite(slot,room){
  const current=()=>slot.room===room && !room.controller.signal.aborted;
  room.updateRelayVideoState=state=>{
    if(!current())return;
    room.delivery=state;
    if(state==='receiving'){
      room.relayReceived=true;
      slot.status.textContent=room.replayStatus || 'Internet relay video received';
      if(room===inviteRoom && inviteDialog.open)inviteDialog.close();
    }else if(state==='stalled')slot.status.textContent='Internet relay stalled. Buffered TV replay is still available.';
  };
  startRelayAngle({
    cameraId:slot.cameraId,signal:room.controller.signal,
    onInvite:url=>{
      if(!current())return;
      showPhoneLink(slot,room,url,'On the phone, scan this QR code, open the link, and tap Start camera. The encrypted relay sends video to '+slot.label+'.');
      slot.status.textContent='Internet relay invite ready · waiting for phone';
    },
    onClaimed:()=>{if(current())room.claimed=true;},
    onPicture:(source,stamp)=>{if(current())room.onRelayPicture?.(source,stamp);},
    onStream:async(stream,mime)=>{
      if(!current())throw new DOMException('Pairing stopped.','AbortError');
      room.claimed=true;room.mime=mime;
      await receiveRelayVideo(slot,room,stream,mime);
      room.updateRelayVideoState('receiving');
    },
    onStatus:message=>{
      if(!current() || room.relayReceived)return;
      setText(slot.status,message);
      if(room===inviteRoom && inviteDialog.open && (!room.invited || room.claimed))setText(by('invite-note'),message);
    },
    onError:error=>{if(current())failedConnection(slot,room,error.message || 'Internet relay stopped. Retry the invite for this camera.');}
  });
}
async function invite(slot,relay=preferRelay(slot)) {
  if(demo)setDemo(false);
  dispose(slot,'Creating private invite…');slot.epoch++;
  const room={controller:new AbortController(),key:token(),clock:new ClockMap(),relay};
  slot.room=room;
  const signal=room.controller.signal;
  inviteSlot=slot;inviteRoom=room;
  by('invite-title').textContent=slot.label+(relay?' internet relay invite':' direct invite');
  inviteState('Creating a private invite for '+slot.label+'.');
  if(!inviteDialog.open)inviteDialog.showModal();
  try{
    if(relay){
      slot.relayButton.textContent='Disconnect relay';slot.relayButton.setAttribute('aria-label','Disconnect internet relay for '+slot.label);
      relayInvite(slot,room);return;
    }
    if(typeof RTCPeerConnection!=='function')throw Error('This display cannot receive a direct connection. Choose internet relay for this camera.');
    const timer=setTimeout(()=>{
      if(slot.room===room)dispose(slot,'The pairing service took too long. Check that this display is online, then retry.');
    },11000);
    let result;
    try{result=await call('',null,{tvToken:room.key,purpose:'multicam'},signal);}
    finally{clearTimeout(timer);}
    if(signal.aborted){if(result.id)call('/'+result.id+'/end',room.key,{}).catch(()=>{});return;}
    if(!/^~[A-Za-z0-9_-]{21}$/.test(result?.id || '') || !/^[A-Za-z0-9_-]{43}$/.test(result?.invite || '') ||
      !Number.isFinite(result?.expiresAt) || result.expiresAt<=Date.now())throw Error('The pairing service returned an incomplete invite. Retry to create a new one.');
    Object.assign(room,{id:result.id,expiry:result.expiresAt});
    const url=new URL('phone',location.href);
    url.hash=new URLSearchParams({room:room.id,invite:result.invite,camera:slot.cameraId,session,until:String(room.expiry)});
    showPhoneLink(slot,room,url,"Connect the phone to the display's Wi-Fi, then scan the code and tap Start camera.");
    slot.status.textContent='Invite ready · waiting for phone';
    slot.node.querySelector('.invite').textContent='Replace invite';
    const pc=createPeer();room.pc=pc;
    pc.ontrack=e=>{if(slot.room===room && e.track.kind==='video')receive(slot,room,e.track);};
    pc.ondatachannel=e=>control(slot,room,e.channel);
    pc.onconnectionstatechange=()=>{
      if(slot.room!==room || room.finishing)return;
      if(pc.connectionState==='connected'){
        room.wasConnected=true;watchPhoneVideo(slot,room);
        clearTimeout(room.watchdog);slot.status.textContent='Direct connected · waiting for capture timestamps';
        if(room===inviteRoom && inviteDialog.open)by('invite-note').textContent='Phone connected. Waiting for video from '+slot.label+'.';
      } else if(pc.connectionState==='failed')failedConnection(slot,room,directFailure());
      else if(pc.connectionState==='disconnected')slot.status.textContent='Camera interrupted';
    };
    await negotiate(pc,{...room,signal,onPhoneClaimed:()=>{
      if(slot.room!==room || room.wasConnected)return;
      setText(slot.status,'Phone joined. Waiting for its direct video connection.');
      if(room===inviteRoom && inviteDialog.open)setText(by('invite-note'),'Phone joined. Waiting for its direct video connection.');
    }},false);
    if(signal.aborted)return;
    if(pc.connectionState!=='connected')room.watchdog=setTimeout(()=>failedConnection(slot,room,directFailure()),22000);
  }catch(error){
    if(signal.aborted)return;
    const message=!room.id && error.status===429?'The pairing service is busy. Wait a minute, then retry.':
      !room.id && error.status===403?'The pairing service did not accept this display address.':
      !room.id && (error instanceof TypeError || error instanceof SyntaxError)?'Could not create a private invite. Check that this display is online, then retry.':error.message;
    failedConnection(slot,room,message);
  }
  function directFailure(){
    if(!canReceiveRelay())return directConnectionMessage(room.wasConnected);
    return 'Direct video could not reach '+slot.label+'. Choose internet relay for this camera, then scan the new QR code on the phone.';
  }
}
function finishPhone(room) {
  if(room.channel?.readyState!=='open')return Promise.resolve(null);
  return new Promise(resolve=>{
    const channel=room.channel;
    function done(saved){
      clearTimeout(timer);room.finishReply=null;resolve(saved);
    }
    const timer=setTimeout(()=>done(null),5000);
    room.finishReply=done;
    try{channel.send(JSON.stringify({op:'finish-source'}));}catch{done(null);}
  });
}
async function finishSource(slot){
  slot.pendingWebcam=null;slot.discovery?.stream?.getTracks().forEach(t=>t.stop());slot.discovery=null;
  const room=slot.room;
  let issue='',checkPhone=false;
  if(room){
    room.finishing=true;room.controller.abort();clearTimeout(room.watchdog);
    if(room.local){
      // Stop acquisition immediately, then wait for the recorder's last database write.
      room.stream.getTracks().forEach(t=>t.stop());
      try{
        const original=await room.originalReady;
        if(!original)throw Error();
        await original.stop();
        if(room.originalError)throw Error(room.originalError);
      }catch{issue=slot.label+' original could not be confirmed. Check Webcam originals.';}
    }else if(room.relay){checkPhone=!!(room.claimed || room.video);}
    else if(room.channel?.readyState==='open' || room.wasConnected || room.video){
      const saved=await finishPhone(room);
      if(saved===null)checkPhone=true;
      else if(!saved)issue=slot.label+' stopped. Check the original on the phone.';
    }
    if(!room.local && !room.relay && room.id){
      const revoke=new AbortController(),timer=setTimeout(()=>revoke.abort(),3500);
      try{await call('/'+room.id+'/end',room.key,{},revoke.signal);}
      catch(error){if(error.status!==410 && error.status!==404 && !issue)issue='Could not confirm invite closure for '+slot.label+'. Check that phone.';}
      finally{clearTimeout(timer);}
    }
  }
  dispose(slot,'No source selected',false);
  slot.buffer=new AngleBuffer();
  return {issue,checkPhone,label:slot.label};
}
const demoDialog=by('demo-dialog');
let finishing=false,pendingPhoneChecks=[],recordingIssues=[];
const demoTitle=by('demo-title').textContent,demoDescription=by('demo-description').textContent;
const sourcesPresent=()=>slots.some(s=>s.room || s.pendingWebcam || s.discovery);
function showDemoChoice(){
  const check=pendingPhoneChecks.length>0;
  by('demo-title').textContent=check?'Confirm the phone has stopped':demoTitle;
  by('demo-description').textContent=check?
    'The display could not confirm that '+pendingPhoneChecks.join(' and ')+' stopped. Check the phone and tap Stop camera if it is still recording.':demoDescription;
  by('demo-keep').textContent=check?'Back to cameras':'Keep recording';
  by('demo-finish').textContent=check?'Camera stopped. Continue':'Finish recording and start demo';
  by('demo-progress').textContent=recordingIssues.join(' ');
  if(!demoDialog.open)demoDialog.showModal();
}
function enterDemo(){
  setDemo(true);
  if(recordingIssues.length)by('mode').textContent+=' · '+recordingIssues.join(' ');
  recordingIssues=[];demoDialog.close();
}
by('demo-keep').onclick=()=>demoDialog.close();
demoDialog.addEventListener('cancel',event=>{if(finishing)event.preventDefault();});
by('demo-finish').onclick=async()=>{
  if(finishing)return;
  if(pendingPhoneChecks.length){
    pendingPhoneChecks=[];
    if(sourcesPresent())showDemoChoice();else enterDemo();
    return;
  }
  finishing=true;by('demo-keep').disabled=by('demo-finish').disabled=true;
  by('demo-progress').textContent='Stopping cameras and finishing the originals…';
  try{
    const results=await Promise.all(slots.map(finishSource));
    pendingPhoneChecks=results.filter(r=>r.checkPhone).map(r=>r.label);
    recordingIssues.push(...results.map(r=>r.issue).filter(Boolean));
    if(by('local-originals').open)by('local-originals').ontoggle();
    if(pendingPhoneChecks.length)showDemoChoice();else enterDemo();
  }finally{finishing=false;by('demo-keep').disabled=by('demo-finish').disabled=false;}
};
function setDemo(value) {
  demo=value;mode='delay';origin=performance.now()-3200-Number(by('delay').value)*1000;cursor=3200;markIn=markOut=null;clipId=null;
  by('save').disabled=true;by('clip-status').textContent='';
  by('demo').textContent=value?'Exit demo':'Try synced demo';
  by('mode').textContent=value?'Demo · shared clock':setupHint;
  for(const s of slots){
    s.rendered=null;s.displayed=null;s.frameJob++;s.canvas.getContext('2d').clearRect(0,0,s.canvas.width,s.canvas.height);
    s.status.textContent=value?'Simulated camera':(s.room?'Live camera':'No source selected');
  }
}
function blank(slot,message){
  if(slot.rendered!==null){slot.frameJob++;slot.rendered=null;slot.canvas.getContext('2d').clearRect(0,0,slot.canvas.width,slot.canvas.height);}
  slot.displayed=null;slot.canvas.hidden=true;setText(slot.missing,message);slot.missing.hidden=false;
}
function draw(slot,time,paired){
  const room=slot.room;
  if(room && room===inviteRoom && inviteDialog.open && room.preview){
    const previous=slot.buffer.frames.at(-2);
    if(room.playBlocked || previous?.epoch===slot.epoch || room.preview.state()==='live')inviteDialog.close();
  }
  if(slot.node.hidden)return;
  if(demo){
    slot.canvas.hidden=false;slot.missing.hidden=true;slot.rendered='demo';
    renderMock(slot.canvas,time/1000,{angle:slot.name});return;
  }
  const fromRelay=room?room.relay:slot.buffer.frames.at(-1)?.receipt;
  let frame=fromRelay?relayFrameAt(slot.buffer.frames,time):slot.buffer.nearest(time,paired?120:50);
  if(room && frame?.epoch!==slot.epoch)frame=null;
  if(!frame){
    const live=room?.preview?.state();
    const frames=slot.buffer.frames;
    const insideHistory=frames.length && time>=frames[0].time && time<=frames.at(-1).time;
    const reason=live==='live' && mode==='delay' && !insideHistory && room.preview.liveReason(time);
    if(reason){
      if(slot.rendered!==null){slot.frameJob++;slot.rendered=null;}
      slot.displayed=null;slot.canvas.hidden=true;slot.missing.hidden=true;
      setText(slot.status,reason);
    }else{
      if(live==='stalled' && room?.delivery!=='stalled')setText(slot.status,'No new video frames');
      const message=live==='stalled'?'Camera stopped sending frames':live==='live'?'Synchronized replay unavailable':
        room || slot.buffer.frames.length?'Angle unavailable at this time':'Choose a webcam or invite a phone';
      blank(slot,message);
    }
    return;
  }
  if(room?.relay && frame.receipt){
    const timing=frame.captureTimed?(frame.estimated?'phone preview time':'phone capture time'):'TV receipt time';
    setText(slot.status,'Internet relay · '+timing+(room.delivery==='stalled'?' · live feed interrupted':''));
  }else if(room?.replayStatus)setText(slot.status,room.replayStatus);
  const changingSource=slot.rendered && (slot.rendered.epoch!==frame.epoch || slot.rendered.timingSegment!==frame.timingSegment);
  const maxJump=mode==='delay' && (frame.receipt || paired)?1000:250;
  if(slot.rendered!==frame && (changingSource || (slot.canvas.hidden && slot.missing.hidden) ||
      (Number.isFinite(slot.displayed) && Math.abs(slot.displayed-frame.time)>maxJump))){
    slot.displayed=null;slot.canvas.hidden=true;slot.missing.hidden=false;slot.missing.textContent='Loading frame';
  }
  if(slot.rendered===frame)return;
  const seq=++slot.frameJob;slot.rendered=frame;
  createImageBitmap(frame.blob).then(bitmap=>{
    if(slot.frameJob===seq) {
      if(slot.canvas.width!==bitmap.width || slot.canvas.height!==bitmap.height){slot.canvas.width=bitmap.width;slot.canvas.height=bitmap.height;}
      slot.canvas.getContext('2d').drawImage(bitmap,0,0);
      slot.displayed=frame.time;
      slot.displayedBasis=frame.receipt && !frame.captureTimed?'arrival':
        frame.presentationTimed || frame.estimated?'presentation':'capture';
      slot.displayedUncertainty=Number.isFinite(frame.uncertainty)?frame.uncertainty:0;
      slot.canvas.hidden=false;slot.missing.hidden=true;
    }
    bitmap.close();
  }).catch(()=>{if(seq===slot.frameJob)blank(slot,'Frame could not be decoded');});
}
let lastTick=performance.now(),lo=0,hi=0,displayCursor=0,sharedAnchor=null;
function sharedTimeline(requested,now){
  sharedAnchor=null;
  if(demo || slots.some(s=>s.node.hidden || !s.room))return requested;
  const calibrated=slots.filter(slot=>{
    const last=slot.buffer.frames.at(-1);
    return slot.room.relay && slot.room.captureTimed && last?.captureTimed && last.epoch===slot.epoch;
  });
  if(!calibrated.length)return requested;
  // The slower relay supplies the actual picture to match in the other view.
  const anchor=calibrated.reduce((a,b)=>a.buffer.frames.at(-1).time<=b.buffer.frames.at(-1).time?a:b);
  const frames=anchor.buffer.frames,last=frames.at(-1);
  if(mode==='delay' && now-last.arrival<=2000){
    // Leave a small delivery cushion. During warmup hold the first matched
    // picture until the selected delay has accumulated.
    const first=frames.find(f=>f.epoch===anchor.epoch && f.captureTimed && f.timingSegment===last.timingSegment);
    if(first)requested=Math.max(first.time,Math.min(requested,last.time-120));
  }
  const picture=relayFrameAt(frames,requested);
  if(!picture?.captureTimed || picture.epoch!==anchor.epoch)return requested;
  sharedAnchor=anchor;
  return picture.time;
}
function alignmentStatus(){
  if(demo || slots.some(s=>s.node.hidden || !s.room))return '';
  const hasRelay=slots.some(s=>s.room.relay);
  if(!slots.every(s=>Number.isFinite(s.displayed)))return hasRelay?'Waiting for matching pictures.':'';
  if(slots.some(s=>s.displayedBasis==='arrival'))return 'Capture-time sync unavailable. Relay playback uses arrival on this display.';
  const gap=Math.round(Math.abs(slots[0].displayed-slots[1].displayed));
  const preview=slots.some(s=>s.displayedBasis==='presentation');
  if(!hasRelay && !preview)return 'Displayed capture stamps differ by '+gap+' ms';
  const timingError=Math.ceil(slots.reduce((sum,s)=>sum+s.displayedUncertainty,0));
  return (preview?'Estimated preview offset: ':'Estimated capture offset: ')+gap+' ms'+
    (hasRelay?' · relay timing uncertainty ±'+timingError+' ms':'')+
    (preview?' · camera processing delay unknown':'');
}
function refresh(now){
  const dt=Math.max(0,now-lastTick);lastTick=now;
  for(const s of slots)s.buffer.trim(now);
  const frames=slots.flatMap(s=>s.buffer.frames.length?[s.buffer.frames[0].time,s.buffer.frames.at(-1).time]:[]);
  lo=demo?0:Math.min(...frames);hi=demo?16000:Math.max(...frames);
  const have=hi>=lo;
  if(mode==='delay'){
    const delayed=now-Number(by('delay').value)*1000;
    cursor=demo?((delayed-origin)%16000+16000)%16000:delayed;
  }
  if(mode==='play')cursor=Math.min(hi,cursor+dt);
  displayCursor=sharedTimeline(cursor,now);
  const range=by('timeline');
  range.disabled=by('pause').disabled=by('step').disabled=by('follow').disabled=!have;
  if(have){
    // Range steps are relative to min. Use fixed millisecond ticks so a
    // captured frame can be restored after the rolling minimum changes.
    // The first tick on/after a relay frame still belongs to that picture.
    range.min=Math.floor(lo);range.max=Math.ceil(hi);range.value=Math.ceil(displayCursor);
  }
  by('position').textContent=have?(demo?(displayCursor/1000).toFixed(2)+' s':((now-displayCursor)/1000).toFixed(1)+' s behind live'):'Waiting for capture timestamps';
  by('pause').textContent=mode==='pause'?'Play':'Pause';
  for(const s of slots)draw(s,displayCursor,Boolean(sharedAnchor));
  if(now-lastClipRefresh>=250){
    lastClipRefresh=now;refreshClips();
    slots.forEach((slot,i)=>relayClipControls[i].update(!demo && (slot.room?.relay || (!slot.room && slot.buffer.frames.at(-1)?.receipt))));
  }
  setText(by('alignment'),alignmentStatus());
  requestAnimationFrame(refresh);
}
const renderWebcams=bindWebcams(slots,{
  begin(slot,room){
    if(demo)setDemo(false);
    dispose(slot,'Opening webcam.');
    slot.room=room;
    slot.node.querySelector('.invite').textContent='Replace webcam with phone';
    slot.relayButton.textContent='Replace webcam with relayed phone';
    slot.relayButton.setAttribute('aria-label','Replace '+slot.label+' webcam with a relayed phone');
  },
  dispose,receive
});
for(const s of slots){
  s.node.querySelector('.invite').onclick=()=>invite(s);
  s.relayButton.onclick=()=>{
    if(s.room?.relay)dispose(s,'Internet relay disconnected.');
    else invite(s,true);
  };
}
by('retry-invite').onclick=()=>{if(inviteSlot)invite(inviteSlot,!!inviteRoom?.relay);};
by('use-slot-relay').onclick=()=>{if(inviteSlot)invite(inviteSlot,true);};
by('use-slot-direct').onclick=()=>{if(inviteSlot)invite(inviteSlot,false);};
inviteDialog.addEventListener('close',()=>{
  if(inviteDialog.open)return;
  const pending=inviteSlot && inviteRoom && inviteSlot.room===inviteRoom && !inviteRoom.invited;
  if(pending)dispose(inviteSlot,'Invite canceled.');
  inviteSlot=null;inviteRoom=null;
  inviteState('');
});
by('demo').onclick=()=>{
  if(demo){setDemo(false);return;}
  if(sourcesPresent() || pendingPhoneChecks.length)showDemoChoice();else setDemo(true);
};
by('close').onclick=()=>by('invite-dialog').close();
by('layout').onchange=e=>{
  const view=e.target.value;by('angles').classList.toggle('single',view!=='both');
  for(const s of slots)s.node.hidden=view!=='both' && s.name!==view;
};
by('timeline').oninput=e=>{mode='pause';cursor=Number(e.target.value);};
by('pause').onclick=()=>{cursor=displayCursor;mode=mode==='pause'?'play':'pause';};
by('follow').onclick=()=>{mode='delay';};
by('step').onclick=()=>{
  mode='pause';
  const sources=sharedAnchor?[sharedAnchor]:slots;
  const after=sources.flatMap(s=>s.buffer.frames.filter(f=>f.time>displayCursor+1).slice(0,1).map(f=>f.time));
  cursor=Math.min(hi,demo?cursor+1000/30:after.length?Math.min(...after):hi);
};
function covers(slot,start,end) {
  const room=slot.room;
  if(!room || room.relay)return false;
  if(room.local){
    if(!Number.isFinite(room.original?.start) || start<room.original.start)return false;
  }else{
    const fit=room.clock.fit(performance.now());
    if(!fit || room.channel?.readyState!=='open' || !Number.isFinite(room.originalStart) || fit.phoneTime(start)<room.originalStart)return false;
  }
  // The full native recording remains continuous when the TV snapshot buffer
  // skips a preview frame. Require a single connected camera epoch that spans
  // the requested time in both local originals.
  const frames=slot.buffer.frames.filter(f=>f.epoch===slot.epoch && !f.receipt && !f.presentationTimed);
  return frames.length>=2 && start>=frames[0].time && end<=frames.at(-1).time;
}
function trimSupport(room){
  if(!room)return null;
  if(room.relay)return 'relay';
  if(room.local)return room.original && !room.originalError ? trimHere && !room.presentationTimed : null;
  return room.channel?.readyState==='open' && room.pc.connectionState==='connected' ? room.trimSupport : null;
}
function originalLocation(room,active=true){
  if(room.local)return active?'Disconnect this webcam, then open Webcam originals here.':'Open Webcam originals here.';
  return active?'Stop this camera, then open Phone originals on its phone.':'Open Phone originals on its phone.';
}
function refreshClips(){
  const eligible=[];
  for(const slot of slots){
    const room=slot.room,support=trimSupport(room);
    let label=(!demo && !room && slot.lastOriginalLocation) || '';
    if(!demo && room){
      if(support===true)eligible.push(slot);
      else if(support==='relay')label='Save this view with Save TV relay clip. Its full original is on the phone when recorded.';
      else if(support==='starting')label='Starting the original recording on the phone.';
      else if(support==='unavailable')label='Live video only. The phone could not record an original.';
      else if(support==='partial')label='Recording stopped. Check Phone originals for the saved portion.';
      else if(support===false)label='Original only. '+originalLocation(room);
      else if(support==='unconfirmed')label='Clip support unconfirmed. '+originalLocation(room);
      else if(room.trimSupport===false)label='Original only. '+originalLocation(room,false);
      else if(room.channel?.readyState==='open')label='Checking clip support…';
    }
    setText(slot.capability,label);
  }
  const save=by('save');
  const valid=Number.isFinite(markIn) && Number.isFinite(markOut) && markOut>markIn;
  const covered=valid && eligible.length>0 && eligible.every(s=>covers(s,markIn,markOut));
  const pending=clipId && exportJobs.some(({slot,room})=>slot.room===room && trimSupport(room)===true && !room.clipResult);
  save.disabled=demo || !covered || Boolean(pending);
  setText(save,eligible.length===2?'Prepare both clips':eligible.length===1?'Prepare '+eligible[0].label+' clip':'Prepare clips');
  let message='';
  if(clipId){
    message=exportJobs.map(({slot,room})=>{
      const available=slot.room===room && trimSupport(room)===true;
      return slot.label+' '+(room.clipResult || (available?'preparing':'disconnected. Check the recording device.'));
    }).join(' · ');
    if(exportOriginals.length)message+=' · '+exportOriginals.join(' · ');
  }else if(markIn!==null || markOut!==null){
    if(demo)message='Choose a real camera to export a recording.';
    else if(!valid)message='Mark a start followed by a later end.';
    else message=((markOut-markIn)/1000).toFixed(2)+' s '+(covered?'selected':'outside the available clip range');
  }
  setText(by('clip-status'),message);
  return eligible;
}
function mark(which){
  if(which==='start')markIn=displayCursor;else markOut=displayCursor;
  clipId=null;
  refreshClips();
}
by('mark-in').onclick=()=>mark('start');by('mark-out').onclick=()=>mark('end');
by('save').onclick=()=>{
  const targets=refreshClips();
  if(by('save').disabled)return;
  const id=clipId=crypto.randomUUID();
  clearClipDownloads();
  exportJobs=targets.map(slot=>({slot,room:slot.room}));
  exportOriginals=slots.filter(slot=>trimSupport(slot.room)===false)
    .map(slot=>slot.label+' original only. '+originalLocation(slot.room,false));
  for(const {slot,room} of exportJobs){
    room.clipResult='';
    if(room.local){
      room.original.clip(markIn,markOut).then(blob=>{
        if(clipId!==id)return;
        offerClip(slot,blob,id);room.clipResult='ready here';
      }).catch(error=>{if(clipId===id)room.clipResult=error.message;}).finally(refreshClips);
    }else{
      const fit=room.clock.fit(performance.now());
      try{
        room.channel.send(JSON.stringify({op:'clip',id,start:fit.phoneTime(markIn),end:fit.phoneTime(markOut)}));
      }catch{room.clipResult='request interrupted; check the recording phone';}
    }
  }
  refreshClips();
};
window.addEventListener('pagehide',()=>slots.forEach(s=>dispose(s,'Closed',false)));
requestAnimationFrame(refresh);
