// Post-release checks on the public URLs. Creates only short-lived test room
// metadata and always revokes its rooms. No camera, SDP or media is sent.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const site = 'https://www.fernandezgrowthsystems.com';
const pair = 'https://sitereview.fernandezgrowthsystems.com/api/replay-pair';
const root = path.resolve(process.env.STUDIO_SITE_ROOT || 'site');
const replay = '/replay/', volleyball = '/volleyball/';
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
  const trees = await Promise.all([replay,volleyball].map(route => list(path.join(root,route.slice(1)))));
  const files=trees.flat().filter(f=>/\.(?:html|webmanifest|m?js|css|png|svg|ico|woff2|txt)$/i.test(f));
  assert.ok(trees[0].length>12 && trees[1].length>=5,'Camera or tracker missing from release');
  for(let i=0;i<files.length;i+=6) {
    await Promise.all(files.slice(i,i+6).map(async file=>{
      const url='/'+path.relative(root,file).split(path.sep).join('/');
      if(checks.has(url))return;
      const r=await get(url), local=await readFile(file), remote=Buffer.from(await r.arrayBuffer());
      if(file.endsWith('.html')){
        const title=local.toString().match(/<title>([^<]+)<\/title>/i)?.[1];
        assert.ok(title && remote.toString().includes(title),url+' page identity or title mismatch');
      }else if(/\.(m?js|css|webmanifest|svg|txt)$/.test(file)){
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
      // Pages and the pairing backend roll out independently. Retrying this
      // idempotent acknowledgement reuses the one room already claimed.
      await verifyEventually('Phone receives TV readiness',async()=>{
        const ack=await api('/'+id+'/relay',tv,{action:'direct',state:'moving'});
        assert.ok(ack.ok,'TV readiness metadata returned '+ack.status);
        const receipt=await api('/'+id+'/relay',phone);
        assert.ok(receipt.ok,'Phone receipt returned '+receipt.status);
        assert.equal((await receipt.json()).direct,'moving','Phone reads TV readiness');
      });
    }
  } finally {
    if(id){const end=await api('/'+id+'/end',tv,{});assert.ok(end.ok || end.status===410,'Test-room cleanup: HTTP '+end.status);}
  }
}
async function verifyShell(){
  const [directory,home] = await Promise.all([
    page('/tools',/Replay Cam/i),
    page(replay,/<h1[^>]*>\s*Replay Cam\s*<\/h1>/i),
    page(volleyball,/Open local rally/i)
  ]);
  const links = [...directory.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)]
    .map(match=>new URL(match[1],site+'/tools').pathname);
  for(const route of [replay,volleyball])assert.ok(links.includes(route),'Missing Tools card for '+route);
  assert.ok(!links.includes('/replay-studio/'),'Duplicate Studio tool');
  assert.match(home,/Video diagnostics/i,'Expected updated Replay Cam');
  assert.doesNotMatch(home,/href=["'][^"']*volleyball\//i,'Tracker is a separate tool');
  const cameras = await page(replay+'multicam/', /Two-camera replay/i);
  for (const name of ['Camera 1', 'Camera 2']) {
    assert.ok(cameras.includes('>'+name+'</h2>'), 'Missing camera heading for '+name);
    assert.ok(cameras.includes('>'+name+'</option>'), 'Missing view choice for '+name);
  }
  const tag = home.match(/<link\b[^>]*\brel=["']manifest["'][^>]*>/i)?.[0];
  const href = tag?.match(/\bhref=["']([^"']+)["']/i)?.[1];
  assert.ok(href,'Replay manifest link missing');
  const current = new URL(href,site+replay).pathname;
  for(const manifestPath of new Set([current,replay+'manifest-v3.webmanifest'])) {
    const manifest=await (await get(manifestPath)).json();
    for(const field of ['start_url','scope','id']) {
      assert.equal(new URL(manifest[field],site+manifestPath).pathname,replay,'Installed Replay Cam '+field);
    }
  }
  const sw = await get(replay+'sw.js');
  assert.match(sw.headers.get('content-type')||'',/javascript/i);
  assert.match(await sw.text(),/addEventListener\(['"]fetch['"]/,'Replay worker');
  const retired = await get('/replay-studio/sw.js');
  assert.equal(new URL(retired.url).pathname,'/replay-studio/sw.js','Existing Studio installs must be able to retire');
  assert.match(retired.headers.get('content-type')||'',/javascript/i);
  assert.match(await retired.text(),/registration\.unregister\(/,'Retired Studio worker');
}
async function verifyLegacyRoute(from, destinations) {
  let url = new URL(from,site);
  const query = [...url.searchParams];
  // Browsers carry the original private QR fragment through a redirect
  // chain only while no Location header supplies its own fragment.
  for(let hop=0;hop<5;hop++){
    const response=await fetch(url,{redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(9500)});
    if(response.status===200){
      assert.ok(destinations.includes(url.pathname),from+' ended at '+url.pathname);
      for(const [key,value] of query)assert.equal(url.searchParams.get(key),value,from+' lost '+key);
      return;
    }
    assert.ok([301,302,303,307,308].includes(response.status),from+' redirect status '+response.status);
    const location=response.headers.get('location');
    assert.ok(location && !location.includes('#'),'Unexpected replacement fragment on '+url.pathname);
    url=new URL(location,url);
    assert.equal(url.origin,site,'Expected same-origin migration');
  }
  throw new Error('Too many redirects for '+from);
}
async function verifyBookmarks() {
  await Promise.all([
    verifyLegacyRoute('/replay-studio/?mode=tv',[replay]),
    verifyLegacyRoute('/replay-studio/tv/',[replay+'tv/',replay]),
    verifyLegacyRoute('/replay-studio/tv/phone.html',[replay+'tv/phone',replay+'tv/phone.html']),
    verifyLegacyRoute('/replay-studio/multicam/phone.html',[replay+'multicam/phone',replay+'multicam/phone.html']),
    verifyLegacyRoute('/replay-studio/volleyball/',[volleyball]),
    verifyLegacyRoute('/replay/volleyball/',[volleyball])
  ]);
}
if(process.argv.includes('--pair-only')) {
  await testRoom(null);await testRoom('multicam');console.log('PASS private metadata receipts for both room types');
}else {
  await verifyEventually('Canonical Replay Cam, standalone volleyball, Tools and installed app identity',verifyShell);
  await verifyEventually('Studio bookmarks and phone invites',verifyBookmarks);
  const total=await verifyEventually('Camera and volleyball assets match the release',validateAssets);
  await testRoom(null);await testRoom('multicam');
  console.log('PASS '+total+' release files; normal TV readiness, direct-only multicamera policy and room revocation.');
}
