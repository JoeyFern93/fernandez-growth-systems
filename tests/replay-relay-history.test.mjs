import assert from 'node:assert/strict';
import {test} from 'node:test';
import {relayFrameAt} from '../site/replay/multicam/relay-buffer.mjs';

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
