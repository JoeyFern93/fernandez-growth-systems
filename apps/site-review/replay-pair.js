const ORIGINS = new Set(['https://www.fernandezgrowthsystems.com','https://fernandezgrowthsystems.com']);
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

class PairError extends Error {
  constructor(status,message) { super(message); this.status=status; }
}
function fail(status,message) { throw new PairError(status,message); }
async function setup(db) {
  if(!initialized.has(db)) {
    const result=db.batch([db.prepare(CREATE),
      db.prepare('CREATE INDEX IF NOT EXISTS replay_pairs_expiry ON replay_pairs(expires)')]);
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
function description(value,kind) {
  if(value.type!==kind || typeof value.sdp!=='string' || value.sdp.length>MAX_SDP) fail(400,'Choose a valid video connection description.');
  const lines=value.sdp.replace(/\r\n/g,'\n').replace(/\n$/,'').split('\n');
  if(lines.length>512 || lines[0]!=='v=0' || lines.some(line=>line.length>2048 || !/^[a-z]=[\x20-\x7e]*$/.test(line))) {
    fail(400,'The video connection description is invalid.');
  }
  const media=lines.filter(line=>line.startsWith('m='));
  if(media.length!==1 || !/^m=video \d{1,5} (?:UDP|TCP)\/TLS\/RTP\/SAVPF?(?: \d{1,3})+$/.test(media[0]) ||
      !lines.some(line=>/^a=fingerprint:sha-(?:256|384|512) (?:[a-f0-9]{2}:){15,}[a-f0-9]{2}$/i.test(line)) ||
      !lines.some(line=>/^a=ice-ufrag:\S+$/.test(line)) || !lines.some(line=>/^a=ice-pwd:\S+$/.test(line)) ||
      !lines.some(line=>line.startsWith('o=')) || !lines.some(line=>line.startsWith('t='))) {
    fail(400,'Pair one encrypted video connection at a time.');
  }
  // Keep the negotiated transport and codec parameters. Discard optional titles, URLs,
  // contacts and unknown attributes. SDP necessarily contains temporary ICE details.
  return lines.filter(line=>/^[vostcmb]=/.test(line) || (line.startsWith('a=') && SDP_ATTRIBUTES.test(line.slice(2))))
    .map(line=>line.startsWith('s=') ? 's=-' : line).join('\r\n')+'\r\n';
}
async function createPair(request,db,now) {
  const {tvToken}=await body(request);
  requireToken(tvToken);
  const expiry = now+TTL;
  const [idSeed,tvHash,invite]=await Promise.all([digest('id',tvToken),digest('role',tvToken),digest('invite/'+expiry,tvToken)]);
  const id=idSeed.slice(0,22), inviteHash=await digest('claim',invite);
  const ip=request.headers.get('CF-Connecting-IP');
  const bucket=ip ? await digest('network',Math.floor(now/TTL)+'/'+ip) : tvHash;
  const [,result]=await db.batch([
    db.prepare('DELETE FROM replay_pairs WHERE expires<=?').bind(now),
    db.prepare(`INSERT INTO replay_pairs(id,tv_hash,invite_hash,bucket,expires)
      SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM replay_pairs) < 160
      AND (SELECT count(*) FROM replay_pairs WHERE bucket=?) < 16 ON CONFLICT(id) DO NOTHING`)
      .bind(id,tvHash,inviteHash,bucket,expiry,bucket)
  ]);
  const row=await db.prepare('SELECT expires,ended FROM replay_pairs WHERE id=? AND tv_hash=?').bind(id,tvHash).first();
  if(!row) fail(429,'Pairing is busy. Try again in a few minutes.');
  if(row.ended) fail(410,'This pairing has ended. Show a new QR code on the TV.');
  return {status:result.meta.changes ? 201 : 200, data:{id,invite:row.expires===expiry ? invite : await digest('invite/'+row.expires,tvToken),expiresAt:row.expires}};
}
async function handle(request,db,id,action,now) {
  if(!db) fail(503,'Pairing is temporarily unavailable.');
  await setup(db);
  if(!id) return createPair(request,db,now);
  if(action==='claim') {
    const input=await body(request);
    const [invite,phone]=await Promise.all([digest('claim',requireToken(input.invite)),digest('role',requireToken(input.phoneToken))]);
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
  const roleHash=await digest('role',token);
  const row=await db.prepare('SELECT tv_hash,phone_hash,expires,ended,offer,answer FROM replay_pairs WHERE id=?').bind(id).first();
  if(!row || row.expires<=now) fail(410,'This pairing has expired. Show a new QR code on the TV.');
  const tv=roleHash===row.tv_hash, phone=roleHash===row.phone_hash;
  if(!tv && !phone) fail(403,'Pairing access is invalid.');
  if(action==='end') {
    await db.prepare('UPDATE replay_pairs SET ended=1,invite_hash=NULL,offer=NULL,answer=NULL WHERE id=? AND ended=0').bind(id).run();
    return {data:{status:'ended'}};
  }
  if(row.ended) fail(410,'This pairing has ended.');
  if(!action) {
    const data=publicState(row);
    if(tv && row.offer) data.offer={type:'offer',sdp:row.offer};
    if(phone && row.answer) data.answer={type:'answer',sdp:row.answer};
    return {data};
  }
  if(action==='offer' ? !phone : !tv) fail(403,'This device cannot send that description.');
  const sdp=description(await body(request,MAX_SDP*2),action);
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
export async function replayPair(request,db,url) {
  const origin=request.headers.get('Origin'), headers=new Headers({'Cache-Control':'private, no-store','Vary':'Origin','Referrer-Policy':'no-referrer'});
  if(!ORIGINS.has(origin)) return Response.json({error:'Open Replay Cam to pair a TV.'},{status:403,headers});
  headers.set('Access-Control-Allow-Origin',origin);
  try {
    const path=url.pathname.slice(PREFIX.length);
    const match=/^\/([A-Za-z0-9_-]{22})(?:\/(claim|offer|answer|end))?$/.exec(path);
    if(url.search || (path && !match)) fail(404,'Pairing route not found.');
    const id=match?.[1], action=match?.[2], allowed=!id || action ? 'POST' : 'GET';
    if(request.method==='OPTIONS') {
      const requested=(request.headers.get('Access-Control-Request-Headers')||'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
      if(request.headers.get('Access-Control-Request-Method')!==allowed || requested.some(h=>!['authorization','content-type','accept'].includes(h))) fail(403,'Unsupported pairing request.');
      headers.set('Access-Control-Allow-Methods',allowed);
      headers.set('Access-Control-Allow-Headers','Authorization, Content-Type, Accept');
      headers.set('Access-Control-Max-Age','600');
      return new Response(null,{status:204,headers});
    }
    if(request.method!==allowed) fail(405,'Use the correct method for this pairing action.');
    const result=await handle(request,db,id,action,Date.now());
    return Response.json(result.data,{status:result.status||200,headers});
  } catch(error) {
    const status=error instanceof PairError ? error.status : 503;
    if(status===429) headers.set('Retry-After','60');
    return Response.json({error:status===503 ? 'Pairing is temporarily unavailable.' : error.message},{status,headers});
  }
}
