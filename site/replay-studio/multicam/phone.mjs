import {call,token,negotiate} from './signaling.mjs';
import {startOriginal,recordings,loadOriginal} from './originals.mjs';
const by=id=>document.getElementById(id);
const q=new URLSearchParams(location.hash.slice(1));
const id=q.get('room'),invite=q.get('invite'),angle=q.get('angle'),expiry=Number(q.get('until'));
history.replaceState(null,'',location.pathname+location.search);
let active=null;
function saveLink(container,blob,label,file){
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=file;
  a.textContent=label;container.append(a);return a;
}
const extension=blob=>blob.type.includes('mp4')?'mp4':'webm';
async function showOriginals() {
  const rows=await recordings(),container=by('originals');container.replaceChildren();
  if(!rows.length){container.textContent='No originals recorded on this phone.';return;}
  for(const row of rows.reverse()) {
    const b=document.createElement('button');
    b.textContent='Open '+row.angle+' original · '+new Date(row.date).toLocaleTimeString();
    b.onclick=async()=>{
      b.disabled=true;
      try{
        const blob=await loadOriginal(row);
        const link=saveLink(container,blob,'Download '+row.angle+' original','FGS-studio-'+row.angle+'-'+row.date+'.'+extension(blob));
        b.replaceWith(link);
      }catch(error){b.disabled=false;by('status').textContent=error.message;}
    };container.append(b);
  }
}
async function close(room,message){
  if(active!==room)return;active=null;room.controller.abort();clearTimeout(room.watchdog);
  room.pc?.close();room.stream?.getTracks().forEach(t=>t.stop());
  by('camera').srcObject=null;by('start').disabled=true;by('stop').disabled=true;
  by('status').textContent=message;
  if(room.claimed)call('/'+id+'/end',room.key,{}).catch(()=>{});
  try{await room.original?.stop();await showOriginals();}catch(error){by('status').textContent=error.message;}
}
async function start() {
  if(active)return;
  const room={key:token(),controller:new AbortController()};active=room;
  const signal=room.controller.signal;
  by('start').disabled=true;by('stop').disabled=false;
  try{
    if(!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)throw Error('Open this camera link over HTTPS.');
    if(!('MediaRecorder' in window))throw Error('This phone cannot record an original in this browser.');
    if(Date.now()>=expiry)throw Error('This code expired. Request a new invite for this angle.');
    by('status').textContent='Connecting directly…';
    await call('/'+id+'/claim',null,{invite,phoneToken:room.key},signal);room.claimed=true;
    const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{
      facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:60}}});
    if(active!==room){stream.getTracks().forEach(t=>t.stop());return;}
    room.stream=stream;const video=by('camera');video.srcObject=stream;await video.play();
    if(signal.aborted)return;
    room.original=await startOriginal(stream,angle,message=>{by('status').textContent=String(message);});
    if(signal.aborted){await room.original.stop();return;}
    const anchor=(_,m)=>{
      if(active!==room)return;
      room.original.anchor(m.captureTime);room.hasStamp ||= Number.isFinite(m.captureTime) && m.captureTime>0;
      video.requestVideoFrameCallback(anchor);
    };
    video.requestVideoFrameCallback?.(anchor);
    const pc=new RTCPeerConnection({iceServers:[]});room.pc=pc;
    pc.addTransceiver(stream.getVideoTracks()[0],{direction:'sendonly',streams:[stream]});
    const channel=pc.createDataChannel('replay-clock-v1');
    channel.onmessage=async event=>{
      const received=performance.now();
      if(active!==room || typeof event.data!=='string' || event.data.length>600)return;
      let msg;try{msg=JSON.parse(event.data);}catch{return;}
      if(msg.op==='ping' && Number.isFinite(msg.tv)){
        channel.send(JSON.stringify({op:'pong',tv:msg.tv,p1:received,p2:performance.now(),
          originalStart:room.original.start}));
      }else if(msg.op==='clip' && /^[a-f0-9-]{36}$/.test(msg.id) && [msg.start,msg.end].every(Number.isFinite)){
        let ok=false;
        try{
          if(room.exporting)throw Error('A clip is already being prepared.');
          room.exporting=msg.id;
          const blob=await room.original.clip(msg.start,msg.end);
          saveLink(by('clips'),blob,'Download '+angle+' clip','FGS-studio-'+angle+'-'+msg.id+'.'+extension(blob));
          ok=true;by('status').textContent='Matching clip ready. The camera is still recording.';
        }catch(error){by('status').textContent='Clip export · '+error.message;}
        finally{if(room.exporting===msg.id)room.exporting=null;}
        if(channel.readyState==='open')channel.send(JSON.stringify({op:'clip-result',id:msg.id,ok}));
      }
    };
    pc.onconnectionstatechange=()=>{
      if(active!==room)return;
      if(pc.connectionState==='connected'){
        clearTimeout(room.watchdog);by('status').textContent='Direct · recording original'+(room.hasStamp?'':' · checking source timestamps');
      }else if(pc.connectionState==='disconnected'){
        by('status').textContent='Direct connection interrupted';
        clearTimeout(room.watchdog);room.watchdog=setTimeout(()=>close(room,'Disconnected. Scan a new invite for this angle.'),8000);
      }else if(pc.connectionState==='failed')close(room,'Disconnected. Scan a new invite for this angle.');
    };
    await negotiate(pc,{id,key:room.key,expiry,signal},true);
    if(!signal.aborted && pc.connectionState!=='connected')room.watchdog=setTimeout(()=>close(room,'Direct connection timed out. Scan a new invite.'),22000);
  }catch(error){if(!signal.aborted)await close(room,error.message);}
}
by('start').onclick=start;by('stop').onclick=()=>active && close(active,'Stopped. Your original is available below.');
window.addEventListener('pagehide',()=>{if(active)close(active,'Closed');});
if(!/^~[A-Za-z0-9_-]{21}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(invite) ||
  !['baseline','sideline'].includes(angle) || !Number.isFinite(expiry)){
  by('start').disabled=true;by('status').textContent='Scan a new camera invite on the TV.';
}else by('angle-name').textContent=angle[0].toUpperCase()+angle.slice(1)+' camera';
showOriginals().catch(()=>{by('status').textContent='Phone storage is unavailable for originals.';});
