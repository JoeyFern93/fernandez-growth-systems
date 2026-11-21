import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';

const source = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
const guestLink = 'https://sitereview.fernandezgrowthsystems.com/example.com/test-invite';
const imageLink = guestLink + '#shot=saved-image';

function mount({status, shareLink = imageLink, allowCopy = true, reviews = [], captureResult} = {}) {
  const messages = [];
  const copies = [];
  const nodes = new Map();
  let closed = false;
  const createElement = tag => ({
      tag, textContent:'', hidden:false, value:'', children:[],
      addEventListener(_name, fn) { this.click = fn; },
      focus() { this.focused = true; },
      select() { this.selected = true; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      removeAttribute(key) { delete this[key]; },
      querySelector() { return null; }
  });
  for (const match of html.matchAll(/<(\w+)\b[^>]*?\bid="([^"]+)"[^>]*>/g)) {
    const [,tag,id] = match;
    const node = createElement(tag);
    node.hidden = match[0].includes(' hidden');
    nodes.set(id,node);
  }
  const defaults = {ok:true, host:'example.com', hasReview:true, reviewerUrl:guestLink};
  const replies = {
    status:status || defaults,
    capture:captureResult || {ok:true, captureKey:'local-key', dataUrl:'data:image/jpeg;base64,YQ==', host:'example.com',path:'/services'},
    'share-capture':{ok:true, reviewerUrl:shareLink}, 'discard-capture':{ok:true},
    'connect-review':{ok:true}, 'open-connected-site':{ok:true}, 'new-review':{ok:true},
    'list-reviews':{ok:true,reviews}, 'open-saved-review':{ok:true}, 'get-saved-reviewer-link':{ok:true,reviewerUrl:guestLink},
    'begin-feedback':{ok:true}, 'get-reviewer-link':{ok:true,reviewerUrl:guestLink}
  };
  const document = {
    createElement,
    getElementById:id => nodes.get(id),
    querySelectorAll:() => [...nodes.values()].filter(node => node.tag === 'button')
  };
  class ClipboardItem { constructor(data) { this.data = data; } }
  const clipboard = {
    async write(items) {
      if (!allowCopy) throw Error('Clipboard is unavailable');
      copies.push(await (await items[0].data['text/plain']).text());
    }
  };
  const chrome = {runtime:{async sendMessage(message) {
    messages.push(message);
    return replies[message.type];
  }}};
  runInNewContext(source, {document, chrome, navigator:{clipboard}, ClipboardItem, Blob, URL,
    window:{close() { closed = true; }, addEventListener() {}}});
  return {node:id => nodes.get(id), messages, copies, closed:() => closed};
}

test('screenshot stays local on preview and cancel, and explicit share copies only the confirmed guest image URL', async () => {
  const popup = mount();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(popup.node('home').hidden, false);
  await popup.node('capture').click();
  assert.equal(popup.node('preview').hidden, false);
  assert.equal(popup.node('capture-site').textContent, 'example.com/services');
  await popup.node('discard').click();
  assert.deepEqual(popup.messages.map(m => m.type), ['status','capture','discard-capture']);
  assert.equal(popup.node('preview-image').src, undefined);
  await popup.node('capture').click();
  await popup.node('share').click();
  assert.equal(popup.messages.at(-1).captureKey, 'local-key');
  assert.equal(popup.node('open-shot').href, imageLink);
  assert.equal(popup.node('shared').hidden, false);
  assert.deepEqual(popup.copies, [imageLink]);
});

test('read-only links remain usable when the clipboard denies permission', async () => {
  const popup = mount({allowCopy:false});
  await new Promise(resolve => setImmediate(resolve));
  await popup.node('copy-review').click();
  assert.equal(popup.node('manual').hidden, false);
  assert.equal(popup.node('manual-link').value, guestLink);
  await popup.node('capture').click();
  await popup.node('share').click();
  assert.equal(popup.node('share-link').value, imageLink);
  await popup.node('copy-shot').click();
  assert.equal(popup.node('share-link').selected, true);
});

