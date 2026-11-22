import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {webcrypto,randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after,test} from 'node:test';
import worker from '../worker.js';

globalThis.crypto ??= webcrypto;
const folder=mkdtempSync(join(tmpdir(),'replay-pair-'));
after(()=>rmSync(folder,{recursive:true,force:true}));
const sqlite=`import json, sqlite3, sys
db=sqlite3.connect(sys.argv[1])
db.execute('PRAGMA foreign_keys=ON')
db.row_factory=sqlite3.Row
rows=[]
with db:
 for sql,args in json.load(sys.stdin):
  changes=db.total_changes
  result=[dict(r) for r in db.execute(sql,args)]
  rows.append({'results':result,'meta':{'changes':db.total_changes-changes}})
print(json.dumps(rows))`;
function execute(jobs) {
  const res=spawnSync(process.env.PYTHON||(process.platform==='win32'?'python':'python3'),
    ['-X','utf8','-c',sqlite,join(folder,'pairs.sqlite')],{input:JSON.stringify(jobs),encoding:'utf8'});
  if(res.status!==0) throw Error(res.stderr);
  return JSON.parse(res.stdout);
}
function statement(sql,args=[]) {
  return {sql,args,bind:(...args)=>statement(sql,args),run:async()=>execute([[sql,args]])[0],
    first:async()=>execute([[sql,args]])[0].results[0]||null};
}
const DB={prepare:statement,batch:async jobs=>execute(jobs.map(q=>[q.sql,q.args]))};
const origin='https://www.fernandezgrowthsystems.com', endpoint='https://sitereview.fernandezgrowthsystems.com/api/replay-pair';
const token=()=>randomBytes(32).toString('base64url');
function call(path,method='GET',body,role,originHeader=origin) {
  return worker.fetch(new Request(endpoint+path,{method,body:body===undefined?undefined:JSON.stringify(body),
    headers:{Origin:originHeader,'Content-Type':'application/json',...(role?{Authorization:'Bearer '+role}:{})}}),{DB});
}
const lines=['v=0','o=- 123 1 IN IP4 127.0.0.1','s=private device nickname','t=0 0','a=group:BUNDLE 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96','c=IN IP4 0.0.0.0','a=mid:0','a=ice-ufrag:abcd',
  'a=ice-pwd:0123456789abcdefghijklmnopqrstuvwxyz','a=fingerprint:sha-256 '+Array(32).fill('AA').join(':'),
  'a=setup:actpass','a=sendonly','a=rtcp-mux','a=rtpmap:96 VP8/90000','a=end-of-candidates'];
const offer={type:'offer',sdp:lines.join('\r\n')+'\r\n'};
const answer={type:'answer',sdp:offer.sdp.replace('sendonly','recvonly').replace('actpass','active')};

test('two-angle invites allow one native video plus one private control channel and have no relay',async()=>{
  const tv=token(),phone=token(),room=await(await call('','POST',{tvToken:tv,purpose:'multicam'})).json();
  assert.match(room.id,/^~[A-Za-z0-9_-]{21}$/);
  const path='/'+room.id;
  assert.equal((await call(path+'/claim','POST',{invite:room.invite,phoneToken:phone})).status,200);
  const control='m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:1\r\na=sctp-port:5000\r\na=max-message-size:262144\r\n';
  const multiOffer={type:'offer',sdp:offer.sdp+control};
  assert.equal((await call(path+'/offer','POST',offer,phone)).status,400);
  assert.equal((await call(path+'/offer','POST',{type:'offer',sdp:multiOffer.sdp+control},phone)).status,400);
  assert.equal((await call(path+'/offer','POST',multiOffer,phone)).status,200);
  const received=await(await call(path,'GET',undefined,tv)).json();
  assert.ok(received.offer.sdp.includes('a=sctp-port:5000'));
  assert.equal((await call(path+'/ice-servers','GET',undefined,phone)).status,403);
  assert.equal((await call(path+'/relay','POST',{action:'start',mimeType:'image/jpeg'},phone)).status,403);
  const normal=await pairedDevices();
  assert.equal((await call(normal.path+'/offer','POST',multiOffer,normal.phone)).status,400);
});

