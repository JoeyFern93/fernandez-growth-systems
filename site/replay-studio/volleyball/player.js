(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const api=window.FGSVolleyball, video=$('video'), scrub=$('scrub');
  let local='', clock=3.6, start=0, playing=false, raf=0, view='follow';
  const duration=()=>local ? (Number.isFinite(video.duration)?video.duration:0) : api.duration;
  const now=()=> local ? video.currentTime : Math.min(duration(),clock+(playing?(performance.now()-start)/1000:0));
  function pause() {
    clock=now();playing=false;video.pause();cancelAnimationFrame(raf);raf=0;
    $('play').textContent='Play';
  }
  function display() {
    const t=now(), both=!local && $('angle').value==='both';
    const angle=$('angle').value==='sideline'?'sideline':'baseline', fps=Number($('fps').value);
    $('viewer').classList.toggle('pair',both);$('second').hidden=!both;
    $('caption').textContent=local?'Full Court':(angle==='sideline'?'Raised sideline':'Baseline')+' · '+(view==='follow'?'Follow Play':'Full Court');
    $('wide').setAttribute('aria-pressed',String(view==='full'));$('follow').setAttribute('aria-pressed',String(view==='follow'));
    if(!local) {
      api.renderMock($('primary'),t,{angle,view,fps});
      if(both)api.renderMock($('secondary'),t,{angle:'sideline',view:'full',fps});
    }
    const end=duration();
    scrub.disabled=!end;scrub.max=end||1;scrub.value=t;
    $('time').textContent=t.toFixed(2)+' / '+(end?end.toFixed(2):'—')+' s';
  }
  function tick() {
    display();
    if(now()>=duration() && duration()>0)pause();
    if(playing)raf=requestAnimationFrame(tick);
  }
  $('play').onclick=async()=>{
    if(playing){pause();display();return;}
    if(!local && !duration())return;
    if((duration() && now()>=duration()) || (local && video.ended)){clock=0;if(local)video.currentTime=0;}
    if(local) {
      try {await video.play();}catch{$('note').textContent='The browser could not play this file. Open a browser-supported local video.';return;}
    }
    playing=true;start=performance.now();$('play').textContent='Pause';tick();
  };
  scrub.oninput=()=>{clock=Number(scrub.value);start=performance.now();if(local && duration())video.currentTime=clock;display();};
  $('angle').onchange=$('fps').onchange=display;
  $('wide').onclick=()=>{view='full';display();};
  $('follow').onclick=()=>{if(!local)view='follow';display();};
  function setSource(file) {
    pause();const old=local;video.removeAttribute('src');video.load();if(old)URL.revokeObjectURL(old);
    local=file?URL.createObjectURL(file):'';view=local?'full':'follow';clock=local?0:3.6;
    $('angle').disabled=$('fps').disabled=$('follow').disabled=!!local;
    $('reset').hidden=!local;$('primary').hidden=!!local;video.hidden=!local;
    $('source').textContent=local?file.name:'Mock rally';
    $('note').textContent=local?'Local original · Full Court. Follow Play is available in the demo.':'16-second mock rally with synthetic ball and player tracks. Choose a local recording to watch it in Full Court.';
    if(local)video.src=local;else $('file').value='';
    display();
  }
  video.onloadedmetadata=video.ondurationchange=video.onseeked=display;video.onended=()=>{pause();display();};
  video.onerror=()=>{if(local)$('note').textContent='This video could not be decoded. Open an MP4 or WebM supported by your browser.';};
  $('file').onchange=()=>{const f=$('file').files[0];if(f)setSource(f);};
  $('reset').onclick=()=>setSource(null);
  window.addEventListener('pagehide',event=>{pause();if(local && !event.persisted){URL.revokeObjectURL(local);local='';}});
  display();
})();
