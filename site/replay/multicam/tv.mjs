import {renderMock} from './demo-court.mjs';
import {ClockMap,AngleBuffer} from './clock.mjs';
import {call,token,negotiate} from './signaling.mjs';
import {cameras} from './cameras.mjs';
const by=id=>document.getElementById(id);
const slots=cameras.map(({id:cameraId,angle:name,label})=>{
  const node=by(name);
  return {name,cameraId,label,node,canvas:node.querySelector('canvas'),missing:node.querySelector('.missing'),status:node.querySelector('.status'),
    buffer:new AngleBuffer(),room:null,rendered:null,frameJob:0,epoch:0};
});
let demo=false,origin=0,mode='delay',cursor=0,markIn=null,markOut=null,clipId=null;
const session=token().slice(0,16);
function dispose(slot,msg,notify=true) {
  const room=slot.room;
  if(room){
    slot.room=null;room.controller.abort();clearInterval(room.clockTimer);clearTimeout(room.watchdog);
    if(room.video){room.video.pause();room.video.srcObject=null;room.video.remove();}
    room.pc?.close();
    if(notify && room.id)call('/'+room.id+'/end',room.key,{}).catch(()=>{});
  }
  slot.status.textContent=msg;
  slot.node.querySelector('.invite').textContent=room?'New invite':'Invite phone';
}
function receive(slot,room,track) {
  const video=document.createElement('video');
  Object.assign(video,{autoplay:true,muted:true,playsInline:true});video.hidden=true;
  room.video=video;document.body.append(video);video.srcObject=new MediaStream([track]);
  const scratch=document.createElement('canvas'),ctx=scratch.getContext('2d',{alpha:false});
  let busy=false,last=-Infinity,missingSince=0;
  const next=(_,info)=>{
    if(slot.room!==room)return;
    video.requestVideoFrameCallback(next);
    // For remote tracks captureTime is the sender's capture time in the TV
    // clock domain, estimated by WebRTC via RTCP sender reports. mediaTime
    // and callback arrival are intentionally never substituted here.
    const t=info.captureTime,now=performance.now();
    if(!Number.isFinite(t) || t<=0 || t>now+100 || now-t>20000){
      if(!missingSince)missingSince=now;
      if(now-missingSince>600)slot.status.textContent='Direct connected · capture timestamps unavailable';
      return;
    }
    missingSince=0;
    if(busy || t-last<28)return;
    const w=video.videoWidth,h=video.videoHeight;if(!w || !h)return;
    const scale=Math.min(1,960/Math.max(w,h));
    const dw=Math.round(w*scale),dh=Math.round(h*scale);
    if(scratch.width!==dw || scratch.height!==dh){scratch.width=dw;scratch.height=dh;}
    ctx.drawImage(video,0,0,dw,dh);busy=true;last=t;
    scratch.toBlob(blob=>{
      busy=false;
      if(!blob || slot.room!==room)return;
      slot.buffer.add({time:t,size:blob.size,blob,epoch:slot.epoch});
      const fit=room.clock.fit(performance.now());
      slot.status.textContent='Direct · '+w+'×'+h+(fit?' · clock ±'+Math.ceil(fit.uncertainty)+' ms':' · calibrating clock');
    },'image/jpeg',.82);
  };
  if(!video.requestVideoFrameCallback){slot.status.textContent='Browser lacks capture timestamps';return;}
  video.requestVideoFrameCallback(next);
  video.play().catch(()=>{slot.status.textContent='TV browser could not play this camera';});
}
function control(slot,room,channel) {
  if(channel.label!=='replay-clock-v1' || room.channel){channel.close();return;}
  room.channel=channel;
  const probes=new Map();
  function ping() {
    if(channel.readyState!=='open' || slot.room!==room)return;
    const tv=performance.now();probes.clear();probes.set(tv,true);
    channel.send(JSON.stringify({op:'ping',tv}));
  }
  channel.onopen=()=>{ping();room.clockTimer=setInterval(ping,2000);};
  channel.onmessage=e=>{
    if(slot.room!==room || typeof e.data!=='string' || e.data.length>600)return;
    let m;try{m=JSON.parse(e.data);}catch{return;}
    if(m.op==='pong' && probes.delete(m.tv)){
      room.clock.add(m.tv,m.p1,m.p2,performance.now());room.originalStart=m.originalStart;
    }
    if(m.op==='clip-result' && m.id===clipId) {
      room.clipResult=m.ok?'ready on phone':'failed on phone';
      by('clip-status').textContent=slots.map(s=>s.label+' '+(s.room?.clipResult || 'preparing')).join(' · ');
    }
  };
  if(channel.readyState==='open')channel.onopen();
}
async function invite(slot) {
  if(demo)setDemo(false);
  dispose(slot,'Creating private invite…');slot.epoch++;
  const room={controller:new AbortController(),key:token(),clock:new ClockMap()};
  slot.room=room;
  const signal=room.controller.signal;
  try{
    const result=await call('',null,{tvToken:room.key,purpose:'multicam'},signal);
    if(signal.aborted)return;
    if(!result.id?.startsWith('~'))throw Error('Two-camera pairing is unavailable. Create a new invite and try again.');
    Object.assign(room,{id:result.id,expiry:result.expiresAt});
    const url=new URL('phone.html',location.href);
    url.hash=new URLSearchParams({room:room.id,invite:result.invite,camera:slot.cameraId,session,until:String(room.expiry)});
    const qr=globalThis.qrcode(0,'M');qr.addData(url.href);qr.make();
    by('qr').innerHTML=qr.createSvgTag({cellSize:5,margin:20,scalable:true});
    by('phone-link').href=url;by('invite-title').textContent=slot.label+' invite';
    if(!by('invite-dialog').open)by('invite-dialog').showModal();
    slot.status.textContent='Invite ready · waiting for phone';
    slot.node.querySelector('.invite').textContent='Replace invite';
    const pc=new RTCPeerConnection({iceServers:[]});room.pc=pc;
    pc.ontrack=e=>{if(slot.room===room && e.track.kind==='video')receive(slot,room,e.track);};
    pc.ondatachannel=e=>control(slot,room,e.channel);
    pc.onconnectionstatechange=()=>{
      if(slot.room!==room)return;
      if(pc.connectionState==='connected'){
        clearTimeout(room.watchdog);slot.status.textContent='Direct connected · waiting for capture timestamps';
        if(by('phone-link').href===url.href)by('invite-dialog').close();
      } else if(pc.connectionState==='failed')dispose(slot,'Camera disconnected · create a new invite');
      else if(pc.connectionState==='disconnected')slot.status.textContent='Camera interrupted';
    };
    await negotiate(pc,{...room,signal},false);
    if(signal.aborted)return;
    if(pc.connectionState!=='connected')room.watchdog=setTimeout(()=>dispose(slot,'Direct connection timed out · create a new invite'),22000);
  }catch(error){if(!signal.aborted)dispose(slot,error.message);}
}
function setDemo(value) {
  demo=value;mode='delay';origin=performance.now()-3200-Number(by('delay').value)*1000;cursor=3200;markIn=markOut=null;clipId=null;
  by('save').disabled=true;by('clip-status').textContent='';
  by('demo').textContent=value?'Exit demo':'Try synced demo';
  by('mode').textContent=value?'Demo · shared clock':'Direct · same Wi-Fi · prototype';
  for(const s of slots){
    s.rendered=null;s.displayed=null;s.frameJob++;s.canvas.getContext('2d').clearRect(0,0,s.canvas.width,s.canvas.height);
    s.status.textContent=value?'Simulated camera':(s.room?'Live camera':'Waiting for a phone');
  }
}
function blank(slot,message){
  if(slot.rendered!==null){slot.frameJob++;slot.rendered=null;slot.canvas.getContext('2d').clearRect(0,0,slot.canvas.width,slot.canvas.height);}
  slot.displayed=null;slot.canvas.hidden=true;slot.missing.textContent=message;slot.missing.hidden=false;
}
function draw(slot,time){
  if(slot.node.hidden)return;
  if(demo){
    slot.canvas.hidden=false;slot.missing.hidden=true;slot.rendered='demo';
    renderMock(slot.canvas,time/1000,{angle:slot.name});return;
  }
  const frame=slot.buffer.nearest(time);
  if(!frame){blank(slot,demo?'Demo asset unavailable':'Angle unavailable at this time');return;}
  if(Number.isFinite(slot.displayed) && Math.abs(slot.displayed-time)>50){
    slot.displayed=null;slot.canvas.hidden=true;slot.missing.hidden=false;slot.missing.textContent='Loading frame';
  }
  if(slot.rendered===frame)return;
  const seq=++slot.frameJob;slot.rendered=frame;
  createImageBitmap(frame.blob).then(bitmap=>{
    if(slot.frameJob===seq) {
      if(slot.canvas.width!==bitmap.width || slot.canvas.height!==bitmap.height){slot.canvas.width=bitmap.width;slot.canvas.height=bitmap.height;}
      slot.canvas.getContext('2d').drawImage(bitmap,0,0);slot.displayed=frame.time;slot.canvas.hidden=false;slot.missing.hidden=true;
    }
    bitmap.close();
  }).catch(()=>{if(seq===slot.frameJob)blank(slot,'Frame could not be decoded');});
}
let lastTick=performance.now(),lo=0,hi=0;
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
  const range=by('timeline');
  range.disabled=by('pause').disabled=by('step').disabled=by('follow').disabled=!have;
  if(have){range.min=lo;range.max=hi;range.value=cursor;}
  by('position').textContent=have?(demo?(cursor/1000).toFixed(2)+' s':((now-cursor)/1000).toFixed(1)+' s behind live'):'Waiting for capture timestamps';
  by('pause').textContent=mode==='pause'?'Play':'Pause';
  for(const s of slots)draw(s,cursor);
  const both=!demo && slots.every(s=>!s.node.hidden && Number.isFinite(s.displayed));
  by('alignment').textContent=both?'Displayed capture stamps differ by '+Math.round(Math.abs(slots[0].displayed-slots[1].displayed))+' ms':'';
  requestAnimationFrame(refresh);
}
for(const s of slots)s.node.querySelector('.invite').onclick=()=>invite(s);
by('demo').onclick=()=>setDemo(!demo);
by('close').onclick=()=>by('invite-dialog').close();
by('layout').onchange=e=>{
  const view=e.target.value;by('angles').classList.toggle('single',view!=='both');
  for(const s of slots)s.node.hidden=view!=='both' && s.name!==view;
};
by('timeline').oninput=e=>{mode='pause';cursor=Number(e.target.value);};
by('pause').onclick=()=>{mode=mode==='pause'?'play':'pause';};
by('follow').onclick=()=>{mode='delay';};
by('step').onclick=()=>{
  mode='pause';
  const after=slots.flatMap(s=>s.buffer.frames.filter(f=>f.time>cursor+1).slice(0,1).map(f=>f.time));
  cursor=Math.min(hi,demo?cursor+1000/30:after.length?Math.min(...after):hi);
};
function covers(slot,start,end) {
  const room=slot.room,fit=room?.clock.fit(performance.now());
  if(!fit || room.channel?.readyState!=='open' || !Number.isFinite(room.originalStart) || fit.phoneTime(start)<room.originalStart)return false;
  // The full native recording remains continuous when the TV snapshot buffer
  // skips a preview frame. Require a single connected camera epoch that spans
  // the requested time in both local originals.
  const frames=slot.buffer.frames.filter(f=>f.epoch===slot.epoch);
  return frames.length>=2 && start>=frames[0].time && end<=frames.at(-1).time;
}
function mark(which){
  if(which==='start')markIn=cursor;else markOut=cursor;
  const valid=Number.isFinite(markIn)&&Number.isFinite(markOut)&&markOut>markIn;
  by('save').disabled=demo || !valid || !slots.every(s=>covers(s,markIn,markOut));
  by('clip-status').textContent=demo?'Clip export requires two phone originals.':valid?
    ((markOut-markIn)/1000).toFixed(2)+' s'+(by('save').disabled?' · both angles must cover the range':' selected'):'Mark the other end of the interval.';
}
by('mark-in').onclick=()=>mark('start');by('mark-out').onclick=()=>mark('end');
by('save').onclick=()=>{
  if(!slots.every(s=>covers(s,markIn,markOut))){by('clip-status').textContent='Both angles must still cover the range.';return;}
  clipId=crypto.randomUUID();
  for(const s of slots){
    const fit=s.room.clock.fit(performance.now());s.room.clipResult='';
    s.room.channel.send(JSON.stringify({op:'clip',id:clipId,start:fit.phoneTime(markIn),end:fit.phoneTime(markOut)}));
  }
  by('clip-status').textContent='Preparing trimmed originals on both phones';
};
window.addEventListener('pagehide',()=>slots.forEach(s=>dispose(s,'Closed',false)));
requestAnimationFrame(refresh);
