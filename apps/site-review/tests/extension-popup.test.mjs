import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';

const source = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
const guestLink = 'https://sitereview.fernandezgrowthsystems.com/example.com/test-invite';
const imageLink = guestLink + '#shot=saved-image';

function mount({status, shareLink = imageLink, allowCopy = true} = {}) {
  const messages = [];
  const copies = [];
  const nodes = new Map();
  let closed = false;
  for (const match of html.matchAll(/<(\w+)\b[^>]*?\bid="([^"]+)"[^>]*>/g)) {
    const [,tag,id] = match;
    nodes.set(id, {
      tag, textContent:'', hidden:match[0].includes(' hidden'), value:'',
      addEventListener(_name, fn) { this.click = fn; },
      focus() { this.focused = true; },
      select() { this.selected = true; },
      removeAttribute(key) { delete this[key]; },
      querySelector() { return null; }
    });
  }
  const defaults = {ok:true, host:'example.com', hasReview:true, reviewerUrl:guestLink};
  const replies = {
    status:status || defaults,
    capture:{ok:true, captureKey:'local-key', dataUrl:'data:image/jpeg;base64,YQ==', host:'example.com',path:'/services'},
    'share-capture':{ok:true, reviewerUrl:shareLink}, 'discard-capture':{ok:true},
    'connect-review':{ok:true}, 'open-connected-site':{ok:true}
  };
  const document = {
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
  assert.deepEqual(popup.messages.map(m=>m.type), ['status','connect-review','open-connected-site']);
  assert.equal(popup.closed(), true);
});
