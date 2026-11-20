import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const script = await readFile(new URL('../public/companion.js',import.meta.url),'utf8');

function mockBrowser() {
  const elements = [];
  function element(tag) {
    const node = {tag, children:[], events:{}, attrs:{},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute(key,value) { this.attrs[key] = value; },
      addEventListener(key,callback) { this.events[key] = callback; },
      focus() { this.focused = true; }
    };
    elements.push(node);
    return node;
  }
  const document = {documentElement:{lang:'en'},head:element('head'),body:element('body'),createElement:element};
  const popup = {document, addEventListener(){},focus(){},close(){this.closed=true;}};
  const window = {isSecureContext:true};
  window.top = window;
  vm.runInNewContext(script,{window,document,URL,crypto:{randomUUID}});
  let opens = 0;
  function enable() {
    window.documentPictureInPicture = {requestWindow(){ opens++; return Promise.resolve(popup); }};
  }
  return {window,enable,app:window.FGSReviewCompanion,elements,get opens(){ return opens; }};
}

test('floating notes require support, a top-level window and explicit open', async () => {
  const b = mockBrowser();
  assert.equal(b.app.available(),false);
  b.enable();
  assert.equal(b.app.available(),true);
  assert.equal(b.opens,0);
  b.window.top = {};
  assert.equal(b.app.available(),false);
  await assert.rejects(b.app.open({pageId:'p',pageUrl:'https://example.org/',saveNote(){}}),/unavailable/);
  assert.equal(b.opens,0);
});

test('floating editor opens the website separately and saves a scoped, retryable guest note', async () => {
  const b = mockBrowser();
  b.enable();
  const notes = [];
  const opts = {pageId:'p1',pageUrl:'https://example.org/start',reviewerName:'Test',async saveNote(payload) {
    notes.push(payload);
    if (notes.length===1) throw Error('Offline');
  }};
  const opening = b.app.open(opts);
  assert.equal(b.opens,1);
  await opening;
  await b.app.open(opts);
  assert.equal(b.opens,1);
  assert.equal(notes.length,0);
  const link = b.elements.find(n=>n.tag==='a');
  assert.equal(link.href,opts.pageUrl);
  assert.equal(link.rel,'noopener noreferrer');
  assert.equal(link.target,'_blank');
  const [name,url] = b.elements.filter(n=>n.tag==='input');
  const feedback = b.elements.find(n=>n.tag==='textarea');
  const form = b.elements.find(n=>n.tag==='form');
  const error = b.elements.find(n=>n.attrs.role==='alert');
  const status = b.elements.find(n=>n.attrs.role==='status');
  const submit = () => form.events.submit({preventDefault(){}});
  assert.equal(name.value,'Test');
  feedback.value = 'Fix the heading.';
  url.value = 'https://unrelated.example/info';
  await submit();
  assert.match(error.textContent,/example.org/);
  assert.equal(notes.length,0);
  url.value = '/services?private=value#location';
  await submit();
  assert.equal(error.textContent,'Offline');
  assert.equal(feedback.value,'Fix the heading.');
  await submit();
  assert.equal(notes.length,2);
  assert.equal(notes[0].clientId,notes[1].clientId);
  assert.deepEqual(Object.keys(notes[1]).sort(),['clientId','name','pageId','pageUrl','text']);
  assert.equal(notes[1].pageUrl,'https://example.org/services');
  assert.equal(notes[1].pageId,'p1');
  assert.equal(feedback.value,'');
  assert.match(status.textContent,/saved/);
  url.value = '';
  name.value = '';
  feedback.value = 'A separate note.';
  await submit();
  assert.notEqual(notes[1].clientId,notes[2].clientId);
  assert.equal(notes[2].pageUrl,opts.pageUrl);
  assert.equal(notes[2].name,'Guest');
});
