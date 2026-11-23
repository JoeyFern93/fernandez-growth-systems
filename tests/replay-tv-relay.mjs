import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';

// A changing optical marker is composited over Chrome's actual camera simulator.
// Reading it from both receiver videos proves source identity and frame motion.
function decorateCamera() {
  const getCamera=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async constraints=>{
    const native=await getCamera(constraints);
    const camera=document.createElement('video');
    camera.autoplay=true;camera.muted=true;camera.playsInline=true;camera.srcObject=native;
    await camera.play();
    const canvas=document.createElement('canvas');
    canvas.width=320;canvas.height=180;
    const ctx=canvas.getContext('2d',{alpha:false});
    const t0=performance.now();
    function paint(){
      ctx.drawImage(camera,0,0,320,180);
      const n=Math.floor((performance.now()-t0)/650)%8;
      const a=n>>2,b=(n>>1)&1,c=n&1;
      const bits=[1,0,1,a,b,c,1-c,0];
      for(let i=0;i<bits.length;i++){
        ctx.fillStyle=bits[i]?'#fff':'#000';
        ctx.fillRect(32+32*i,63,32,54);
      }
    }
    paint();
    const timer=setInterval(paint,70), marked=canvas.captureStream(14),track=marked.getVideoTracks()[0];
    const finish=track.stop.bind(track);
    track.stop=()=>{
      clearInterval(timer);finish();native.getTracks().forEach(t=>t.stop());
      camera.pause();camera.srcObject=null;
    };
    window.__sourceMarkerTrack=track;
    return marked;
  };
  const sealed=[];
  const encrypt=crypto.subtle.encrypt.bind(crypto.subtle);
  crypto.subtle.encrypt=async(algo,key,plaintext)=>{
    const result=await encrypt(algo,key,plaintext);
    if(algo?.name==='AES-GCM'){
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',result)))
        .map(byte=>byte.toString(16).padStart(2,'0')).join('');
      sealed.push({hash,bytes:result.byteLength});
      if(sealed.length>128)sealed.shift();
    }
    return result;
  };
  window.__observedSeals=()=>sealed.slice();
}

function installMarkerReader() {
  const canvas=document.createElement('canvas');canvas.width=80;canvas.height=24;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  const seen=new Map();
  window.__readMarker=id=>{
    const source=document.getElementById(id);
    if(!source || (source instanceof HTMLVideoElement && (!source.videoWidth || source.readyState<2)))return [];
    if(source instanceof HTMLCanvasElement && (source.hidden || !source.width))return [];
    context.drawImage(source,0,0,80,24);
    const data=context.getImageData(0,12,80,1).data;
    const bits=Array.from({length:8},(_,i)=>{
      const ix=(12+8*i)*4,luma=(data[ix]+data[ix+1]+data[ix+2])/3;
      return luma<58?0:luma>197?1:-1;
    });
    function decode(b){
      if(b.includes(-1) || b[0]!==1 || b[1]!==0 || b[2]!==1 || b[6]!==1-b[5] || b[7]!==0)return null;
      return b[3]*4+b[4]*2+b[5];
    }
    const n=decode(bits)??decode(bits.reverse());
    if(!seen.has(id))seen.set(id,new Set());
    if(n!==null)seen.get(id).add(n);
    return [...seen.get(id)];
  };
}

// A slow display can register its capabilities after the phone has authorized relay.
function holdDisplayRegistration(){
  const originalFetch=window.fetch.bind(window);
  const ready=new Promise(resolve=>{window.__releaseDisplayFormats=resolve;});
  window.fetch=async(input,options)=>{
    if(String(input).endsWith('/relay') && options?.method==='POST' && JSON.parse(options.body).action==='request'){
      await ready;
    }
    return originalFetch(input,options);
  };
}

