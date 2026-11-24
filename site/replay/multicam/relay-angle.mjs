import {call,token} from './signaling.mjs';

async function request(path,key,data,signal,keepalive=false) {
  const attempt=new AbortController();
  const abort=()=>attempt.abort();
  const timer=setTimeout(abort,11000);
  signal?.addEventListener('abort',abort,{once:true});
  try {
    if(signal?.aborted)attempt.abort();
    return await call(path,key,data,attempt.signal,keepalive);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort',abort);
  }
}

// A relay angle uses a normal video room. The decoded MediaStream has no phone
// capture clock and must not enter the synchronized capture-time buffer.
export function startRelayAngle({cameraId,signal,onInvite,onClaimed,onStream,onStatus,onError}) {
  const controller=new AbortController();
  const live=controller.signal;
  const tvKey=token(),videoKey=token();
  let roomId,revoked,expiry,firstFrames;
  async function revoke() {
    if(!roomId)return;
    // Room creation may complete after an invite was cancelled. Revoke it too.
    revoked ||= request('/'+roomId+'/end',tvKey,{},undefined,true).catch(()=>{});
    return revoked;
  }
  function stop() {
    controller.abort();
    clearTimeout(expiry);clearTimeout(firstFrames);
    signal.removeEventListener('abort',stop);
    return revoke();
  }
  function fail(error) {
    if(live.aborted)return;
    stop();
    onError(error);
  }
  function expiresAt(time) {
    clearTimeout(expiry);
    expiry=setTimeout(()=>fail(Error('The private phone relay expired. Create a new invite.')),Math.max(0,time-Date.now()));
  }
  async function connect() {
    const relay=window.FGSReplayRelay;
    const formats=relay?.receiveFormats() || [];
    if(!formats.length)throw Error('This display cannot receive encrypted relay video. Use a computer browser as the display.');
    if(!['1','2'].includes(cameraId))throw Error('Choose a camera for the phone relay.');
    const room=await request('',null,{tvToken:tvKey});
    if(!/^[a-zA-Z0-9_-]{22}$/.test(room?.id || '') || !/^[a-zA-Z0-9_-]{43}$/.test(room.invite || '') ||
        !Number.isFinite(room.expiresAt))throw Error('The pairing service returned an incomplete relay invite.');
    roomId=room.id;
    if(live.aborted){await revoke();return;}
    expiresAt(room.expiresAt);
    const path='/'+roomId+'/relay';
    await request(path,tvKey,{action:'request',formats},live);
    if(live.aborted)return;
    const invite=new URL('/replay/tv/phone',location.origin);
    invite.hash=new URLSearchParams({pair:roomId+'.'+room.invite,key:videoKey,transport:'relay',camera:cameraId});
    onInvite(invite.href);
    let claimed=false;
    while(!live.aborted) {
      try {
        if(!claimed) {
          const pairing=await request('/'+roomId,tvKey,undefined,live);
          if(live.aborted)return;
          if(pairing.status!=='waiting'){claimed=true;onClaimed?.();}
        }
        if(claimed) {
          const state=await request(path,tvKey,undefined,live);
          if(live.aborted)return;
          if(state.status==='ended')throw Error('The phone ended this relay.');
          if(state.status==='active') {
            if(!formats.includes(state.mimeType) || !Number.isFinite(state.expiresAt))throw Error('The phone selected an unsupported relay format.');
            expiresAt(state.expiresAt);
            onStatus('Waiting for relay video.');
            firstFrames=setTimeout(()=>fail(Error('The phone relay did not deliver moving frames. Create a new invite.')),18000);
            const acknowledge=async stream=>{
              if(live.aborted)return;
              await onStream(stream,state.mimeType);
              if(live.aborted)return;
              await request(path,tvKey,{action:'direct',state:'relay-moving'},live);
              clearTimeout(firstFrames);
            };
            // Errors after the encrypted decoder starts are terminal for this
            // room. Never silently restart or duplicate the relay.
            try {
              await relay.receive({id:roomId,token:tvKey,key:videoKey,origin:window.FGSReplayPairEndpoint,
                mimeType:state.mimeType,signal:live,onStream:acknowledge,onError:fail});
            } catch(error) {fail(error);}
            return;
          }
        }
      } catch(error) {
        if(live.aborted)return;
        if(!(error instanceof TypeError || error.name==='AbortError' || error.status>=500))throw error;
      }
      await new Promise(resolve=>setTimeout(resolve,850));
    }
  }
  signal.addEventListener('abort',stop,{once:true});
  if(signal.aborted)stop();else connect().catch(fail);
  return stop;
}

