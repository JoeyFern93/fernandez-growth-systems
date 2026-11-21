import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {turnIceServers} from '../replay-turn.js';
globalThis.crypto??=webcrypto;

test('unconfigured TURN never contacts a provider; enabled issuance returns only approved short-lived ICE credentials',async()=>{
  const original=globalThis.fetch;let calls=0,cached=null,budget=0;
  const db={
    prepare(sql) {
      return {sql,args:[],bind(...args){return {...this,args};},
        first:async()=>cached,
        async run(){cached={config:this.args[0],expires:Date.now()+1200000};return {meta:{changes:1}};}};
    },
    async batch(queries) {
      const touched=queries.some(q=>q.sql.includes('INSERT INTO replay_turn_issues'));
      if(touched) budget++;
      return queries.map(()=>({meta:{changes:1}}));
    }
  };
  const config={REPLAY_TURN_KEY_ID:'0123456789abcdef',REPLAY_TURN_API_TOKEN:'private-test-key-never-send-to-peer'};
  globalThis.fetch=async(url,init)=>{
    calls++;assert.match(url,/^https:\/\/rtc\.live\.cloudflare\.com\//);
    assert.equal(init.redirect,'error');assert.equal(JSON.parse(init.body).ttl,1200);
    assert.equal(init.headers.Authorization,'Bearer '+config.REPLAY_TURN_API_TOKEN);
    return Response.json({iceServers:[{urls:['turns:turn.cloudflare.com:443?transport=tcp','turn:unrelated.example:80'],
      username:'temporary-user',credential:'temporary-password'}]});
  };
  try {
    assert.equal((await turnIceServers(config,db,'id','tv',Date.now())).relayAvailable,false);
    assert.equal(calls,0);config.REPLAY_TURN_ENABLED='true';
    const data=await turnIceServers(config,db,'id','tv',Date.now());assert.equal(data.relayAvailable,true);
    assert.deepEqual(data.iceServers[1].urls,['turns:turn.cloudflare.com:443?transport=tcp']);
    assert(!JSON.stringify(data).includes(config.REPLAY_TURN_API_TOKEN));assert(!JSON.stringify(data).includes(config.REPLAY_TURN_KEY_ID));
    assert.deepEqual(await turnIceServers(config,db,'id','tv',Date.now()),data);
    assert.equal(budget,1);assert.equal(calls,1);
  } finally {globalThis.fetch=original;}
});
