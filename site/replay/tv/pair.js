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
  const supported = () => window.isSecureContext && typeof RTCPeerConnection === 'function';
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
  function end(s, notifyServer = true) {
    if (!s || s.ended) return;
    s.ended = true;
    if (active === s) active = null;
    clearTimeout(s.disconnectTimer);
    clearTimeout(s.connectionTimer);
    if (s.peer) {
      s.peer.onconnectionstatechange = s.peer.oniceconnectionstatechange = s.peer.ontrack = null;
      s.peer.close();
    }
    if (s.role === 'phone') {
      stopTracks(s.media);
      if (el('phone-preview')) {
        el('phone-preview').srcObject = null;
        el('phone-preview').hidden = true;
        el('phone-stop').hidden = true;
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
  async function poll(s, property) {
    const route = '/' + s.id;
    while (!s.ended && Date.now() < s.expires) {
      let data;
      try { data = await api(route, 'GET', s.key); }
      catch (error) {
        if (error.status && error.status < 500 && error.status !== 429) throw error;
      }
      if (!s.ended && data?.[property]) return data[property];
      await sleep(1600);
    }
    throw new Error('This pairing code has expired. Show a new code on the TV.');
  }
  async function localDescription(peer, description) {
    await peer.setLocalDescription(description);
    if (peer.iceGatheringState !== 'complete') {
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', changed); resolve(); };
        const changed = () => { if (peer.iceGatheringState === 'complete') finish(); };
        const timer = setTimeout(finish, 4500);
        peer.addEventListener('icegatheringstatechange', changed);
        changed();
      });
    }
    const result = peer.localDescription;
    if (!result) throw new Error('Pairing ended before the connection was ready.');
    return {type:result.type, sdp:result.sdp};
  }
  function peerFor(s) {
    const peer = new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}]});
    s.peer = peer;
    function changed() {
      if (s.ended) return;
      const state = peer.connectionState || peer.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        s.connected = true;
        clearTimeout(s.disconnectTimer); s.disconnectTimer=null; clearTimeout(s.connectionTimer);
        if (s.role === 'phone') el('phone-status').textContent = 'Connected. Your camera is sending video to the TV.';
        else if (s.started) tvConnected(s);
      } else if (state === 'failed' || state === 'closed') {
        fail(s, new Error('Connection ended. Both devices need a network that allows direct connections.'));
      } else if (state === 'disconnected' && !s.disconnectTimer) {
        s.disconnectTimer = setTimeout(() => fail(s, new Error('The other device disconnected.')), 5000);
      }
    }
    peer.onconnectionstatechange = peer.oniceconnectionstatechange = changed;
    return peer;
  }
  function watchConnection(s) {
    if (!s.connected && !s.ended) s.connectionTimer = setTimeout(() => fail(s, new Error('The devices could not connect. Use the same Wi-Fi and avoid guest networks that isolate devices.')), 22000);
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
    el('tv-end').hidden=state!=='connected';
    el('tv-close').textContent=state==='connected'?'Back to replay':'Close';
    if (!dialog.open) dialog.showModal();
  }
  function tvConnected(s) {
    if (s.ended || s.notified) return;
    s.notified=true;
    tvButton.textContent='Phone connected';
    el('tv-pair-dialog').close();
  }
  async function openTv() {
    if (active?.role==='tv') {
      if (active.connected) tvState('The phone is sending video. Use the dashboard to set the delay or review a frame.', 'connected');
      else if (!el('tv-pair-dialog').open) el('tv-pair-dialog').showModal();
      return;
    }
    if (!supported()) { tvState('This TV browser cannot receive a camera stream. Open this TV display on a computer connected to the TV.', 'unavailable'); return; }
    const s={role:'tv', key:token()};
    active=s;
    tvState('Preparing your private code…', 'loading');
    try {
      await loadQr();
      if (s.ended) return;
      const session=await api('', 'POST', null, {tvToken:s.key});
      s.id=session.id; s.expires=session.expiresAt;
      if (s.ended) { api('/'+s.id+'/end','POST',s.key).catch(()=>{}); return; }
      const link=new URL('/replay/tv/phone.html', location.origin);
      link.hash='pair='+s.id+'.'+session.invite;
      const code=window.qrcode(0,'M');
      code.addData(link.href); code.make();
      tvState('Scan this code with your phone, then tap Start camera. Use the same Wi-Fi on both devices.', 'code');
      el('tv-qr').innerHTML=code.createSvgTag({cellSize:5,margin:20,scalable:true});
      el('tv-phone-link').href=link.href; el('tv-phone-link').hidden=false;
      const offer=await poll(s,'offer');
      if (s.ended) return;
      tvState('Phone found. Connecting its camera…','connecting');
      const peer=peerFor(s);
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
        } catch (error) { fail(s,error); }
      };
      await peer.setRemoteDescription(offer);
      const answer=await localDescription(peer,await peer.createAnswer());
      if (s.ended) return;
      await api('/'+s.id+'/answer','POST',s.key,answer);
      watchConnection(s);
    } catch (error) { fail(s,error); }
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
    el('tv-close').onclick=dismiss;
    el('tv-end').onclick=()=>{end(active); dialog.close();tvButton.focus();};
    el('tv-new').onclick=openTv;
    dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss();});
    tvButton.addEventListener('click',openTv);
    window.addEventListener('fgs:remote-stopped',()=>{ if (active?.role==='tv') end(active); });
    if (new URLSearchParams(location.search).get('mode')==='tv') openTv();
  }
  function setupPhone() {
    const match=/^#pair=([a-zA-Z0-9_-]{10,90})\.([a-zA-Z0-9_-]{16,96})$/.exec(location.hash);
    if (!match || !supported() || !navigator.mediaDevices?.getUserMedia) {
      phoneStart.hidden=true;
      el('phone-status').textContent=match?'Open this link in a browser that supports camera sharing.':'Open Replay Cam TV display and scan its QR code with this phone.';
      return;
    }
    phoneStart.onclick=async()=>{
      if (active) return;
      const s={role:'phone',id:match[1],key:token()};
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
        const track=stream.getVideoTracks()[0];
        if (!track) throw new Error('The phone camera did not provide a video track.');
        track.addEventListener('ended',()=>fail(s,new Error('The camera stopped.')),{once:true});
        const preview=el('phone-preview'); preview.srcObject=stream; preview.hidden=false; preview.play().catch(()=>{});
        el('phone-status').textContent='Camera ready. Waiting for the TV…';
        const peer=peerFor(s);
        peer.addTransceiver(track,{direction:'sendonly',streams:[stream]});
        const offer=await localDescription(peer,await peer.createOffer());
        if (s.ended) return;
        await api('/'+s.id+'/offer','POST',s.key,offer);
        const answer=await poll(s,'answer');
        if (s.ended) return;
        await peer.setRemoteDescription(answer);
        watchConnection(s);
      } catch (error) { fail(s,error); }
    };
    el('phone-stop').onclick=()=>{end(active);el('phone-status').textContent='Camera disconnected. Scan a new TV code to connect again.';};
  }
  window.addEventListener('pagehide',()=>end(active));
  if (phoneStart) setupPhone(); else makeTvDialog();
})();
