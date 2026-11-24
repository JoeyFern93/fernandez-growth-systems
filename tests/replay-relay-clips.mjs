import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

// Offline Chrome test. Use the same Playwright installation as the public
// invite smoke test. Each picture encodes its sequence in black/white bars.
const require = createRequire(process.env.REPLAY_QA_PACKAGES ? path.join(process.env.REPLAY_QA_PACKAGES,'package.json') : import.meta.url);
const {chromium} = require('playwright-core');
const root = process.env.REPLAY_SITE_ROOT || fileURLToPath(new URL('../site',import.meta.url));
const browser = await chromium.launch({channel:'chrome',headless:true, executablePath:process.env.FGS_CHROME_BIN,
  args:['--autoplay-policy=no-user-gesture-required','--disable-background-networking']});

try {
  for (const fallback of [false,true]) {
    const page = await browser.newPage({serviceWorkers:'block'});
    const errors=[];
    page.on('pageerror',err=>errors.push(err.message));
    await page.route('**/*',async route=>{
      const url = new URL(route.request().url());
      if (url.origin !== 'https://replay.test') return route.abort();
      if (url.pathname === '/') return route.fulfill({contentType:'text/html',body:'<main id="camera"></main>'});
      if (!['/replay/multicam/relay-clips.mjs','/replay/js/frame-export-v1.js'].includes(url.pathname)) return route.abort();
      await route.fulfill({contentType:'text/javascript',body:await readFile(path.join(root,url.pathname))});
    });
    await page.goto('https://replay.test/');
    await page.evaluate(async fallback => {
      const {bindRelayClips,exportRelayClip} = await import('/replay/multicam/relay-clips.mjs');
      if (fallback) window.ReplayFrameExport.create = async () => null;
      const canvas = document.createElement('canvas');canvas.width=128;canvas.height=72;
      const ctx = canvas.getContext('2d'),frames=[];
      for(let i=0;i<30;i++){
        for(let bit=0;bit<6;bit++) {
          ctx.fillStyle=i & (1<<bit)?'white':'black';ctx.fillRect(bit*20,0,20,72);
        }
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.85));
        frames.push({epoch:1,receipt:true,blob,time:1000+i*100});
      }
      const slot={epoch:1,label:'Camera 2',buffer:{frames},node:document.querySelector('main')};
      const control=bindRelayClips(slot);control.update(true);
      const abort=new AbortController();
      for (const invalid of [
        {...frames[2],epoch:2}, {...frames[2],receipt:false}, {...frames[2],time:frames[3].time+1000},
        {...frames[2],time:frames[1].time+1600}
      ]) {
        let rejected=false;
        try {await exportRelayClip([frames[0],frames[1],invalid,frames[3]],abort.signal);} catch {rejected=true;}
        if (!rejected) throw Error('Invalid or interrupted range was accepted');
      }
      window.releaseHistory=()=>{slot.buffer.frames=[];control.update(true);};
      window.hideRelay=()=>control.update(false);
    },fallback);
    await page.locator('summary').click();
    const controls=page.locator('input[type=range]');
    await controls.nth(0).fill('6');await controls.nth(1).fill('21');
    await page.evaluate(()=>window.releaseHistory());
    await page.getByRole('button',{name:'Preview clip'}).click();
    const save=page.getByRole('link',{name:'Download TV clip'});
    await save.waitFor({state:'visible',timeout:20000});
    assert.match(await save.getAttribute('download'),/Camera-2-TV-relay-.*\.(mp4|webm)$/);
    const decoded=await page.evaluate(async()=>{
      const file=await (await fetch(document.querySelector('a').href)).blob();
      const video=document.createElement('video');video.muted=true;video.playsInline=true;
      const url=URL.createObjectURL(file);video.src=url;document.body.append(video);
      const canvas=document.createElement('canvas');canvas.width=128;canvas.height=72;
      const ctx=canvas.getContext('2d',{willReadFrequently:true}),symbols=[];
      let cb,timeout;
      function sample(){
        ctx.drawImage(video,0,0,128,72);
        const bytes=ctx.getImageData(0,10,120,1).data;
        let id=0;for(let k=0;k<6;k++)if(bytes[(10+k*20)*4]>127)id|=1<<k;
        symbols.push(id);cb=video.requestVideoFrameCallback(sample);
      }
      try{
        const complete=new Promise((resolve,reject)=>{
          video.onended=resolve;timeout=setTimeout(()=>reject(Error('Clip failed to finish playback')),6000);
        });
        cb=video.requestVideoFrameCallback(sample);
        await video.play();await complete;
        return {bytes:file.size,width:video.videoWidth,height:video.videoHeight,ended:video.currentTime,
          ids:[...new Set(symbols)]};
      } finally {
        clearTimeout(timeout);video.cancelVideoFrameCallback(cb);video.pause();video.remove();URL.revokeObjectURL(url);
      }
    });
    console.log(fallback?'MediaRecorder':'Frame-timed WebCodecs',JSON.stringify(decoded));
    assert.deepEqual([decoded.width,decoded.height],[128,72]);
    assert(decoded.ended>1.3 && decoded.ended<2);
    assert(decoded.ids.length>=10 && decoded.ids.every(id=>id>=6 && id<=21));
    assert(decoded.ids.some(id=>id===12), 'marked picture 12 must survive trimming');
    await page.evaluate(()=>window.hideRelay());
    assert(await save.isHidden());
    assert.deepEqual(errors,[]);
    await page.close();
  }
} finally {await browser.close();}
