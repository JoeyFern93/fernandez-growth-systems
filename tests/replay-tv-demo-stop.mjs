import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';

const countPieces = `new Promise((resolve,reject)=>{
 const open=indexedDB.open('fgs-studio-angle-originals');open.onerror=()=>reject(open.error);
 open.onsuccess=()=>{const db=open.result;const req=db.transaction('pieces').objectStore('pieces').count();
 req.onsuccess=()=>{resolve(req.result);db.close()};req.onerror=()=>reject(req.error);};
})`;
const states='__inspectMedia().then(m=>m.tracks.map(t=>t.state))';
const sourceReport=`(async()=>{
  const {loadOriginal,recordings}=await import('/replay/multicam/originals.mjs');
  const rows=await recordings();const row=rows.at(-1);const blob=await loadOriginal(row);
  const video=document.createElement('video');video.muted=true;
  const url=URL.createObjectURL(blob);video.src=url;
  try{await video.play();await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('original did not decode')),5000);
  const frame=(_,m)=>{if(m.mediaTime>0.15){clearTimeout(timer);resolve();}else video.requestVideoFrameCallback(frame);};
  video.requestVideoFrameCallback(frame);});
  return {id:row.id,source:row.source,bytes:blob.size,width:video.videoWidth,height:video.videoHeight,decodedAt:video.currentTime};}
  finally{video.pause();video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
})()`;
const openWebcam='document.querySelector("#angles .webcam").value="default";document.querySelector("#angles .webcam").dispatchEvent(new Event("change"))';
export async function runDemoStop({tv,phone,site,taskErrors,delay,output}){
  await tv.navigate(site+'/replay/multicam/');
  await tv.until('typeof document.querySelector("#angles .invite")?.onclick==="function"','TV');
  await tv.get(openWebcam);
  await tv.get('document.querySelectorAll("#angles .invite")[1].click()');
  const link=await tv.until('document.getElementById("invite-dialog").open && document.getElementById("phone-link").href','camera invite');
  await phone.navigate(link);
  await phone.until('typeof document.getElementById("start").onclick==="function"','phone camera');
  await phone.click('start');
  await tv.until('__inspectMedia().then(m=>m.received.some(r=>r.frames>=15))','direct moving phone',40000);
  for(const tab of [tv,phone])await tab.until(countPieces+'.then(n=>n>=2)','two native recorded fragments',20000);
  const before=await Promise.all([tv.get(countPieces),phone.get(countPieces)]);
  await tv.click('demo');await tv.until('document.querySelector("#demo-dialog").open','demo choice');
  await tv.shot('recording-choice');await tv.click('demo-keep');
  for(const [i,tab] of [tv,phone].entries())await tab.until(countPieces+'.then(n=>n>'+before[i]+')','keep original growing');
  assert.equal(await tv.get('document.getElementById("demo").textContent'),'Try synced demo');
  const kept=await Promise.all([tv.get(countPieces),phone.get(countPieces)]);
  await tv.click('demo');await tv.click('demo-finish');
  await tv.until('document.getElementById("demo").textContent==="Exit demo"','demo entered',20000);
  assert.equal(await tv.get('document.getElementById("mode").textContent.includes("Check")'),false);
  await phone.until('document.querySelector("#status").textContent.includes("Camera stopped for the TV demo. Your original")','phone acknowledged flushed original');
  for(const tab of [tv,phone])assert.deepEqual(await tab.get(states),['ended']);
  const final=await Promise.all([tv.get(countPieces),phone.get(countPieces)]);
  const originals=await Promise.all([tv.get(sourceReport),phone.get(sourceReport)]);
  await delay(3500);
  const during=await Promise.all([tv.get(countPieces),phone.get(countPieces)]);
  assert.deepEqual(final,during);
  await tv.shot('demo-after-finish');
  await tv.click('demo');await delay(1200);
  assert.deepEqual(await tv.get('Array.from(document.querySelectorAll("#angles .status"),n=>n.textContent)'),['No source selected','No source selected']);
  assert.deepEqual(await Promise.all([tv.get(countPieces),phone.get(countPieces)]),final);
  assert.deepEqual(await tv.get(states),['ended']);assert.deepEqual(await phone.get(states),['ended']);
  // Cancel an unclaimed invite and an in-flight webcam permission result together.
  await tv.get('document.querySelectorAll("#angles .invite")[1].click()');
  const pending=await tv.until('document.getElementById("invite-dialog").open && document.getElementById("phone-link").href','second invite');
  await tv.click('close');
  await tv.get(`(()=>{const media=navigator.mediaDevices,open=media.getUserMedia.bind(media);media.getUserMedia=async(...args)=>{
    const stream=await open(...args);await new Promise(resolve=>{window.__release=resolve;});return stream;};})()`);
  await tv.get(openWebcam);
  await tv.until('typeof window.__release==="function"','pending camera result');
  await tv.click('demo');await tv.click('demo-finish');
  await tv.until('document.getElementById("demo").textContent==="Exit demo"','demo after pending starts');
  await tv.get('__release()');
  await tv.until(states+'.then(tracks=>tracks.length===2 && tracks.every(t=>t==="ended"))','late webcam release');
  await phone.navigate(pending);await phone.until('typeof document.getElementById("start").onclick==="function"','canceled invite');
  await phone.click('start');await phone.until(states+'.then(tracks=>tracks.length && tracks.every(t=>t==="ended"))','cancelled invite releases phone');
  const invalidMessage=await phone.get('document.getElementById("status").textContent');
  // Emulate an old or interrupted phone that cannot send its stop acknowledgement.
  await tv.get('document.querySelectorAll("#angles .invite")[1].click()');
  const noReply=await tv.until('document.getElementById("invite-dialog").open && document.getElementById("phone-link").href','unacknowledged phone invite');
  await phone.navigate(noReply);await phone.until('typeof document.getElementById("start").onclick==="function"','unacknowledged phone');
  await phone.get(`(()=>{const send=RTCDataChannel.prototype.send;RTCDataChannel.prototype.send=function(message){
    if(typeof message==="string" && JSON.parse(message).op==="source-stopped")return;
    return send.call(this,message);
  };})()`);
  await phone.click('start');await tv.until('document.getElementById("sideline").querySelector(".status").textContent.includes("clock")','new moving phone');
  await tv.click('demo');await tv.click('demo-finish');
  await tv.until('document.getElementById("demo-description").textContent.includes("could not confirm")','manual confirmation for missing acknowledgement',15000);
  assert.equal(await tv.get('document.getElementById("demo").textContent'),'Try synced demo');
  await tv.click('demo-keep');await tv.click('demo');
  assert.equal(await tv.get('document.getElementById("demo-finish").textContent'),'Camera stopped. Continue');
  await tv.click('demo-finish');await tv.until('document.getElementById("demo").textContent==="Exit demo"','explicit phone stop confirmation');
  assert(!taskErrors.length,taskErrors.join('\n'));
  const result={ids:'device order: TV webcam, phone',before,kept,final,during,originals,pendingInvite:invalidMessage,unacknowledgedPhone:'demo held until explicit phone confirmation',modeAfterExplicitExit:'No source selected on both',growthWindowMs:3500};
  console.log(JSON.stringify(result,null,2));
  await writeFile(path.join(output,'demo-stop-results.json'),JSON.stringify(result,null,2));
}
