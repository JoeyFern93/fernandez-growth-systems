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
async function gather(pc,description,signal) {
  await pc.setLocalDescription(description);
  const end=performance.now()+8000;
  while(pc.iceGatheringState!=='complete' && performance.now()<end) {
    signal.throwIfAborted();await delay(60);
  }
  const local=pc.localDescription;
  if(!local?.sdp.includes('a=candidate:'))throw Error('No direct Wi-Fi address was available. Check local network access.');
  return local;
}
export async function negotiate(pc,{id,key,expiry,signal},phone) {
  const path='/'+id;
  if(phone)await call(path+'/offer',key,await gather(pc,await pc.createOffer(),signal),signal);
  const deadline=Math.min(expiry,Date.now()+(phone?30000:600000));
  while(Date.now()<deadline) {
    signal.throwIfAborted();
    const state=await call(path,key,undefined,signal);
    const remote=phone?state.answer:state.offer;
    if(remote) {
      await pc.setRemoteDescription(remote);
      if(!phone)await call(path+'/answer',key,await gather(pc,await pc.createAnswer(),signal),signal);
      return;
    }
    await delay(phone?500:1100);
  }
  throw Error('Invite expired. Create a new invite for this angle.');
}
