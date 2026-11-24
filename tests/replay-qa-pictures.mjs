import assert from 'node:assert/strict';
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));

// Browser fixture. A visible marker changes ten times per second. It survives
// compression and lets the TV distinguish an older replay from the live phone.
export function installPhoneCounter() {
  const fixture = window.testCamera = {opens:0, tracks:[], marker:null};
  navigator.mediaDevices.getUserMedia = async () => {
    fixture.opens++;
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d'), start = performance.now();
    const draw = () => {
      fixture.marker = Math.floor((performance.now()-start)/100) % 1024;
      for (let lane=0; lane<12; lane++) {
        const lit = lane===0 || (lane<=10 && (fixture.marker & (1 << (lane-1))));
        ctx.fillStyle = lit ? '#efefef' : '#161616';
        const left = Math.round(lane*canvas.width/12);
        ctx.fillRect(left,0,Math.round((lane+1)*canvas.width/12)-left,canvas.height);
      }
    };
    draw();
    const stream = canvas.captureStream(30), track = stream.getVideoTracks()[0];
    fixture.tracks.push(track);
    const tick = setInterval(() => {
      if (track.readyState==='ended') clearInterval(tick); else draw();
    },33);
    return stream;
  };
}

// Read only the surface actually occupying the center of the playback
// panel. Hidden decoders and a canvas covered by the placeholder cannot pass.
export function visiblePicture(selector) {
  const panel = document.querySelector(selector);
  if (!panel || panel.closest('[hidden]')) return null;
  const rect = panel.getBoundingClientRect();
  if (rect.width<40 || rect.height<25) return null;
  const surface = document.elementFromPoint(rect.left+rect.width/2, rect.top+rect.height/2);
  if (!panel.contains(surface) || !['VIDEO','CANVAS'].includes(surface?.tagName)) return null;
  if (surface.tagName==='VIDEO' && surface.readyState<2) return null;
  const width = surface.videoWidth || surface.width, height = surface.videoHeight || surface.height;
  if (width<16 || height<16) return null;
  const probe = document.createElement('canvas');
  probe.width=120; probe.height=18;
  const ctx=probe.getContext('2d', {willReadFrequently:true});
  ctx.drawImage(surface,0,0,120,18);
  const pixels=ctx.getImageData(0,0,120,18).data;
  let hash=2166136261;
  for(const value of pixels) hash=Math.imul(hash^value,16777619);
  const lanes=Array.from({length:12},(_,i)=>pixels[4*(9*120+5+i*10)]>128);
  if (!lanes[0] && lanes[11]) lanes.reverse();
  const marker=lanes[0] && !lanes[11] ? lanes.slice(1,11).reduce((n,lit,i)=>n+(lit?(1<<i):0),0) : null;
  return {hash,marker,width,height,surface:surface.tagName};
}

export async function verifyMoving(page, selector, timeout=45000) {
  const frames=new Set(),until=Date.now()+timeout;
  const panel=page.locator(selector);
  await panel.scrollIntoViewIfNeeded();
  do {
    const frame=await page.evaluate(visiblePicture,selector);
    if(frame){
      frames.add(frame.hash);
      if(frames.size>=3)return frame;
    }
    await delay(150);
  }while(Date.now()<until);
  throw Error('No changing pictures on the visible display.');
}

export async function verifyMixedReplay(tv, phone) {
  const slot='#sideline .picture', timeline=tv.locator('#timeline');
  const elapsed=(newer,older)=>(newer-older+1024)%1024;
  async function picture() {
    await tv.locator(slot).scrollIntoViewIfNeeded();
    const end=Date.now()+5000;
    do {
      const f=await tv.evaluate(visiblePicture,slot);
      if(f?.surface==='CANVAS' && f.marker!==null)return f;
      await delay(80);
    }while(Date.now()<end);
    throw Error('The relayed angle never showed its recorded optical marker on the replay canvas.');
  }
  async function seek(value) {
    await timeline.evaluate((el,at)=>{
      el.value=String(at);
      el.dispatchEvent(new Event('input',{bubbles:true}));
    },value);
    // Canvas bitmaps decode asynchronously. The position must settle.
    await delay(270);
    return picture();
  }
  await verifyMoving(tv,slot);
  await verifyMoving(tv,'#baseline .picture');
  await delay(1500);
  const delayed=await picture();
  const live=await phone.evaluate(()=>testCamera.marker);
  const lag=elapsed(live,delayed.marker);
  assert.ok(lag>=19 && lag<200,'Relayed picture must show older phone footage at the selected three-second delay.');
  await tv.locator('#pause').click();
  await delay(300);
  const paused=await picture(), at=Number(await timeline.inputValue());
  await delay(650);
  assert.equal((await picture()).marker,paused.marker,'Paused marker advanced');
  assert.equal(Number(await timeline.inputValue()),at,'Paused timeline moved');
  const earlier=await seek(at-900);
  assert.ok(elapsed(paused.marker,earlier.marker)>=2 && elapsed(paused.marker,earlier.marker)<35,
    'Seeking earlier must show earlier relayed footage.');
  const restored=await seek(at);
  assert.equal(restored.marker,paused.marker,'Returning to the paused play must restore its marker');
  await tv.locator('#follow').click();
  return {lagMs:lag*100,pausedMarker:paused.marker,earlierMarker:earlier.marker};
}
