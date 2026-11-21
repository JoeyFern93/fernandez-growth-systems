// Run with Node 20+ and a local Chrome executable. Uses generated, individually
// numbered Y4M frames and a new disposable profile. No real camera is opened.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const siteRoots=(process.env.REPLAY_SITE_ROOT ? [path.resolve(process.env.REPLAY_SITE_ROOT)] : [
  path.join(here,'replay-fps-release/site'),path.join(here,'replay-release/site'),path.join(here,'replay-base/site'),
  path.join(here,'../work-replay-ux-2026-11-16/repo/site')
]);
const chrome=process.env.FGS_CHROME_BIN || [
  path.join(process.env.ProgramFiles||'','Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(existsSync);
assert(chrome,'Set FGS_CHROME_BIN to a Chrome executable');
const proof=path.resolve(process.env.REPLAY_QA_PROOF||path.join(here,'replay-high-fps-proof'));
await mkdir(proof,{recursive:true});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Wide high-contrast bars provide an inspectable frame number through a lossy
// encoder. At 320x180 each original bar occupies 32 pixels.
function y4m(fps) {
  const w=320,h=180,parts=[Buffer.from('YUV4MPEG2 W320 H180 F'+fps+':1 Ip A1:1 C420jpeg\n')];
  for(let frame=0;frame<128;frame++){
    const buf=Buffer.alloc(w*h*3/2,128);
    const row=Buffer.alloc(w,32);row.fill(220,0,32);
    for(let bit=0;bit<7;bit++)row.fill((frame>>bit)&1 ? 220 : 32,32+32*bit,64+32*bit);
    for(let y=0;y<h;y++)row.copy(buf,y*w);
    parts.push(Buffer.from('FRAME\n'),buf);
  }
  return Buffer.concat(parts);
}
async function check(fps,probeOnly=false){
  const work=await mkdtemp(path.join(process.env.REPLAY_QA_TEMP || os.tmpdir(),'fgs-camera-'));
  const sample=path.join(work,'numbered.y4m');await writeFile(sample,y4m(fps));
  const child=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--disable-background-networking','--disable-component-update','--autoplay-policy=no-user-gesture-required','--host-resolver-rules=MAP * ~NOTFOUND',
    '--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-video-capture='+sample,
    '--remote-debugging-pipe','--user-data-dir='+path.join(work,'profile')],{stdio:['ignore','ignore','ignore','pipe','pipe'],windowsHide:true});
  child.stdio[3].on('error',()=>{}); // A page request can finish while its browser is closing.
  const ended=once(child,'exit'),jobs=new Map(),errors=[];let id=0,tail='',sessionId;
  const send=(method,params={},sid=sessionId)=>new Promise((resolve,reject)=>{
    const requestId=++id;jobs.set(requestId,{resolve,reject});
    child.stdio[3].write(JSON.stringify({id:requestId,method,params,sessionId:sid})+'\0');
  });
  async function respond(evt){
    const requestUrl=new URL(evt.request.url);const key=decodeURIComponent(requestUrl.pathname);
    let file;const name=(key.endsWith('/') ? key+'index.html' : key).replace(/^\//,'');
    if(requestUrl.origin==='https://replay.test' && !name.includes('..')){
      file=siteRoots.map(root=>path.join(root,name)).find(existsSync);
    }
    const type={html:'text/html',js:'text/javascript',css:'text/css',png:'image/png',svg:'image/svg+xml',webmanifest:'application/manifest+json',woff2:'font/woff2'}[name.split('.').pop()]||'application/octet-stream';
    const body=file ? await readFile(file) : Buffer.alloc(0);
    await send('Fetch.fulfillRequest',{requestId:evt.requestId,responseCode:file ? 200 : 404,responseHeaders:[{name:'Content-Type',value:type}],body:body.toString('base64')});
  }
  child.stdio[4].setEncoding('utf8').on('data',chunk=>{
    tail+=chunk;let i;
    while((i=tail.indexOf('\0'))>=0){
      const msg=JSON.parse(tail.slice(0,i));tail=tail.slice(i+1);
      if(msg.id){const job=jobs.get(msg.id);if(job){jobs.delete(msg.id);msg.error?job.reject(Error(JSON.stringify(msg.error))):job.resolve(msg.result);}}
      else if(msg.method==='Fetch.requestPaused')respond(msg.params).catch(e=>errors.push(e.message));
      else if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.exception?.description||msg.params.exceptionDetails.text);
    }
  });
  async function evaluate(expression){
    const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});
    if(result.exceptionDetails)throw Error(result.result.description||result.exceptionDetails.text);
    return result.result.value;
  }
  async function until(expression,ms=12000){
    const expiry=Date.now()+ms;while(Date.now()<expiry){const value=await evaluate(expression);if(value)return value;await wait(100);}
    throw Error('Timeout: '+expression+'; '+await evaluate("document.body.innerText.slice(0,1100)")+'; '+errors.join(', '));
  }
  const click=id=>evaluate("document.getElementById("+JSON.stringify(id)+").click()");
  const select=(id,value,event='change')=>evaluate("(()=>{const n=document.getElementById("+JSON.stringify(id)+");n.value="+JSON.stringify(String(value))+";n.dispatchEvent(new Event("+JSON.stringify(event)+",{bubbles:true}));})()");
  try {
    const {targetId}=await send('Target.createTarget',{url:'about:blank'});({sessionId}=await send('Target.attachToTarget',{targetId,flatten:true}));
    await send('Fetch.enable',{patterns:[{urlPattern:'https://*'}]});
    await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,mobile:false,deviceScaleFactor:1});
    await send('Page.navigate',{url:'https://replay.test/replay/'});await until("document.readyState==='complete' && document.getElementById('startBtn')");
    const generated=process.env.REPLAY_CAMERA_GENERATOR==='1';
    if(generated){
      const fixture=await readFile(path.join(here,'replay-generator-camera-fixture.js'),'utf8');
      await evaluate(fixture+'\ngeneratedCamera('+fps+')');
    }
    const report={sourceType:generated?'numbered MediaStreamTrackGenerator':'numbered native Y4M test camera',requestedSourceFps:fps,
      chrome:(await send('Browser.getVersion',{},undefined)).product};
    if(probeOnly){
      report.driver=await evaluate(`(async()=>{const stream=await navigator.mediaDevices.getUserMedia({video:{frameRate:{ideal:${fps}}},audio:false});
        const t=stream.getVideoTracks()[0], r=new MediaStreamTrackProcessor({track:t}).readable.getReader(), times=[];
        for(let i=0;i<50;i++){const v=(await r.read()).value;times.push(v.timestamp);v.close();}
        await r.cancel();const caps=t.getCapabilities(),config=t.getSettings();t.stop();
        return {caps:caps.frameRate,setting:config.frameRate,sampleRate:49e6/(times.at(-1)-times[0])};})()`);
      return report;
    }
    try{return await testApp({fps,report,evaluate,until,click,select,errors});}
    catch(error){await writeFile(path.join(proof,'partial-'+fps+'.json'),JSON.stringify({...report,error:error.message},null,2)+'\n');throw error;}
  }finally{
    child.stdio[3].end();await ended;await rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  }
}
function stampReader(){
  const c=document.createElement('canvas');c.width=100;c.height=2;
  const context=c.getContext('2d',{willReadFrequently:true});
  return image=>{
    context.drawImage(image,0,0,100,2);
    const pixels=context.getImageData(0,1,100,1).data;
    const light=x=>pixels[x*4]>130;
    const mirrored=!light(5) && light(95);
    if(light(mirrored?95:5)===light(mirrored?5:95))return -1;
    let code=0;
    for(let bit=0;bit<7;bit++){const x=15+10*bit;if(light(mirrored?99-x:x))code|=1<<bit;}
    return code;
  };
}
async function sourceSamples(){
  const live=document.getElementById('liveVideo');
  const track=live.srcObject.getVideoTracks()[0].clone();
  const reader=new MediaStreamTrackProcessor({track}).readable.getReader(), frames=[];
  const stamp=window.qaStamp();
  try{
    while(frames.length<90){
      const {value}=await reader.read();frames.push([value.timestamp/1e6,stamp(value)]);value.close();
    }
  }finally{await reader.cancel();track.stop();}
  return frames;
}
async function decodeDownload(linkId){
  const video=document.createElement('video');video.muted=true;video.playsInline=true;
  Object.assign(video.style,{position:'fixed',width:'140px',top:'1px',left:'1px',zIndex:'9999'});
  document.body.append(video);video.src=document.getElementById(linkId).href;
  const frames=[], stamp=window.qaStamp();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(Error('Timed out decoding '+linkId)),45000);let cb;
    function finish(error){clearTimeout(timer);video.cancelVideoFrameCallback(cb);video.pause();video.remove();
      error?reject(error):resolve({frames,reportedDuration:Number.isFinite(video.duration)?video.duration:null});}
    video.onended=()=>finish();video.onerror=()=>finish(Error('Browser cannot decode saved recording'));
    function seen(_time,meta){frames.push([meta.mediaTime,stamp(video),meta.presentedFrames]);cb=video.requestVideoFrameCallback(seen);}
    cb=video.requestVideoFrameCallback(seen);video.playbackRate=.25;video.play().catch(finish);
  });
}
function timing(frames){
  assert(frames.length>5,'Too few decoded samples: '+frames.length);
  const wall=frames.at(-1)[0]-frames[0][0];
  const good=frames.filter(([,code])=>code>=0);
  assert(good.length>=frames.length*.96,'The downloaded image has a readable frame number');
  const distinct=good.slice(1).filter(([,code],i)=>code!==good[i][1]).length;
  const consecutive=good.slice(1).filter(([,code],i)=>((code-good[i][1]+128)%128)===1).length;
  return {samples:frames.length,duration:wall,fps:(frames.length-1)/wall,distinctFps:distinct/wall,adjacentRatio:consecutive/(good.length-1),
    firstFrame:good[0][1],lastFrame:good.at(-1)[1]};
}
async function testApp({fps,report,evaluate,until,click,select,errors}){
  await evaluate('window.qaStamp='+stampReader.toString());
  const selected=await evaluate("document.getElementById('captureFps').value");
  assert.equal(selected,'max','A new installation should use the fastest camera setting');
  await select('delayRange',1,'input'); await select('delayRange',1);await select('captureResolution','640x360');
  await click('startBtn');
  await until("document.getElementById('liveVideo').srcObject && !document.getElementById('sessionRecordBtn').disabled");
  report.camera=await evaluate("(()=>{const t=document.getElementById('liveVideo').srcObject.getVideoTracks()[0];return {settings:t.getSettings().frameRate,max:t.getCapabilities().frameRate.max,asked:t.getConstraints().frameRate};})()");
  assert.equal(report.camera.max,fps);assert.equal(report.camera.settings,fps);
  await click('sessionRecordBtn');const started=Date.now();
  report.source=timing(await evaluate('('+sourceSamples.toString()+')()'));
  if (process.env.REPLAY_MIN_SOURCE_FPS) {
    assert(report.source.distinctFps>=Number(process.env.REPLAY_MIN_SOURCE_FPS),
      'The fixture must actually deliver the required source rate, measured '+report.source.distinctFps);
  }
  await wait(Math.max(0,4500-(Date.now()-started)));await click('sessionRecordBtn');
  await until("document.getElementById('sessionDownloadLink').href.startsWith('blob:')");
  report.sessionWallSeconds=(Date.now()-started)/1000;
  report.status=await evaluate("document.querySelector('#frameRateStatus')?.textContent");
  // Chromium decodes the actual saved blob at a low display rate, allowing a
  // 60 Hz display to inspect all stored frames from a 120 fps capture.
  const decoded=await evaluate('('+decodeDownload.toString()+')("sessionDownloadLink")');
  report.session=timing(decoded.frames);
  report.session.mediaDuration=decoded.reportedDuration;
  console.log('Source and recorded session measurement:',JSON.stringify({fps,source:report.source,session:report.session}));
  if(process.argv.includes('--recording-only'))return report;
  await click('reviewSessionBtn');await until("!document.getElementById('sessionVideo').hidden");
  await select('playbackSpeed',.125);
  await click('playPauseBtn');
  const watch=async id=>{
    await until("!document.getElementById("+JSON.stringify(id)+").paused");
    const get=()=>evaluate("(()=>{const v=document.getElementById("+JSON.stringify(id)+");return [v.currentTime,performance.now(),v.playbackRate]})()");
    const a=await get();await wait(850);const b=await get();return {setting:b[2],measured:(b[0]-a[0])*1000/(b[1]-a[1])};
  };
  report.playback=await watch('sessionVideo'); await click('playPauseBtn');
  assert.equal(report.playback.setting,.125);assert(Math.abs(report.playback.measured-.125)<.035);
  await select('reviewRange',1.25,'input');await select('reviewRange',1.25,'change');
  async function step(id,media){
    const read=()=>evaluate("(()=>{const v=document.getElementById('sessionVideo');return {time:v.currentTime,code:window.qaStamp()(document.getElementById("+JSON.stringify(media)+")),paused:v.paused};})()");
    await until("!document.getElementById('sessionVideo').seeking");await wait(65);const before=await read();
    await click(id);await until("!document.getElementById('sessionVideo').seeking");await wait(65);return {before,after:await read()};
  }
  report.next=await step('nextFrameBtn','sessionVideo');report.prev=await step('prevFrameBtn','sessionVideo');
  assert(report.next.after.time>report.next.before.time && report.next.after.paused && report.prev.after.time<report.prev.before.time);
  assert(report.next.after.code!==report.next.before.code,'Next frame should change the actual image');
  assert.equal(report.prev.after.code,report.next.before.code,'Previous frame should return to the original image');
  await click('recordClipBtn');await until("!document.getElementById('trimPanel').hidden");
  await select('trimEndRange',2.75,'input');await select('trimStartRange',1,'input');
  await select('trimPreviewSeek',1.15,'input');
  report.trimNext=await step('trimNextFrameBtn','trimPreviewCanvas');report.trimPrev=await step('trimPrevFrameBtn','trimPreviewCanvas');
  assert(report.trimNext.after.code!==report.trimNext.before.code,'Next frame must repaint the clip preview');
  assert.equal(report.trimPrev.after.code,report.trimNext.before.code);
  await select('trimPreviewSpeed',.125);await click('trimPreviewBtn');report.trimPlayback=await watch('sessionVideo');
  assert.equal(report.trimPlayback.setting,.125);assert(Math.abs(report.trimPlayback.measured-.125)<.035);
  await click('trimPreviewBtn');
  const selection=await evaluate("['trimStartRange','trimEndRange'].map(id=>Number(document.getElementById(id).value))");
  await click('trimExportBtn');await until("document.getElementById('downloadLink').href.startsWith('blob:')",120000);
  const selectedFrames=await evaluate('('+decodeDownload.toString()+')("downloadLink")');
  report.clip=timing(selectedFrames.frames);report.clip.selectedSeconds=selection[1]-selection[0];
  report.clip.mediaDuration=selectedFrames.reportedDuration;
  assert(Math.abs(report.clip.duration-report.clip.selectedSeconds)<.36,'Export should have original selection duration after slow preview');
  assert(report.session.distinctFps>report.source.distinctFps*.77,'Session encoding must retain the source cadence: '+JSON.stringify(report));
  assert(report.clip.distinctFps>report.source.distinctFps*.75,'Clip encoding must retain the source cadence: '+JSON.stringify(report));
  assert.deepEqual(errors,[]);
  return report;
}
for(const fps of (process.env.REPLAY_QA_FPS||'60,120').split(',').map(Number)){
  const result=await check(fps,process.argv.includes('--probe'));console.log(JSON.stringify(result,null,2));
  await writeFile(path.join(proof,(process.argv.includes('--probe')?'probe-':'result-')+fps+'.json'),JSON.stringify(result,null,2)+'\n');
}
