import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';

// Native Chrome camera input. Each quadrant has a known color and the center
// flashes, letting the receiver verify orientation, reflection and frame motion.
export async function writeTestCamera(file) {
  const width=640, height=360;
  const colors=[[81,90,240],[145,54,34],[41,240,110],[210,16,146]];
  const parts=[Buffer.from('YUV4MPEG2 W640 H360 F30:1 Ip A1:1 C420jpeg\n')];
  for(let frame=0;frame<30;frame++){
    parts.push(Buffer.from('FRAME\n'));
    for(let plane=0;plane<3;plane++){
      const w=plane?width/2:width, h=plane?height/2:height;
      const bytes=Buffer.alloc(w*h);
      for(let y=0;y<h;y++){
        const left=y<h/2?0:2, offset=y*w;
        bytes.fill(colors[left][plane],offset,offset+w/2);
        bytes.fill(colors[left+1][plane],offset+w/2,offset+w);
        if(y>h*.42 && y<h*.58){
          bytes.fill(plane?128:(frame<15?24:228),offset+Math.floor(w*.42),offset+Math.floor(w*.58));
        }
      }
      parts.push(bytes);
    }
  }
  await writeFile(file,Buffer.concat(parts));
}

// Decode a low-resolution sample from the media element itself. Center-of-mass
// positions work for landscape, portrait, and square canvases with letterboxes.
function observePicture() {
  const canvas=document.createElement('canvas');
  canvas.width=64;canvas.height=48;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  window.__picture=id=>{
    const media=document.getElementById(id);
    if(!media || (media instanceof HTMLVideoElement && (!media.videoWidth||media.readyState<2)) ||
        (media instanceof HTMLCanvasElement && (media.hidden||!media.width)))return null;
    ctx.drawImage(media,0,0,canvas.width,canvas.height);
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    const centers={};
    for(let y=0;y<48;y+=2){
      for(let x=0;x<64;x+=2){
        const i=4*(64*y+x),r=pixels[i],g=pixels[i+1],b=pixels[i+2];
        let color;
        if(r>145&&g>145&&b<100)color='Y';
        else if(r>130 && r>g+65 && r>b+65)color='R';
        else if(g>110 && g>r+40 && g>b+40)color='G';
        else if(b>130 && b>r+65 && b>g+65)color='B';
        if(!color)continue;
        const c=centers[color]??={x:0,y:0,n:0};
        c.x+=x;c.y+=y;c.n++;
      }
    }
    const order=['?','?','?','?'];
    for(const [color,c] of Object.entries(centers)){
      if(c.n<10)continue;
      order[(c.x/c.n>32?1:0)+(c.y/c.n>24?2:0)]=color;
    }
    const middle=4*(64*24+32);
    const shade=(pixels[middle]+pixels[middle+1]+pixels[middle+2])/3;
    return {order:order.join(''),pulse:shade<75?'dark':shade>175?'light':'middle'};
  };
}

async function setControl(tab,id,value) {
  await tab.get('('+function(id,value){
    const control=document.getElementById(id);
    if(!control || control.disabled)throw Error('Unavailable control '+id);
    const detail=control.closest('details');
    if(detail)detail.open=true;
    control.value=String(value);
    if(control instanceof HTMLSelectElement && control.value!==String(value))throw Error('Unavailable option '+id);
    control.dispatchEvent(new Event('input',{bubbles:true}));
    control.dispatchEvent(new Event('change',{bubbles:true}));
  }.toString()+')('+JSON.stringify(id)+','+JSON.stringify(value)+')');
}

async function clickControl(tab,id) {
  await tab.get('document.getElementById('+JSON.stringify(id)+')?.closest("details")?.setAttribute("open","")');
  await tab.click(id);
}

async function expectReplay(tab,order) {
  const sample=JSON.stringify(order);
  await tab.until('["delayedVideo","delayedCanvas"].some(id=>__picture(id)?.order==='+sample+')',
    'four decoded replay quadrants in order '+order,35000);
  for(const pulse of ['light','dark']){
    await tab.until('["delayedVideo","delayedCanvas"].some(id=>{const p=__picture(id);return p?.order==='+
      sample+' && p.pulse==='+JSON.stringify(pulse)+';})','moving replay after '+order,12000);
  }
}

async function pictureArea(tv) {
  return tv.get('('+function(){
    const el=['delayedVideo','delayedCanvas'].map(id=>document.getElementById(id))
      .find(e=>!e.hidden && e.getBoundingClientRect().width && (e.videoWidth || e.width));
    if(!el)return 0;
    const box=el.getBoundingClientRect();
    const w=el.videoWidth || el.width, h=el.videoHeight || el.height;
    const scale=Math.min(box.width/w,box.height/h);
    return Math.round(w*h*scale*scale);
  }.toString()+')()');
}

