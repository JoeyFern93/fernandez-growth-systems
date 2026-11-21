import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const publicFile = name => new URL('../public/' + name, import.meta.url);
const script = await readFile(publicFile('install.js'),'utf8');

function browser({path = '/', display = false, standalone = false, ua = 'Chrome/130', install} = {}) {
  const events = new Map();
  const on = (name, fn) => events.set(name, fn);
  const button = {hidden:true};
  const nodes = [];
  function createElement(tag) {
    const node = {tag, append(){}, setAttribute(){}, addEventListener(){}, showModal(){this.open=true;}};
    nodes.push(node);
    return node;
  }
  const document = {readyState:'complete', querySelector:()=>button, addEventListener:on, createElement, body:createElement('body')};
  const window = {isSecureContext:true, addEventListener:on, matchMedia:()=>({matches:display, addEventListener(){}})};
  window.top=window;
  vm.runInNewContext(script, {location:new URL('https://sitereview.example'+path), window, document,
    navigator:{standalone, userAgent:ua, install}});
  return {button, nodes, events, click:()=>events.get('click')?.({target:{closest:()=>button}}),
    offer(prompt) {events.get('beforeinstallprompt')?.({prompt, preventDefault(){}});}};
}

test('home offers the native action only while a usable installation prompt exists', async () => {
  const b = browser();
  assert.equal(b.button.textContent,'How to install');
  assert.equal(b.button.hidden,false);
  let calls = 0;
  b.offer(async()=>{calls++;return {outcome:'dismissed'};});
  assert.equal(b.button.textContent,'Install Site Review');
  await b.click();
  assert.equal(calls,1);
  assert.equal(b.button.textContent,'How to install');
  b.offer(async()=>{throw Error('Prompt expired');});
  await b.click();
  assert.equal(b.button.textContent,'How to install');
  assert.equal(b.nodes.some(n=>n.open),false);
  b.offer(async()=>({outcome:'accepted'}));
  await b.click();
  assert.equal(b.button.hidden,true);
});

test('a supported self-install runs in the click handler, deferring to an existing prompt; policy failure offers help', async () => {
  let calls = 0;
  const b=browser({install(...args){assert.equal(args.length,0); calls++; return Promise.resolve({});}});
  assert.equal(b.button.textContent,'Install Site Review');
  b.offer(async()=>({outcome:'dismissed'}));
  await b.click();
  assert.equal(calls,0);
  const action=b.click();
  assert.equal(calls,1);
  await action;
  assert.equal(b.button.hidden,true);
  const policy=browser({async install(){throw new DOMException('Forbidden','NotAllowedError');}});
  await policy.click();
  assert.equal(policy.button.textContent,'How to install');
  const dismissed=browser({async install(){throw new DOMException('Cancelled','AbortError');}});
  await dismissed.click();
  assert.equal(dismissed.button.textContent,'Install Site Review');
});

test('help opens device-specific menu instructions and installed or private pages have no install action', async () => {
  for (const [ua,wording] of [['iPhone','Open as Web App'], ['Android','Install and create shortcut']]) {
    const b=browser({ua});
    await b.click();
    assert.equal(b.nodes.find(n=>n.tag==='dialog').open,true);
    assert.ok(b.nodes.some(n=>n.textContent?.includes(wording)));
  }
  const current=browser();
  current.events.get('appinstalled')();
  assert.equal(current.button.hidden,true);
  for (const state of [{standalone:true}, {display:true}, {path:'/client.com/invite'}, {path:'/#owner=secret'}, {path:'/?site=x'}]) {
    const b=browser(state);
    assert.equal(b.button.hidden,true);
    await b.click();
    assert.equal(b.nodes.some(n=>n.tag==='dialog'),false);
  }
});

test('install images resolve at their advertised sizes with the existing app identity', async () => {
  const manifest=JSON.parse(await readFile(publicFile('site-review.webmanifest')));
  assert.equal(manifest.id,'/');
  assert.equal(manifest.start_url,'/');
  const html=await readFile(publicFile('index.html'),'utf8');
  assert.match(html,/data-install-review hidden>How to install/);
  const touch=html.match(/rel="apple-touch-icon" sizes="180x180" href="([^"]+)"/)[1];
  for (const {src,sizes} of [...manifest.icons,{src:touch,sizes:'180x180'}]) {
    const bytes=await readFile(publicFile(src.slice(1)));
    assert.equal(bytes.toString('ascii',1,4),'PNG');
    assert.equal(bytes.readUInt32BE(16)+'x'+bytes.readUInt32BE(20),sizes);
  }
});
