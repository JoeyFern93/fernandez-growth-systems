import assert from 'node:assert/strict';

// Hold the display's room creation while the user sees the pending dialog.
// All successful attempts run through the harness's real local pairing Worker.
function interceptCreate() {
  const fetchOriginal=window.fetch.bind(window);
  window.pendingInviteRequests=0;
  window.failNextInvite=true;
  window.fetch=(input,init)=>{
    const url=new URL(input,location.href);
    if(window.failNextInvite && init?.method==='POST' && url.pathname==='/api/replay-pair'){
      window.pendingInviteRequests++;
      return new Promise((resolve,reject)=>{
        window.rejectPendingInvite=code=>{
          window.failNextInvite=false;
          if(code===0)reject(new TypeError('Failed to fetch'));
          else resolve(new Response(JSON.stringify({error:'Retry later'}),{status:code}));
        };
      });
    }
    return fetchOriginal(input,init);
  };
}

export async function runInviteUI({tv,phone,site,taskErrors,delay}) {
  const script={source:'('+interceptCreate.toString()+')()'};
  await tv.send('Page.addScriptToEvaluateOnNewDocument',script);
  const visible=id=>'document.getElementById('+JSON.stringify(id)+')?.getClientRects().length > 0';
  const open=id=>'document.getElementById('+JSON.stringify(id)+')?.open';
  const text=id=>'document.getElementById('+JSON.stringify(id)+').textContent';

  await tv.navigate(site+'/replay/?mode=tv');
  await tv.until(open('tv-pair-dialog')+' && typeof rejectPendingInvite==="function"','single pending dialog');
  assert.match(await tv.get(text('tv-pair-status')),/Creating/);
  await tv.get('document.getElementById("pairTvBtn").click()');
  assert.equal(await tv.get('pendingInviteRequests'),1);
  await tv.get('rejectPendingInvite(403)');
  await tv.until(visible('tv-new'),'single retry action');
  assert.match(await tv.get(text('tv-pair-status')),/display address/);
  await tv.click('tv-new');
  await tv.until('document.querySelector("#tv-qr svg") && '+visible('tv-phone-link'),'single QR after retry');
  assert.equal(new URL(await tv.get('document.getElementById("tv-phone-link").href')).origin,site);
  await tv.click('tv-close');

  await tv.navigate(site+'/replay/multicam/');
  await tv.until('typeof document.getElementById("camera-1-invite")?.onclick==="function"','camera invites');
  await tv.click('camera-1-invite');
  await tv.until(open('invite-dialog')+' && typeof rejectPendingInvite==="function"','camera 1 pending');
  assert.match(await tv.get(text('invite-note')),/Creating/);
  assert.equal(await tv.get(visible('phone-link')),false);
  await tv.get('rejectPendingInvite(0)');
  await tv.until(visible('retry-invite'),'multi retry action');
  assert.match(await tv.get(text('invite-note')),/Could not create/);
  await tv.click('retry-invite');
  await tv.until('document.querySelector("#qr svg") && '+visible('phone-link'),'multi QR after retry');
  const first=await tv.get('document.getElementById("phone-link").href');
  assert.match(first,/#room=/);
  await tv.click('close');
  await tv.click('camera-2-invite');
  await tv.until('document.querySelector("#qr svg") && '+visible('phone-link'),'second camera invite');
  const second=await tv.get('document.getElementById("phone-link").href');
  assert.notEqual(new URL(first).hash,new URL(second).hash);
  await phone.navigate(second);
  await phone.until('typeof document.getElementById("start")?.onclick==="function"','phone camera start');
  assert.equal(await tv.get(open('invite-dialog')),true);
  await phone.click('start');
  await tv.until('!document.getElementById("invite-dialog").open && document.querySelector("#sideline video")?.videoWidth > 2','second phone delivers video');
  assert.match(await tv.get('document.querySelector("#baseline .status").textContent'),/waiting for phone/i);
  await phone.click('stop');
  await tv.get('window.failNextInvite=true; document.getElementById("camera-1-invite").click()');
  await tv.until(open('invite-dialog')+' && pendingInviteRequests===2','fresh invite pending');
  assert.equal(await tv.get(visible('phone-link')),false);
  await tv.click('close');
  await tv.get('rejectPendingInvite(429)');
  await delay(400);
  assert.equal(await tv.get(open('invite-dialog')),false);
  assert.equal(await tv.get('document.getElementById("phone-link").hasAttribute("href")'),false);
  assert.deepEqual(taskErrors,[]);
  console.log('PASS: single and two-camera invites show pending/failure, retry in place, produce QR codes, discard stale links, and receive phone video.');
}
