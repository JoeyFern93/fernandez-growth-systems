(() => {
  'use strict';
  const apiRoot = 'https://sitereview.fernandezgrowthsystems.com/api/replay-pair';
  const phoneStart = document.getElementById('phone-start');
  const tvButton = document.getElementById('pairTvBtn');
  if (!phoneStart && !tvButton) return;
  const el = id => document.getElementById(id);
  let active = null;
  let qrLib = null;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const hasDirect = () => typeof RTCPeerConnection === 'function';
  const supported = role => window.isSecureContext && (hasDirect() || (role==='tv'
    ? window.FGSReplayRelay?.receiveFormats().length : window.FGSReplayRelay?.sendFormats().length));
  function token() {
    return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  }
  async function api(path, method, credential, body, keepalive = false) {
    const headers = {};
    if (credential) headers.Authorization = 'Bearer ' + credential;
    if (body) headers['Content-Type'] = 'application/json';
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => abort?.abort(), 11000);
    let response;
    try {
      response = await fetch(apiRoot + path, {method, headers, body:body ? JSON.stringify(body) : undefined,
        credentials:'omit', cache:'no-store', referrerPolicy:'no-referrer', keepalive, signal:abort?.signal});
    } finally { clearTimeout(timer); }
    if (!response.ok) {
      const messages = {403:'This pairing link is no longer valid.', 404:'This code has expired.', 409:'This code is already in use.', 410:'This code has expired.', 429:'Pairing is busy. Try again in a moment.'};
      const err = new Error(messages[response.status] || 'The pairing service could not be reached.');
      err.status = response.status;
      throw err;
    }
    return response.status === 204 ? {} : response.json();
  }
  function stopTracks(stream) { stream?.getTracks().forEach(track => track.stop()); }
  function closePeer(s) {
    clearTimeout(s.disconnectTimer); clearTimeout(s.connectionTimer); clearTimeout(s.candidateTimer);
    if (!s.peer) return;
    const peer = s.peer;
    s.peer = null;
    peer.onicecandidate = peer.onconnectionstatechange = peer.oniceconnectionstatechange = peer.ontrack = null;
    peer.close();
  }
  function end(s, notifyServer = true) {
    if (!s || s.ended) return;
    s.ended = true;
    if (active === s) active = null;
    closePeer(s);
    clearTimeout(s.relayHintTimer);
    s.relayController?.abort();
    if (s.role === 'phone') {
      stopTracks(s.media);
      if (el('phone-preview')) {
        el('phone-preview').srcObject = null;
        el('phone-preview').hidden = true;
        el('phone-stop').hidden = true;
        el('phone-options').hidden = true;
        el('phone-relay').hidden = true;
      }
    } else if (s.media) {
      window.FGSReplayCamera?.endRemote(s.media);
      if (tvButton) tvButton.textContent = 'TV display';
    }
    if (notifyServer && s.id && s.key) {
      api('/' + s.id + '/end', 'POST', s.key, null, true).catch(() => {});
    }
  }
  function fail(s, error) {
    if (s.ended) return;
    end(s);
    const message = error.name === 'NotAllowedError' ? 'Allow camera access in your browser, then scan a new TV code.' :
      error.name === 'NotFoundError' ? 'This phone could not find an available camera.' :
      error instanceof TypeError ? 'Pairing could not reach the other device. Check the Wi-Fi and try a new code.' :
      error.message || 'Connection lost. Connect both devices to the same Wi-Fi and scan a new code.';
    if (s.role === 'tv') tvState(message, 'retry');
    else {
      el('phone-status').textContent = message + (message.includes('code') ? '' : ' Scan a new code on the TV to try again.');
      phoneStart.hidden = true;
    }
  }
  function relayOptions(s,mimeType) {
    return {id:s.id,token:s.key,key:s.videoKey,origin:apiRoot,stream:s.media,
      mimeType,signal:s.relayController.signal,
      onStatus:message=>{if(!s.ended && s.role==='phone')el('phone-status').textContent=message;},
      onError:error=>{if(!s.ended && !s.relayController.signal.aborted)fail(s,error);}};
  }
  function offerRelay(s, message) {
    if(s.ended || s.relaying || s.closing)return;
    if(!s.videoKey || !window.FGSReplayRelay || Date.now()>=s.expires) {
      fail(s,new Error(message+' Open TV display on both updated browsers and scan a new code to try the relay.'));
      return;
    }
    clearTimeout(s.connectionTimer);
    s.interrupted=true;
    if(s.role==='phone') {
      el('phone-status').textContent=message+' You can keep this camera connected through the relay.';
      el('phone-options').hidden=true;
      el('phone-relay').hidden=false;
    } else {
      tvState(message+' On the paired phone, tap Use encrypted relay. You can keep this pairing open.', 'relay');
    }
  }
  async function monitorRelay(s) {
    if (!s.videoKey || !window.FGSReplayRelay) return;
    const path='/'+s.id+'/relay';
    let registered=false;
    while (!s.ended && (!s.relaying || s.role==='tv' && !s.relayStarted) && Date.now()<s.expires) {
      try {
        if(s.role==='tv' && !registered){
          const formats=window.FGSReplayRelay.receiveFormats();
          if(!formats.length)return;
          await api(path,'POST',s.key,{action:'request',formats});
          registered=true;
        }
        const state=await api(path,'GET',s.key);
        if(s.ended)return;
        if(state.status==='ended'){fail(s,new Error('The other device ended this pairing.'));return;}
        if(s.role==='phone') {
          s.formats=state.formats || [];
          if(s.interrupted) el('phone-relay').hidden=false;
        } else if(state.status==='active' && !s.relayStarted) {
          s.relayStarted=true; s.relaying=true; s.notified=false;
          closePeer(s);
          if(s.media)window.FGSReplayCamera?.endRemote(s.media);
          s.media=null; s.connected=false; s.started=false;
          s.relayController=new AbortController();
          s.expires=state.expiresAt;
          tvState('Phone approved the encrypted relay. Waiting for its video…','connecting');
          const options=relayOptions(s,state.mimeType);
          options.onStream=async stream=>{
            if (s.ended) { stopTracks(stream); return; }
            s.media=stream;
            try {
              await window.FGSReplayCamera.startRemote(stream);
              if(s.ended)return;
              s.started=true;s.connected=true;tvConnected(s);
            } catch(error) {if(!s.ended)fail(s,error);}
          };
          await window.FGSReplayRelay.receive(options);
          return;
        }
      } catch(error) {
        if (s.ended)return;
        if(s.relayStarted){fail(s,error);return;}
        if(error.status===410){
          if(Date.now()<s.expires-2000 || !s.connected || s.interrupted)fail(s,new Error('This pairing has ended. Open a new code on the TV.'));
          return;
        }
        if(error.status===403 || error.status===404)return;
      }
      await sleep(s.connected && !s.interrupted ? 6500 : 1200);
    }
  }
  async function consentToRelay() {
    const s=active;
    if(!s || s.role!=='phone' || s.ended || s.relaying || !s.media || !s.videoKey)return;
    const button=el('relay-consent');
    if(button.disabled)return;
    button.disabled=true;
    try {
      const state=await api('/'+s.id+'/relay','GET',s.key);
      if(s.ended)return;
      const mime=window.FGSReplayRelay.sendFormats().find(f=>(state.formats||[]).includes(f));
      if(!mime){el('phone-status').textContent='Waiting for the TV to offer a compatible relay format. Keep TV display open and try again.';return;}
      const agreed=await api('/'+s.id+'/relay','POST',s.key,{action:'start',mimeType:mime});
      if(s.ended)return;
      s.relaying=true;s.expires=agreed.expiresAt||s.expires;
      closePeer(s);
      s.relayController=new AbortController();
      el('phone-relay').hidden=true;
      el('phone-options').hidden=true;
      el('phone-status').textContent='Sending encrypted video to the TV. Keep this page open.';
      await window.FGSReplayRelay.send(relayOptions(s,mime));
    } catch(error) {
      if(s.ended)return;
      if(!s.relaying && (error.status===429 || error.status===409 || error.status>=500)){
        el('phone-status').textContent=error.status===429?'The relay is busy. Keep this pairing open and try again shortly.':'The relay is getting ready. Keep the TV open and try again.';
      } else fail(s,error);
    }
    finally{button.disabled=false;}
  }
  async function poll(s, property) {
    const route = '/' + s.id;
    while (!s.ended && !s.relaying && Date.now() < s.expires) {
      let data;
      try { data = await api(route, 'GET', s.key); }
      catch (error) {
        if (error.status && error.status < 500 && error.status !== 429) throw error;
      }
      if (!s.ended && s.role==='tv' && !s.monitoring && data && data.status!=='waiting') {
        s.monitoring=true;
        monitorRelay(s);
        if(!hasDirect())offerRelay(s,'Phone found. This display uses the encrypted relay.');
      }
      if (!s.ended && data?.[property]) return data[property];
      await sleep(1600);
    }
    if(s.relaying || s.ended)return null;
    throw new Error('This pairing code has expired. Show a new code on the TV.');
  }
  function sendCandidates(s, peer) {
    const pending = [];
    let busy = false, complete = false;
    async function flush() {
      if (busy || s.peer !== peer || s.ended || (!pending.length && !complete)) return;
      busy = true;
      const candidates = pending.slice(0,12), last = complete && candidates.length === pending.length;
      try {
        await api('/'+s.id+'/candidates','POST',s.key,{candidates,complete:last});
        pending.splice(0,candidates.length);
        if (last) complete=false;
      } catch (error) {
        // Older deployments can still connect using candidates in the session description.
        if (error.status === 404 || error.status === 410 || error.status === 403) return;
        if (!s.ended && s.peer === peer) await sleep(800);
      } finally { busy=false; }
      if (pending.length || complete) s.candidateTimer=setTimeout(flush,120);
    }
    peer.onicecandidate = event => {
      if (s.ended || s.peer !== peer) return;
      if (event.candidate?.candidate) {
        const {candidate,sdpMid,sdpMLineIndex,usernameFragment} = event.candidate;
        if (pending.length < 64) pending.push({candidate,sdpMid,sdpMLineIndex,usernameFragment});
      } else complete=true;
      clearTimeout(s.candidateTimer);
      s.candidateTimer=setTimeout(flush,60);
    };
  }
  async function receiveCandidates(s, peer) {
    let cursor=0;
    const applied=new Set();
    while (!s.ended && s.peer===peer && Date.now()<s.expires) {
      try {
        const result=await api('/'+s.id+'/candidates?after='+cursor,'GET',s.key);
        if (s.ended || s.peer!==peer) return;
        for(const c of result.candidates || []) {
          const id=c.candidate+' '+c.sdpMid;
          if(applied.has(id))continue;
          try { await peer.addIceCandidate(c); } catch { /* A duplicate or unusable route does not invalidate other routes. */ }
          applied.add(id);
        }
        cursor=result.next ?? cursor;
        if(result.complete) return;
      } catch(error) { if(error.status===403 || error.status===404 || error.status===410)return; }
      await sleep(s.connected ? 1800 : 550);
    }
  }
  async function localDescription(peer, description) {
    await peer.setLocalDescription(description);
    if (peer.iceGatheringState !== 'complete') {
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', changed); resolve(); };
        const changed = () => { if (peer.iceGatheringState === 'complete') finish(); };
        const timer = setTimeout(finish, 1450);
        peer.addEventListener('icegatheringstatechange', changed);
        changed();
      });
    }
    const result = peer.localDescription;
    if (!result) throw new Error('Pairing ended before the connection was ready.');
    return {type:result.type, sdp:result.sdp};
  }
  async function peerFor(s) {
    let iceServers=[{urls:'stun:stun.cloudflare.com:3478'}];
    try {
      const config=await api('/'+s.id+'/ice-servers','GET',s.key);
      if(Array.isArray(config.iceServers) && config.iceServers.length) iceServers=config.iceServers;
    } catch { /* Keep discovery available when optional configuration is offline. */ }
    if(s.ended)throw new Error('Pairing was closed.');
    const peer = new RTCPeerConnection({iceServers});
    s.peer = peer;
    sendCandidates(s,peer);
    function changed() {
      if (s.ended || s.relaying || s.peer!==peer) return;
      const state = peer.connectionState || peer.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        s.connected = true;
        s.interrupted=false;
        clearTimeout(s.disconnectTimer); s.disconnectTimer=null; clearTimeout(s.connectionTimer);
        if (s.role === 'phone') {
          el('phone-status').textContent = 'Connected. Your camera is sending video to the TV.';
          if (!s.manualRelay) {
            el('phone-relay').hidden=true;
            el('phone-options').hidden=!s.videoKey;
          }
        }
        else if (s.started) tvConnected(s);
      } else if (state === 'failed' || state === 'closed') {
        offerRelay(s, s.connected ? 'The direct video connection was interrupted.' : 'The phone and TV paired, but a direct video connection did not open.');
      } else if (state === 'disconnected' && !s.disconnectTimer) {
        s.disconnectTimer = setTimeout(() => offerRelay(s,'The direct video connection was interrupted.'), 9000);
      }
    }
    peer.onconnectionstatechange = peer.oniceconnectionstatechange = changed;
    return peer;
  }
  function watchConnection(s) {
    if (!s.connected && !s.ended) s.connectionTimer = setTimeout(() => offerRelay(s,'The devices paired, but the direct video connection timed out.'), 19000);
  }
  function loadQr() {
    if (!qrLib) qrLib = new Promise((resolve,reject) => {
      const script=document.createElement('script');
      script.src='/replay/tv/qrcode.js';
      script.onload=resolve;
      script.onerror=() => { qrLib=null; script.remove(); reject(new Error('The QR code could not load. Try a new code.')); };
      document.head.append(script);
    });
    return qrLib;
  }
  function tvState(message, state) {
    const dialog=el('tv-pair-dialog');
    el('tv-pair-status').textContent=message;
    if (state!=='code') {
      el('tv-qr').replaceChildren();
      el('tv-phone-link').removeAttribute('href');
      el('tv-phone-link').hidden=true;
    }
    el('tv-new').hidden=state!=='retry';
    if(el('tv-play'))el('tv-play').hidden=state!=='play';
    el('tv-end').hidden=state!=='connected';
    el('tv-close').textContent=state==='connected'?'Back to replay':'Close';
    if (!dialog.open) dialog.showModal();
  }
  function tvConnected(s) {
    if (s.ended || s.notified) return;
    s.notified=true;
    tvButton.textContent=s.relaying?'Phone connected · relay':'Phone connected';
    el('tv-pair-dialog').close();
  }
  async function openTv() {
    if (active?.role==='tv') {
      if (active.connected) tvState('The phone is sending video. Use the dashboard to set the delay or review a frame.', 'connected');
      else if (!el('tv-pair-dialog').open) el('tv-pair-dialog').showModal();
      return;
    }
    if (!supported('tv')) { tvState('This TV browser cannot receive a camera stream. Open this TV display on a computer connected to the TV.', 'unavailable'); return; }
    const s={role:'tv', key:token(), videoKey:token()};
    active=s;
    tvState('Preparing your private code…', 'loading');
    try {
      await loadQr();
      if (s.ended) return;
      const session=await api('', 'POST', null, {tvToken:s.key});
      s.id=session.id; s.expires=session.expiresAt;
      if (s.ended) { api('/'+s.id+'/end','POST',s.key).catch(()=>{}); return; }
      const link=new URL('/replay/tv/phone.html', location.origin);
      link.hash='pair='+s.id+'.'+session.invite+'&key='+s.videoKey;
      const code=window.qrcode(0,'M');
      code.addData(link.href); code.make();
      tvState('Scan this code with your phone, then tap Start camera. Use the same Wi-Fi on both devices.', 'code');
      el('tv-qr').innerHTML=code.createSvgTag({cellSize:5,margin:20,scalable:true});
      el('tv-phone-link').href=link.href; el('tv-phone-link').hidden=false;
      const offer=await poll(s,'offer');
      if (s.ended || s.relaying || !offer) return;
      if (!hasDirect()) { offerRelay(s,'Phone found. This display uses the encrypted relay.');return; }
      tvState('Phone found. Connecting its camera…','connecting');
      const peer=await peerFor(s);
      peer.ontrack=async event => {
        if (s.ended || event.track.kind!=='video') return;
        s.media=new MediaStream([event.track]);
        try {
          if (!window.FGSReplayCamera) throw new Error('Reload Replay Cam to receive this phone camera.');
          // The dashboard opens its delayed player from this stream without requesting a TV camera.
          await window.FGSReplayCamera.startRemote(s.media);
          if (s.ended) return;
          s.started=true;
          if (s.connected) tvConnected(s);
        } catch (error) { if(!s.ended && !s.relaying)offerRelay(s,error.message||'The TV did not receive camera frames.'); }
      };
      await peer.setRemoteDescription(offer);
      receiveCandidates(s,peer);
      const answer=await localDescription(peer,await peer.createAnswer());
      if (s.ended) return;
      await api('/'+s.id+'/answer','POST',s.key,answer);
      watchConnection(s);
    } catch (error) {
      if(s.ended || s.relaying)return;
      if(s.monitoring && !error.status && Date.now()<s.expires)offerRelay(s,'The TV could not open direct video.');
      else fail(s,error);
    }
  }
  function makeTvDialog() {
    const dialog=document.createElement('dialog');
    dialog.id='tv-pair-dialog'; dialog.className='tv-pair'; dialog.setAttribute('aria-labelledby','tv-pair-title');
    if (typeof dialog.showModal !== 'function') {
      dialog.classList.add('tv-dialog-fallback');dialog.setAttribute('role','dialog');
      dialog.showModal=()=>{dialog.open=true;dialog.setAttribute('open','');el('tv-close')?.focus();};
      dialog.close=()=>{dialog.open=false;dialog.removeAttribute('open');tvButton.focus();};
    }
    dialog.innerHTML='<h2 id="tv-pair-title">Use your phone as the camera</h2><p id="tv-pair-status" role="status"></p><div id="tv-qr" class="pair-qr" role="img" aria-label="Scan to connect a phone camera"></div><a id="tv-phone-link" referrerpolicy="no-referrer" target="_blank" rel="noopener noreferrer" hidden>Open phone link</a><div class="pair-actions"><button id="tv-new" type="button" hidden>Show new code</button><button id="tv-end" type="button" hidden>Disconnect phone</button><button id="tv-close" type="button">Close</button></div>';
    document.body.append(dialog);
    function dismiss() { if (active && !active.connected) end(active); dialog.close(); }
    const play=document.createElement('button');play.type='button';play.id='tv-play';play.textContent='Play phone video';play.hidden=true;
    el('tv-close').before(play);
    play.onclick=()=>window.FGSReplayCamera?.resumeRemote?.();
    el('tv-close').onclick=dismiss;
    el('tv-end').onclick=()=>{end(active); dialog.close();tvButton.focus();};
    el('tv-new').onclick=openTv;
    dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss();});
    tvButton.addEventListener('click',openTv);
    window.addEventListener('fgs:remote-phase',event=>{
      if(active?.role!=='tv')return;
      const {phase,message}=event.detail||{};
      play.hidden=phase!=='playback-blocked';
      if(phase==='playback-blocked')tvState(message||'Tap Play phone video on this display.','play');
      else if(phase==='waiting-video' && dialog.open && !active.interrupted) el('tv-pair-status').textContent='Phone paired. Waiting for the first video frame…';
    });
    window.addEventListener('fgs:remote-stopped',event=>{
      const s=active;
      if(s?.role!=='tv' || s.ended)return;
      const {reason,message}=event.detail||{};
      if(s.relaying && reason==='external')return;
      if(reason==='user' || reason==='pagehide' || !reason){s.closing=true;end(s);return;}
      if(!s.relaying)offerRelay(s,message||'The TV stopped receiving phone video.');
      else if(reason!=='external')fail(s,new Error(message||'The relay video stopped.'));
    });
    if (new URLSearchParams(location.search).get('mode')==='tv') openTv();
  }
  function setupPhone() {
    const params=new URLSearchParams(location.hash.slice(1));
    const match=/^([a-zA-Z0-9_-]{10,90})\.([a-zA-Z0-9_-]{16,96})$/.exec(params.get('pair')||'');
    if (!match || !supported('phone') || !navigator.mediaDevices?.getUserMedia) {
      phoneStart.hidden=true;
      el('phone-status').textContent=match?'Open this link in a browser that supports camera sharing.':'Open Replay Cam TV display and scan its QR code with this phone.';
      return;
    }
    phoneStart.onclick=async()=>{
      if (active) return;
      const secret=params.get('key');
      const s={role:'phone',id:match[1],key:token(),videoKey:/^[A-Za-z0-9_-]{43}$/.test(secret||'')?secret:null};
      active=s; phoneStart.disabled=true;
      try {
        el('phone-status').textContent='Connecting to your TV…';
        const session=await api('/'+s.id+'/claim','POST',null,{invite:match[2],phoneToken:s.key});
        if (s.ended) return;
        s.expires=session.expiresAt;
        el('phone-status').textContent='Allow camera access to start sending video.';
        phoneStart.hidden=true; el('phone-stop').hidden=false;
        const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:240}}});
        if (s.ended) { stopTracks(stream);return; }
        s.media=stream;
        el('phone-options').hidden=!s.videoKey;
        const track=stream.getVideoTracks()[0];
        if (!track) throw new Error('The phone camera did not provide a video track.');
        track.addEventListener('ended',()=>fail(s,new Error('The camera stopped.')),{once:true});
        const preview=el('phone-preview'); preview.srcObject=stream; preview.hidden=false; preview.play().catch(()=>{});
        el('phone-status').textContent='Camera ready. Waiting for the TV…';
        monitorRelay(s);
        if(!hasDirect()){offerRelay(s,'This phone uses the encrypted relay to send video.');return;}
        s.relayHintTimer=setTimeout(()=>{
          if (!s.ended && !s.connected && !s.relaying && s.videoKey)offerRelay(s,'The TV is taking longer to receive video.');
        },9500);
        const peer=await peerFor(s);
        peer.addTransceiver(track,{direction:'sendonly',streams:[stream]});
        const offer=await localDescription(peer,await peer.createOffer());
        if (s.ended || s.relaying) return;
        await api('/'+s.id+'/offer','POST',s.key,offer);
        const answer=await poll(s,'answer');
        if (s.ended || s.relaying || !answer) return;
        await peer.setRemoteDescription(answer);
        receiveCandidates(s,peer);
        watchConnection(s);
      } catch (error) {
        if(s.ended || s.relaying)return;
        if(s.media && !error.status && Date.now()<s.expires)offerRelay(s,'The phone could not open direct video.');
        else fail(s,error);
      }
    };
    phoneStart.disabled=false;
    el('phone-stop').onclick=()=>{end(active);el('phone-status').textContent='Camera disconnected. Scan a new TV code to connect again.';};
    el('relay-consent').onclick=consentToRelay;
    el('phone-options').onclick=()=>{
      if(!active?.media)return;
      active.manualRelay=true;
      offerRelay(active,'If the TV is blank, you can switch how the video gets there.');
      el('relay-consent').focus();
    };
  }
  window.addEventListener('pagehide',()=>end(active));
  if (phoneStart) setupPhone(); else makeTvDialog();
})();
