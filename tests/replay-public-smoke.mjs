// Requires desktop Chrome and Node 20+. No real camera, screenshots or artifacts.
// Direct execution requires an explicit --public flag. Import runs nothing.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const site='https://www.fernandezgrowthsystems.com';
const api='https://sitereview.fernandezgrowthsystems.com/api/replay-pair';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Everything identifying the disposable session stays inside the browser.
function instrument(side, service) {
  const fetchRaw=window.fetch.bind(window), tracks=[], peers=[], seen=new Map();
  let created=0, accepted=0, received=0, stopped=false, sourceRequests=0, token, room, creating;
  window.fetch=async function(input,init) {
    const url=new URL(typeof input==='string' ? input : input.url || input,location.href);
    const method=(init?.method || input?.method || 'GET').toUpperCase();
    if (side==='tv' && url.href===service && method==='POST') {
      if (++created!==1) throw new Error('This check permits one pairing.');
      token=JSON.parse(init.body).tvToken;
      const response=await fetchRaw(input,init);
      if (response.ok) {
        creating=response.clone().json().then(value=>{room=value.id;});
        await creating;
      }
      return response;
    }
    const response=await fetchRaw(input,init);
    if (url.origin===new URL(service).origin && url.pathname.endsWith('/relay-chunk') && response.ok && response.status!==204) {
      if (method==='POST') accepted++;
      if (method==='GET') received++;
    }
    return response;
  };
  const Native=window.RTCPeerConnection;
  if (Native) window.RTCPeerConnection=class extends Native {
    constructor(config={},...rest) {
      super({...config,iceServers:[],iceTransportPolicy:'relay'},...rest);
      peers.push(this);
    }
  };
  const realCamera=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async constraints=>{
    sourceRequests++;
    if (side!=='phone' || sourceRequests!==1 || constraints.audio) throw new Error('Camera request outside test scope.');
    const source=await realCamera(constraints);
    tracks.push(...source.getTracks());
    const video=document.createElement('video');video.muted=true;video.playsInline=true;video.srcObject=source;
    await video.play();
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
    const ctx=canvas.getContext('2d'), t0=performance.now();
    function paint() {
      ctx.drawImage(video,0,0,320,180);
      const n=Math.floor((performance.now()-t0)/600)%8, a=n>>2,b=(n>>1)&1,c=n&1;
      [1,0,1,a,b,c,1-c,0].forEach((v,i)=>{
        ctx.fillStyle=v?'white':'black';ctx.fillRect(32+32*i,63,32,54);
      });
    }
    paint();
    const clock=setInterval(paint,75), marked=canvas.captureStream(14);
    const track=marked.getVideoTracks()[0],stop=track.stop.bind(track);
    track.stop=()=>{clearInterval(clock);source.getTracks().forEach(t=>t.stop());video.pause();video.srcObject=null;stop();};
    tracks.push(track);
    return marked;
  };
  const sample=document.createElement('canvas');sample.width=80;sample.height=24;
  const ctx=sample.getContext('2d',{willReadFrequently:true});
  function marker(id, direction) {
    const el=document.getElementById(id);
    // The live source is intentionally hidden behind the main replay display.
    if (!el || (el instanceof HTMLCanvasElement && el.hidden) ||
        (el instanceof HTMLVideoElement && (!el.videoWidth || el.readyState<2))) return 0;
    ctx.drawImage(el,0,0,80,24);
    const data=ctx.getImageData(0,12,80,1).data;
    const bits=Array.from({length:8},(_,i)=>{
      const offset=(12+8*i)*4,luma=(data[offset]+data[offset+1]+data[offset+2])/3;
      return luma<58?0:luma>197?1:-1;
    });
    function decode(b) {
      return b.includes(-1)||b[0]!==1||b[1]!==0||b[2]!==1||b[6]!==1-b[5]||b[7]!==0?null:b[3]*4+b[4]*2+b[5];
    }
    const value=direction==='mirror' ? decode(bits.slice().reverse()) : (decode(bits)??decode(bits.slice().reverse()));
    id=id+'/'+(direction||'either');
    if (!seen.has(id)) seen.set(id,new Set());
    if (value!==null) seen.get(id).add(value);
    return seen.get(id).size;
  }
  async function release() {
    for(const track of tracks)if(track.readyState!=='ended')track.stop();
    if(side!=='tv')return true;
    await creating;
    if(!room || !token)return created===0;
    const opts={headers:{Authorization:'Bearer '+token},cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'};
    const bounded=()=>AbortSignal.timeout(4500);
    const end=await fetchRaw(service+'/'+room+'/end',{...opts,method:'POST',signal:bounded()});
    const state=await fetchRaw(service+'/'+room,{...opts,signal:bounded()});
    stopped=(end.ok || end.status===410) && state.status===410;
    return stopped;
  }
  async function directFrames(){
    let total=0;
    for(const peer of peers)(await peer.getStats()).forEach(s=>{
      if(s.type==='inbound-rtp' && (s.kind||s.mediaType)==='video')total+=s.framesDecoded||0;
    });
    return total;
  }
  window.__smoke={marker,release,directFrames,counts:()=>({created,accepted,received,sourceRequests,
    ended:tracks.length>0 && tracks.every(t=>t.readyState==='ended')})};
}

// Also imported by the existing local fixture to validate this same interaction.
export default async function scenario({tv,phone}) {
  let phase='browser setup', cleanup=false, failure, statistics;
  const stage=value=>{phase=value;console.log('Checking '+value);};
  try{
    for(const [tab,side] of [[tv,'tv'],[phone,'phone']]){
      await tab.send('Page.addScriptToEvaluateOnNewDocument',{source:'('+instrument.toString()+')('+JSON.stringify(side)+','+JSON.stringify(api)+');'});
    }
    stage('TV room creation');
    await tv.navigate(site+'/replay/tv/');
    await tv.until("window.FGSReplayRelay && document.querySelector('#tv-phone-link')?.hash?.startsWith('#pair=')",'TV room',18000);
    // Never print the private link, the document, raw network URLs or Chrome errors.
    const invite=await tv.get("document.querySelector('#tv-phone-link').href");
    if (new URL(invite).origin!==site || new URL(invite).pathname!=='/replay/tv/phone.html') throw Error();
    stage('paired phone camera');
    await phone.navigate(invite);
    await phone.until("window.FGSReplayRelay && typeof document.getElementById('phone-start')?.onclick==='function'",'phone controls',16000);
    await phone.until("window.FGSPhoneCamera && !document.getElementById('phone-camera-settings').open && document.getElementById('phone-rotate')",'updated compact phone camera',10000);
    await phone.click('phone-start');
    await phone.until("__smoke.counts().sourceRequests===1 && document.getElementById('phone-preview').srcObject",'simulated camera',16000);
    stage('relay consent');
    await phone.until("!document.getElementById('phone-relay').hidden && !document.getElementById('relay-consent').disabled",'fallback option',25000);
    if ((await phone.get('__smoke.counts()')).accepted!==0) throw Error();
    await phone.click('relay-consent');
    stage('decoded relay motion');
    await tv.until("__smoke.marker('liveVideo')>=3",'changing live camera markers',35000);
    await tv.until("!document.getElementById('reviewRange').disabled && !document.getElementById('tv-pair-dialog').open",'TV dashboard',15000);
    await tv.get("(()=>{const el=document.getElementById('delayRange');el.value=1;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()");
    stage('delayed replay motion');
    await tv.until("Math.max(__smoke.marker('delayedVideo'),__smoke.marker('delayedCanvas'))>=3",'changing delayed camera markers',20000);
    stage('compact replay controls');
    const layout=await tv.get("(()=>{const viewer=document.getElementById('viewer');const size=document.getElementById('replaySize');const area=()=>viewer.clientWidth*viewer.clientHeight;const change=v=>{size.value=v;size.dispatchEvent(new Event('change',{bubbles:true}));};const initial=size.value;const large=area();change('standard');const standard=area();change('large');return {initial,large,standard,compact:document.getElementById('toggleReplayControls').getAttribute('aria-expanded')==='false'};})()");
    if(layout.initial!=='large'||!layout.compact||layout.large<layout.standard*1.15)throw Error('Replay sizing');
    stage('mirrored delayed phone video');
    await phone.click('phone-mirror');
    await tv.until("Math.max(__smoke.marker('delayedVideo','mirror'),__smoke.marker('delayedCanvas','mirror'))>=3",'mirrored delayed frames',25000);
    const sender=await phone.get('__smoke.counts()'), receiver=await tv.get('__smoke.counts()');
    if(receiver.created!==1 || receiver.sourceRequests!==0 || (await tv.get('__smoke.directFrames()'))!==0 || sender.accepted<1 || receiver.received<1)throw Error();
    statistics={rooms:receiver.created,encryptedPacketsSent:sender.accepted,encryptedPacketsReceived:receiver.received,delayedMotion:true,mirroredDelayedFrames:true,defaultLayout:layout};
    stage('normal disconnect');
    await phone.click('phone-stop');
    await phone.until('__smoke.counts().ended','simulated camera released',13000);
  }catch{failure=phase;
    for(const [side,tab] of [['TV',tv],['phone',phone]]){
      const state=await tab.get("({correctOrigin:location.origin==='https://www.fernandezgrowthsystems.com',ready:document.readyState,newPlayer:!!document.getElementById('replaySize'),pairDialog:!!document.getElementById('tv-pair-dialog'),hasInvite:!!document.getElementById('tv-phone-link')?.hash,phoneModule:!!window.FGSPhoneCamera,phoneSettings:!!document.getElementById('phone-camera-settings'),relay:!!window.FGSReplayRelay})").catch(()=>null);
      console.log(side+' page state',JSON.stringify(state));
    }
  }
  finally{
    // A room can already exist even when the expected phone controls did not load.
    await phone.get('window.__smoke?.release()').catch(()=>false);
    cleanup=await tv.get('window.__smoke?.release()').catch(()=>false);
  }
  if(failure || !cleanup)throw Error('Smoke check stopped during '+(failure||'cleanup')+'. Room closure '+(cleanup?'confirmed.':'unconfirmed.'));
  console.log('PASS',JSON.stringify({...statistics,cameraReleased:true,roomClosed:true}));
}

async function runPublic() {
  for(const slug of ['/replay/','/replay/tv/phone.html']) {
    const result=await fetch(site+slug,{signal:AbortSignal.timeout(10000)});
    const html=await result.text();
    console.log('Release HTML',slug,result.status,{player:html.includes('id="replaySize"'),phone:html.includes('id="phone-mirror"'),versioned:html.includes('phone-camera.js?v=')||html.includes('js/dashboard-v11.js?v=')});
  }
  const binary=process.env.FGS_CHROME_BIN || [
    path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
  if(!binary || !existsSync(binary)) throw Error('Chrome executable unavailable.');
  const profile=await mkdtemp(path.join(tmpdir(),'replay-public-check-'));
  const child=spawn(binary,['--headless=new','--no-sandbox','--no-first-run','--no-default-browser-check','--disable-gpu',
    '--disable-background-networking','--disable-component-update','--disable-breakpad','--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--remote-debugging-pipe','--user-data-dir='+profile],
    {stdio:['ignore','ignore','ignore','pipe','pipe'],windowsHide:true});
  const exited=once(child,'exit').catch(()=>{});
  let serial=0, partial='', interrupted=false;
  const jobs=new Map();
  function cancel(){interrupted=true;}
  process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  function call(method,params={},sessionId){
    return new Promise((resolve,reject)=>{
      const id=++serial;
      const timer=setTimeout(()=>{jobs.delete(id);reject(Error('Chrome command timed out.'));},35000);
      jobs.set(id,{finish:m=>{clearTimeout(timer);jobs.delete(id);if(m.error)reject(Error('Chrome command failed.'));else resolve(m.result);}});
      child.stdio[3].write(JSON.stringify({id,method,params,sessionId})+'\0',error=>{
        if(error)jobs.get(id)?.finish({error:true});
      });
    });
  }
  child.stdio[3].on('error',()=>{});
  child.stdio[4].setEncoding('utf8').on('data',chunk=>{
    partial+=chunk;let end;
    while((end=partial.indexOf('\0'))>=0) {
      const msg=JSON.parse(partial.slice(0,end));partial=partial.slice(end+1);
      if(msg.id)jobs.get(msg.id)?.finish(msg);
    }
  });
  async function tab(width,height,phone) {
    const {browserContextId}=await call('Target.createBrowserContext');
    const {targetId}=await call('Target.createTarget',{url:'about:blank',browserContextId});
    const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
    const send=(method,params={})=>call(method,params,sessionId);
    await send('Page.enable');await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride',{width,height,mobile:phone,deviceScaleFactor:1});
    if(phone)await call('Browser.grantPermissions',{browserContextId,origin:site,permissions:['videoCapture']});
    async function get(expression){
      const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});
      if(r.exceptionDetails)throw Error('Browser check failed.');
      return r.result.value;
    }
    async function until(expression,label,ms){
      const end=Date.now()+ms;
      while(Date.now()<end && !interrupted){if(await get(expression).catch(()=>false))return;await sleep(170);}
      throw Error('Step did not complete.');
    }
    async function click(id){
      if(interrupted)throw Error('Stopped.');
      const point=await get("(()=>{const el=document.getElementById("+JSON.stringify(id)+");if(!el||el.disabled)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return el.contains(document.elementFromPoint(x,y))?{x,y}:null;})()");
      if(!point)throw Error('Control unavailable.');
      for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
    }
    return {send,get,until,click,navigate:url=>send('Page.navigate',{url})};
  }
  try{await scenario({tv:await tab(1000,720,false),phone:await tab(390,844,true)});}
  finally{
    process.off('SIGINT',cancel);process.off('SIGTERM',cancel);
    child.stdio[3].end();
    const watchdog=setTimeout(()=>child.kill(),3000);
    await exited;clearTimeout(watchdog);
    await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  if(process.argv.length!==3 || process.argv[2]!=='--public'){
    console.error('No network check started. Pass --public to test the deployed site once.');process.exitCode=2;
  }else{
    try{await runPublic();}
    catch(error){console.error(/^Smoke check stopped during [A-Za-z ]+\. Room closure (unconfirmed|confirmed)\.$/.test(error.message)?error.message:'Smoke runner stopped ('+(error.name==='TypeError'?'network or runtime':error.code==='ENOENT'?'file missing':'runner')+').');process.exitCode=1;}
  }
}
