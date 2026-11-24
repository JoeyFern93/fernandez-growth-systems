import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createClockEstimate,startRelayClock} from '../site/replay/multicam/relay-clock.mjs';

test('different monotonic origins align to the same motion despite skewed network legs and database time',()=>{
  const epoch=1_700_000_000_000;
  const phoneOrigin=epoch-2000,displayOrigin=epoch-830000;
  let trueTime=epoch+1200;
  const phone=createClockEstimate(()=>trueTime-phoneOrigin);
  const display=createClockEstimate(()=>trueTime-displayOrigin);
  function read(clock,origin,start,up,work,down) {
    return clock.observe(start-origin,start+up,start+up+work,start+up+work+down-origin);
  }
  for(const clock of [[phone,phoneOrigin],[display,displayOrigin]]) {
    read(...clock,epoch,120,35,5);
    read(...clock,epoch+220,4,67,110);
  }
  const capture=trueTime-50;
  const shared=phone.toServer(capture-phoneOrigin);
  const recovered=display.toLocal(shared.time);
  assert(Math.abs(recovered.time-(capture-displayOrigin))<=shared.uncertainty+recovered.uncertainty);
  assert(shared.uncertainty+recovered.uncertainty<25);
  // Even close readings disqualify after calibration ages out.
  trueTime+=61000;
  assert.equal(phone.toServer(trueTime-phoneOrigin),null);
  assert.equal(display.toLocal(shared.time),null);
});

test('outliers cannot claim sync and a reference clock step drops previous offsets',()=>{
  let now=3000;
  const clock=createClockEstimate(()=>now);
  assert.equal(clock.observe(1,10,9,12),false);
  assert.equal(clock.observe(100,500,515,1600),false);
  assert.equal(clock.toLocal(2000),null);
  assert(clock.observe(2000,10000,10010,2030));
  assert(clock.observe(2500,30000,30003,2509));
  const mapped=clock.toServer(3000);
  assert(Math.abs(mapped.time-30500)<10);
  assert.equal(clock.toServer(NaN),null);
});

test('calibration uses only authenticated read-only status requests and aborts the run',async t=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    calls.push({url,options});
    const now=Date.now();
    return Response.json({serverReceivedAt:now,serverSentAt:now});
  });
  const controller=new AbortController();
  const clock=startRelayClock({origin:'https://example.test/api/replay-pair',id:'my-room',token:'device',signal:controller.signal});
  try {
    assert.equal(await clock.ready,true);
    assert(clock.toServer(performance.now()));
    assert.equal(calls.length,1);
    const [{url,options}]=calls;
    assert.equal(url,'https://example.test/api/replay-pair/my-room/relay');
    assert.equal(options.method,'GET');
    assert.equal(options.headers.Authorization,'Bearer device');
    assert.equal(options.redirect,'error');
    assert.equal(options.body,undefined);
  } finally {controller.abort();}
  await new Promise(r=>setTimeout(r,125));
  assert.equal(calls.length,1);
});