export async function runControls({tv,phone,site,db,rounds,requests,relayScenario,taskErrors,delay}) {
  await tv.send('Page.addScriptToEvaluateOnNewDocument',{source:'('+observePicture.toString()+')()'});
  await phone.send('Page.addScriptToEvaluateOnNewDocument',{source:'('+function(){
    const start=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const sources=[];
    navigator.mediaDevices.getUserMedia=async constraints=>{
      const stream=await start(constraints);
      sources.push(stream.getVideoTracks()[0]);
      return stream;
    };
    window.__cameraSources=()=>sources.map(t=>{
      const requested=t.getConstraints(), applied=t.getSettings();
      return {state:t.readyState,height:requested.height?.ideal??requested.height,
        fps:requested.frameRate?.max??requested.frameRate,reportedFps:applied.frameRate,width:applied.width,reportedHeight:applied.height};
    });
  }.toString()+')()'});
  await tv.navigate(site+'/replay/tv/');
  const invite=await tv.until("document.querySelector('#tv-phone-link')?.href.includes('#pair=') && document.querySelector('#tv-phone-link').href",'private pairing');
  await phone.navigate(invite);
  await phone.until("typeof document.querySelector('#phone-start')?.onclick==='function'",'phone controls');
  assert.equal((await phone.get('__inspectMedia()')).requests.length,0);
  await setControl(phone,'phone-fps','30');
  await phone.click('phone-start');
  await phone.until("document.getElementById('phone-preview').srcObject?.active",'phone camera');
  if(relayScenario){
    await phone.until("!document.getElementById('phone-options').hidden",'internet relay controls');
    await phone.click('phone-options');await phone.click('relay-consent');
  }
  await tv.until("!document.querySelector('#tv-pair-dialog').open && !document.getElementById('reviewRange').disabled",'working delayed player',45000);
  await setControl(tv,'delayRange','1');
  await expectReplay(tv,'RGBY');
  const phonePreviewHeight=()=>phone.get("document.getElementById('phone-preview').getBoundingClientRect().height");
  const initialPhoneHeight=await phonePreviewHeight();
  await phone.click('phone-preview-expand');
  await phone.until("document.getElementById('phone-preview-expand').getAttribute('aria-expanded')==='true'",'expanded phone preview');
  assert((await phonePreviewHeight())>initialPhoneHeight*1.05,'the phone preview surface must grow');
  await phone.click('phone-preview-expand');
  await phone.until("document.getElementById('phone-preview-expand').getAttribute('aria-expanded')==='false'",'restored phone controls');
  await setControl(tv,'replaySize','standard');
  await delay(250);
  const standard=await pictureArea(tv);
  await setControl(tv,'replaySize','maximum');await delay(250);
  const maximum=await pictureArea(tv);
  assert(standard>0 && maximum>standard*1.15,'maximum must enlarge visible video: '+JSON.stringify({standard,maximum}));
  await expectReplay(tv,'RGBY');
  await setControl(tv,'replaySize','standard');
  await clickControl(phone,'phone-rotate');
  await expectReplay(tv,'BRYG');
  await clickControl(phone,'phone-mirror');
  await expectReplay(tv,'RBGY');
  await setControl(phone,'phone-resolution','480');
  await phone.until("__cameraSources().at(-1)?.height===480",'480-line camera request');
  await setControl(phone,'phone-fps','30');
  await phone.until("__cameraSources().at(-1)?.fps===30 && __cameraSources().at(-1).reportedFps<=30.1",'native phone FPS preference');
  // File-backed Chrome supplies one physical-input choice. Explicitly opening
  // that device still creates a second native capture track, just as a lens
  // change does, and verifies old-source cleanup and relay continuity.
  const exactDevice=await phone.until("document.querySelector('#phone-lens option[data-camera]')?.value",'enumerated camera choice');
  await setControl(phone,'phone-lens',exactDevice);
  await phone.until("__cameraSources().length===2 && __cameraSources()[0].state==='ended' && __cameraSources()[1].state==='live'",'native source replacement');
  await expectReplay(tv,'RBGY');
  await clickControl(phone,'phone-rotate');
  await expectReplay(tv,'BYRG');
  const current=await phone.get('__cameraSources().at(-1)');
  const readout=await phone.get("document.getElementById('phone-camera-readout').textContent");
  const size=readout.match(/(\d+)\s*[x×]\s*(\d+)/);
  assert.deepEqual(size?.slice(1,3).map(Number),[current.width,current.reportedHeight],'readout must report the actual camera size');
  await setControl(tv,'replaySize','large');
  const compact=await tv.get("({drawer:document.getElementById('toggleReplayControls').getAttribute('aria-expanded'),controls:['playPauseBtn','reviewRange'].every(id=>{const el=document.getElementById(id);return el.closest('#quickReplayTransport') && el.getClientRects().length>0;})})");
  assert.deepEqual(compact,{drawer:'false',controls:true},'the video-first view must keep pause and timeline available');
  await tv.click('playPauseBtn');
  await tv.until("document.getElementById('playPauseBtn').getAttribute('aria-pressed')==='true'",'pause from the compact controls');
  const seek=await tv.get("(()=>{const input=document.getElementById('reviewRange');return (Number(input.max)+Number(input.min))/2;})()");
  await setControl(tv,'reviewRange',seek);
  assert(Math.abs(await tv.get("Number(document.getElementById('reviewRange').value)")-seek)<.2,'compact timeline must seek the buffered replay');
  const receive=await tv.get('__inspectMedia()');
  const packets=requests.filter(r=>r.op==='relay-chunk'&&r.verb==='POST'&&r.status<300).length;
  if(relayScenario){
    assert(packets>0 && !receive.received.some(row=>row.frames),'frames must come through the relay');
  }else{
    assert.equal(packets,0);
    assert(receive.received.some(row=>row.frames>=10),'frames must come through the direct peer');
  }
  assert.equal(rounds.length,1,'all controls must preserve the same room');
  await phone.click('phone-stop');
  await phone.until("__inspectMedia().then(s=>s.tracks.length && s.tracks.every(t=>t.state==='ended'))",'camera released');
  await tv.until("!document.getElementById('liveVideo').srcObject?.active",'TV stream ended',30000);
  assert.equal((await db.prepare('SELECT count(*) n FROM replay_relay_chunks WHERE pair_id=?').bind(rounds[0].id).first()).n,0);
  assert.deepEqual(taskErrors,[]);
  console.log(JSON.stringify({path:relayScenario?'encrypted relay':'direct',standard,maximum,orientations:['RGBY','BRYG','RBGY','BYRG'],sourceReplaced:true,rooms:rounds.length,cameraReleased:true}));
}
