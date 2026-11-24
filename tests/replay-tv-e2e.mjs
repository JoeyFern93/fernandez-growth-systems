// Node 24 + Chrome. All requests are intercepted in disposable browser contexts.
// The Chrome capture-device simulator supplies video. Its physical devices are unused.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {webcrypto} from 'node:crypto';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath,pathToFileURL} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const site='https://www.fernandezgrowthsystems.com';
const api='https://sitereview.fernandezgrowthsystems.com';
const probeOnly=process.argv.includes('--test-browser');
const manualRelay=process.argv.includes('--manual-relay');
const relayScenario=manualRelay || process.argv.includes('--relay');
const controlsScenario=process.argv.includes('--controls');
const temps=await mkdtemp(path.join(process.env.REPLAY_QA_TEMP||os.tmpdir(),'fgs-tv-check-'));
const output=process.env.REPLAY_QA_PROOF || path.join(here,'replay-tv-proof');
await mkdir(output,{recursive:true});
const roots=process.env.REPLAY_SITE_ROOT?[path.resolve(process.env.REPLAY_SITE_ROOT)]:[
  'replay-fps-release/site','replay-release/site','replay-base/site','../work-favicon-rounded-2026-11-15/repo/site',
  '../work-replay-ux-2026-11-16/repo/site','../fgs-site-review-integration/site'
].map(x=>path.resolve(here,x));
const workerRoot=process.env.REPLAY_WORKER_ROOT||path.resolve(here,'../fgs-site-review-build');
globalThis.crypto??=webcrypto;
const worker=(await import(pathToFileURL(path.join(workerRoot,'worker.js')))).default;

// CI uses Node's built-in SQLite; Node 20 can use the local Python fixture.
async function openDB(){
  try{
    const {DatabaseSync}=await import('node:sqlite');
    const db=new DatabaseSync(':memory:');await db.exec(await readFile(path.join(workerRoot,'schema.sql'),'utf8'));
    class Query{
      constructor(sql,args=[]){this.sql=sql;this.args=args;}
      bind(...args){return new Query(this.sql,args);}
      first(key){const row=db.prepare(this.sql).get(...this.args)||null;return key?row?.[key]??null:row;}
      all(){return {results:db.prepare(this.sql).all(...this.args)};}
      run(){const before=db.prepare('SELECT total_changes() n').get().n;const results=db.prepare(this.sql).all(...this.args);
        return {results,meta:{changes:db.prepare('SELECT total_changes() n').get().n-before}};}
    }
    return {prepare:sql=>new Query(sql),exec:sql=>db.exec(sql),batch:rows=>{
      db.exec('BEGIN');try{const value=rows.map(r=>r.run());db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}
    },close:()=>db.close()};
  }catch(e){if(e.code!=='ERR_UNKNOWN_BUILTIN_MODULE')throw e;}
  const p=spawn('python',['-u',path.join(here,'sqlite_adapter.py'),':memory:'],{stdio:['pipe','pipe','inherit'],windowsHide:true});
  const pending=[];readline.createInterface({input:p.stdout}).on('line',line=>{
    const msg=JSON.parse(line),job=pending.shift();msg.error?job.reject(Error(msg.error)):job.resolve(msg.value);
  });
  function sql(obj){return new Promise((resolve,reject)=>{pending.push({resolve,reject});p.stdin.write(JSON.stringify(obj)+'\n');});}
  class Query{
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...args){return new Query(this.sql,args);}
    async all(){return (await sql({statements:[this]}))[0];}
    run(){return this.all();}
    async first(key){const row=(await this.all()).results[0]||null;return key?row?.[key]??null:row;}
  }
  await sql({schema:await readFile(path.join(workerRoot,'schema.sql'),'utf8')});
  return {prepare:q=>new Query(q),exec:schema=>sql({schema}),batch:statements=>sql({statements}),
    close:()=>p.stdin.end()};
}
const db=await openDB(), taskErrors=[], requests=[];
const rounds=[];
const chrome=process.env.FGS_CHROME_BIN||[path.join(process.env.ProgramFiles||'','Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
assert(chrome,'Set FGS_CHROME_BIN to a local Chrome executable');
const cameraFixture=[];
if(controlsScenario){
  const {writeTestCamera}=await import('./replay-tv-controls.mjs');
  const fixture=path.join(temps,'replay-camera.y4m');
  await writeTestCamera(fixture);
  cameraFixture.push('--use-file-for-fake-video-capture='+fixture);
}
const child=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check',
  '--disable-background-networking','--disable-component-update','--autoplay-policy=no-user-gesture-required',
  '--host-resolver-rules=MAP * ~NOTFOUND','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',
  '--allow-loopback-in-peer-connection','--disable-features=WebRtcHideLocalIpsWithMdns',
  ...cameraFixture,'--remote-debugging-pipe','--user-data-dir='+path.join(temps,'profile')],
  {stdio:['ignore','ignore','ignore','pipe','pipe'],windowsHide:true});
