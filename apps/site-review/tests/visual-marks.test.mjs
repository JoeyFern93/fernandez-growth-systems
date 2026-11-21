import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../public/visual-marks.js',import.meta.url),'utf8');
function fixture() {
  const box={left:0,top:-1600,bottom:1400,width:390,height:3000};
  let surface, selected, finished;
  function element(tag) {
    const listeners={};
    return {tag, style:{}, dataset:{}, children:[], classList:{add(){}}, isConnected:false,
      addEventListener(type,fn){listeners[type]=fn;},
      fire(type,values){listeners[type]({type,preventDefault(){},...values});},
      append(...nodes){for(const node of nodes){this.children.push(node);node.isConnected=true;}},
      replaceChildren(...nodes){this.children=[];this.append(...nodes);},
      remove(){this.isConnected=false;},setAttribute(){},focus(){},scrollIntoView(){},setPointerCapture(){},
      closest(){return {getBoundingClientRect:()=>({top:0,bottom:800})};},
      getBoundingClientRect:()=>box};
  }
  const window={};
  const document={createElement:tag=>{const item=element(tag);if(tag==='div')surface=item;return item;},
    createElementNS:(_,tag)=>element(tag)};
  runInNewContext(source,{window,document});
  const editor=window.FGSVisualMarks.editor({point:(...point)=>{selected=point;},
    finish:()=>{finished=JSON.parse(JSON.stringify(editor.geometry()));},changed(){},announce(){}});
  const size={width:390,height:3000};
  return {surface,editor,begin:(mode,keyboard=false)=>editor.begin(element('section'),mode,size,keyboard),
    selected:()=>selected,finished:()=>finished};
}
test('mobile points and drawings use full-image coordinates after scrolling',()=>{
  const h=fixture();h.begin('point');
  h.surface.fire('click',{clientX:195,clientY:800,detail:1});
  assert.deepEqual(h.selected(),[.5,.8]);
  h.begin('draw');
  const pointer={isPrimary:true,button:0,pointerId:3,clientX:78,clientY:500};
  h.surface.fire('pointerdown',pointer);
  h.surface.fire('pointermove',{...pointer,clientX:195,clientY:650});
  h.surface.fire('pointerup',{...pointer,clientX:234,clientY:800});
  assert.deepEqual(JSON.parse(JSON.stringify(h.editor.geometry().strokes)),[[[.2,.7],[.5,.75],[.6,.8]]]);
  h.editor.undo();assert.equal(h.editor.geometry().strokes.length,0);
});
test('keyboard drawing and point selection start in the visible part of a tall screenshot',()=>{
  const h=fixture();h.begin('draw',true);
  const press=key=>h.surface.fire('keydown',{key});
  press(' ');press('ArrowRight');press('ArrowDown');press(' ');press('Enter');
  assert.deepEqual(h.finished().strokes,[[[.5,.6667],[.51,.6667],[.51,.6767]]]);
  h.begin('point',true);press('ArrowLeft');press('Enter');
  assert.deepEqual(h.selected(),[.49,.6667]);
});