export default async function runRelay({tv,phone,site,api,db,requests,rounds,worker,workerEnv,taskErrors,output,delay}){
  const jpeg=process.env.REPLAY_QA_RELAY_JPEG==='1';
  const tvWithoutRtc=process.env.REPLAY_QA_TV_WITHOUT_RTC==='1';
  await phone.send('Page.addScriptToEvaluateOnNewDocument',{source:'('+decorateCamera.toString()+')();'+
    (jpeg?'Object.defineProperty(window,"MediaRecorder",{value:undefined,configurable:true});':'')});
  await tv.send('Page.addScriptToEvaluateOnNewDocument',{source:'('+installMarkerReader.toString()+')();'+
    (tvWithoutRtc?'Object.defineProperty(window,"RTCPeerConnection",{value:undefined,configurable:true});('+holdDisplayRegistration.toString()+')();':'')});
  await tv.navigate(site+'/replay/tv/');
  const invite=await tv.until("document.querySelector('#tv-phone-link')?.href.includes('#pair=') && document.querySelector('#tv-phone-link').href",'private phone link');
  await phone.navigate(invite);
  await phone.until("typeof document.querySelector('#phone-start')?.onclick==='function'",'phone start ready');
  for(const [role,device] of [['TV',tv],['phone',phone]]){
    assert(await device.get('!!window.FGSReplayRelay'),role+' did not load the shared relay client');
  }
  assert.equal((await phone.get('__inspectMedia()')).requests.length,0);
  assert.equal(requests.filter(r=>r.op==='relay-chunk' && r.verb==='POST').length,0);
  const began=Date.now();
  await phone.click('phone-start');
  await phone.until("__inspectMedia().then(s=>s.tracks.some(t=>t.state==='live'))",'phone camera ready');
  if(tvWithoutRtc){
    await phone.until("document.getElementById('phone-status').textContent.includes('Switching')",'automatic handoff while registration is pending',25000);
    assert.equal(requests.filter(r=>r.op==='relay-chunk' && r.verb==='POST').length,0);
    await tv.get('window.__releaseDisplayFormats()');
  }
  await tv.until("(()=>{const a=__readMarker('liveVideo');return a.length>=2 && a;})()",'two different markers in received video',45000);
  const movingAfterMs=Date.now()-began;
  const session=rounds[0], lookup=()=>db.prepare('SELECT status,mime,latest FROM replay_relays WHERE id=?').bind(session.id).first();
  const media=await tv.get('__inspectMedia()');
  assert(media.requests.length===0,'the receiver must never prompt for a camera');
  assert(!media.received.some(flow=>flow.frames>0),'no frames can come from the blocked peer');
  const status=await lookup();assert.equal(status.status,'active');
  if(jpeg)assert.match(status.mime,/jpeg/);
  else assert.match(status.mime,/video\//,'normal browsers must negotiate video');
  const rows=(await db.prepare('SELECT seq,ciphertext FROM replay_relay_chunks WHERE pair_id=? ORDER BY seq').bind(session.id).all()).results;
  const seals=await phone.get('__observedSeals()');
  let matched=0;
  for(const row of rows){
    const wire=Buffer.from(row.ciphertext,'base64');
    assert(!wire.subarray(0,4).equals(Buffer.from('1a45dfa3','hex')),'server has a plain WebM header');
    assert(!wire.subarray(0,3).equals(Buffer.from('ffd8ff','hex')),'server has a plain JPEG header');
    if(seals.some(s=>s.bytes<=wire.length && createHash('sha256').update(wire.subarray(-s.bytes)).digest('hex')===s.hash))matched++;
  }
  assert(matched>0,'stored packets must match actual AES-GCM output from the phone');
  await tv.until("document.getElementById('tv-pair-dialog')?.open===false && !document.getElementById('reviewRange')?.disabled",'TV replay dashboard',35000);
  await tv.get("(()=>{const n=document.getElementById('delayRange');n.value='1';n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));})()");
  const replay=await tv.until("(()=>{for(const id of ['delayedVideo','delayedCanvas']){const seen=__readMarker(id);if(seen.length>=3)return {id,seen};}return false;})()",'changing phone marker in delayed replay',40000);
  const source=await tv.get("__readMarker('liveVideo')");
  await tv.get("(()=>{const n=document.getElementById('reviewRange');n.value=Number(n.min)+(Number(n.max)-Number(n.min))*.45;n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await tv.until("!document.getElementById('nextFrameBtn').disabled",'frame control');
  const position="({time:document.getElementById('delayedVideo').currentTime,cursor:Number(document.getElementById('reviewRange').value)})";
  const previous=await tv.get(position);await tv.click('nextFrameBtn');
  const stepped=await tv.until("(()=>{const p="+position+";return (p.time>"+previous.time+" || p.cursor>"+previous.cursor+") && p;})()",'step in encrypted relay replay');
  await tv.shot('tv-relay-delayed-replay');await phone.shot('phone-relay-sharing');
  await tv.click('pairTvBtn');await tv.until("document.getElementById('tv-pair-dialog')?.open",'disconnect controls');await tv.click('tv-end');
  const stopped=await phone.until("__inspectMedia().then(s=>s.tracks.every(t=>t.state==='ended') && window.__sourceMarkerTrack?.readyState==='ended' && s.tracks)",'phone camera release',30000);
  const ended=await worker.fetch(new Request(api+'/api/replay-pair/'+session.id,{headers:{Origin:site,Authorization:'Bearer '+session.tvToken}}),workerEnv,{waitUntil:()=>{}});
  assert.equal(ended.status,410);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM replay_relay_chunks WHERE pair_id=?').bind(session.id).first()).n,0);
  assert.equal(rounds.length,1);
  assert.deepEqual(taskErrors,[]);
  const proof={mode:status.mime,tvWithoutRtc,timeToTwoDistinctMarkersMs:movingAfterMs,tapsAfterStart:0,verifiedCiphertexts:matched,liveOpticalMarkers:source,delayedOpticalMarkers:replay,directDecodedFrames:0,frameStep:{previous,stepped},cameraAfterDisconnect:stopped,pairAfterDisconnect:ended.status,storedPacketsAfterDisconnect:0};
  await writeFile(path.join(output,'results.json'),JSON.stringify(proof,null,2));
  console.log(JSON.stringify(proof,null,2));
  await Promise.all([tv.navigate('about:blank'),phone.navigate('about:blank')]);
  await delay(150);
}
