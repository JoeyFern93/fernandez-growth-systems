const ORIGINS = new Set(['https://www.fernandezgrowthsystems.com','https://fernandezgrowthsystems.com']);
const QA_SITE = 'https://qa-replay-audit-fixes-202611.fernandez-growth-systems.pages.dev';
const QA_API = 'https://qa-replay-audit-fixes-202611.fgs-site-review.pages.dev';
const PREFIX = '/api/replay-pair';
const TTL = 10 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_SDP = 49152;
const SDP_ATTRIBUTES = /^(?:candidate|ice-ufrag|ice-pwd|ice-options|fingerprint|setup|mid|group|msid-semantic|msid|ssrc|ssrc-group|rtcp|rtpmap|rtcp-fb|fmtp|extmap|rid|simulcast|content|framerate|rtcp-xr|tls-id|imageattr|rtcp-mux-only)(?::|$)|^(?:sendonly|recvonly|sendrecv|inactive|rtcp-mux|rtcp-rsize|extmap-allow-mixed|end-of-candidates|ice-lite|bundle-only)$/;
const CREATE = `CREATE TABLE IF NOT EXISTS replay_pairs (
 id TEXT PRIMARY KEY, tv_hash TEXT NOT NULL, invite_hash TEXT, phone_hash TEXT,
 bucket TEXT NOT NULL, expires INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0,
 offer TEXT, answer TEXT)`;
const initialized = new WeakMap();
const nextSweep = new WeakMap();
const previewDatabases = new WeakMap();
function previewDatabase(db) {
  if (!previewDatabases.has(db)) {
    // All SQL in the pairing and relay modules is app-owned, with request data
    // bound separately. Scope every table, index and trigger, including cleanup.
    previewDatabases.set(db, {
      prepare(sql) { return db.prepare(sql.replace(/\breplay_[a-z0-9_]+\b/g, 'audit_$&')); },
      batch(statements) { return db.batch(statements); }
    });
  }
  return previewDatabases.get(db);
}
const expiredPairs = "DELETE FROM replay_pairs WHERE expires<=? AND NOT EXISTS (SELECT 1 FROM replay_relays WHERE id=replay_pairs.id AND status='active' AND expires>?)";