test('private owner URLs can never appear in the guest clipboard or client link', async () => {
  const popup = mount({shareLink:guestLink + '#owner=test'});
  await new Promise(resolve => setImmediate(resolve));
  await popup.node('capture').click();
  await popup.node('share').click();
  assert.equal(popup.node('shared').hidden, true);
  assert.deepEqual(popup.copies, []);
  assert.equal(popup.node('open-shot').href, undefined);
  assert.match(popup.node('error').textContent, /reviewer link/);
});

test('a review invite offers a deliberate connection to its target site', async () => {
  const popup = mount({status:{ok:true, isReviewPage:true, host:'example.com'}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(popup.node('connect').hidden, false);
  await popup.node('connect-review').click();
  assert.deepEqual(popup.messages.map(m=>m.type), ['status','open-connected-site']);
  assert.equal(popup.closed(), true);
});

test('confirming a new round identifies the review the user chose to replace', async () => {
  const popup = mount();
  await new Promise(resolve => setImmediate(resolve));
  await popup.node('new-review').click();
  assert.equal(popup.messages.length, 1);
  await popup.node('confirm-new').click();
  const request = popup.messages.at(-1);
  assert.equal(request.type, 'new-review');
  assert.equal(request.previousReviewerUrl, guestLink);
});

test('first-time reviewer can enter the picker or copy an intentional invitation with one action', async () => {
  const popup = mount({status:{ok:true,host:'example.com',hasReview:false}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(popup.node('existing').hidden,true);
  await popup.node('copy-review').click();
  assert.deepEqual(popup.messages.map(m=>m.type),['status','get-reviewer-link']);
  assert.deepEqual(popup.copies,[guestLink]);
  assert.equal(popup.node('existing').hidden,false);
  await popup.node('start').click();
  assert.equal(popup.messages.at(-1).type,'begin-feedback');
  assert.equal(popup.closed(),true);
});

test('My reviews can find and open saved notes even from an unsupported tab', async () => {
  const popup = mount({status:{ok:false,error:'Open a website.'},
    reviews:[{id:'round',host:'example.com',current:true,isOwner:true,savedAt:0}]});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(popup.node('unavailable').hidden,false);
  assert.equal(popup.node('my-reviews').hidden,false);
  await popup.node('my-reviews').click();
  const [row] = popup.node('review-list').children;
  const [host,,buttons] = row.children;
  assert.equal(host.textContent,'example.com');
  assert.equal(popup.node('empty-shelf').hidden,true);
  await buttons.children[1].click();
  assert.deepEqual(popup.copies,[guestLink]);
  await buttons.children[0].click();
  assert.deepEqual(Array.from(popup.messages,m=>m.type),['status','list-reviews','get-saved-reviewer-link','open-saved-review']);
  assert.equal(popup.messages.at(-1).id,'round');
  assert.equal(popup.closed(),true);
});

test('tall full-page image stays in a scrollable preview until all tiles are explicitly shared', async () => {
  const tiles = [{dataUrl:'data:image/jpeg;base64,YQ=='},{dataUrl:'data:image/jpeg;base64,Yg=='}];
  const popup = mount({captureResult:{ok:true,captureKey:'full-key',area:'full',tiles,width:1200,height:9000,host:'example.com'}});
  await new Promise(resolve => setImmediate(resolve));
  popup.node('capture-area').value = 'full';
  await popup.node('capture').click();
  assert.equal(popup.messages.at(-1).area,'full');
  assert.equal(popup.node('preview-image').hidden,true);
  assert.deepEqual(Array.from(popup.node('tile-preview').children,img=>img.src),tiles.map(t=>t.dataUrl));
  await popup.node('share').click();
  assert.equal(JSON.stringify(popup.messages.at(-1).fullImage),JSON.stringify({tiles}));
  assert.equal(popup.node('tile-preview').children.length,0);
});
