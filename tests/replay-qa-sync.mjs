import assert from 'node:assert/strict';
import {visiblePicture} from './replay-qa-pictures.mjs';

const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
const MARKER_MS=50, MARKERS=1024;

// Two cameras filming the same 20 Hz optical counter. Both rasterize the
// scene from the host reference clock before introducing phone clock skew.
function installScene({webcam,phoneSkew,driverStamps,jpeg}) {
  const referenceOrigin=performance.timeOrigin;
  const realNow=Date.now.bind(Date);
  if(phoneSkew) {
    Date.now=()=>realNow()+phoneSkew;
    Object.defineProperty(performance,'timeOrigin',{value:referenceOrigin+phoneSkew});
  }
  if(jpeg)Object.defineProperty(window,'MediaRecorder',{value:undefined});
  const originalFrame=HTMLVideoElement.prototype.requestVideoFrameCallback;
  let source;
  if(webcam && driverStamps) {
    // A canvas-backed fake webcam has no device driver. Expose its local
    // presentation stamp as a zero-hardware-latency camera capture stamp.
    // This does not use either the optical marker value or any relay time.
    HTMLVideoElement.prototype.requestVideoFrameCallback=function(callback) {
      const video=this;
      return originalFrame.call(video,(time,metadata)=>{
        const local=source && video.srcObject?.getVideoTracks()[0]===source;
        callback(time,local ? {...metadata,captureTime:metadata.presentationTime} : metadata);
      });
    };
  }
  navigator.mediaDevices.getUserMedia=async()=>{
    const canvas=document.createElement('canvas');
    canvas.width=640;canvas.height=360;
    const paint=canvas.getContext('2d');
    function draw() {
      const marker=Math.floor((referenceOrigin+performance.now())/50)%1024;
      for(let lane=0;lane<12;lane++) {
        const lit=lane===0 || lane<=10 && (marker & (1<<(lane-1)));
        paint.fillStyle=lit?'#efefef':'#161616';
        const start=Math.round(lane*canvas.width/12);
        paint.fillRect(start,0,Math.round((lane+1)*canvas.width/12)-start,canvas.height);
      }
    }
    draw();
    const stream=canvas.captureStream(30);
    const track=source=stream.getVideoTracks()[0];
    const timer=setInterval(()=>track.readyState==='ended'?clearInterval(timer):draw(),24);
    return stream;
  };
}

function markerDelta(a,b){return ((a-b+MARKERS*1.5)%MARKERS-MARKERS/2)*MARKER_MS;}

