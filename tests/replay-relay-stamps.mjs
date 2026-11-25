import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=process.env.REPLAY_SITE_ROOT || fileURLToPath(new URL('../site',import.meta.url));
const require=createRequire(process.env.REPLAY_QA_PACKAGES ? path.join(process.env.REPLAY_QA_PACKAGES,'package.json') : import.meta.url);
const {chromium}=require('playwright-core');
const browser=await chromium.launch({channel:'chrome',executablePath:process.env.FGS_CHROME_BIN,args:['--autoplay-policy=no-user-gesture-required']});
try {
  const page=await browser.newPage();
  await page.route('https://timing.test/**',async route=>{
    const {pathname}=new URL(route.request().url());
    if(pathname==='/') return route.fulfill({contentType:'text/html',body:'<script src="/replay/tv/relay-media.js"></script>'});
    if(!['/replay/tv/relay-media.js','/replay/tv/frame-stamp.mjs'].includes(pathname))return route.abort();
    await route.fulfill({contentType:'text/javascript',body:await readFile(path.join(root,pathname))});
  });
  await page.goto('https://timing.test/');
  for(const mime of ['image/jpeg','video/webm;codecs=vp8']){
    const result=await page.evaluate(async mime=>{
      const {createStampWriter,createStampReader}=await import('/replay/tv/frame-stamp.mjs');
      const start=1795610000000, picture=document.createElement('canvas');
      picture.width=480;picture.height=272;
      const ctx=picture.getContext('2d');
      const reader=createStampReader();
      if(reader(picture,480,272).height!==272)throw Error('Unstamped camera was cropped');
      const writer=createStampWriter({toServer:time=>({time,uncertainty:6})});
      const controller=new AbortController();
      let id=0, rotated=false;
      function paint(){
        id=(id+1)%256;
        const width=picture.width;
        for(let bit=0;bit<8;bit++){
          ctx.fillStyle=id & 1<<bit ? 'white':'black';
          ctx.fillRect(bit*width/8,0,width/8,picture.height);
        }
        writer.paint(picture,{time:start+id,estimated:false});
      }
      paint();
      const stream=writer.getStream(),packets=new Map(),observed=new Set();
      const settings={id:'timing-room',origin:'https://timing.test/api',token:'test',key:'A'.repeat(43),
        mimeType:mime,signal:controller.signal,timed:true};
      const fetchOriginal=window.fetch;
      window.fetch=async (input,init)=>{
        const seq=Number(new URL(input).searchParams.get('seq'));
        if(init.method==='POST'){packets.set(seq,init.body);return new Response(null,{status:201});}
        return packets.has(seq)?new Response(packets.get(seq)):new Response(null,{status:204});
      };
      let timer, pumping;
      try {
        await new Promise((resolve,reject)=>{
          timer=setTimeout(()=>reject(Error('Timed relay did not produce enough moving frames')),15000);
          const receive={...settings,onStream:()=>{},onError:reject,onPicture(canvas,stamp){
            if(!stamp)return;
            try {
              if(!([480,272].includes(canvas.width) && canvas.width+canvas.height===752))throw Error('Timing strip leaked into a visible picture');
              const data=canvas.getContext('2d').getImageData(0,64,canvas.width,1).data;
              let depicted=0;
              for(let bit=0;bit<8;bit++)if(data[Math.floor((bit+.5)*canvas.width/8)*4]>128)depicted|=1<<bit;
              if(stamp.time!==start+depicted)throw Error('Timestamp associated with the wrong decoded picture');
              if(stamp.uncertainty!==7 || stamp.estimated)throw Error('Clock quality was lost in transport');
              observed.add(depicted);
              if(observed.size>=4 && !rotated) {rotated=true;picture.width=272;picture.height=480;}
              if(observed.size>=8 && canvas.width===272)resolve();
            }catch(error){reject(error);}
          }};
          pumping=setInterval(paint,65);
          Promise.all([FGSReplayRelay.receive(receive),FGSReplayRelay.send({...settings,stream})]).catch(error=>{
            if(!controller.signal.aborted)reject(error);
          });
        });
        return observed.size;
      } finally {
        clearInterval(pumping); clearTimeout(timer); controller.abort(); writer.stop(); window.fetch=fetchOriginal;
      }
    },mime);
    assert(result>=8);
    console.log(mime+': '+result+' distinct decoded frames matched their encrypted capture markers, including after rotation; original dimensions preserved.');
  }
} finally {await browser.close();}
