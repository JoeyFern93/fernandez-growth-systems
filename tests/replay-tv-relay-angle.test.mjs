import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {test} from 'node:test';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

globalThis.crypto??=webcrypto;
const api='https://relay.test/api/replay-pair';
globalThis.location=new URL('https://display.test/replay/multicam/');
globalThis.window={FGSReplayPairEndpoint:api};
const site=process.env.REPLAY_SITE_ROOT || fileURLToPath(new URL('../site/',import.meta.url));
const {startRelayAngle}=await import(pathToFileURL(path.resolve(site,'replay/multicam/relay-angle.mjs')));
const id='r'.repeat(22),invite='i'.repeat(43),mime='video/webm';
const room={id,invite,expiresAt:Date.now()+60000};

function deferred() {
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {resolve,reject,promise};
}

test('relay retries a lost frame receipt without replacing the room or decoder', async t=>{
  const calls=[],pictures=[],ready=deferred(),displayed=deferred(),confirmed=deferred();
  let decoded,claimed=0,decoders=0,receipts=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const data=options.body && JSON.parse(options.body);
    calls.push({url,method:options.method,data});
    if(url===api)return Response.json(room);
    if(url===api+'/'+id)return Response.json({status:'paired'});
    if(url.endsWith('/relay')&&options.method==='GET'){
      const now=Date.now();
      return Response.json({status:'active',mimeType:mime,expiresAt:room.expiresAt,serverReceivedAt:now,serverSentAt:now});
    }
    if(data?.state==='relay-moving') {
      if(++receipts===1)return Response.json({error:'Temporary service error'},{status:503});
      confirmed.resolve();
    }
    return Response.json({});
  });
  window.FGSReplayRelay={
    receiveFormats:()=>[mime],
    async receive(session) {
      decoders++;
      decoded=session;
      session.onStream({}).catch(session.onError);
      await new Promise(resolve=>session.signal.addEventListener('abort',resolve,{once:true}));
    }
  };
  const cancel=new AbortController();
  const stop=startRelayAngle({cameraId:'2',signal:cancel.signal,onInvite:link=>ready.resolve(new URL(link)),
    onClaimed:()=>claimed++,onStream:async()=>displayed.promise,onPicture:(_frame,stamp)=>pictures.push(stamp),
    onStatus:()=>{},onError:error=>assert.fail(error)});
  const link=await ready.promise;
  const params=new URLSearchParams(link.hash.slice(1));
  assert.equal(link.origin,location.origin);
  assert.equal(params.get('pair'),id+'.'+invite);
  assert.equal(params.get('transport'),'relay');
  assert.equal(params.get('sync'),'1');
  assert.equal(params.get('camera'),'2');
  while(!decoded)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(claimed,1);
  assert.equal(decoded.key,params.get('key'));
  assert.equal(decoded.timed,true);
  assert.equal(calls.some(c=>c.data?.state==='relay-moving'),false);
  displayed.resolve();
  await confirmed.promise;
  decoded.onPicture({},null);
  assert.equal(pictures.at(-1),null,'Legacy pictures have no capture timestamp');
  decoded.onPicture({},{time:Date.now(),uncertainty:5,estimated:true});
  assert(Math.abs(pictures.at(-1).time-performance.now())<150);
  assert(pictures.at(-1).uncertainty>=5);
  assert.equal(pictures.at(-1).estimated,true);
  assert.equal(decoders,1);
  assert.equal(receipts,2);
  assert.equal(calls.filter(c=>c.url===api).length,1);
  assert.equal(calls.some(c=>c.data?.purpose || c.url.endsWith('/offer')),false);
  cancel.abort();
  await stop();
  assert.equal(decoded.signal.aborted,true);
  assert.equal(calls.filter(c=>c.url.endsWith('/end')).length,1);
  assert.equal(calls.some(c=>JSON.stringify(c).includes(params.get('key'))),false,'keep the video key on the devices');
});

test('closing a relay while its receipt is being retried does not send another receipt',async t=>{
  const firstReceipt=deferred(),decoderStopped=deferred(),roomEnded=deferred();
  let receives=0,receipts=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const data=options.body && JSON.parse(options.body);
    if(url===api)return Response.json(room);
    if(url===api+'/'+id)return Response.json({status:'paired'});
    if(url.endsWith('/relay') && options.method==='GET')return Response.json({status:'active',mimeType:mime,expiresAt:room.expiresAt});
    if(data?.state==='relay-moving'){
      receipts++;firstReceipt.resolve();
      return Response.json({error:'Temporary service error'},{status:503});
    }
    if(url.endsWith('/end'))roomEnded.resolve();
    return Response.json({});
  });
  window.FGSReplayRelay={receiveFormats:()=>[mime],async receive(session){
    receives++;
    try{await session.onStream({});}finally{decoderStopped.resolve();}
  }};
  const cancel=new AbortController();
  startRelayAngle({cameraId:'1',signal:cancel.signal,onInvite:()=>{},onStream:async()=>{},onStatus:()=>{},onError:err=>assert.fail(err)});
  await firstReceipt.promise;cancel.abort();
  await Promise.all([decoderStopped.promise,roomEnded.promise]);
  assert.equal(receipts,1);
  assert.equal(receives,1);
});

test('a cancelled creation revokes a room returned late without exposing an invite',async t=>{
  const started=deferred(),created=deferred(),ended=deferred();
  t.mock.method(globalThis,'fetch',async url=>{
    if(url===api){started.resolve();await created.promise;return Response.json(room);}
    assert.equal(url,api+'/'+id+'/end');
    ended.resolve();
    return Response.json({});
  });
  window.FGSReplayRelay={receiveFormats:()=>[mime]};
  const cancel=new AbortController();
  startRelayAngle({cameraId:'1',signal:cancel.signal,onInvite:()=>assert.fail('stale invite'),onError:error=>assert.fail(error)});
  await started.promise;
  cancel.abort();
  created.resolve();
  await ended.promise;
});
