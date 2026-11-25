import {call,token} from './signaling.mjs';
import {startRelayClock} from './relay-clock.mjs';

async function request(path,key,data,signal,keepalive=false,timeoutMs=11000) {
  const attempt=new AbortController();
  const abort=()=>attempt.abort();
  const timer=setTimeout(abort,timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});
  try {
    if(signal?.aborted)attempt.abort();
    return await call(path,key,data,attempt.signal,keepalive);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort',abort);
  }
}

function waitForRetry(ms,signal) {
  return new Promise((resolve,reject)=>{
    const cancel=()=>{clearTimeout(timer);reject(signal.reason);};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},ms);
    signal.addEventListener('abort',cancel,{once:true});
    if(signal.aborted)cancel();
  });
}

async function confirmReceivedFrames(path,key,signal,deadline) {
  // This state write is idempotent. Retry it without restarting the stream
  // if the acknowledgement or its response is lost on the network.
  for(const backoff of [0,300,900,1800]) {
    signal.throwIfAborted();
    if(backoff) {
      if(performance.now()+backoff>=deadline)break;
      await waitForRetry(backoff,signal);
    }
    const remaining=deadline-performance.now();
    if(remaining<=0)break;
    try {
      await request(path,key,{action:'direct',state:'relay-moving'},signal,false,Math.min(3500,remaining));
      return;
    } catch(error) {
      if(signal.aborted || !(error instanceof TypeError || error.name==='AbortError' || error.status>=500))throw error;
    }
  }
  throw Error('Video reached the display, but the phone could not receive confirmation. Create a new invite.');
}

// Each angle uses one existing media room. Timing, when available, travels
// between the devices as part of the same encrypted media stream.
export function startRelayAngle({cameraId,signal,onInvite,onClaimed,onStream,onPicture,onStatus,onError}) {
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
    invite.hash=new URLSearchParams({pair:roomId+'.'+room.invite,key:videoKey,transport:'relay',camera:cameraId,sync:'1'});
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
            // The phone waits 22 seconds for confirmation after starting its
            // relay. Leave time for its next poll to observe this receipt.
            const confirmBy=performance.now()+20000;
            firstFrames=setTimeout(()=>fail(Error('The phone relay did not deliver moving frames. Create a new invite.')),18000);
            const acknowledge=async stream=>{
              if(live.aborted)return;
              // The decoder has delivered a stream. The tile now watches for
              // advancing pictures and can prompt for playback permission.
              clearTimeout(firstFrames);
              await onStream(stream,state.mimeType);
              if(live.aborted)return;
              await confirmReceivedFrames(path,tvKey,live,confirmBy);
            };
            const origin=window.FGSReplayPairEndpoint;
            const clock=startRelayClock({origin,id:roomId,token:tvKey,signal:live});
            const displayPicture=(canvas,stamp)=>{
              if(live.aborted)return;
              const mapped=stamp && Number.isFinite(stamp.uncertainty) && stamp.uncertainty>=0
                ? clock.toLocal(stamp.time) : null;
              onPicture?.(canvas,mapped?{
                time:mapped.time,
                uncertainty:mapped.uncertainty+stamp.uncertainty,
                estimated:stamp.estimated===true
              }:null);
            };
            // Errors after the encrypted decoder starts are terminal for this
            // room. Never silently restart or duplicate the relay.
            try {
              await relay.receive({id:roomId,token:tvKey,key:videoKey,origin,
                mimeType:state.mimeType,signal:live,timed:true,onPicture:displayPicture,onStream:acknowledge,onError:fail});
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

