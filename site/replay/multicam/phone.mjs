import {call,token,negotiate,createPeer,directConnectionMessage} from './signaling.mjs';
import {startOriginal,recordings,loadOriginal,canTrimOriginal} from './originals.mjs';
import {cameras} from './cameras.mjs';
const by=id=>document.getElementById(id);
const q=new URLSearchParams(location.hash.slice(1));
const id=q.get('room'),invite=q.get('invite'),expiry=Number(q.get('until'));
const camera=q.has('camera') ? cameras.find(c=>c.id===q.get('camera')) : cameras.find(c=>c.angle===q.get('angle'));
const validInvite=/^~[A-Za-z0-9_-]{21}$/.test(id) && /^[A-Za-z0-9_-]{43}$/.test(invite) &&
  camera && Number.isFinite(expiry) && expiry>0;
const expiredMessage='This invite expired. Scan a new invite for this camera on the TV.';
let active=null,claimKey;
const canTrim=canTrimOriginal();
if(!canTrim)by('clip-capability').textContent='Original only. After you stop this camera, open Phone originals below to download its recording.';
function saveLink(container,blob,label,file){
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=file;
  a.textContent=label;container.append(a);return a;
}
const extension=blob=>blob.type.includes('mp4')?'mp4':'webm';
async function showOriginals() {
  const rows=await recordings(),container=by('originals');container.replaceChildren();
  if(!rows.length){container.textContent='No originals recorded on this phone.';return;}
  for(const row of rows.reverse()) {
    const label=cameras.find(c=>c.angle===row.angle)?.label ?? 'Camera';
    const b=document.createElement('button');
    b.textContent='Open '+label+' original · '+new Date(row.date).toLocaleTimeString();
    b.onclick=async()=>{
      b.disabled=true;
      try{
        const blob=await loadOriginal(row);
        const link=saveLink(container,blob,'Download '+label+' original','FGS-'+label.replace(' ','-')+'-'+row.date+'.'+extension(blob));
        b.replaceWith(link);
      }catch(error){b.disabled=false;by('status').textContent=error.message;}
    };container.append(b);
  }
}
async function close(room,message,retry=false,finishChannel=null){
  if(active!==room)return;active=null;room.controller.abort();clearTimeout(room.watchdog);clearTimeout(room.inviteTimer);
  if(!finishChannel)room.pc?.close();
  room.stream?.getTracks().forEach(t=>t.stop());
  by('camera').srcObject=null;by('start').disabled=!retry || Date.now()>=expiry;by('stop').disabled=true;
  by('status').textContent=message;
  if(room.claimed)call('/'+id+'/end',room.key,{}).catch(()=>{});
  let saved=false;
  try{
    const original=await room.originalReady;
    if(original){await original.stop();saved=!room.originalError;}
  }catch(error){by('originals').textContent=error.message;}
  if(finishChannel){
    const pc=room.pc;
    if(finishChannel.readyState==='open'){
      try{finishChannel.send(JSON.stringify({op:'source-stopped',saved}));}catch{}
      // Let the display receive the acknowledgement and close the connection first.
      const safety=setTimeout(()=>pc.close(),3000);
      finishChannel.addEventListener('close',()=>{clearTimeout(safety);pc.close();},{once:true});
    }else pc.close();
    by('status').textContent=saved?'Camera stopped for the TV demo. Your original is available below.':'Camera stopped for the TV demo. Original saving could not be confirmed.';
  }
  try{await showOriginals();}catch(error){by('originals').textContent=error.message;}
}
async function start() {
  if(active || !validInvite)return;
  const room={controller:new AbortController()};active=room;
  const signal=room.controller.signal;
  by('start').disabled=true;by('stop').disabled=false;
  try{
    if(Date.now()>=expiry)throw Error(expiredMessage);
    if(!window.isSecureContext || !navigator.mediaDevices?.getUserMedia ||
       !('MediaRecorder' in window) || typeof RTCPeerConnection!=='function'){
      throw Error('Open this private invite in Chrome or Safari with camera access.');
    }
    room.inviteTimer=setTimeout(()=>close(room,expiredMessage),Math.min(expiry-Date.now(),2147483647));
    by('status').textContent='Allow camera access to join the TV.';
    const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{
      facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:60}}});
    if(active!==room){stream.getTracks().forEach(t=>t.stop());return;}
    room.stream=stream;const video=by('camera');video.srcObject=stream;await video.play();
    if(signal.aborted)return;
    if(Date.now()>=expiry)throw Error(expiredMessage);
    by('status').textContent='Connecting directly to the TV.';
    // A lost response may follow a successful claim; retry with the same in-memory phone key.
    room.key=claimKey ||= token();
    room.claimSent=true;
    const claimController=new AbortController();
    const timeout=setTimeout(()=>claimController.abort(),12000);
    try{
      await call('/'+id+'/claim',null,{invite,phoneToken:room.key},claimController.signal);
    }finally{clearTimeout(timeout);}
    if(signal.aborted){call('/'+id+'/end',room.key,{}).catch(()=>{});return;}
    room.claimed=true;clearTimeout(room.inviteTimer);
    // Keep an unclaimed invitation usable through a reload. A claimed invite is single-use.
    try{history.replaceState(history.state,'',location.pathname+location.search);}catch{}
    room.originalReady=startOriginal(stream,camera.angle,message=>{room.originalError=true;if(active===room)by('status').textContent=String(message);});
    room.original=await room.originalReady;
    if(signal.aborted){await room.original.stop();return;}
    const anchor=(_,m)=>{
      if(active!==room)return;
      room.original.anchor(m.captureTime);room.hasStamp ||= Number.isFinite(m.captureTime) && m.captureTime>0;
      video.requestVideoFrameCallback(anchor);
    };
    video.requestVideoFrameCallback?.(anchor);
    const pc=createPeer();room.pc=pc;
    pc.addTransceiver(stream.getVideoTracks()[0],{direction:'sendonly',streams:[stream]});
    const channel=pc.createDataChannel('replay-clock-v1');
    channel.onclose=()=>{if(active===room)close(room,'Display disconnected. Open your saved original below.');};
    channel.onmessage=async event=>{
      const received=performance.now();
      if(active!==room || typeof event.data!=='string' || event.data.length>600)return;
      let msg;try{msg=JSON.parse(event.data);}catch{return;}
      if(msg.op==='finish-source'){
        await close(room,'Finishing the original for the TV demo.',false,channel);return;
      }
      if(msg.op==='ping' && Number.isFinite(msg.tv)){
        channel.send(JSON.stringify({op:'pong',tv:msg.tv,p1:received,p2:performance.now(),
          originalStart:room.original.start,canTrim}));
      }else if(msg.op==='clip' && /^[a-f0-9-]{36}$/.test(msg.id) && [msg.start,msg.end].every(Number.isFinite)){
        let ok=false;
        try{
          if(!canTrim)throw Error('Original only. After you stop this camera, open Phone originals below.');
          if(room.exporting)throw Error('A clip is already being prepared.');
          room.exporting=msg.id;
          const blob=await room.original.clip(msg.start,msg.end);
          saveLink(by('clips'),blob,'Download '+camera.label+' clip','FGS-'+camera.label.replace(' ','-')+'-'+msg.id+'.'+extension(blob));
          ok=true;if(active===room)by('status').textContent='Matching clip ready. The camera is still recording.';
        }catch(error){if(active===room)by('status').textContent='Clip export · '+error.message;}
        finally{if(room.exporting===msg.id)room.exporting=null;}
        if(channel.readyState==='open')channel.send(JSON.stringify({op:'clip-result',id:msg.id,ok}));
      }
    };
    pc.onconnectionstatechange=()=>{
      if(active!==room)return;
      if(pc.connectionState==='connected'){
        room.wasConnected=true;
        clearTimeout(room.watchdog);by('status').textContent='Direct · recording original'+(room.hasStamp?'':' · checking source timestamps');
      }else if(pc.connectionState==='disconnected'){
        by('status').textContent='Direct connection interrupted';
        clearTimeout(room.watchdog);room.watchdog=setTimeout(()=>close(room,directConnectionMessage(room.wasConnected)),8000);
      }else if(pc.connectionState==='failed')close(room,directConnectionMessage(room.wasConnected));
    };
    await negotiate(pc,{id,key:room.key,expiry,signal},true);
    if(!signal.aborted && pc.connectionState!=='connected')room.watchdog=setTimeout(()=>close(room,directConnectionMessage(room.wasConnected)),22000);
  }catch(error){
    if(signal.aborted){
      // The server may have claimed the room even if its reply was lost during Stop.
      if(room.claimSent && !room.claimed)call('/'+id+'/end',room.key,{}).catch(()=>{});
      return;
    }
    const expired=Date.now()>=expiry || error.status===410;
    const invalid=[400,403,404,409].includes(error.status);
    const retry=!expired && !invalid && !room.claimed;
    let message=error.message;
    if(expired)message=expiredMessage;
    else if(invalid)message='This camera invite is already used or invalid. Scan a new invite on the TV.';
    else if(error.name==='NotAllowedError')message='Allow camera access in this browser, then tap Start camera again.';
    else if(error.name==='NotReadableError')message='Close the other app using your camera, then tap Start camera again.';
    else if(room.claimSent && !room.claimed)message='Could not reach the TV room. Check your connection and tap Start camera again.';
    else if(room.claimed)message+=' Scan a new invite on the TV to reconnect.';
    await close(room,message,retry);
  }
}
by('start').onclick=start;
by('stop').onclick=()=>{
  if(!active)return;
  const retry=!active.claimSent;
  close(active,retry?'Stopped. You can start this camera again.':'Stopped. Scan a new invite on the TV to reconnect.',retry);
};
window.addEventListener('pagehide',()=>{if(active)close(active,'Closed');});
window.addEventListener('hashchange',()=>location.reload());
if(!validInvite){
  by('start').disabled=true;by('status').textContent='Scan a new camera invite on the TV.';
}else{
  by('angle-name').textContent=camera.label;
  document.title=camera.label+' · FGS Replay Cam';
  by('start').disabled=Date.now()>=expiry;
  by('status').textContent=by('start').disabled?expiredMessage:'Tap Start camera to join the TV.';
}
showOriginals().catch(()=>{by('originals').textContent='Phone storage is unavailable for originals.';});