const finished=once(child,'exit');let serial=0,tail='',closing=false;
const jobs=new Map();const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function cdp(method,params={},sessionId){
  if(closing)return Promise.reject(new Error('Browser is closing'));
  const id=++serial;return new Promise((resolve,reject)=>{jobs.set(id,{resolve,reject});
    child.stdio[3].write(JSON.stringify({id,method,params,sessionId})+'\0');});
}
const mime={html:'text/html',js:'text/javascript',css:'text/css',png:'image/png',svg:'image/svg+xml',
  ico:'image/x-icon',woff2:'font/woff2',webmanifest:'application/manifest+json'};
async function route({request,requestId},sessionId){
  const url=new URL(request.url);
  let response;
  if(url.origin===api && /^\/api\/replay-pair(?:\/|$)/.test(url.pathname)){
    const headers=new Headers(request.headers);headers.set('CF-Connecting-IP','203.0.113.42');
    // CDP's text field is not a binary-safe representation of encrypted video.
    const entries=request.postDataEntries;
    const body=entries?.length && entries.every(part=>typeof part.bytes==='string')
      ? Buffer.concat(entries.map(part=>Buffer.from(part.bytes,'base64')))
      : request.postData||undefined;
    const req=new Request(url,{method:request.method,headers,body});
    response=await worker.fetch(req,{DB:db},{waitUntil:task=>Promise.resolve(task).catch(e=>taskErrors.push(e.message))});
    requests.push({op:url.pathname.split('/').filter(Boolean).at(-1).replace(/^[A-Za-z0-9_-]{16,}$/,'poll'),verb:request.method,status:response.status});
    if(url.pathname==='/api/replay-pair' && request.method==='POST' && response.status===201){
      const value=await response.clone().json();
      rounds.push({...value,tvToken:JSON.parse(request.postData).tvToken});
    }
  }else if(url.origin===site){
    if(probeOnly)response=new Response('<!doctype html><title>RTC isolation check</title>',{headers:{'Content-Type':'text/html'}});
    else{
      let name=url.pathname.replace(/^\//,'');
      if(name.endsWith('/'))name+='index.html';
      else if(!path.extname(name))name+='.html';
      const found=roots.map(root=>path.join(root,name)).find(existsSync);
      response=found?new Response(await readFile(found),{headers:{'Content-Type':mime[path.extname(name).slice(1)]||'application/octet-stream'}}):new Response('missing local asset',{status:404});
    }
  }else throw Error('Unexpected external resource '+url.origin);
  const body=Buffer.from(await response.arrayBuffer()).toString('base64');
  await cdp('Fetch.fulfillRequest',{requestId,responseCode:response.status,
    responseHeaders:[...response.headers].map(([name,value])=>({name,value})),body},sessionId);
}
child.stdio[4].setEncoding('utf8').on('data',chunk=>{
  tail+=chunk;let at;
  while((at=tail.indexOf('\0'))!==-1){
    const message=JSON.parse(tail.slice(0,at));tail=tail.slice(at+1);
    if(message.id){
      const job=jobs.get(message.id);if(!job)continue;jobs.delete(message.id);
      message.error?job.reject(Error(JSON.stringify(message.error))):job.resolve(message.result);
    }else if(message.method==='Fetch.requestPaused'){
      route(message.params,message.sessionId).catch(e=>{
        // Closing a pairing intentionally aborts its polling request.
        if(closing||e.message.includes('Invalid InterceptionId'))return;
        taskErrors.push(e.message);cdp('Fetch.failRequest',{requestId:message.params.requestId,errorReason:'BlockedByClient'},message.sessionId).catch(()=>{});
      });
    }else if(message.method==='Runtime.exceptionThrown')taskErrors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
  }
});
// Record only diagnostics. Force local ICE by removing external STUN/TURN in the
// two disposable contexts. Connection establishment and media encoding are native.
const observe=`(() => {
  const pcs=[],tracks=[],requests=[];
  const RTC=window.RTCPeerConnection;
  window.RTCPeerConnection=class extends RTC {constructor(configuration,...rest){
    super({...configuration,iceServers:[],iceTransportPolicy:${relayScenario&&!manualRelay?"'relay'":"'all'"}},...rest);
    pcs.push(this);
  }};
  const media=navigator.mediaDevices;
  const open=media.getUserMedia.bind(media);
  media.getUserMedia=async constraints=>{requests.push({video:!!constraints.video,audio:!!constraints.audio});
    const stream=await open(constraints);tracks.push(...stream.getTracks());return stream;};
  window.__inspectMedia=async()=>{
    const received=[];
    for(const pc of pcs){
      const stats=await pc.getStats();
      stats.forEach(s=>{if(s.type==='inbound-rtp'&&(s.kind||s.mediaType)==='video')received.push({frames:s.framesDecoded||0,bytes:s.bytesReceived||0,width:s.frameWidth,height:s.frameHeight});});
    }
    return {requests,tracks:tracks.map(t=>({kind:t.kind,state:t.readyState})),connections:pcs.map(p=>({
      connection:p.connectionState,ice:p.iceConnectionState,gathering:p.iceGatheringState,
      localCandidates:(p.localDescription?.sdp||'').split('a=candidate:').length-1,remoteCandidates:(p.remoteDescription?.sdp||'').split('a=candidate:').length-1})),received};
  };
})()`;
async function tab(width,height,mobile=false){
  const {browserContextId}=await cdp('Target.createBrowserContext');
  const {targetId}=await cdp('Target.createTarget',{url:'about:blank',browserContextId});
  const {sessionId}=await cdp('Target.attachToTarget',{targetId,flatten:true});
  const send=(m,p)=>cdp(m,p,sessionId);
  await send('Page.enable');await send('Runtime.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]});await send('Network.setBypassServiceWorker',{bypass:true});
  await send('Emulation.setDeviceMetricsOverride',{width,height,mobile,deviceScaleFactor:1});
  await send('Emulation.setTouchEmulationEnabled',{enabled:mobile,maxTouchPoints:mobile?5:1});
  await send('Page.addScriptToEvaluateOnNewDocument',{source:observe});
  await cdp('Browser.grantPermissions',{browserContextId,origin:site,permissions:['videoCapture']});
  async function get(exp){const r=await send('Runtime.evaluate',{expression:exp,awaitPromise:true,returnByValue:true,userGesture:true});
    if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
  async function until(exp,label,ms=20000){
    const end=Date.now()+ms;while(Date.now()<end){try{const value=await get(exp);if(value)return value;}catch{}await delay(100);}
    const state=await get("({path:location.origin+location.pathname,media:typeof navigator.mediaDevices,observer:typeof __inspectMedia,title:document.title,tv:document.getElementById('tv-pair-status')?.textContent,phone:document.getElementById('phone-status')?.textContent,viewer:document.getElementById('reviewPosition')?.textContent})");
    throw Error('Timeout waiting for '+label+'; '+JSON.stringify(state)+'; requests '+JSON.stringify(requests.slice(-8))+'; '+taskErrors.join(','));
  }
  async function click(id){
    if(id==='pairTvBtn' || id==='nextFrameBtn'){
      const insideClosedDrawer=await get("(()=>{const button=document.getElementById("+JSON.stringify(id)+"),drawer=document.getElementById('toggleReplayControls');return button && !button.getClientRects().length && drawer?.getAttribute('aria-expanded')==='false';})()");
      if(insideClosedDrawer)await click('toggleReplayControls');
    }
    const pos=await get("(()=>{const el=document.getElementById("+JSON.stringify(id)+");if(!el||el.disabled)return null;el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);return r.width>0 && r.height>0 && (hit===el||el.contains(hit)) ? {x,y}:null;})()");
    assert(pos,'Unreachable control '+id);
    if(mobile){await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,...pos}]});await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
    else for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,...pos,button:'left',clickCount:1});
  }
  return {send,get,until,click,navigate:url=>send('Page.navigate',{url}),shot:async name=>{
    const {data}=await send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(output,name+'.png'),Buffer.from(data,'base64'));
  }};
}
let tv,phone;
try{
  tv=await tab(1280,720);phone=await tab(390,844,true);
  if(controlsScenario){
    const {runControls}=await import('./replay-tv-controls.mjs');
    await runControls({tv,phone,site,db,rounds,requests,relayScenario,taskErrors,delay});
  }else if(relayScenario){
    const {default:runRelay}=await import('./replay-tv-relay.mjs');
    await runRelay({tv,phone,site,api,db,requests,rounds,worker,workerEnv:{DB:db},taskErrors,output,delay,manualRelay});
  }else if(probeOnly){
    await Promise.all([tv.navigate(site+'/'),phone.navigate(site+'/')]);
    await Promise.all([tv.until('!!window.__inspectMedia','TV setup'),phone.until('!!window.__inspectMedia','phone setup')]);
    const offer=await phone.get(`(async()=>{window.p=new RTCPeerConnection();window.s=await navigator.mediaDevices.getUserMedia({video:true,audio:false});p.addTrack(s.getVideoTracks()[0],s);await p.setLocalDescription(await p.createOffer());const end=performance.now()+5000;while(p.iceGatheringState!=='complete' && performance.now()<end)await new Promise(r=>setTimeout(r,40));return p.localDescription.toJSON();})()`);
    const answer=await tv.get(`(async()=>{window.p=new RTCPeerConnection();p.ontrack=e=>{const v=document.createElement('video');v.autoplay=true;v.muted=true;v.srcObject=e.streams[0];document.body.append(v);};await p.setRemoteDescription(${JSON.stringify(offer)});await p.setLocalDescription(await p.createAnswer());const end=performance.now()+5000;while(p.iceGatheringState!=='complete' && performance.now()<end)await new Promise(r=>setTimeout(r,40));return p.localDescription.toJSON();})()`);
    await phone.get('p.setRemoteDescription('+JSON.stringify(answer)+')');
    const received=await tv.until("window.__inspectMedia().then(v=>v.received.find(x=>x.frames>=3))",'native peer media');
    console.log('Local real WebRTC confirmed',received);process.exitCode=0;
  }else{
    await tv.navigate(site+'/replay/tv/');
    const link=await tv.until("document.querySelector('#tv-phone-link')?.href?.includes('#pair=') && document.querySelector('#tv-phone-link').href",'TV pairing link');
    assert.equal(new URL(link).pathname,'/replay/tv/phone');assert.match(new URL(link).hash,/^#pair=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}&key=[A-Za-z0-9_-]{43}$/);
    const qr=await tv.until("(()=>{const q=document.querySelector('#tv-qr'), e=q?.matches('svg,img,canvas')?q:q?.querySelector('svg,img,canvas');if(!e)return false;const b=e.getBoundingClientRect();return b.width>60&&b.height>60?{width:b.width,height:b.height,kind:e.tagName}:false;})()",'visible QR');
    await tv.shot('tv-pair');await phone.navigate(link);await phone.until("typeof document.querySelector('#phone-start')?.onclick==='function'",'phone ready to start');
    assert.equal((await phone.get('__inspectMedia()')).requests.length,0,'the invite must wait for a phone tap');
    await phone.shot('phone-before-camera');await phone.click('phone-start');
    const inbound=await tv.until("__inspectMedia().then(v=>v.received.find(x=>x.frames>=12 && x.bytes>0))",'decoded TV video',35000);
    const sender=await phone.get('__inspectMedia()');assert(sender.requests.length>=1 && sender.requests.every(r=>r.video && !r.audio));
    assert(sender.tracks.some(t=>t.kind==='video'&&t.state==='live'));assert((await tv.get('__inspectMedia()')).requests.length===0,'TV must not request camera');
    await tv.until("!document.getElementById('reviewRange')?.disabled && document.querySelector('#tv-pair-dialog')?.open!==true",'TV replay buffer',30000);
    await tv.get("(()=>{const n=document.getElementById('delayRange');n.value='1';n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await tv.until("document.getElementById('delayValue')?.textContent.includes('1') && !document.getElementById('nextFrameBtn')?.disabled",'delay and frame controls');
    const review=await tv.get("(()=>{const v=document.getElementById('delayedVideo'),s=document.getElementById('reviewRange');s.value=Number(s.max)*.5+Number(s.min)*.5;s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));return {start:Number(s.value),max:Number(s.max),time:v.currentTime};})()");
    await tv.until("document.getElementById('delayedVideo').paused",'paused TV review');
    const position=()=>tv.get("({time:document.getElementById('delayedVideo').currentTime,range:Number(document.getElementById('reviewRange').value)})");
    const before=await position();await tv.click('nextFrameBtn');await tv.until("document.getElementById('delayedVideo').currentTime>"+before.time+" || Number(document.getElementById('reviewRange').value)>"+before.range,'single frame step');
    const after=await position();await tv.shot('tv-delayed-replay');await phone.shot('phone-streaming');
    await tv.click('pairTvBtn');await tv.until("document.getElementById('tv-pair-dialog').open",'TV pairing controls');await tv.click('tv-end');
    const ended=await phone.until("__inspectMedia().then(v=>v.tracks.length && v.tracks.every(t=>t.state==='ended') && v)",'phone camera release',35000);
    async function pairState(round){
      return worker.fetch(new Request(api+'/api/replay-pair/'+round.id,{headers:{Origin:site,Authorization:'Bearer '+round.tvToken}}),{DB:db},{waitUntil:()=>{}});
    }
    assert.equal(rounds.length,1);
    assert.equal((await pairState(rounds[0])).status,410,'the disconnected pairing must be revoked');
    // Open pairing from a dashboard which is already running its own demo.
    // The first journey opened the dedicated TV URL directly.
    await tv.navigate(site+'/replay/');
    await tv.until("document.querySelector('#startDemoBtn') && document.readyState==='complete'",'ordinary camera dashboard');
    await tv.click('startDemoBtn');await tv.until("!document.getElementById('stopBtn').disabled",'running demonstration');
    await tv.click('pairTvBtn');
    await tv.until("document.querySelector('#tv-phone-link')?.href?.includes('#pair=')",'pair from the running camera controls');
    const newRound=rounds[1];assert(newRound && rounds[0].id!==newRound.id);
    assert(newRound.expiresAt-Date.now()>=590000 && newRound.expiresAt-Date.now()<=600000,'new invites must have a ten-minute TTL');
    const now=Date.now;let expiryStatus;
    try{
      Date.now=()=>newRound.expiresAt+1;
      expiryStatus=(await pairState(newRound)).status;
    }finally{Date.now=now;}
    assert([404,410].includes(expiryStatus),'expired pairing cannot be reused');
    await tv.click('tv-close');await tv.click('stopBtn');
    assert(!taskErrors.length,taskErrors.join('\n'));
    assert.equal(requests.filter(r=>r.op==='relay-chunk' && r.verb==='POST').length,0,'direct video must avoid relay uploads');
    const proof={qr,inbound,directRelayUploads:0,tapsAfterStart:0,recordingRequests:sender.requests,cameraTracksAfterDisconnect:ended.tracks,review,before,after,
      dialog:'TV QR opens phone invite; camera needs a separate tap',entryPoints:['TV URL','running dashboard'],
      revoked:410,expired:expiryStatus,workerRequests:requests.map(r=>r.verb+' '+r.op+' '+r.status)};
    await writeFile(path.join(output,'results.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
  }
}catch(error){console.error('Browser errors',taskErrors);
 for(const [name,screen] of [['tv',tv],['phone',phone]])if(screen){console.error(name+' instrument',await screen.get('window.__inspectMedia?.()').catch(()=>null));await screen.shot(name+'-diagnostic').catch(()=>{});}
 throw error;}
finally{closing=true;child.stdio[3].end();await finished;await db.close();await rm(temps,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
