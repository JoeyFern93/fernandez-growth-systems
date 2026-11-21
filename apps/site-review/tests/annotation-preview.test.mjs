import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attributes = {}; this.style = {}; this.dataset = {};
  }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this.attributes[key] = value; }
  cloneNode() { const copy = new Element(this.tag); copy.attributes = {...this.attributes}; return copy; }
}
const source = await readFile(new URL('../public/annotation-preview.js', import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(source, {window, document: {
  createElement:tag => new Element(tag),
  createElementNS:(_, tag) => new Element(tag)
}});
const render = window.fgsAnnotationPreview;

test('drawn screenshot notes render the original strokes over the saved image, including separate dots', () => {
  const note = {context:{annotation:{kind:'draw',width:800,height:400,
    strokes:[[[0,0],[0.25,0.5],[1,1]],[[0.75,0.25]]]}}};
  const proof = render(note, {width:800,height:400,imageUrl:'/api/reviews/invite/captures/id/image'});
  assert.equal(proof.dataset.kind, 'draw');
  const [image, svg] = proof.children[0].children;
  assert.equal(image.src,'/api/reviews/invite/captures/id/image');
  assert.equal(svg.attributes.viewBox,'0 0 800 400');
  assert.equal(svg.children[1].attributes.d,'M0 0 L200 200 L800 400');
  assert.equal(svg.children[2].attributes.cx,'600');
  assert.equal(svg.children[2].attributes.cy,'100');
  assert.match(proof.children[1].textContent,/Screenshot/);
});

test('live viewport and preexisting screenshot pins retain edge coordinates and the correct context', () => {
  const note = {context:{annotation:{kind:'point',width:640,height:480,point:[0,1]},scrollY:350}};
  const proof = render(note, null);
  assert.equal(proof.children[0].children.length,1);
  assert.equal(proof.children[0].children[0].children[0].attributes.cy,'480');
  assert.match(proof.children[1].textContent,/Viewport outline.*0% across, 100% down.*350 px down/);
  const legacy = render({x:0, y:0, context:{}}, {width:100,height:300,imageUrl:'/shot'});
  assert.equal(legacy.dataset.kind,'point');
  assert.equal(legacy.children[0].children[0].children[1].children[0].attributes.cx,'0');
  assert.equal(render({x:null,y:null,context:{}}, {width:100,height:100}),null);
  assert.equal(render({context:{mode:'page'}}, null),null);
});


test('tiled captures stack every saved image underneath the mark at the full document scale', () => {
  const proof = render({x:0.2,y:0.9,context:{}}, {width:200,height:2000,imageUrl:'/first',
    tiles:[{height:500,imageUrl:'/one'}, {height:1500,imageUrl:'/two'}]});
  const viewport = proof.children[0], [stack, svg] = viewport.children[0].children;
  assert.equal(viewport.className,'annotation-window');
  assert.deepEqual(stack.children.map(image => [image.src,image.style.height]), [['/one','25%'],['/two','75%']]);
  assert.equal(svg.attributes.viewBox,'0 0 200 2000');
  assert.equal(svg.children[0].attributes.cy,'1800');
});
