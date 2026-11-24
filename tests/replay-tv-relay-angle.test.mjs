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

test('plain relay room acknowledges displayed video, then revokes only that slot', async t=>{
  const calls=[],ready=deferred(),displayed=deferred(),confirmed=deferred();
  let decoded,claimed=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const data=options.body && JSON.parse(options.body);
    calls.push({url,method:options.method,data});
    if(url===api)return Response.json(room);
    if(url===api+'/'+id)return Response.json({status:'paired'});
    if(url.endsWith('/relay')&&options.method==='GET')return Response.json({status:'active',mimeType:mime,expiresAt:room.expiresAt});
    if(data?.state==='relay-moving')confirmed.resolve();
    return Response.json({});
  });
  window.FGSReplayRelay={
    receiveFormats:()=>[mime],
    async receive(session) {
      decoded=session;
      session.onStream({}).catch(session.onError);
      await new Promise(resolve=>session.signal.addEventListener('abort',resolve,{once:true}));
    }
  };
  const cancel=new AbortController();
  const stop=startRelayAngle({cameraId:'2',signal:cancel.signal,onInvite:link=>ready.resolve(new URL(link)),
    onClaimed:()=>claimed++,onStream:async()=>displayed.promise,onStatus:()=>{},onError:error=>assert.fail(error)});
  const link=await ready.promise;
  const params=new URLSearchParams(link.hash.slice(1));
  assert.equal(link.origin,location.origin);
  assert.equal(params.get('pair'),id+'.'+invite);
  assert.equal(params.get('transport'),'relay');
  assert.equal(params.get('camera'),'2');
  while(!decoded)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(claimed,1);
  assert.equal(decoded.key,params.get('key'));
  assert.equal(calls.some(c=>c.data?.state==='relay-moving'),false);
  displayed.resolve();
  await confirmed.promise;
  assert.equal(calls.some(c=>c.data?.purpose || c.url.endsWith('/offer')),false);
  cancel.abort();
  await stop();
  assert.equal(decoded.signal.aborted,true);
  assert.equal(calls.filter(c=>c.url.endsWith('/end')).length,1);
  assert.equal(calls.some(c=>JSON.stringify(c).includes(params.get('key'))),false,'keep the video key on the devices');
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