export async function checkRelaySync(browser,{site,service,newDevice,jpeg=false,driverStamps=true,baseline=false,delaySeconds=5,long=false}) {
  const tv=await newDevice(browser,{width:1280,height:800});
  const phone=await newDevice(browser,{width:390,height:844});
  const sent=new Map(),deliveryAges=[];
  const api=service+'/api/replay-pair';
  let room,token,created,format;
  tv.page.on('response',response=>{
    if(response.url()===api && response.request().method()==='POST' && response.status()===201) {
      token=response.request().postDataJSON().tvToken;
      created=response.json().then(body=>{room=body.id;});
    }
  });
  phone.page.on('request',request=>{
    const url=new URL(request.url());
    if(request.method()!=='POST' || url.origin!==service)return;
    if(url.pathname.endsWith('/relay-chunk'))sent.set(url.searchParams.get('seq'),Date.now());
    if(url.pathname.endsWith('/relay') && request.postDataJSON()?.action==='start')format=request.postDataJSON().mimeType;
  });
  await tv.page.exposeFunction('holdRelayPacket',async seq=>{
    const sentAt=sent.get(seq);
    assert.ok(Number.isFinite(sentAt),'Missing upload for observed relay packet');
    const target=[830,1100,950,1040][Number(seq)%4];
    const remaining=sentAt+target-Date.now();
    if(remaining>0)await wait(remaining);
    deliveryAges.push(Date.now()-sentAt);
  });
  await tv.page.addInitScript(()=>{
    const network=window.fetch.bind(window);
    window.fetch=async(...args)=>{
      const response=await network(...args);
      const url=new URL(response.url);
      if(response.status===200 && url.pathname.endsWith('/relay-chunk') && (args[1]?.method||'GET')==='GET')
        await window.holdRelayPacket(url.searchParams.get('seq'));
      return response;
    };
  });
  await tv.page.addInitScript(installScene,{webcam:true,driverStamps});
  await phone.page.addInitScript(installScene,{phoneSkew:4500,jpeg});
  await tv.page.addInitScript({content:'window.readOpticalPicture=('+visiblePicture.toString()+');'});
  const webcam='#baseline .picture',relay='#sideline .picture';
  async function read() {
    // Execute both optical reads in a single browser task.
    return tv.page.evaluate(([webcam,relay])=>[window.readOpticalPicture(webcam),window.readOpticalPicture(relay)],[webcam,relay]);
  }
  async function both(timeout=6000) {
    const end=Date.now()+timeout;
    while(Date.now()<end){
      const pair=await read();
      if(pair.every(p=>p?.surface==='CANVAS' && Number.isInteger(p.marker)))return pair.map(p=>p.marker);
      await wait(90);
    }
    throw Error('The USB and relay angles did not both show decodable buffered markers.');
  }
  try {
    await tv.page.goto(site+'/replay/multicam/');
    await tv.page.locator('#baseline .webcam').selectOption('default');
    await tv.page.waitForFunction(()=>document.querySelector('#baseline .picture video')?.readyState>=2);
    if(delaySeconds!==3)await tv.page.locator('#delay').selectOption(String(delaySeconds));
    assert.equal(await tv.page.locator('#delay').inputValue(),String(delaySeconds));
    await tv.page.locator('#camera-2-relay').click();
    await tv.page.locator('#qr svg').waitFor();
    await phone.page.goto(await tv.page.locator('#phone-link').getAttribute('href'));
    await phone.page.locator('#phone-start').click();
    await both(45000);
    const alignment=tv.page.locator('#alignment');
    if(!baseline)await tv.page.waitForFunction(()=>/^Estimated (capture|preview) offset:/.test(document.getElementById('alignment').textContent),null,{timeout:30000});
    // A calibrated display holds the earliest matched pair while its history
    // builds. Measure once there is a full delay interval to play and seek.
    await wait((delaySeconds+1)*1000);
    const pairs=[],offsets=[];
    for(let i=0;i<(long?52:22);i++){const pair=await both();pairs.push(pair);offsets.push(markerDelta(...pair));await wait(long?420:125);}
    const distinct=[0,1].map(i=>new Set(pairs.map(x=>x[i])).size);
    const sorted=offsets.map(Math.abs).sort((a,b)=>a-b);
    const sample={format,driverStamps,clockSkewMs:4500,delaySeconds,count:sorted.length,markerMs:MARKER_MS,distinct,first:pairs[0],last:pairs.at(-1),
      deliveryAgeRangeMs:[Math.min(...deliveryAges),Math.max(...deliveryAges)],medianMs:sorted[Math.floor(sorted.length/2)],
      p95Ms:sorted[Math.ceil(.95*sorted.length)-1],maxMs:sorted.at(-1),alignment:await alignment.textContent(),mode:await tv.page.locator('#position').textContent()};
    console.log('Mixed camera optical sync: '+JSON.stringify(sample));
    const progress=pairs.slice(1).reduce((ms,pair,i)=>ms+markerDelta(pair[0],pairs[i][0]),0);
    assert(distinct.every(n=>n>=(jpeg?7:12)) && progress>1600,
      'Both optical sequences must advance during playback');
    assert.ok(deliveryAges.length>=5 && Math.min(...deliveryAges)>=820,'Relay latency fixture did not run');
    assert(jpeg?format==='image/jpeg':format?.startsWith('video/'),'Unexpected relay codec');
    if(baseline)return sample;
    assert.ok(sample.p95Ms<=100 && sample.maxMs<=150,'USB and phone show different events during delayed playback');
    await tv.page.locator('#pause').click();await wait(300);
    const paused=await both();
    await wait(450);assert.deepEqual(await both(),paused,'A paused optical pair moved');
    const slider=tv.page.locator('#timeline'),pausedAt=Number(await slider.inputValue());
    for(const offset of [-950,-1650,0]){
      await slider.evaluate((el,value)=>{
        el.valueAsNumber=value;
        el.dispatchEvent(new Event('input',{bubbles:true}));
      },pausedAt+offset);await wait(300);
      const pair=await both();
      assert.ok(Math.abs(markerDelta(...pair))<=150,'Scrubbing selected different optical events');
      if(!offset)assert.deepEqual(pair,paused,'Seeking back missed a paused marker');
      else {
        const selectedMs=Number(await slider.inputValue())-pausedAt;
        const opticalMs=markerDelta(pair[0],paused[0]);
        assert.ok(Math.abs(opticalMs-selectedMs)<=150,'Rendered pictures disagree with the selected timeline time');
        // The TV uses the newest received picture at or before the target.
        // Low-rate JPEG may legitimately select an earlier picture than VP8.
        assert.ok(selectedMs<=offset+2 && selectedMs>=offset-(jpeg?1000:250),'Scrubbing did not select the requested earlier play');
      }
    }
    console.log('Mixed camera sync: both paused markers held and matched across three seeks.');
    return sample;
  }finally{
    await created;
    if(room && token)await tv.page.evaluate(async({api,room,token})=>{
      await fetch(api+'/'+room+'/end',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(6000)});
    },{api,room,token}).catch(()=>{});
    await Promise.all([tv.context.close(),phone.context.close()]);
  }
}
