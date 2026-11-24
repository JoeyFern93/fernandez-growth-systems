import {delay} from './clock.mjs';

// Production reuses the existing pairing API. Development uses a local
// same-origin adapter so unpublished builds never create production rooms.
const api=document.querySelector('meta[name="replay-pair-api"]')?.content === '/api/replay-pair' ? '/api/replay-pair' :
  'https://sitereview.fernandezgrowthsystems.com/api/replay-pair';
export const token=()=>btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  .replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export async function call(path,key,data,signal) {
  const headers={};
  if(key)headers.Authorization='Bearer '+key;
  if(data!==undefined)headers['Content-Type']='application/json';
  const response=await fetch(api+path,{method:data!==undefined?'POST':'GET',signal,
    cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',headers,
    body:data===undefined ? undefined : JSON.stringify(data)});
  if(!response.ok) {
    const error=Error((await response.json().catch(()=>({}))).error || 'The pairing service is unavailable. Create a new invite and try again.');
    error.status=response.status;
    throw error;
  }
  return response.json();
}
export function directConnectionMessage(wasConnected) {
  return wasConnected
    ? 'The direct connection was lost. Scan a new invite for this camera.'
    : 'Camera opened, but the phone and display could not connect directly. Use the same non-guest network, then scan a new invite.';
}
export function createPeer() {
  const local=!!document.querySelector('meta[name="replay-pair-api"]');
  // STUN supplies a discoverable address. Both cameras still send directly.
  return new RTCPeerConnection({bundlePolicy:'max-bundle',iceServers:local?[]:[{urls:'stun:stun.cloudflare.com:3478'}]});
}
function transient(error) {
  return !error.status || error.status===429 || error.status>=500;
}
async function signalRequest(path,key,data,signal,until) {
  while(!signal.aborted && Date.now()<until) {
    const controller=new AbortController();
    const cancel=()=>controller.abort();
    signal.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(cancel,Math.min(6000,until-Date.now()));
    try { return await call(path,key,data,controller.signal); }
    catch(error) { if(signal.aborted || !transient(error))throw error; }
    finally {clearTimeout(timer);signal.removeEventListener('abort',cancel);}
    await delay(500);
  }
  throw Error(signal.aborted?'Pairing stopped.':'The direct connection timed out. Create a new invite.');
}
function trickle(pc,{id,key,signal},until) {
  const path='/'+id+'/candidates',pending=[];
  let sending=false,completed=false,closed=false;
  const live=()=>!closed && !signal.aborted && pc.signalingState!=='closed' && Date.now()<until;
  async function flush() {
    if(sending || !live())return;
    sending=true;
    try {
      while(live() && (pending.length || completed)) {
        const batch=pending.slice(0,12),last=completed && batch.length===pending.length;
        try {await signalRequest(path,key,{candidates:batch,complete:last},signal,until);}
        catch(error) {
          if(error.status===409){await delay(200);continue;}
          // The initial descriptions also carry any candidates already known.
          return;
        }
        pending.splice(0,batch.length);
        if(last){completed=false;return;}
      }
    } finally {sending=false;}
  }
  function onCandidate(event) {
    if(!live())return;
    const c=event.candidate;
    if(c===null)completed=true;
    else if(c?.candidate && (c.sdpMLineIndex==null || c.sdpMLineIndex===0) && pending.length<64) {
      // max-bundle uses the video m-line's ICE transport for the timeline channel too.
      pending.push({candidate:c.candidate,sdpMid:c.sdpMid,sdpMLineIndex:c.sdpMLineIndex,usernameFragment:c.usernameFragment});
    } else return;
    flush();
  }
  pc.addEventListener('icecandidate',onCandidate);
  signal.addEventListener('abort',()=>{closed=true;pc.removeEventListener('icecandidate',onCandidate);},{once:true});
  return async function receive() {
    let cursor=0;
    while(live()) {
      try {
        const data=await signalRequest(path+'?after='+cursor,key,undefined,signal,until);
        if(!live())return;
        for(const candidate of data.candidates || []) {
          try {await pc.addIceCandidate(candidate);} catch { /* Another transport address can still work. */ }
        }
        cursor=data.next ?? cursor;
        if(data.complete)return;
      } catch {return;}
      await delay(pc.connectionState==='connected'?1500:450);
    }
  };
}
async function describe(pc,description,signal) {
  await pc.setLocalDescription(description);
  // Embedded candidates keep older receivers working. Late routes travel
  // through the candidate endpoint instead of blocking the offer or answer.
  const end=performance.now()+1200;
  while(!signal.aborted && pc.iceGatheringState!=='complete' && performance.now()<end)await delay(60);
  if(signal.aborted || !pc.localDescription)throw Error('Pairing stopped.');
  return {type:pc.localDescription.type,sdp:pc.localDescription.sdp};
}
export async function negotiate(pc,room,phone) {
  const {id,key,expiry,signal}=room,path='/'+id;
  const deadline=Math.min(expiry,Date.now()+(phone?30000:600000));
  // A TV can be waiting for a scan for several minutes. Start its candidate
  // window when a phone actually offers video.
  let receive;
  if(phone) {
    receive=trickle(pc,room,deadline);
    await signalRequest(path+'/offer',key,await describe(pc,await pc.createOffer(),signal),signal,deadline);
  }
  while(!signal.aborted && Date.now()<deadline) {
    const state=await signalRequest(path,key,undefined,signal,deadline);
    const remote=phone?state.answer:state.offer;
    if(remote) {
      if(!phone)receive=trickle(pc,room,Math.min(deadline,Date.now()+30000));
      await pc.setRemoteDescription(remote);
      receive();
      if(!phone)await signalRequest(path+'/answer',key,await describe(pc,await pc.createAnswer(),signal),signal,deadline);
      return;
    }
    await delay(phone?500:1100);
  }
  throw Error(signal.aborted?'Pairing stopped.':'Invite expired. Create a new invite for this camera.');
}
