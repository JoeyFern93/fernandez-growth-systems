const MAX_PACKET = 256 * 1024;
const MAX_DAY_PACKETS = 12000;
const MAX_DAY_BYTES = 400 * 1024 * 1024;
const RUN_MS = 30 * 60000;
const MAX_ROOMS = 4;
export const relaySchema = [
  `CREATE TABLE IF NOT EXISTS replay_relays (
     id TEXT PRIMARY KEY REFERENCES replay_pairs(id) ON DELETE CASCADE, status TEXT NOT NULL,
     formats TEXT NOT NULL, mime TEXT, latest INTEGER NOT NULL DEFAULT -1,
     last_at INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL, writer TEXT)`,
  `CREATE TABLE IF NOT EXISTS replay_relay_chunks (
     pair_id TEXT NOT NULL REFERENCES replay_relays(id) ON DELETE CASCADE,
     slot INTEGER NOT NULL, seq INTEGER NOT NULL, ciphertext TEXT NOT NULL, reads INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY(pair_id,slot)) WITHOUT ROWID`,
  'CREATE TABLE IF NOT EXISTS replay_relay_days (day INTEGER PRIMARY KEY,packets INTEGER NOT NULL,bytes INTEGER NOT NULL)',
  `CREATE TRIGGER IF NOT EXISTS replay_erase_ended AFTER UPDATE OF ended ON replay_pairs WHEN NEW.ended=1 BEGIN
     DELETE FROM replay_relay_chunks WHERE pair_id=NEW.id;
     UPDATE replay_relays SET status='ended',writer=NULL WHERE id=NEW.id AND status<>'ended';
   END`,
  `CREATE TRIGGER IF NOT EXISTS replay_erase_expired AFTER DELETE ON replay_pairs BEGIN
     DELETE FROM replay_relay_chunks WHERE pair_id=OLD.id;
     DELETE FROM replay_relays WHERE id=OLD.id;
   END`
];
function normalizeMime(value) {
  if(typeof value!=='string') return null;
  const mime=value.toLowerCase().replace(/\s+/g,'').replace(/"/g,'');
  if(mime==='image/jpeg') return mime;
  return /^video\/(?:webm|mp4)(?:;codecs=(?:vp8|vp8\.0|vp9|vp09(?:\.[\da-z]{1,4}){0,8}|avc1(?:\.[a-f0-9]{6})?|av01(?:\.[a-z\d]{1,6}){0,8}))?$/.test(mime) ? mime : null;
}
function status(row, expiry) {
  return {status:row?.status||'idle',formats:row ? JSON.parse(row.formats) : [],
    mimeType:row?.mime||null,latest:row?.latest??-1,oldest:row && row.latest>0 ? Math.max(1,row.latest-7) : null,
    expiresAt:row?.expires||expiry};
}
async function packetBytes(request,fail) {
  if(request.headers.get('Content-Type')?.split(';')[0].toLowerCase()!=='application/octet-stream') fail(415,'Send encrypted binary video packets.');
  if(Number(request.headers.get('Content-Length'))>MAX_PACKET) fail(413,'The encrypted video packet is too large.');
  const reader=request.body?.getReader(); if(!reader) fail(400,'The video packet is missing.');
  const parts=[];let size=0;
  for(;;) {
    const {done,value}=await reader.read();if(done)break;
    if((size+=value.length)>MAX_PACKET) {await reader.cancel();fail(413,'The encrypted video packet is too large.');}
    parts.push(value);
  }
  if(size<=28) fail(400,'The encrypted video packet is incomplete.');
  return new Uint8Array(await new Blob(parts).arrayBuffer());
}
function encoded(bytes) {
  if(typeof bytes.toBase64==='function') return bytes.toBase64();
  const parts=[];
  for(let i=0;i<bytes.length;i+=16384) parts.push(String.fromCharCode(...bytes.subarray(i,i+16384)));
  return btoa(parts.join(''));
}
function decoded(value) {
  if(typeof Uint8Array.fromBase64==='function') return Uint8Array.fromBase64(value);
  return Uint8Array.from(atob(value),ch=>ch.charCodeAt(0));
}
export async function replayRelay({request,db,id,role,action,url,now,pair,body,fail}) {
  if(!pair.phone_hash && role!=='tv') fail(409,'Pair the phone before sharing video.');
  const lookup=()=>db.prepare('SELECT status,formats,mime,latest,last_at,expires FROM replay_relays WHERE id=?').bind(id).first();
  const row=await lookup();
  if(action==='relay' && request.method==='GET') return {data:status(row,pair.expires)};
  if(action==='relay') {
    const input=await body(request);
    if(input.action==='stop') {
      await db.batch([db.prepare("UPDATE replay_relays SET status='ended',writer=NULL WHERE id=?").bind(id),
        db.prepare('DELETE FROM replay_relay_chunks WHERE pair_id=?').bind(id)]);
      return {data:status(await lookup(),pair.expires)};
    }
    if(input.action==='request') {
      if(role!=='tv') fail(403,'The TV requests a relay.');
      if(!Array.isArray(input.formats)||!input.formats.length||input.formats.length>8) fail(400,'Choose supported video formats.');
      const formats=[...new Set(input.formats.map(normalizeMime))];
      if(formats.includes(null)) fail(400,'Unsupported relay video format.');
      if(row?.status==='ended') fail(410,'This relay has ended. Show a new code on the TV.');
      if(!row) await db.prepare(`INSERT INTO replay_relays(id,status,formats,expires)
        SELECT id,'requested',?,expires FROM replay_pairs WHERE id=? AND ended=0 AND expires>?
        ON CONFLICT(id) DO NOTHING`).bind(JSON.stringify(formats),id,now).run();
    } else if(input.action==='start') {
      if(role!=='phone') fail(403,'Confirm sharing on the phone.');
      const mime=normalizeMime(input.mimeType);
      if(!row || row.status==='ended' || !mime || !JSON.parse(row.formats).includes(mime)) fail(409,'Choose a format requested by the TV.');
      if(row.status==='active' && row.mime!==mime) fail(409,'A different relay format is already active.');
      if(row.status==='requested') {
        const day=Math.floor(now/86400000);
        const [,start]=await db.batch([
          db.prepare('INSERT INTO replay_relay_days(day,packets,bytes) VALUES (?,0,0) ON CONFLICT(day) DO NOTHING').bind(day),
          db.prepare(`UPDATE replay_relays SET status='active',mime=?,expires=?,last_at=0
            WHERE id=? AND status='requested' AND expires>? AND EXISTS (SELECT 1 FROM replay_pairs WHERE id=? AND ended=0)
              AND (SELECT count(*) FROM replay_relays WHERE status='active' AND expires>?) < ?
              AND EXISTS (SELECT 1 FROM replay_relay_days WHERE day=? AND packets<? AND bytes<?)`)
            .bind(mime,now+RUN_MS,id,now,id,now,MAX_ROOMS,day,MAX_DAY_PACKETS,MAX_DAY_BYTES),
          db.prepare('DELETE FROM replay_relay_days WHERE day<?').bind(day-1)
        ]);
        if(!start.meta.changes && (await lookup())?.status!=='active') fail(429,'The video relay is at capacity. Try again later.');
      }
    } else fail(400,'Choose a relay action.');
    return {data:status(await lookup(),pair.expires)};
  }
  if(!row || row.status!=='active' || row.expires<=now) fail(410,'Encrypted sharing is not active.');
  const seq=Number(url.searchParams.get('seq')), slot=seq===0 ? 0 : 1+(seq-1)%8;
  if(request.method==='GET') {
    if(role!=='tv') fail(403,'Only the TV receives video packets.');
    if(seq>row.latest) return {status:204};
    // Limit each encrypted packet to the receiver plus two retries. The persistent init
    // packet allows a few extra decoder restarts. This bounds egress without polling writes.
    const item=await db.prepare('UPDATE replay_relay_chunks SET reads=reads+1 WHERE pair_id=? AND slot=? AND seq=? AND reads<? RETURNING ciphertext')
      .bind(id,slot,seq,seq===0 ? 8 : 3).first();
    if(!item) fail(409,'That video packet has left the live window or was already delivered.');
    return {bytes:decoded(item.ciphertext)};
  }
  if(role!=='phone') fail(403,'Only the paired phone sends video.');
  if(seq>row.latest+1) fail(409,'Send encrypted video packets in order.');
  const bytes=await packetBytes(request,fail), ciphertext=encoded(bytes);
  if(seq<=row.latest) {
    const stored=await db.prepare('SELECT ciphertext FROM replay_relay_chunks WHERE pair_id=? AND slot=? AND seq=?').bind(id,slot,seq).first();
    if(stored && stored.ciphertext!==ciphertext) fail(409,'That video packet was already sent.');
    return {data:{seq}};
  }
  const day=Math.floor(now/86400000), writer=crypto.randomUUID(), interval=row.mime==='image/jpeg' ? 140 : 300;
  const [,updated]=await db.batch([
    db.prepare('INSERT INTO replay_relay_days(day,packets,bytes) VALUES (?,0,0) ON CONFLICT(day) DO NOTHING').bind(day),
    db.prepare(`UPDATE replay_relays SET latest=?,last_at=?,writer=? WHERE id=? AND latest=? AND status='active' AND expires>? AND last_at<=?
      AND EXISTS (SELECT 1 FROM replay_relay_days WHERE day=? AND packets<? AND bytes<=?)`)
      .bind(seq,now,writer,id,seq-1,now,now-interval,day,MAX_DAY_PACKETS,MAX_DAY_BYTES-bytes.length),
    db.prepare(`INSERT INTO replay_relay_chunks(pair_id,slot,seq,ciphertext) SELECT ?,?,?,?
      WHERE EXISTS(SELECT 1 FROM replay_relays WHERE id=? AND writer=?)
      ON CONFLICT(pair_id,slot) DO UPDATE SET seq=excluded.seq,ciphertext=excluded.ciphertext,reads=0`)
      .bind(id,slot,seq,ciphertext,id,writer),
    db.prepare('UPDATE replay_relay_days SET packets=packets+1,bytes=bytes+? WHERE day=? AND EXISTS (SELECT 1 FROM replay_relays WHERE id=? AND writer=?)')
      .bind(bytes.length,day,id,writer)
  ]);
  if(!updated.meta.changes) {
    const again=await lookup();
    if(again?.status!=='active'||again.expires<=now) fail(410,'Encrypted sharing has ended.');
    if(again.latest>=seq) {
      const item=await db.prepare('SELECT ciphertext FROM replay_relay_chunks WHERE pair_id=? AND slot=? AND seq=?').bind(id,slot,seq).first();
      if(item && item.ciphertext!==ciphertext) fail(409,'That video packet was already sent.');
      return {data:{seq}};
    }
    if(now-again.last_at<interval) return {status:429,data:{error:'Send video packets a little more slowly.',retryAfterMs:interval-(now-again.last_at)}};
    fail(429,'The daily encrypted video allowance has been used. Direct pairing still works.');
  }
  return {status:201,data:{seq}};
}
