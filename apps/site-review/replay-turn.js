const STUN = {iceServers:[{urls:'stun:stun.cloudflare.com:3478'}],relayAvailable:false};
const TTL_SECONDS = 1200;
const DAILY_CREDENTIALS = 48;
const ready = new WeakMap();

async function ensureTurn(db) {
  if(!ready.has(db)) {
    const result=db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS replay_turn_issues (
        id TEXT NOT NULL REFERENCES replay_pairs(id) ON DELETE CASCADE, role TEXT NOT NULL,
        nonce TEXT NOT NULL, expires INTEGER NOT NULL, config TEXT,
        PRIMARY KEY(id,role)) WITHOUT ROWID`),
      db.prepare('CREATE TABLE IF NOT EXISTS replay_turn_days(day INTEGER PRIMARY KEY,used INTEGER NOT NULL)'),
      db.prepare(`CREATE TRIGGER IF NOT EXISTS replay_clear_turn AFTER UPDATE OF ended ON replay_pairs WHEN NEW.ended=1 BEGIN
        DELETE FROM replay_turn_issues WHERE id=NEW.id; END`)
    ]);
    ready.set(db,result);
    try {await result;} catch(error) {ready.delete(db);throw error;}
  } else await ready.get(db);
}
function approvedServer(server) {
  const urls=(Array.isArray(server?.urls) ? server.urls : [server?.urls]).filter(url=>
    typeof url==='string' && /^(?:turn:turn\.cloudflare\.com:(?:3478|80|443)(?:\?transport=(?:udp|tcp))?|turns:turn\.cloudflare\.com:(?:5349|443)(?:\?transport=tcp)?)$/.test(url));
  if(!urls.length || typeof server.username!=='string' || typeof server.credential!=='string' ||
     !server.username.length || !server.credential.length || server.username.length>512 || server.credential.length>512) return null;
  return {urls:urls.slice(0,8),username:server.username,credential:server.credential};
}
export async function turnIceServers(env,db,id,role,now) {
  const key=env.REPLAY_TURN_KEY_ID, bearer=env.REPLAY_TURN_API_TOKEN;
  if(env.REPLAY_TURN_ENABLED!=='true' || typeof key!=='string' || !/^[a-zA-Z0-9_-]{12,80}$/.test(key) ||
     typeof bearer!=='string' || !bearer.length) return STUN;
  try {
    await ensureTurn(db);
    const cached=await db.prepare('SELECT config,expires FROM replay_turn_issues WHERE id=? AND role=?').bind(id,role).first();
    if(cached) return cached.config && cached.expires>now+10000 ? JSON.parse(cached.config) : STUN;
    const day=Math.floor(now/86400000), nonce=crypto.randomUUID();
    const [,reserve]=await db.batch([
      db.prepare('INSERT INTO replay_turn_days(day,used) VALUES(?,0) ON CONFLICT(day) DO NOTHING').bind(day),
      db.prepare(`INSERT INTO replay_turn_issues(id,role,nonce,expires)
        SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM replay_pairs WHERE id=? AND ended=0 AND expires>? AND phone_hash IS NOT NULL)
        AND EXISTS(SELECT 1 FROM replay_turn_days WHERE day=? AND used<?) ON CONFLICT(id,role) DO NOTHING`)
        .bind(id,role,nonce,now+TTL_SECONDS*1000,id,now,day,DAILY_CREDENTIALS),
      db.prepare('UPDATE replay_turn_days SET used=used+1 WHERE day=? AND EXISTS(SELECT 1 FROM replay_turn_issues WHERE id=? AND role=? AND nonce=?)').bind(day,id,role,nonce),
      db.prepare('DELETE FROM replay_turn_days WHERE day<?').bind(day-1)
    ]);
    if(!reserve.meta.changes) return STUN;
    const res=await fetch('https://rtc.live.cloudflare.com/v1/turn/keys/'+key+'/credentials/generate-ice-servers',{
      method:'POST',headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json'},
      redirect:'error',signal:AbortSignal.timeout(4500),body:JSON.stringify({ttl:TTL_SECONDS})
    });
    if(!res.ok || Number(res.headers.get('Content-Length'))>16384) {await res.body?.cancel();return STUN;}
    const raw=await res.text();
    if(raw.length>16384) return STUN;
    const entries=JSON.parse(raw).iceServers;
    if(!Array.isArray(entries)) return STUN;
    const relays=entries.slice(0,8).map(approvedServer).filter(Boolean);
    if(!relays.length) return STUN;
    const config={iceServers:[...STUN.iceServers,...relays],relayAvailable:true};
    const save=await db.prepare('UPDATE replay_turn_issues SET config=? WHERE id=? AND role=? AND nonce=? AND EXISTS(SELECT 1 FROM replay_pairs WHERE id=? AND ended=0)')
      .bind(JSON.stringify(config),id,role,nonce,id).run();
    return save.meta.changes ? config : STUN;
  } catch {return STUN;}
}
