import assert from 'node:assert/strict';
import {test} from 'node:test';
import {relayFrameAt,createRelayTimeline} from '../site/replay/multicam/relay-buffer.mjs';
import {AngleBuffer} from '../site/replay/multicam/clock.mjs';

test('low-rate relay playback holds each received picture until the next one',()=>{
  const frames=[1000,1200,1400,1600].map(time=>({time,receipt:true}));
  for(let time=1000;time<1600;time+=16){
    const selected=relayFrameAt(frames,time);
    assert(selected && selected.time<=time);
    assert.equal(selected,frames.findLast(frame=>frame.time<=time));
  }
  assert.equal(relayFrameAt(frames,999),null,'never show footage before it arrived');
  assert.equal(relayFrameAt(frames,2601),null,'do not conceal a stopped feed');
  assert.equal(relayFrameAt([],1200),null);
  assert.equal(relayFrameAt([{time:1000,receipt:false}],1100),null,'capture clocks keep their own policy');
});

test('the same captured moment keeps its source time as relay latency changes',()=>{
  const buffer=new AngleBuffer(),store=createRelayTimeline(buffer,1);
  const blob=new Blob(['picture']);
  for(const [capture,arrival] of [[1000,1500],[1200,1970],[1400,2600]]){
    const frame=store(blob,{time:capture,uncertainty:24},arrival);
    assert.equal(frame.time,capture);
    assert.equal(frame.arrival,arrival);
    assert.equal(frame.captureTimed,true);
  }
  assert.equal(relayFrameAt(buffer.frames,1220).time,1200);
  assert.equal(store(blob,{time:1190,uncertainty:24},2800),null,'duplicate/out-of-order stamp');
});

test('uncertain and legacy time never masquerade as capture time',()=>{
  const buffer=new AngleBuffer(),store=createRelayTimeline(buffer,1),blob=new Blob(['abc']);
  assert.equal(store(blob,null,2000).captureTimed,false);
  assert.equal(store(blob,{time:1700,uncertainty:500},2200).time,2200);
  const calibrated=store(blob,{time:1650,uncertainty:25},2350);
  assert.deepEqual(buffer.frames,[calibrated],'earlier-clock transition removes overlapping receipt history');
  assert.equal(buffer.bytes,blob.size);
  assert.equal(store(blob,null,2450),null,'one missing timestamp cannot disrupt calibrated history');
  const degraded=store(blob,null,3900);
  assert.equal(degraded.captureTimed,false);
  assert.notEqual(degraded.timingSegment,calibrated.timingSegment);
  const future=store(blob,{time:4400,uncertainty:25},4200);
  assert.equal(future.time,4200);
  assert.equal(future.captureTimed,false);
});
