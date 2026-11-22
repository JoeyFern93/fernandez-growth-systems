// Post-release checks on the public URLs. Creates only short-lived test room
// metadata and always revokes its rooms. No camera, SDP or media is sent.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const site = 'https://www.fernandezgrowthsystems.com';
const pair = 'https://sitereview.fernandezgrowthsystems.com/api/replay-pair';
const root = path.resolve(process.env.STUDIO_SITE_ROOT || 'site');
const studio = '/replay-studio/';
const until = Date.now() + 205000;
const digest = b => createHash('sha256').update(b).digest('hex');
const pause = ms => new Promise(r => setTimeout(r, ms));
const token = () => randomBytes(32).toString('base64url');
const release = process.env.GITHUB_SHA?.slice(0,12) || 'production';
const sha = s => digest(s.toString().replace(/\r\n/g,'\n'));
const checks = new Map();

async function verifyEventually(label, task) {
  let error;
  while (Date.now() < until) {
    try { const value = await task(); console.log('PASS',label); return value; }
    catch (e) { error=e; }
    await pause(7500);
  }
  throw new Error(label + ' — ' + String(error?.message || 'timed out').slice(0,200));
}
async function get(urlPath) {
  const url = new URL(urlPath,site);
  url.searchParams.set('studio_check',release);
  const r = await fetch(url, {cache:'no-store',headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(9500)});
  assert.equal(new URL(r.url).origin,site,'Expected canonical site');
  assert.equal(r.status,200,url.pathname+' returned '+r.status);
  return r;
}
async function page(urlPath, pattern) {
  const r=await get(urlPath), body=await r.text();
  assert.match(r.headers.get('content-type')||'',/text\/html/i);
  assert.match(body,pattern,urlPath+' identity');
  return body;
}
async function list(dir) {
  const files=[];
  for(const item of await readdir(dir,{withFileTypes:true})) {
    const name=path.join(dir,item.name);
    if(item.isDirectory())files.push(...await list(name));else files.push(name);
  }
  return files;
}
async function validateAssets() {
  const files=(await list(path.join(root,'replay-studio'))).filter(f=>/\.(?:html|webmanifest|m?js|css|png|svg|ico|woff2)$/i.test(f));
  assert.ok(files.length>12,'Studio assets missing from checked-out release');
  for(let i=0;i<files.length;i+=6) {
    await Promise.all(files.slice(i,i+6).map(async file=>{
      const url='/'+path.relative(root,file).split(path.sep).join('/');
      if(checks.has(url))return;
      const r=await get(url), local=await readFile(file), remote=Buffer.from(await r.arrayBuffer());
      if(file.endsWith('.html')){
        const title=local.toString().match(/<title>([^<]+)<\/title>/i)?.[1];
        assert.ok(title && remote.toString().includes(title),url+' page identity or title mismatch');
      }else if(/\.(m?js|css|webmanifest|svg)$/.test(file)){
        assert.ok(sha(local)===sha(remote),url+' differs from release');
      }else assert.ok(digest(local)===digest(remote),url+' differs from release');
      checks.set(url,true);
    }));
  }
  return files.length;
}
async function api(pathname, auth, data) {
  const headers={Origin:site};
  if(auth)headers.Authorization='Bearer '+auth;
  if(data!==undefined)headers['Content-Type']='application/json';
  return fetch(pair+pathname,{method:data===undefined?'GET':'POST',headers,
    body:data===undefined?undefined:JSON.stringify(data),redirect:'error',signal:AbortSignal.timeout(9000)});
}
async function testRoom(purpose) {
  const tv=token(),phone=token();
  let id;
  try {
    const create=await api('',null,{tvToken:tv,...(purpose?{purpose}:{})});
    assert.ok(create.ok,'Room creation returned '+create.status);
    assert.equal(create.headers.get('access-control-allow-origin'),site,'Allowed browser origin');
    const room=await create.json();
    // Never include credentials or invite fragments in failure messages.
    assert.ok(typeof room.id==='string' && /^[~A-Za-z0-9_-]{22}$/.test(room.id),'Invalid test room');
    id=room.id;
    const claim=await api('/'+id+'/claim',null,{invite:room.invite,phoneToken:phone});
    assert.ok(claim.ok,'Phone claim returned '+claim.status);
    if(purpose) {
      assert.ok(id.startsWith('~'),'Multi-camera signaling is not active');
      assert.equal((await api('/'+id+'/relay',phone)).status,403,'Direct-only room');
    }else{
      const ack=await api('/'+id+'/relay',tv,{action:'direct',state:'moving'});
      assert.ok(ack.ok,'TV readiness metadata returned '+ack.status);
      const receipt=await api('/'+id+'/relay',phone);
      assert.ok(receipt.ok,'Phone receipt returned '+receipt.status);
      assert.equal((await receipt.json()).direct,'moving','Phone reads TV readiness');
    }
  } finally {
    if(id){const end=await api('/'+id+'/end',tv,{});assert.ok(end.ok || end.status===410,'Test-room cleanup: HTTP '+end.status);}
  }
}
async function verifyShell(){
  const [directory,home,old]=await Promise.all([page('/tools',/Replay Studio/i),page(studio,/<h1[^>]*>\s*Replay Studio\s*<\/h1>/i),page('/replay/',/<h1[^>]*>\s*Replay Cam\s*<\/h1>/i)]);
  for(const slug of ['/replay/',studio])assert.ok(directory.includes('href="'+slug+'"')||directory.includes("href='"+slug+"'"),'Missing Tools card for '+slug);
  for(const [html,base] of [[old,'/replay/'],[home,studio]]) {
    const link=html.match(/<link\b[^>]*\brel=["']manifest["'][^>]*>/i)?.[0];
    const href=link?.match(/\bhref=["']([^"']+)["']/i)?.[1];assert.ok(href,base+' manifest link');
    const file=new URL(href,site+base), r=await get(file.pathname), manifest=await r.json();
    for(const field of ['start_url','scope','id'])assert.equal(new URL(manifest[field],file).pathname,base,base+' manifest '+field);
  }
}
if(process.argv.includes('--pair-only')) {
  await testRoom(null);await testRoom('multicam');console.log('PASS private metadata receipts for both room types');
}else {
  await verifyEventually('Both original and Studio pages, directory cards, install identities',verifyShell);
  const total=await verifyEventually('Studio release files on the canonical production hostname',validateAssets);
  // The Worker must be ready before the Studio card ships. One test room per
  // mode keeps the check within the shared creation allowance.
  await testRoom(null);await testRoom('multicam');
  console.log('PASS '+total+' release files; normal TV readiness, direct-only multicamera policy and room revocation.');
}
