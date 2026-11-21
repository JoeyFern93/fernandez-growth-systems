// Disposable browser test supplement. Each represented camera frame has its
// own number and timestamp; no product assets are changed.
function generatedCamera(fps) {
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value: async () => {
    const track=new MediaStreamTrackGenerator({kind:'video'});
    Object.defineProperties(track,{
      getSettings:{value:()=>({width:320,height:180,frameRate:fps,deviceId:'test-camera'})},
      getCapabilities:{value:()=>({frameRate:{min:1,max:fps}})},
      getConstraints:{value:()=>({frameRate:{ideal:fps}})}
    });
    const video=document.createElement('canvas');video.width=320;video.height=180;
    const ctx=video.getContext('2d',{alpha:false});
    const writer=track.writable.getWriter();
    let frame=0;const clock=performance.now(),interval=1000/fps;
    const ticks=new MessageChannel();
    ticks.port1.onmessage=async()=>{
      if(track.readyState==='ended'){ticks.port1.close();ticks.port2.close();writer.close().catch(()=>{});return;}
      const delta=clock+frame*interval-performance.now();
      if(delta>0){ticks.port2.postMessage(0);return;}
      const code=frame%128;ctx.fillStyle='#202020';ctx.fillRect(0,0,320,180);ctx.fillStyle='#e0e0e0';ctx.fillRect(0,0,32,180);
      for(let b=0;b<7;b++)if((code>>b)&1)ctx.fillRect((b+1)*32,0,32,180);
      const next=new VideoFrame(video,{timestamp:Math.round((clock+frame*interval)*1000),duration:Math.round(interval*1000)});frame++;
      try{await writer.write(next);}finally{next.close();}
      ticks.port2.postMessage(0);
    };
    ticks.port2.postMessage(0);
    return new MediaStream([track]);
  }});
}