class PairError extends Error {
  constructor(status,message) { super(message); this.status=status; }
}
function fail(status,message) { throw new PairError(status,message); }
async function setup(db, relaySchema) {
  if(!initialized.has(db)) {
    const result=db.batch([db.prepare(CREATE),
      db.prepare('CREATE INDEX IF NOT EXISTS replay_pairs_expiry ON replay_pairs(expires)'),
      db.prepare(`CREATE TABLE IF NOT EXISTS replay_pair_ice (id TEXT NOT NULL REFERENCES replay_pairs(id) ON DELETE CASCADE,
        role TEXT NOT NULL, revision INTEGER NOT NULL, candidates TEXT NOT NULL, complete INTEGER NOT NULL,
        PRIMARY KEY(id,role)) WITHOUT ROWID`),
      db.prepare(`CREATE TRIGGER IF NOT EXISTS replay_clear_ice AFTER UPDATE OF ended ON replay_pairs WHEN NEW.ended=1 BEGIN
        DELETE FROM replay_pair_ice WHERE id=NEW.id; END`),
      ...relaySchema.map(sql=>db.prepare(sql))]);
    initialized.set(db,result);
    try { await result; } catch(error) { initialized.delete(db);throw error; }
  } else await initialized.get(db);
}
function requireToken(token) {
  if(typeof token!=='string' || !TOKEN.test(token)) fail(400,'Use a valid pairing credential.');
  return token;
}
async function digest(tag,secret) {
  const raw=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('FGS Replay pairing v1/'+tag+'/'+secret));
  return btoa(String.fromCharCode(...new Uint8Array(raw))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function body(request,limit=1200) {
  if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json') fail(415,'Send JSON.');
  if(Number(request.headers.get('Content-Length'))>limit) fail(413,'Pairing message is too large.');
  const stream=request.body?.getReader();
  if(!stream) fail(400,'Pairing message is empty.');
  const chunks=[];let bytes=0;
  for(;;) {
    const {done,value}=await stream.read();
    if(done) break;
    if((bytes+=value.length)>limit) {await stream.cancel();fail(413,'Pairing message is too large.');}
    chunks.push(value);
  }
  let parsed;
  try { parsed=JSON.parse(await new Blob(chunks).text()); } catch {fail(400,'Pairing message is invalid.');}
  if(!parsed || Array.isArray(parsed) || typeof parsed!=='object') fail(400,'Pairing message is invalid.');
  return parsed;
}
function publicState(pair) {
  return {status:pair.answer ? 'answered' : pair.offer ? 'offered' : pair.phone_hash ? 'paired' : 'waiting',expiresAt:pair.expires};
}
function description(value,kind,angleRoom=false) {
  if(value.type!==kind || typeof value.sdp!=='string' || value.sdp.length>MAX_SDP) fail(400,'Choose a valid video connection description.');
  const lines=value.sdp.replace(/\r\n/g,'\n').replace(/\n$/,'').split('\n');
  if(lines.length>512 || lines[0]!=='v=0' || lines.some(line=>line.length>2048 || !/^[a-z]=[\x20-\x7e]*$/.test(line))) {
    fail(400,'The video connection description is invalid.');
  }
  const media=lines.filter(line=>line.startsWith('m='));
  const validVideo = /^m=video \d{1,5} (?:UDP|TCP)\/TLS\/RTP\/SAVPF?(?: \d{1,3})+$/;
  const validControl = /^m=application \d{1,5} UDP\/DTLS\/SCTP webrtc-datachannel$/;
  const validMedia = angleRoom
    ? media.length===2 && media.filter(line=>validVideo.test(line)).length===1 &&
      media.filter(line=>validControl.test(line)).length===1 &&
      lines.includes('a=sctp-port:5000')
    : media.length===1 && validVideo.test(media[0]);
  if(!validMedia ||
      !lines.some(line=>/^a=fingerprint:sha-(?:256|384|512) (?:[a-f0-9]{2}:){15,}[a-f0-9]{2}$/i.test(line)) ||
      !lines.some(line=>/^a=ice-ufrag:\S+$/.test(line)) || !lines.some(line=>/^a=ice-pwd:\S+$/.test(line)) ||
      !lines.some(line=>line.startsWith('o=')) || !lines.some(line=>line.startsWith('t='))) {
    fail(400,'Pair one encrypted video connection at a time.');
  }
  // Keep the negotiated transport and codec parameters. Discard optional titles, URLs,
  // contacts and unknown attributes. SDP necessarily contains temporary ICE details.
  return lines.filter(line=>/^[vostcmb]=/.test(line) || (line.startsWith('a=') && SDP_ATTRIBUTES.test(line.slice(2))) ||
      (angleRoom && /^(?:a=sctp-port:5000|a=max-message-size:\d{1,10})$/.test(line)))
    .map(line=>line.startsWith('s=') ? 's=-' : line).join('\r\n')+'\r\n';
}
async function createPair(request,db,now,hash) {
  const {tvToken,purpose}=await body(request);
  requireToken(tvToken);
  const expiry = now+TTL;
  const [idSeed,tvHash,invite]=await Promise.all([hash('id',tvToken),hash('role',tvToken),hash('invite/'+expiry,tvToken)]);
  // The reserved prefix cannot occur in ordinary base64url room identifiers.
  const id=purpose==='multicam' ? '~'+idSeed.slice(0,21) : idSeed.slice(0,22);
  const inviteHash=await hash('claim',invite);
  const ip=request.headers.get('CF-Connecting-IP');
  const bucket=ip ? await hash('network',Math.floor(now/TTL)+'/'+ip) : tvHash;
  const [,result]=await db.batch([
    db.prepare(expiredPairs).bind(now,now),
    db.prepare(`INSERT INTO replay_pairs(id,tv_hash,invite_hash,bucket,expires)
      SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM replay_pairs) < 160
      AND (SELECT count(*) FROM replay_pairs WHERE bucket=?) < 16 ON CONFLICT(id) DO NOTHING`)
      .bind(id,tvHash,inviteHash,bucket,expiry,bucket)
  ]);
  const row=await db.prepare('SELECT expires,ended FROM replay_pairs WHERE id=? AND tv_hash=?').bind(id,tvHash).first();
  if(!row) fail(429,'Pairing is busy. Try again in a few minutes.');
  if(row.ended) fail(410,'This pairing has ended. Show a new QR code on the TV.');
  return {status:result.meta.changes ? 201 : 200, data:{id,invite:row.expires===expiry ? invite : await hash('invite/'+row.expires,tvToken),expiresAt:row.expires}};
}
function checkedCandidate(value) {
  const c=value?.candidate;
  if(typeof c!=='string' || c.length>1200 || !/^[\x20-\x7e]+$/.test(c) ||
      !/^candidate:[^ ]{1,64} [12] (udp|tcp) \d{1,10} [^ ]{1,255} \d{1,5} typ (host|srflx|prflx|relay)(?: [^ ]+)*$/i.test(c)) {
    fail(400,'Invalid connection candidate.');
  }
  if(value.sdpMid!=null && (typeof value.sdpMid!=='string' || !/^[A-Za-z0-9_.-]{1,32}$/.test(value.sdpMid))) fail(400,'Invalid video media identifier.');
  if(value.sdpMLineIndex!=null && value.sdpMLineIndex!==0) fail(400,'Choose the video connection.');
  if(value.sdpMid==null && value.sdpMLineIndex==null) fail(400,'Choose the video connection.');
  if(value.usernameFragment!=null && (typeof value.usernameFragment!=='string' || !/^[A-Za-z0-9+/_=-]{1,256}$/.test(value.usernameFragment))) fail(400,'Invalid candidate fragment.');
  return {candidate:c,sdpMid:value.sdpMid??null,sdpMLineIndex:value.sdpMLineIndex??null,...(value.usernameFragment ? {usernameFragment:value.usernameFragment} : {})};
}
async function candidates(request,db,id,role,url,now) {
  const read=which=>db.prepare('SELECT candidates,complete,revision FROM replay_pair_ice WHERE id=? AND role=?').bind(id,which).first();
  if(request.method==='GET') {
    const row=await read(role==='tv'?'phone':'tv'), list=JSON.parse(row?.candidates||'[]');
    const after=Number(url.searchParams.get('after')||0);
    if(after>64) fail(400,'Invalid candidate cursor.');
    return {data:{candidates:list.slice(after),next:list.length,complete:!!row?.complete}};
  }
  const input=await body(request,24000);
  if(!Array.isArray(input.candidates) || input.candidates.length>12 ||
      (input.complete!==undefined && typeof input.complete!=='boolean')) fail(400,'Send up to 12 video connection candidates.');
  const incoming=input.candidates.map(checkedCandidate);
  for(let attempt=0;attempt<5;attempt++) {
    const row=await read(role), list=JSON.parse(row?.candidates||'[]'), original=list.length, complete=!!row?.complete || input.complete===true;
    const seen=new Set(list.map(x=>JSON.stringify(x)));
    for(const value of incoming) {
      const key=JSON.stringify(value);if(!seen.has(key)) {seen.add(key);list.push(value);}
    }
    if(list.length>64) fail(413,'The connection candidate limit has been reached.');
    const data={status:'ok',count:list.length,complete};
    if(original===list.length && !!row?.complete===complete) return {data};
    const previous=row?.revision||0;
    const write=await db.prepare(`INSERT INTO replay_pair_ice(id,role,revision,candidates,complete)
      SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM replay_pairs WHERE id=? AND ended=0 AND expires>?)
      ON CONFLICT(id,role) DO UPDATE SET revision=excluded.revision,candidates=excluded.candidates,complete=excluded.complete
      WHERE replay_pair_ice.revision=?`).bind(id,role,previous+1,JSON.stringify(list),+complete,id,now,previous).run();
    if(write.meta.changes) return {data};
  }
  fail(409,'Connection details changed. Retry the same batch.');
}
async function handle(request,env,id,action,now,url,helpers,preview) {
  if(!env.DB) fail(503,'Pairing is temporarily unavailable.');
  const db=preview ? previewDatabase(env.DB) : env.DB;
  const hash=preview ? (tag,value)=>digest('audit/'+tag,value) : digest;
  await setup(db,helpers.relaySchema);
  if(!id) return createPair(request,db,now,hash);
  // Pair creation always sweeps. Active traffic also clears abandoned rooms at most once
  // per minute on each Worker isolate, including their encrypted rolling windows.
  if(now >= (nextSweep.get(db)||0)) {
    nextSweep.set(db,now+60000);
    try {await db.prepare(expiredPairs).bind(now,now).run();}
    catch(error) {nextSweep.delete(db);throw error;}
  }
  if(action==='claim') {
    const input=await body(request);
    const [invite,phone]=await Promise.all([hash('claim',requireToken(input.invite)),hash('role',requireToken(input.phoneToken))]);
    // The first phone claims atomically. Retrying the same phone's request is harmless.
    const row=await db.prepare(`UPDATE replay_pairs SET phone_hash=?
      WHERE id=? AND expires>? AND ended=0 AND invite_hash=? AND tv_hash<>?
      AND (phone_hash IS NULL OR phone_hash=?) RETURNING expires,phone_hash,offer,answer`)
      .bind(phone,id,now,invite,phone,phone).first();
    if(row) return {data:publicState(row)};
    const existing=await db.prepare('SELECT invite_hash,phone_hash,expires,ended FROM replay_pairs WHERE id=?').bind(id).first();
    if(!existing || existing.expires<=now || existing.ended) fail(410,'This QR code has expired. Show a new one on the TV.');
    if(existing.invite_hash!==invite) fail(403,'This pairing invite is invalid.');
    fail(409,'Another phone has already joined. Show a new QR code to pair again.');
  }
  const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization')||'')?.[1];
  if(!token) fail(401,'Pairing access is required.');
  const roleHash=await hash('role',token);
  // Fetch pixel-free signaling metadata only; media packets never need the potentially long SDP.
  const desc=(!action || action==='offer' || action==='answer') ? ',p.offer,p.answer' : '';
  const row=await db.prepare(`SELECT p.tv_hash,p.phone_hash,p.expires,p.ended,
    CASE WHEN r.status='active' THEN MAX(r.expires,p.expires) ELSE p.expires END AS access_until`+desc+
    ' FROM replay_pairs p LEFT JOIN replay_relays r ON r.id=p.id WHERE p.id=?').bind(id).first();
  if(!row || row.access_until<=now) {
    if(row) await db.prepare(expiredPairs+' AND id=?').bind(now,now,id).run();
    fail(410,'This pairing has expired. Show a new QR code on the TV.');
  }
  const tv=roleHash===row.tv_hash, phone=roleHash===row.phone_hash;
  if(!tv && !phone) fail(403,'Pairing access is invalid.');
  if(action==='end') {
    await db.prepare('UPDATE replay_pairs SET ended=1,invite_hash=NULL,offer=NULL,answer=NULL WHERE id=? AND ended=0').bind(id).run();
    return {data:{status:'ended'}};
  }
  if(row.ended) fail(410,'This pairing has ended.');
  const role=tv?'tv':'phone';
  const angleRoom=id.startsWith('~');
  if(angleRoom && ['ice-servers','relay','relay-chunk'].includes(action)) fail(403,'Multi-camera rooms use direct connections only.');
  if(action==='candidates') return candidates(request,db,id,role,url,now);
  if(action==='ice-servers') {
    // Preview rooms never issue credentials using the production TURN binding.
    if(preview) return {data:{iceServers:[{urls:'stun:stun.cloudflare.com:3478'}],relayAvailable:false}};
    return {data:await helpers.turnIceServers(env,db,id,role,now)};
  }
  if(action==='relay' || action==='relay-chunk') return helpers.replayRelay({request,db,id,role,action,url,now,pair:row,body,fail});
  if(!action) {
    const data=publicState(row);
    if(tv && row.offer) data.offer={type:'offer',sdp:row.offer};
    if(phone && row.answer) data.answer={type:'answer',sdp:row.answer};
    return {data};
  }
  if(action==='offer' ? !phone : !tv) fail(403,'This device cannot send that description.');
  const sdp=description(await body(request,MAX_SDP*2),action,angleRoom);
  if(row[action]) {
    if(row[action]!==sdp) fail(409,'This device already sent a different connection description.');
    return {data:publicState(row)};
  }
  // The route matcher restricts the column names to offer and answer.
  const prerequisite=action==='answer' ? ' AND offer IS NOT NULL' : '';
  const result=await db.prepare('UPDATE replay_pairs SET '+action+'=? WHERE id=? AND expires>? AND ended=0 AND phone_hash IS NOT NULL AND ('+action+' IS NULL OR '+action+'=?)'+prerequisite)
    .bind(sdp,id,now,sdp).run();
  if(!result.meta.changes) fail(409,'This pairing changed. Start a new pairing on the TV.');
  return {data:{status:action==='offer'?'offered':'answered',expiresAt:row.expires}};
}
export function replayPreview(request,env,helpers) {
  const url=new URL(request.url);
  if(url.origin!==QA_API || !(url.pathname===PREFIX || url.pathname.startsWith(PREFIX+'/'))) {
    return new Response(null,{status:404,headers:{'Cache-Control':'private, no-store'}});
  }
  return replayPair(request,env,url,helpers);
}
export async function replayPair(request,env,url,helpers) {
  const origin=request.headers.get('Origin'), headers=new Headers({'Cache-Control':'private, no-store','Vary':'Origin','Referrer-Policy':'no-referrer'});
  const preview=url.origin===QA_API;
  const allowed=preview ? origin===QA_SITE : !url.hostname.endsWith('.fgs-site-review.pages.dev') && ORIGINS.has(origin);
  if(!allowed) return Response.json({error:'Open Replay Cam to pair a TV.'},{status:403,headers});
  headers.set('Access-Control-Allow-Origin',origin);
  try {
    const path=url.pathname.slice(PREFIX.length);
    const match=/^\/([~A-Za-z0-9_-][A-Za-z0-9_-]{21})(?:\/(claim|offer|answer|end|candidates|ice-servers|relay|relay-chunk))?$/.exec(path);
    if(path && !match) fail(404,'Pairing route not found.');
    const id=match?.[1], action=match?.[2];
    if(action==='relay-chunk' ? !/^\?seq=(?:0|[1-9]\d{0,6})$/.test(url.search) :
       url.search && !(action==='candidates' && /^\?after=(?:0|[1-9]\d?)$/.test(url.search))) fail(404,'Pairing route not found.');
    const methods=['candidates','relay','relay-chunk'].includes(action) ? ['GET','POST'] :
      (!id || (action && action!=='ice-servers') ? ['POST'] : ['GET']);
    if(request.method==='OPTIONS') {
      const requested=(request.headers.get('Access-Control-Request-Headers')||'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
      if(!methods.includes(request.headers.get('Access-Control-Request-Method')) || requested.some(h=>!['authorization','content-type','accept'].includes(h))) fail(403,'Unsupported pairing request.');
      headers.set('Access-Control-Allow-Methods',methods.join(', '));
      headers.set('Access-Control-Allow-Headers','Authorization, Content-Type, Accept');
      headers.set('Access-Control-Max-Age','600');
      return new Response(null,{status:204,headers});
    }
    if(!methods.includes(request.method)) fail(405,'Use the correct method for this pairing action.');
    const result=await handle(request,env,id,action,Date.now(),url,helpers,preview);
    if(result.bytes) {
      headers.set('Content-Type','application/octet-stream');
      headers.set('Content-Length',String(result.bytes.length));
      return new Response(result.bytes,{status:200,headers});
    }
    if(result.status===204) return new Response(null,{status:204,headers});
    return Response.json(result.data,{status:result.status||200,headers});
  } catch(error) {
    const status=error instanceof PairError ? error.status : 503;
    if(status===429) headers.set('Retry-After','60');
    return Response.json({error:status===503 ? 'Pairing is temporarily unavailable.' : error.message},{status,headers});
  }
}
