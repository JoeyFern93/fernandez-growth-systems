import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';

const script = readFileSync(new URL('../public/review.js', import.meta.url), 'utf8');
const address = 'https://example.com/';
function storage() {
  const items = new Map();
  return {get length() { return items.size; }, key:i => [...items.keys()][i],
    getItem:k => items.get(k), setItem:(k,v) => items.set(k,v), removeItem:k => items.delete(k)};
}
function landing(fetch, localStorage, sessionStorage) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      dataset:{}, elements:{file:{},url:{}}, listeners:{}, children:[],
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      querySelector(selector) { return element(id + selector); },
      setAttribute() {}, removeAttribute() {}
    });
    return elements.get(id);
  }
  const document = {getElementById:element, createElement:() => element(Symbol()), querySelectorAll:() => [], addEventListener() {}};
  const location = {origin:'https://sitereview.fernandezgrowthsystems.com', pathname:'/', hash:'',
    assign(url) { this.destination = url; }};
  runInNewContext(script, {document, location, window:{addEventListener() {}},
    URL, URLSearchParams, crypto:webcrypto, localStorage, sessionStorage, fetch});
  return {
    submit(value) {
      const form = element('create');
      form.elements.url.value = value;
      return form.listeners.submit({preventDefault() {}});
    },
    demo:() => element('start-demo').onclick(), location, element
  };
}
test('web retries reuse a single private create request and completed submissions start distinct rounds', async () => {
  const local = storage(), session = storage();
  const bodies = [];
  const fetch = async (path, options) => {
    assert.equal(path,'/api/reviews');
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) throw Error('Server response interrupted');
    return Response.json({ownerPath:'/example.com/guest#owner=owner-only'});
  };
  const first = landing(fetch, local, session);
  await Promise.all([first.submit(address + '#private-fragment'), first.demo()]);
  assert.equal(bodies.length,1);
  assert.equal(bodies[0].url,address);
  assert.match(bodies[0].creationKey,/^[0-9a-f]{64}$/);
  const retry = landing(fetch, local, session);
  await retry.submit(address);
  assert.equal(bodies.length,2);
  assert.deepEqual(bodies[0],bodies[1]);
  assert.match(retry.location.destination,/#owner=owner-only$/);
  assert.equal(session.getItem('fgs-create-pending'),undefined);
  await landing(fetch, local, session).submit(address);
  assert.notEqual(bodies[1].creationKey,bodies[2].creationKey);
  assert.equal(bodies[1].creatorId,bodies[2].creatorId);
});
test('web retries work in memory when browser storage is unavailable', async () => {
  const blocked = {getItem() { throw Error('Private mode'); }, setItem() { throw Error('Private mode'); },
    removeItem() { throw Error('Private mode'); }};
  const bodies = [];
  const form = landing(async (path, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) throw Error('Offline');
    return Response.json({ownerPath:'/example.com/guest#owner=owner-only'});
  }, blocked, blocked);
  await form.submit(address);
  await form.submit(address);
  assert.deepEqual(bodies[0],bodies[1]);
  assert.match(form.location.destination,/#owner=/);
});

test('My reviews shows separate owner rounds and opens Notes or Share without creating another round', async () => {
  const local = storage(), session = storage();
  const host = 'example.com', owner = 'o'.repeat(43), firstId = 'a'.repeat(24), secondId = 'b'.repeat(24);
  let calls = 0;
  async function create() {
    const id = calls++ ? secondId : firstId;
    return Response.json({ownerPath:'/' + host + '/' + id + '#owner=' + owner,
      review:{id,host,role:'owner'}});
  }
  await landing(create,local,session).submit(address);
  await landing(create,local,session).submit(address);
  local.setItem('fgs-owned-review:bad','{');
  const home = landing(create,local,session);
  const rows = home.element('saved-review-list').children;
  assert.equal(rows.length,2);
  assert.equal(rows[0].children[0].children[0].textContent,host);
  const buttons = rows[0].children[1].children;
  assert.deepEqual(buttons.map(button=>button.textContent),['Open notes','Share']);
  assert(!buttons[0].href && !buttons[1].href);
  buttons[0].onclick();
  assert.match(home.location.destination,new RegExp('/' + host + '/[ab]{24}#owner=' + owner + '&panel=notes$'));
  buttons[1].onclick();
  assert.match(home.location.destination,/&panel=share$/);
  assert.equal(calls,2);
});
test('a guest role or an invalid private key cannot populate My reviews', async () => {
  const id = 'a'.repeat(24), local = storage(), session = storage();
  for (const [role, key] of [['reviewer','x'.repeat(43)], ['owner','invalid']]) {
    const form = landing(async () => Response.json({ownerPath:'/example.com/' + id + '#owner=' + key,
      review:{host:'example.com', id, role}}), local, session);
    await form.submit(address);
  }
  assert.equal(local.getItem('fgs-owned-review:' + id),undefined);
  assert.equal(landing(()=>{},local,session).element('saved-review-list').children.length,0);
});