test('only the production Replay origins may signal; preflights and request limits are restricted',async()=>{
  assert.equal((await call('','POST',{tvToken:token()},null,'https://elsewhere.example')).status,403);
  const options=async(origin,method)=>worker.fetch(new Request(endpoint,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':method,'Access-Control-Request-Headers':'Content-Type'}}),{DB});
  const pre=await options('https://fernandezgrowthsystems.com','POST');
  assert.equal(pre.status,204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'),'https://fernandezgrowthsystems.com');
  assert.equal(pre.headers.get('Access-Control-Allow-Credentials'),null);
  assert.equal((await options(origin,'DELETE')).status,403);
  assert.equal((await call('')).status,405);
  assert.equal((await call('?invite=abc','POST',{})).status,404);
  assert.equal((await call('','POST',{tvToken:'short'})).status,400);
  assert.equal((await call('','POST',{tvToken:'x'.repeat(2048)})).status,413);
});

test('one-time claim, role-isolated SDP exchange, identical retries, explicit end and removal of signal details',async()=>{
  const tv=token(),phone=token(),other=token();
  const create=await call('','POST',{tvToken:tv});
  assert.equal(create.status,201);
  const initial=await create.json(),path='/'+initial.id;
  assert.equal(initial.id.length,22);assert.equal(initial.invite.length,43);
  assert(initial.expiresAt>Date.now());
  const retry=await call('','POST',{tvToken:tv});
  assert.equal(retry.status,200);assert.deepEqual(await retry.json(),initial);
  assert.equal((await call(path,'GET',undefined,phone)).status,403);
  assert.equal((await call(path,'GET',undefined,tv)).status,200);
  assert.equal((await call(path+'/claim','POST',{invite:token(),phoneToken:other})).status,403);
  assert.equal((await call(path+'/claim','POST',{invite:initial.invite,phoneToken:phone})).status,200);
  assert.equal((await call(path+'/claim','POST',{invite:initial.invite,phoneToken:phone})).status,200);
  assert.equal((await call(path+'/claim','POST',{invite:initial.invite,phoneToken:other})).status,409);
  assert.equal((await call(path+'/offer','POST',offer,tv)).status,403);
  assert.equal((await call(path+'/answer','POST',answer,tv)).status,409);
  assert.equal((await call(path+'/offer','POST',{...offer,sdp:offer.sdp+'m=audio 9 UDP/TLS/RTP/SAVPF 96\r\n'},phone)).status,400);
  assert.equal((await call(path+'/offer','POST',offer,phone)).status,200);
  assert.equal((await call(path+'/offer','POST',offer,phone)).status,200);
  assert.equal((await call(path+'/offer','POST',{...offer,sdp:offer.sdp.replace('abcd','different')},phone)).status,409);
  const tvRead=await(await call(path,'GET',undefined,tv)).json();
  assert.equal(tvRead.offer.type,'offer');assert.match(tvRead.offer.sdp,/s=-\r\n/);
  assert(!tvRead.offer.sdp.includes('private device nickname'));
  assert.equal((await(await call(path,'GET',undefined,phone)).json()).offer,undefined);
  assert.equal((await call(path+'/answer','POST',answer,tv)).status,200);
  const phoneRead=await(await call(path,'GET',undefined,phone)).json();
  assert.equal(phoneRead.status,'answered');assert.match(phoneRead.answer.sdp,/a=recvonly/);
  assert.equal((await(await call(path,'GET',undefined,tv)).json()).answer,undefined);
  const stored=await DB.prepare('SELECT * FROM replay_pairs WHERE id=?').bind(initial.id).first();
  for(const secret of [tv,phone,initial.invite]) assert(!JSON.stringify(stored).includes(secret));
  assert.equal((await call(path+'/end','POST',undefined,phone)).status,200);
  assert.equal((await call(path+'/end','POST',undefined,tv)).status,200);
  assert.equal((await call(path,'GET',undefined,tv)).status,410);
  const closed=await DB.prepare('SELECT invite_hash,offer,answer FROM replay_pairs WHERE id=?').bind(initial.id).first();
  assert.deepEqual(closed,{invite_hash:null,offer:null,answer:null});
});

test('expired credentials cannot join and reuse of a TV token generates a fresh invite',async()=>{
  const tv=token(),pair=await(await call('','POST',{tvToken:tv})).json(),path='/'+pair.id;
  await DB.prepare('UPDATE replay_pairs SET expires=0 WHERE id=?').bind(pair.id).run();
  assert.equal((await call(path,'GET',undefined,tv)).status,410);
  assert.equal((await call(path+'/claim','POST',{invite:pair.invite,phoneToken:token()})).status,410);
  const fresh=await(await call('','POST',{tvToken:tv})).json();
  assert.equal(fresh.id,pair.id);assert.notEqual(fresh.invite,pair.invite);
  assert.equal((await call(path+'/claim','POST',{invite:pair.invite,phoneToken:token()})).status,403);
});
test('creation budgets bound active signaling rows and preserve retries for existing TVs',async t=>{
  // All simulated requests belong to the same ten-minute quota window,
  // including when a real test run crosses the wall-clock boundary.
  const now=Date.now();
  t.mock.method(Date,'now',()=>now);
  t.after(()=>DB.prepare("DELETE FROM replay_pairs WHERE id GLOB 'quota_network_*' OR id GLOB 'quota_global_*'").run());
  const tv=token(),first=await(await call('','POST',{tvToken:tv})).json();
  const ip='203.0.113.24';
  const createOnNetwork=()=>worker.fetch(new Request(endpoint,{method:'POST',headers:{
    Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':ip},body:JSON.stringify({tvToken:token()})}),{DB});
  const net=await(await createOnNetwork()).json();
  const {bucket}=await DB.prepare('SELECT bucket FROM replay_pairs WHERE id=?').bind(net.id).first();
  const fill=(n,tag,key)=>DB.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?)
    INSERT INTO replay_pairs(id,tv_hash,bucket,expires) SELECT ?||n,'test',?,? FROM seq`)
    .bind(n,tag,key,Date.now()+600000).run();
  await fill(15,'quota_network_',bucket);
  assert.equal((await createOnNetwork()).status,429);
  await fill(160,'quota_global_','fixture');
  assert.equal((await call('','POST',{tvToken:token()})).status,429);
  const retry=await call('','POST',{tvToken:tv});
  assert.equal(retry.status,200);assert.deepEqual(await retry.json(),first);
});

async function pairedDevices() {
  const tv=token(), phone=token();
  const newPair=await call('','POST',{tvToken:tv});
  assert.equal(newPair.status,201);
  const {id,invite}=await newPair.json(), path='/'+id;
  const claim=await call(path+'/claim','POST',{invite,phoneToken:phone});
  assert.equal(claim.status,200);
  return {id,path,tv,phone};
}

function candidate(n) {
  return {candidate:'candidate:'+n+' 1 udp 2113937151 192.0.2.1 '+(40000+n)+' typ host',sdpMid:'0',sdpMLineIndex:0};
}

test('candidate polling returns the opposite device, with stable deduplication and independent cursors',async()=>{
  const {id,path,tv,phone}=await pairedDevices(), route=path+'/candidates';
  const read=async(role,after)=> (await call(route+'?after='+after,'GET',undefined,role)).json();
  assert.deepEqual(await read(tv,0),{candidates:[],next:0,complete:false});
  assert.equal((await call(route,'POST',{candidates:[candidate(1),candidate(2),candidate(1)]},phone)).status,200);
  assert.equal((await call(route,'POST',{candidates:[candidate(2)]},phone)).status,200);
  assert.equal((await call(route,'POST',{candidates:[candidate(3)],complete:true},phone)).status,200);
  assert.deepEqual(await read(tv,1),{candidates:[candidate(2),candidate(3)],next:3,complete:true});
  assert.deepEqual(await read(phone,0),{candidates:[],next:0,complete:false});
  assert.equal((await call(route,'POST',{candidates:[candidate(4)]},tv)).status,200);
  assert.deepEqual(await read(phone,0),{candidates:[candidate(4)],next:1,complete:false});
  assert.deepEqual(await read(tv,3),{candidates:[],next:3,complete:true});
  assert.equal((await call(route,'GET',undefined,token())).status,403);
  assert.equal((await call(route+'?after=65','GET',undefined,tv)).status,400);
  assert.equal((await call(route,'POST',{candidates:[{...candidate(5),sdpMLineIndex:1}]},phone)).status,400);
  assert.equal((await call(path+'/end','POST',undefined,tv)).status,200);
  assert.equal((await call(route,'GET',undefined,phone)).status,410);
  assert.equal((await DB.prepare('SELECT count(*) AS n FROM replay_pair_ice WHERE id=?').bind(id).first()).n,0);
});

function relayPacket(path,role,seq,bytes,type='application/octet-stream') {
  return worker.fetch(new Request(endpoint+path+'/relay-chunk?seq='+seq,{
    method:bytes===undefined?'GET':'POST', body:bytes,
    headers:{Origin:origin,Authorization:'Bearer '+role,'Content-Type':type}
  }),{DB});
}

test('the TV requests encrypted sharing, the phone consents, and only the TV can read its encrypted packet',async()=>{
  const {id,path,tv,phone}=await pairedDevices(), route=path+'/relay';
  const request={action:'request',formats:['video/webm;codecs=vp8','image/jpeg']};
  const start={action:'start',mimeType:'video/webm;codecs=vp8'};
  const report=(state,role)=>call(route,'POST',{action:'direct',state},role);
  const receipt=async()=>(await (await call(route,'GET',undefined,phone)).json()).direct;
  assert.equal(await receipt(),'waiting');
  assert.equal((await report('moving',phone)).status,403);
  assert.equal((await report('moving',token())).status,403);
  assert.equal((await report('relay-moving',tv)).status,409);
  assert.equal((await report('moving',tv)).status,200);
  assert.equal(await receipt(),'moving');
  assert.equal((await report('fallback',tv)).status,200);
  await report('moving',tv);
  assert.equal(await receipt(),'fallback');
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const iv=randomBytes(12), clear=Buffer.from('Replay recording test frame 01');
  const sealed=Buffer.concat([iv,Buffer.from(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,clear))]);
  assert.equal((await relayPacket(path,phone,0,sealed)).status,410);
  assert.equal((await call(route,'POST',request,phone)).status,403);
  assert.equal((await call(route,'POST',request,tv)).status,200);
  assert.equal((await call(route,'POST',start,tv)).status,403);
  assert.equal((await call(route,'POST',{action:'start',mimeType:'video/mp4'},phone)).status,409);
  assert.equal((await relayPacket(path,phone,0,sealed)).status,410);
  assert.equal((await call(route,'POST',start,phone)).status,200);
  assert.equal((await report('relay-moving',tv)).status,200);
  await report('fallback',tv);
  assert.equal(await receipt(),'relay-moving');
  assert.equal((await relayPacket(path,tv,0,sealed)).status,403);
  assert.equal((await relayPacket(path,phone,0)).status,403);
  assert.equal((await relayPacket(path,token(),0)).status,403);
  assert.equal((await relayPacket(path,tv,0)).status,204);
  assert.equal((await relayPacket(path,phone,0,sealed)).status,201);
  assert.equal((await relayPacket(path,phone,0,sealed)).status,200);
  const read=await relayPacket(path,tv,0);
  assert.equal(read.headers.get('Content-Type'),'application/octet-stream');
  assert.match(read.headers.get('Cache-Control'),/no-store/);
  const packet=Buffer.from(await read.arrayBuffer());
  assert.deepEqual(packet,sealed);
  assert.deepEqual(Buffer.from(await crypto.subtle.decrypt({name:'AES-GCM',iv:packet.subarray(0,12)},key,packet.subarray(12))),clear);
  const stored=await DB.prepare('SELECT ciphertext FROM replay_relay_chunks WHERE pair_id=? AND seq=0').bind(id).first();
  assert.equal(stored.ciphertext,sealed.toString('base64'));
  assert.equal((await call(path+'/end','POST',undefined,phone)).status,200);
  assert.equal((await relayPacket(path,tv,0)).status,410);
  assert.equal((await DB.prepare('SELECT count(*) AS n FROM replay_relay_chunks WHERE pair_id=?').bind(id).first()).n,0);
});

test('ICE batches are atomic, capped per sender, and expire with the pairing',async()=>{
  const {id,path,tv,phone}=await pairedDevices(), route=path+'/candidates';
  const send=(role,list,complete=false)=>call(route,'POST',{candidates:list,complete},role);
  const candidates=Array.from({length:65},(_,n)=>candidate(n));
  assert.equal((await send(phone,candidates.slice(0,13))).status,400);
  for(let n=0;n<60;n+=12) assert.equal((await send(phone,candidates.slice(n,n+12))).status,200);
  const concurrent=await Promise.all([send(phone,candidates.slice(60,63)),send(phone,candidates.slice(61,64))]);
  assert.deepEqual(concurrent.map(r=>r.status),[200,200]);
  assert.equal((await send(phone,[candidates[64]])).status,413);
  assert.equal((await send(phone,[],true)).status,200);
  const full=await (await call(route+'?after=0','GET',undefined,tv)).json();
  assert.equal(full.next,64); assert.equal(full.complete,true);
  assert.deepEqual(new Set(full.candidates.map(item=>item.candidate)),new Set(candidates.slice(0,64).map(item=>item.candidate)));
  assert.equal((await send(tv,[candidates[64]])).status,200);
  await DB.prepare('UPDATE replay_pairs SET expires=0 WHERE id=?').bind(id).run();
  assert.equal((await call(route,'GET',undefined,tv)).status,410);
  assert.equal((await send(phone,[candidate(66)])).status,410);
});

test('relay accepts only ordered bounded binary packets and preserves init plus the latest eight',async t=>{
  const {id,path,tv,phone}=await pairedDevices(), route=path+'/relay';
  const realNow=Date.now;
  let now=realNow();
  Date.now=()=>now;
  t.after(()=>{Date.now=realNow;});
  const post=(seq,packet,type)=>relayPacket(path,phone,seq,packet,type);
  const read=seq=>relayPacket(path,tv,seq);
  assert.equal((await call(route,'POST',{action:'request',formats:['image/jpeg']},tv)).status,200);
  assert.equal((await call(route,'POST',{action:'start',mimeType:'image/jpeg'},phone)).status,200);
  assert.equal((await post(0,randomBytes(64),'text/plain')).status,415);
  assert.equal((await post(0,randomBytes(28))).status,400);
  assert.equal((await post(0,Buffer.alloc(256*1024+1))).status,413);
  const initial=randomBytes(256*1024);
  assert.equal((await post(1,randomBytes(64))).status,409);
  assert.equal((await post(0,initial)).status,201);
  assert.equal((await post(0,randomBytes(64))).status,409);
  const throttled=await post(1,randomBytes(64));
  assert.equal(throttled.status,429); assert((await throttled.json()).retryAfterMs>0);
  for(let seq=1;seq<=10;seq++) {
    now+=500;
    assert.equal((await post(seq,randomBytes(64))).status,201);
  }
  const result=await (await call(route,'GET',undefined,tv)).json();
  assert.equal(result.latest,10); assert.equal(result.oldest,3);
  assert.deepEqual(Buffer.from(await (await read(0)).arrayBuffer()),initial);
  assert.equal((await read(1)).status,409);
  assert.equal((await read(2)).status,409);
  assert.equal((await read(3)).status,200);
  assert.equal((await read(10)).status,200);
  assert.equal((await read(11)).status,204);
  assert.equal((await DB.prepare('SELECT count(*) AS n FROM replay_relay_chunks WHERE pair_id=?').bind(id).first()).n,9);
  // Active sharing remains usable beyond the QR's ten-minute invitation window.
  now+=11*60000;
  assert.equal((await read(0)).status,200);
  now+=20*60000;
  assert.equal((await read(0)).status,410);
  assert.equal((await post(11,randomBytes(64))).status,410);
  // The next creation sweeps expired media, including initialization data.
  assert.equal((await call('','POST',{tvToken:token()})).status,201);
  assert.equal((await DB.prepare('SELECT count(*) AS n FROM replay_relay_chunks WHERE pair_id=?').bind(id).first()).n,0);
});

test('stopping encrypted sharing erases packets while preserving the authenticated direct pairing',async()=>{
  const {id,path,tv,phone}=await pairedDevices(), route=path+'/relay';
  assert.equal((await call(route,'POST',{action:'request',formats:['image/jpeg']},tv)).status,200);
  assert.equal((await call(route,'POST',{action:'start',mimeType:'image/jpeg'},phone)).status,200);
  assert.equal((await relayPacket(path,phone,0,randomBytes(64))).status,201);
  assert.equal((await call(route,'POST',{action:'stop'},tv)).status,200);
  assert.equal((await relayPacket(path,tv,0)).status,410);
  assert.equal((await relayPacket(path,phone,1,randomBytes(64))).status,410);
  assert.equal((await DB.prepare('SELECT count(*) AS n FROM replay_relay_chunks WHERE pair_id=?').bind(id).first()).n,0);
  assert.equal((await call(path,'GET',undefined,phone)).status,200);
  assert.equal((await call(route,'POST',{action:'request',formats:['image/jpeg']},tv)).status,410);
});
