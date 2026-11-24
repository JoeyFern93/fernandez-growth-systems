(() => {
  'use strict';
  const apiRoot = window.FGSReplayPairEndpoint;
  const phoneStart = document.getElementById('phone-start');
  const tvButton = document.getElementById('pairTvBtn');
  if (!phoneStart && !tvButton) return;
  const el = id => document.getElementById(id);
  let active = null;
  let qrLib = null;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const firstFrameWait = 12000, stallWait = 4500, relayFrameWait = 18000;
  const current = s => active===s && !s.ended;
  function expiry(s, until) {
    clearTimeout(s.expiryTimer);
    s.expires=until;
    s.expiryTimer=setTimeout(()=>fail(s,new Error('This private room expired.')),Math.max(0,until-Date.now()));
  }
  function transport(s, label) {
    s.transport=label;
    window.FGSReplayQuality?.transport?.(label);
  }
  function frameStatus(s, value) {
    s.directStatus=value;
    if(s.sendingFrameStatus || !current(s))return;
    s.sendingFrameStatus=true;
    const send=async()=>{
      // Keep the receipt eligible throughout the phone's bounded first-frame wait.
      const until=Math.min(s.expires,Date.now()+firstFrameWait);
      while(current(s) && (!s.relaying || s.directStatus==='relay-moving') && s.sentFrameStatus!==s.directStatus && Date.now()<until) {
        const state=s.directStatus;
        try {
          await api('/'+s.id+'/relay','POST',s.key,{action:'direct',state});
          s.sentFrameStatus=state;
        } catch(error) {
          if(error.status===410 || error.status===403 || error.status===404 || error.status===400)break;
          if(!current(s) || Date.now()>=s.expires)break;
          await sleep(1500);
        }
      }
      s.sendingFrameStatus=false;
    };
    send();
  }
  // Inspect the actual dashboard decoder. A playing event or an ICE connection
  // can occur with a single frozen frame. Neither constitutes frame progress.
  function observeDisplay(s, relay=false) {
    s.cancelFrames?.();
    const video=el('liveVideo'), began=Date.now();
    let previous,frames=0,last=began,callback,interval,closed=false,readingStats=false,lastStatsAt=0;
    const counters=new Map();
    function progress(count=1) {
      if(closed || !current(s) || video.paused || !video.videoWidth)return;
      last=Date.now();
      frames+=count;
      if(frames<2 || s.usable)return;
      s.usable=true;
      if(relay)frameStatus(s,'relay-moving');
      else {s.hadDirectFrames=true;transport(s,'Direct WebRTC');frameStatus(s,'moving');}
      if(s.started)tvConnected(s);
    }
    function decoded(source,count) {
      const before=counters.get(source);
      if(!Number.isFinite(count))return;
      counters.set(source,count);
      // Two distinct, nonzero samples from the same decoder establish progress.
      if(before>0 && count>before)progress(2);
    }
    function presented(_,meta) {
      if(closed)return;
      const stamp=meta.rtpTimestamp ?? meta.mediaTime;
      if(Number.isFinite(stamp) && stamp!==previous){previous=stamp;progress();}
      callback=video.requestVideoFrameCallback(presented);
    }
    if(video.requestVideoFrameCallback)callback=video.requestVideoFrameCallback(presented);
    interval=setInterval(async()=>{
      if(closed || !current(s))return;
      if(Date.now()-last>=750) {
        const quality=video.getVideoPlaybackQuality?.();
        if(quality)decoded('element',quality.totalVideoFrames-quality.droppedVideoFrames);
        else decoded('element',video.webkitDecodedFrameCount);
      }
      // The dashboard's hidden source can decode without presenting callbacks,
      // including before its first visible replay. ICE alone cannot confirm video.
      if(s.peer && !readingStats && Date.now()-last>=1000 && Date.now()-lastStatsAt>=750){
        readingStats=true;lastStatsAt=Date.now();
        try {
          const reports=await s.peer.getStats();
          if(closed || !current(s))return;
          for(const row of reports.values()) {
            if(row.type!=='inbound-rtp' || (row.kind || row.mediaType)!=='video' || !Number.isFinite(row.framesDecoded))continue;
            decoded('rtp:'+row.id,row.framesDecoded);
          }
        } catch { /* A closing peer can discard pending stats. */ }
        finally {readingStats=false;}
      }
      if(closed || !current(s))return;
      if(Date.now()-last < (s.usable ? stallWait : relay ? relayFrameWait : firstFrameWait))return;
      s.cancelFrames();
      if(relay)fail(s,new Error('The internet relay did not deliver playable video.'));
      else offerRelay(s,'The display stopped receiving direct video.');
    },250);
    s.cancelFrames=()=>{
      closed=true;clearInterval(interval);
      if(callback!==undefined)video.cancelVideoFrameCallback?.(callback);
      s.cancelFrames=null;
    };
  }
  const hasDirect = () => typeof RTCPeerConnection === 'function';
  const supported = role => window.isSecureContext && (hasDirect() || (role==='tv'
    ? window.FGSReplayRelay?.receiveFormats().length : window.FGSReplayRelay?.sendFormats().length));
  function token() {
    return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  }
  async function api(path, method, credential, body, keepalive = false) {
    if (!apiRoot) throw new Error('Phone pairing is unavailable at this address. Open Replay Cam from its website or the test preview.');
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
      const messages = {403:'This pairing link is no longer valid.', 404:'This code has expired.', 409:'This code is already in use.', 410:'This code has expired.', 429:'The pairing service is busy.'};
      const err = new Error(messages[response.status] || 'The pairing service could not be reached.');
      err.status = response.status;
      throw err;
    }
    return response.status === 204 ? {} : response.json();
  }
  function stopTracks(stream) { stream?.getTracks().forEach(track => track.stop()); }
  function closePeer(s) {
    clearTimeout(s.disconnectTimer); clearTimeout(s.connectionTimer); clearTimeout(s.candidateTimer);
    s.capture?.setSender(null);
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
    clearTimeout(s.expiryTimer);clearTimeout(s.frameDeadline);
    s.cancelFrames?.();
    s.relayController?.abort();
    transport(s,'Disconnected');
    if (s.role === 'phone') {
      s.capture?.stop();
      stopTracks(s.media);
      if (el('phone-preview')) {
        el('phone-preview').srcObject = null;
        el('phone-preview').hidden = true;
        el('phone-stop').hidden = true;
        el('phone-options').hidden = true;
      }
    } else if (s.media) {
      window.FGSReplayCamera?.endRemote(s.media);
      if (s.handoffPrevious && s.handoffPrevious !== s.media) window.FGSReplayCamera?.endRemote(s.handoffPrevious);
      if (tvButton) tvButton.textContent = 'Pair phone to TV';
    }
    if (notifyServer && s.id && s.key && (s.role!=='phone' || s.claimed || s.claimSent)) {
      api('/' + s.id + '/end', 'POST', s.key, null, true).catch(() => {});
    }
  }
  function fail(s, error) {
    if (s.ended) return;
    end(s);
    const creatingRoom=s.role==='tv' && !s.id;
    const message = creatingRoom && error.status===429 ? 'The pairing service is busy. Wait a minute, then retry.' :
      creatingRoom && error.status===403 ? 'The pairing service did not accept this display address.' :
      creatingRoom ? 'Could not create a private room. Check that this display is online, then retry.' :
      error.name === 'NotAllowedError' ? 'Allow camera access in your browser settings.' :
      error.name === 'NotFoundError' ? 'This phone could not find an available camera.' :
      error instanceof TypeError ? 'Pairing could not reach the service.' :
      error.message || 'The room connection was lost.';
    if (s.role === 'tv') tvState(message, 'retry');
    else {
      el('phone-status').textContent = message + (error.name==='NotAllowedError' ? '' : ' Open a new TV room to retry.');
      phoneStart.hidden = true;
    }
  }
  function relayOptions(s,mimeType) {
    return {id:s.id,token:s.key,key:s.videoKey,origin:apiRoot,stream:s.capture?.forRelay(mimeType) || s.media,
      mimeType,signal:s.relayController.signal,
      onStatus:message=>{if(!s.ended && s.role==='phone')el('phone-status').textContent=message;},
      onError:error=>{if(!s.ended && !s.relayController.signal.aborted)fail(s,error);}};
  }
  function offerRelay(s, message) {
    if(!current(s) || s.relaying || s.relayPending || s.interrupted || s.closing)return;
    if(s.directOnly || !s.videoKey || !window.FGSReplayRelay || Date.now()>=s.expires) {
      fail(s,new Error(s.directOnly ? message+' Direct only is selected.' : message));
      return;
    }
    s.interrupted=true;s.usable=false;
    clearTimeout(s.frameDeadline);clearTimeout(s.connectionTimer);clearTimeout(s.disconnectTimer);
    s.cancelFrames?.();
    if(s.role==='phone')switchToRelay(s);
    else {
      if (s.media) s.keepReplay = !!window.FGSReplayCamera?.prepareRemoteHandoff?.(s.media);
      frameStatus(s,'fallback');
      tvState('Switching to internet relay.'+switchNotice(s),'relay');
    }
  }
  function showTransport(s,mime) {
    transport(s,mime==='image/jpeg'?'JPEG relay · low quality':'Encrypted video relay');
  }
  function switchNotice(s) {
    if (s.role !== 'tv' || !s.hadDirectFrames) return '';
    return s.keepReplay ? ' Earlier replay remains available.' : ' TV replay history starts over at the switch.';
  }
  async function monitorRelay(s) {
    const path='/'+s.id+'/relay';
    let registered=false;
    while (current(s) && (!s.relaying || s.role==='phone' && !s.relayConfirmed) && Date.now()<s.expires) {
      try {
        if(s.role==='tv' && !registered){
          const formats=window.FGSReplayRelay?.receiveFormats() || [];
          if(formats.length)await api(path,'POST',s.key,{action:'request',formats});
          registered=true;
        }
        const state=await api(path,'GET',s.key);
        if(!current(s))return;
        if(state.status==='ended'){fail(s,new Error('The other device ended this pairing.'));return;}
        if(s.role==='phone') {
          s.formats=state.formats || [];
          if(s.relaying && state.direct==='relay-moving'){
            s.relayConfirmed=true;clearTimeout(s.frameDeadline);
            el('phone-status').textContent=s.transport+' · The TV is receiving video.'+switchNotice(s);
            return;
          }
          if(state.direct==='fallback')offerRelay(s,'The TV could not receive direct video.');
          if(state.direct==='moving' && !s.interrupted && !s.relayPending && !s.usable){
            s.usable=true;s.hadDirectFrames=true;
            clearTimeout(s.frameDeadline);
            transport(s,'Direct WebRTC');
            el('phone-status').textContent='Direct WebRTC · The TV is receiving video.';
          }
        } else if(state.status==='active') {
          s.relaying=true;s.notified=false;s.usable=false;
          clearTimeout(s.frameDeadline);s.cancelFrames?.();
          if (s.media) s.keepReplay = !!window.FGSReplayCamera?.prepareRemoteHandoff?.(s.media);
          if (s.keepReplay) s.handoffPrevious = s.media;
          closePeer(s);
          if(s.media && !s.keepReplay) { window.FGSReplayCamera?.endRemote(s.media); s.media=null; }
          s.connected=false;s.started=false;
          s.relayController=new AbortController();
          expiry(s,state.expiresAt);showTransport(s,state.mimeType);
          tvState('Switching to internet relay. Waiting for video.'+switchNotice(s),'connecting');
          s.frameDeadline=setTimeout(()=>fail(s,new Error('The internet relay did not deliver playable video.')),relayFrameWait);
          const options=relayOptions(s,state.mimeType);
          options.onStream=async stream=>{
            if(!current(s)){stopTracks(stream);return;}
            s.media=stream;
            observeDisplay(s,true);
            try {
              await window.FGSReplayCamera.startRemote(stream,s.keepReplay);
              if(!current(s))return;
              s.handoffPrevious=null;
              s.started=true;s.connected=true;
              if(s.usable)tvConnected(s);
            } catch(error){if(current(s))fail(s,error);}
          };
          await window.FGSReplayRelay.receive(options);
          return;
        }
      } catch(error) {
        if(!current(s))return;
        if(s.relaying || [410,403,404].includes(error.status)){fail(s,error);return;}
      }
      await sleep(s.usable && !s.interrupted ? 2500 : 850);
    }
  }
  async function switchToRelay(s) {
    if(!current(s) || s.role!=='phone' || s.directOnly || s.relaying || s.relayPending || !s.media)return;
    s.relayPending=true;
    s.updateRelayButton?.();
    el('phone-status').textContent='Switching to internet relay.'+switchNotice(s);
    closePeer(s);
    try {
      const deadline=Math.min(s.expires,Date.now()+14000);
      while(current(s) && !s.formats?.length && Date.now()<deadline)await sleep(200);
      if(!current(s))return;
      const mime=window.FGSReplayRelay.sendFormats().find(f=>s.formats?.includes(f));
      if(!mime)throw new Error('The display did not offer a compatible relay format.');
      const agreed=await api('/'+s.id+'/relay','POST',s.key,{action:'start',mimeType:mime});
      if(!current(s))return;
      s.relaying=true;
      s.updateRelayButton?.();
      expiry(s,agreed.expiresAt || s.expires);
      s.relayController=new AbortController();
      showTransport(s,mime);
      s.frameDeadline=setTimeout(()=>fail(s,new Error('The TV did not confirm relay video.')),relayFrameWait+4000);
      el('phone-status').textContent=s.transport+' · Sending video to the TV.';
      await window.FGSReplayRelay.send(relayOptions(s,mime));
    } catch(error){
      if(current(s))fail(s,error);
    } finally{s.relayPending=false;}
  }
  async function poll(s, property) {
    const route = '/' + s.id;
    while (!s.ended && !s.relaying && !s.interrupted && Date.now() < s.expires) {
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
    if(s.relaying || s.interrupted || s.ended)return null;
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
      } else if(event.candidate==null) complete=true;
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
    const localPreview=!!document.querySelector('meta[name="replay-preview-local"]');
    let iceServers=localPreview ? [] : [{urls:'stun:stun.cloudflare.com:3478'}];
    try {
      // Discovery has working defaults. Two slow configuration lookups must
      // not consume the entire time allotted for actual direct video.
      const config=await Promise.race([api('/'+s.id+'/ice-servers','GET',s.key),sleep(1250)]);
      if(Array.isArray(config?.iceServers) && (config.iceServers.length || localPreview)) iceServers=config.iceServers;
    } catch { /* Keep discovery available when optional configuration is offline. */ }
    if(s.ended || s.relaying || s.interrupted)throw new Error('The direct connection is no longer needed.');
    const peer = new RTCPeerConnection({iceServers});
    s.peer = peer;
    window.FGSReplayQuality?.peer?.(peer,s.role);
    sendCandidates(s,peer);
    function changed() {
      if (s.ended || s.relaying || s.peer!==peer || s.interrupted) return;
      const state = peer.connectionState || peer.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        s.connected=true;
        clearTimeout(s.disconnectTimer);s.disconnectTimer=null;
      } else if (state === 'failed' || state === 'closed') {
        offerRelay(s, s.connected ? 'The direct video connection was interrupted.' : 'The phone and TV paired, but a direct video connection did not open.');
      } else if (state === 'disconnected' && !s.disconnectTimer) {
        s.disconnectTimer = setTimeout(() => offerRelay(s,'The direct video connection was interrupted.'), stallWait);
      }
    }
    peer.onconnectionstatechange = peer.oniceconnectionstatechange = changed;
    return peer;
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
    el('tv-copy-link').hidden=state!=='code';
    el('tv-copy-status').textContent='';
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
    if (!current(s) || !s.usable || s.notified) return;
    clearTimeout(s.frameDeadline);
    s.notified=true;
    tvButton.textContent=s.transport+(s.relaying && s.hadDirectFrames && !s.keepReplay?' · New TV buffer':'');
    el('tv-pair-dialog').close();
  }
  async function openTv() {
    if (active?.role==='tv') {
      if (active.usable) tvState(active.transport+' · The TV is receiving video.'+(active.relaying?switchNotice(active):''), 'connected');
      else if (!el('tv-pair-dialog').open) el('tv-pair-dialog').showModal();
      return;
    }
    if (!supported('tv')) { tvState('This TV browser cannot receive a camera stream. Open this TV display on a computer connected to the TV.', 'unavailable'); return; }
    const s={role:'tv', key:token(), videoKey:token()};
    active=s;
    tvState('Creating your private TV room.', 'loading');
    try {
      const session=await api('', 'POST', null, {tvToken:s.key});
      if (!/^[A-Za-z0-9_-]{10,90}$/.test(session?.id || '') ||
          !/^[A-Za-z0-9_-]{16,96}$/.test(session?.invite || '') || !Number.isFinite(session?.expiresAt) || session.expiresAt<=Date.now()) {
        throw new Error('The pairing service returned an incomplete invite.');
      }
      s.id=session.id;
      if (s.ended) { api('/'+s.id+'/end','POST',s.key).catch(()=>{}); return; }
      expiry(s,session.expiresAt);
      const link=new URL('/replay/tv/phone', location.origin);
      link.hash='pair='+s.id+'.'+session.invite+'&key='+s.videoKey;
      tvState('Open the private phone link or scan the QR code, then tap Start camera. The phone can use a different network. Share the link only with the person using the camera.', 'code');
      el('tv-phone-link').href=link.href; el('tv-phone-link').hidden=false;
      loadQr().then(()=>{
        if (s.ended || el('tv-phone-link').getAttribute('href')!==link.href) return;
        const code=window.qrcode(0,'M');
        code.addData(link.href); code.make();
        el('tv-qr').innerHTML=code.createSvgTag({cellSize:5,margin:20,scalable:true});
      }).catch(()=>{
        if (!s.ended && el('tv-phone-link').getAttribute('href')===link.href)
          el('tv-pair-status').textContent='The QR code is unavailable. Copy the private phone link and open it on the camera phone.';
      });
      const offer=await poll(s,'offer');
      if (s.ended || s.relaying || s.interrupted || !offer) return;
      if (!hasDirect()) { offerRelay(s,'Phone found. This display uses the encrypted relay.');return; }
      tvState('Connecting directly.','connecting');
      const peer=await peerFor(s);
      peer.ontrack=async event => {
        if (!current(s) || s.interrupted || s.peer!==peer || event.track.kind!=='video') return;
        s.media=new MediaStream([event.track]);
        observeDisplay(s);
        try {
          if (!window.FGSReplayCamera) throw new Error('Reload Replay Cam to receive this phone camera.');
          // The dashboard opens its delayed player from this stream without requesting a TV camera.
          await window.FGSReplayCamera.startRemote(s.media);
          if (!current(s) || s.interrupted || s.peer!==peer) return;
          s.started=true;
          if (s.usable) tvConnected(s);
        } catch (error) { if(!s.ended && !s.relaying)offerRelay(s,error.message||'The TV did not receive camera frames.'); }
      };
      await peer.setRemoteDescription(offer);
      receiveCandidates(s,peer);
      const answer=await localDescription(peer,await peer.createAnswer());
      if (s.ended) return;
      await api('/'+s.id+'/answer','POST',s.key,answer);

    } catch (error) {
      if(s.ended || s.relaying || s.interrupted)return;
      if(s.monitoring && ![401,403,404,410].includes(error.status) && Date.now()<s.expires)offerRelay(s,'The TV could not open direct video.');
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
    dialog.innerHTML='<h2 id="tv-pair-title">Private TV room</h2><p id="tv-pair-status" role="status"></p><div id="tv-qr" class="pair-qr" role="img" aria-label="Scan to connect a phone camera"></div><a id="tv-phone-link" referrerpolicy="no-referrer" target="_blank" rel="noopener noreferrer" hidden>Open phone link</a><div class="pair-actions"><button id="tv-copy-link" type="button" hidden>Copy phone link</button><button id="tv-new" type="button" hidden>Create new room</button><button id="tv-end" type="button" hidden>Disconnect phone</button><button id="tv-close" type="button">Close</button></div><p id="tv-copy-status" role="status"></p>';
    document.body.append(dialog);
    el('tv-copy-link').onclick=async()=>{
      const link=el('tv-phone-link');
      const href=link.getAttribute('href');
      if(!href) return;
      let message;
      try {
        await navigator.clipboard.writeText(href);
        message='Private phone link copied.';
      } catch {
        message='Press and hold or right-click Open phone link, then choose Copy link.';
        link.focus();
      }
      if(link.getAttribute('href')===href) el('tv-copy-status').textContent=message;
    };
    function dismiss() { if (active && !active.usable) end(active); dialog.close(); }
    const play=document.createElement('button');play.type='button';play.id='tv-play';play.textContent='Play phone video';play.hidden=true;
    el('tv-close').before(play);
    play.onclick=()=>window.FGSReplayCamera?.resumeRemote?.();
    el('tv-close').onclick=dismiss;
    el('tv-end').onclick=()=>{end(active); dialog.close();tvButton.focus();};
    el('tv-new').textContent='Retry pairing';
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
    window.addEventListener('fgs:remote-track-ended',event=>{
      const s=active;
      if(s?.role!=='tv' || !current(s) || s.relaying || s.directOnly || !s.videoKey ||
         !window.FGSReplayRelay || Date.now()>=s.expires || event.detail.stream!==s.media)return;
      if(!window.FGSReplayCamera?.prepareRemoteHandoff?.(s.media))return;
      event.preventDefault();
      offerRelay(s,'The direct video track ended.');
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
    const status=el('phone-status'), relay=el('phone-options'), stop=el('phone-stop');
    const choice=el('phone-connection-choice'), directOnly=el('phone-direct-only');
    const note=el('phone-connection-note'), browserHelp=el('phone-browser-help');
    const validKey=/^[A-Za-z0-9_-]{43}$/.test(params.get('key') || '');
    const canRelay=!!(validKey && window.FGSReplayRelay?.sendFormats()?.length);
    if(!match) {
      phoneStart.hidden=true;choice.hidden=true;
      status.textContent='On the display, choose Pair phone to TV and scan its new QR code.';
      return;
    }
    el('phone-copy-invite').onclick=async()=>{
      try {
        await navigator.clipboard.writeText(location.href);
        el('phone-copy-status').textContent='Paste the private link into Safari or Chrome on this phone.';
      } catch {
        el('phone-copy-status').textContent='Copy the full address from this browser and paste it into Safari or Chrome.';
      }
    };
    if (!supported('phone') || !navigator.mediaDevices?.getUserMedia) {
      phoneStart.hidden=true;choice.hidden=true;browserHelp.hidden=false;
      status.textContent='This browser cannot start the camera. Open this private link in Safari or Chrome.';
      return;
    }
    if(!canRelay) {
      note.textContent=validKey ? 'This browser supports direct pairing only.' : 'This link supports direct pairing only. For internet relay, scan a new QR code on the TV.';
      directOnly.checked=true;directOnly.disabled=true;
    } else if(!hasDirect()) {
      note.textContent='This browser can send video over the encrypted internet relay for up to 30 minutes. Cellular uses mobile data.';
      directOnly.checked=false;directOnly.disabled=true;
    }
    function updateRelayButton() {
      const s=active;
      relay.hidden=!canRelay;
      relay.disabled=!canRelay || (s?.directOnly ?? directOnly.checked) || !!(s?.manualRelay || s?.interrupted || s?.relayPending || s?.relaying);
      relay.textContent=s?.relaying?'Internet relay active':s?.relayPending?'Switching to relay…':s?.manualRelay?'Relay selected':'Use internet relay';
    }
    let capture=window.FGSPhoneCamera?.setup();
    async function start(manual) {
      const s=active || {role:'phone',id:match[1],key:token(),videoKey:validKey?params.get('key'):null,
        directOnly:directOnly.checked,capture,updateRelayButton};
      if(manual) {
        if(!canRelay || s.directOnly || s.interrupted || s.relaying)return;
        s.manualRelay=true;
        updateRelayButton();
        if(s.claimed && s.media){offerRelay(s,'Manual relay selected.');return;}
      }
      if(s.starting || s.claimed)return;
      s.starting=true;active=s;
      phoneStart.hidden=true;phoneStart.disabled=true;stop.hidden=false;choice.hidden=true;browserHelp.hidden=true;
      updateRelayButton();
      try {
        status.textContent='Allow camera access on this phone.';
        const lost=()=>fail(s,new Error('The camera stopped.'));
        // Request permission during the user's tap. A denied permission leaves
        // the invite unclaimed, and changing transport reuses this capture.
        const stream=s.capture ? await s.capture.start(lost) :
          await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:60}}});
        if(!current(s)){stopTracks(stream);return;}
        s.media=stream;
        const track=stream?.getVideoTracks()[0];
        if (!track) throw new Error('This camera did not provide a video track.');
        if (!s.capture) {
          track.addEventListener('ended',lost,{once:true});
          const preview=el('phone-preview'); preview.srcObject=stream; preview.hidden=false; preview.play().catch(()=>{});
        }
        status.textContent='Joining your private TV room…';
        s.claimPending=true;s.claimSent=true;
        const session=await api('/'+s.id+'/claim','POST',null,{invite:match[2],phoneToken:s.key});
        s.claimPending=false;s.claimed=true;
        if(!current(s)){api('/'+s.id+'/end','POST',s.key,null,true).catch(()=>{});return;}
        expiry(s,session.expiresAt);
        monitorRelay(s);
        if(s.manualRelay || !hasDirect()){offerRelay(s,'Internet relay selected.');return;}
        status.textContent='Connecting directly.';
        // The display confirms that decoded frames advance independently of ICE.
        s.frameDeadline=setTimeout(()=>offerRelay(s,'The TV did not confirm direct video.'),firstFrameWait+2500);
        const peer=await peerFor(s);
        if(s.ended || s.relaying || s.interrupted) return;
        const outgoing=s.capture?.directStream() || stream;
        const sending=peer.addTransceiver(outgoing.getVideoTracks()[0],{direction:'sendonly',streams:[outgoing]});
        s.capture?.setSender(sending.sender);
        const offer=await localDescription(peer,await peer.createOffer());
        if (s.ended || s.relaying || s.interrupted) return;
        await api('/'+s.id+'/offer','POST',s.key,offer);
        const answer=await poll(s,'answer');
        if (s.ended || s.relaying || s.interrupted || !answer) return;
        await peer.setRemoteDescription(answer);
        receiveCandidates(s,peer);
  
      } catch (error) {
        if(!current(s) || s.relaying || s.interrupted)return;
        if(s.claimed) {
          if(![401,403,404,410].includes(error.status) && Date.now()<s.expires)offerRelay(s,'The phone could not open direct video.');
          else fail(s,error);
          return;
        }
        const claimFailed=s.claimPending;s.claimPending=false;
        if(claimFailed && [400,401,403,404,409,410].includes(error.status)){
          s.claimSent=false;fail(s,error);
          return;
        }
        if(s.media){
          s.capture?.stop();stopTracks(s.media);s.media=null;
          const preview=el('phone-preview');preview.srcObject=null;preview.hidden=true;
          capture=window.FGSPhoneCamera?.setup();s.capture=capture;
        }
        const denied=error.name==='NotAllowedError' || error.name==='SecurityError';
        if(claimFailed)status.textContent='The phone could not reach the pairing service. Check your connection and try again.';
        else if(denied)status.textContent='Allow camera access in this browser, then tap Start camera.';
        else if(error.name==='NotReadableError' || error.name==='AbortError')status.textContent='The camera could not open. Close other apps using it, then tap Start camera.';
        else if(error.name==='NotFoundError')status.textContent='No camera was found. Open this private link on a phone with a camera.';
        else status.textContent='The camera could not start. Check camera access, then try again.';
        browserHelp.hidden=!denied && error.name!=='NotFoundError';
        s.manualRelay=false;
        phoneStart.hidden=false;phoneStart.disabled=false;stop.hidden=true;choice.hidden=false;
        s.directOnly=directOnly.checked;
        updateRelayButton();
      } finally{s.starting=false;}
    }
    directOnly.onchange=()=>{if(active && !active.starting && !active.media)active.directOnly=directOnly.checked;updateRelayButton();};
    phoneStart.disabled=false;updateRelayButton();
    phoneStart.onclick=()=>start(false);
    relay.onclick=()=>start(true);
    stop.onclick=()=>{end(active);phoneStart.hidden=true;choice.hidden=true;browserHelp.hidden=true;status.textContent='Camera disconnected. Create a new room on the display for another phone link or QR code.';};
  }
  window.addEventListener('pagehide',()=>end(active));
  if (phoneStart) {
    // A second invitation in the same tab changes only the URL fragment.
    window.addEventListener('hashchange',()=>{end(active);location.reload();});
    setupPhone();
  } else makeTvDialog();
})();
