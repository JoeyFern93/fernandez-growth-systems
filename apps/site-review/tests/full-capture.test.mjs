import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';

const source = readFileSync(new URL('../extension/full-capture.js',import.meta.url),'utf8');
function captureFixture(height, fail = false) {
  const actions = [], canvases = [];
  let x = 0, y = 0;
  const width = 1000, viewHeight = 700;
  const size = () => ({x,y,width,height,viewWidth:width,viewHeight,innerWidth:width,innerHeight:viewHeight});
  const chrome = {scripting:{executeScript:async ({args:[action,,left,top]}) => {
    actions.push(action);
    if (action === 'move') { x = left; y = Math.min(top,height-viewHeight); }
    return [{result:size()}];
  }}};
  class Canvas {
    constructor(width,height) { this.width=width; this.height=height; this.draws=[]; canvases.push({height,draws:this.draws}); }
    getContext() {return {drawImage:(_bitmap,...rect) => this.draws.push(rect)};}
    async convertToBlob() {return new Blob(['local test image']);}
  }
  const ctx = {crypto:webcrypto,chrome,OffscreenCanvas:Canvas, btoa, fetch:async () => new Response('image'),
    createImageBitmap:async () => ({width,height:viewHeight,close(){}})};
  const fn = runInNewContext(source+'\nfullScreenshot',ctx);
  return {actions,canvases,run:() => fn({id:1},async () => {
    if (fail && y > 0) throw Error('Tab switched');
    return 'fixture-' + y;
  })};
}
test('full page crops its final clamped viewport and restores scroll before encoding', async () => {
  const f = captureFixture(3240);
  const result = await f.run();
  assert.equal(result.height,3240);
  assert.equal(result.width,1000);
  assert.match(result.dataUrl,/^data:image\/jpeg;base64,/);
  assert.equal(f.actions.at(-1),'restore');
  const draws = f.canvases[0].draws;
  assert.deepEqual(draws.map(d=>d[5]),[0,700,1400,2100,2800]);
  assert.deepEqual(draws.at(-1),[0,260,1000,440,0,2800,1000,440]);
});
test('long captures produce a complete vertical stack and failures restore the original page', async () => {
  const f = captureFixture(17500);
  const result = await f.run();
  assert.equal(result.height,17500);
  assert.deepEqual(Array.from(result.tiles,t=>t.height),[6000,6000,5500]);
  assert(f.canvases.every(c => c.draws.length));
  const cancelled = captureFixture(3240,true);
  await assert.rejects(cancelled.run(),/Tab switched/);
  assert.equal(cancelled.actions.at(-1),'restore');
  assert.equal(cancelled.canvases.length,0);
});
