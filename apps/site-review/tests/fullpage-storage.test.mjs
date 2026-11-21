import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash, webcrypto} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import worker from '../worker.js';
import {readCapture, storeCapture} from '../capture-storage.js';

globalThis.crypto ??= webcrypto;
const folder = mkdtempSync(join(tmpdir(),'fgs-full-pages-'));
after(() => rmSync(folder,{recursive:true,force:true}));
const filename = join(folder,'db.sqlite');
const schema = fileURLToPath(new URL('../schema.sql',import.meta.url));
const python = `import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.row_factory = sqlite3.Row
db.execute('PRAGMA foreign_keys=ON')
queries = json.load(sys.stdin)
results = []
with db:
 if queries is None:
  db.executescript(open(sys.argv[2], encoding='utf-8').read())
 else:
  for sql, args in queries:
   before = db.total_changes
   rows = [dict(r) for r in db.execute(sql, args)]
   results.append({'results':rows, 'meta':{'changes':db.total_changes-before}})
print(json.dumps(results))`;
function execute(queries) {
  const processResult = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['-X','utf8','-c',python,filename,schema],{input:JSON.stringify(queries),encoding:'utf8',maxBuffer:3*1024*1024});
  if (processResult.status !== 0) throw new Error(processResult.stderr);
  return JSON.parse(processResult.stdout);
}
function statement(sql,args=[]) {
  return {sql,args,bind:(...args) => statement(sql,args),run:async () => execute([[sql,args]])[0],
    first:async () => execute([[sql,args]])[0].results[0] || null};
}
execute(null);
const DB = {prepare:statement, batch:async queries => execute(queries.map(({sql,args}) => [sql,args]))};
const env = {DB};
const origin = 'https://review.example.com';
function request(path, method = 'GET', body, owner) {
  return worker.fetch(new Request(origin + path,{method, headers:{'Content-Type':'application/json',
    ...(owner ? {Authorization:'Bearer ' + owner} : {})},body:body && JSON.stringify(body)}),env);
}
async function board(host = 'example.com') {
  const created = await (await request('/api/reviews','POST',{url:host})).json();
  const path = '/api/reviews/' + created.review.id;
  const response = await (await request(path)).json();
  return {path,reviewId:created.review.id,pageId:response.pages[0].id,owner:created.ownerPath.split('#owner=')[1]};
}
const jpeg = readFileSync(new URL('mobile-preview.jpg',import.meta.url));
function dataUrl(bytes) { return 'data:image/jpeg;base64,' + bytes.toString('base64'); }
function withComments(image, count) {
  // Insert legal JPEG comment segments after SOI, without changing the image.
  const comment = Buffer.alloc(60004,65);
  comment.set([255,254,0xea,0x62]);
  return Buffer.concat([image.subarray(0,2),...Array(count).fill(comment),image.subarray(2)]);
}
const top = dataUrl(jpeg), bottom = dataUrl(withComments(jpeg,1));
const large = withComments(jpeg,24);
const largeUrl = dataUrl(large);
const opts = {maxCount:10,maxBytes:200*1024*1024,hash:async value => createHash('sha256').update(value).digest('hex')};

test('large JPEGs migrate an original database lazily and round-trip as one image across storage parts', async () => {
  execute([['DROP TABLE capture_image_parts',[]]]);
  const {path,pageId} = await board();
  const body = {pageId,label:'Full page · Chrome',dataUrl:largeUrl};
  const stored = await request(path + '/captures','POST',body);
  assert.equal(stored.status,201);
  const {capture} = await stored.json();
  assert.equal(capture.width,390);
  assert.equal(capture.tiles,undefined);
  assert.equal(capture.layout,undefined);
  const row = await DB.prepare('SELECT byte_length FROM captures WHERE id=?').bind(capture.id).first();
  assert.equal(row.byte_length,large.length);
  const parts = await DB.prepare('SELECT COUNT(*) n, MAX(LENGTH(image_data)) largest FROM capture_image_parts WHERE capture_id=?')
    .bind(capture.id).first();
  assert(parts.n > 1 && parts.largest <= 1024*1024);
  assert.equal((await request(capture.imageUrl,'HEAD')).headers.get('Content-Length'),String(large.length));
  assert.deepEqual(Buffer.from(await (await request(capture.imageUrl)).arrayBuffer()),large);
  assert.equal((await request(path + '/captures','POST',body)).status,200);
});

test('tile URLs are ordered, isolated by review and active invite, counted as one capture and visible in the board', async () => {
  const {path,pageId,owner} = await board();
  const second = await board();
  const body = {pageId,label:'Full page · Chrome',tiles:[{dataUrl:top},{dataUrl:bottom}]};
  const upload = await request(path + '/captures','POST',body);
  assert.equal(upload.status,201);
  const {capture} = await upload.json();
  assert.equal(capture.height,1688);
  assert.equal(capture.tiles.length,2);
  const onBoard = await (await request(path)).json();
  assert.deepEqual(onBoard.captures,[capture]);
  const repeat = await (await request(path + '/captures','POST',body)).json();
  assert.equal(repeat.capture.id,capture.id);
  assert.deepEqual(Buffer.from(await (await request(capture.tiles[0].imageUrl)).arrayBuffer()),jpeg);
  assert.deepEqual(Buffer.from(await (await request(capture.tiles[1].imageUrl)).arrayBuffer()),withComments(jpeg,1));
  assert.equal((await request(capture.imageUrl+'?tile=2')).status,404);
  assert.equal((await request(capture.imageUrl+'?tile=-1')).status,404);
  assert.equal((await request(second.path + '/captures/' + capture.id + '/image?tile=0')).status,404);
  const row = await DB.prepare('SELECT count(*) n,sum(byte_length) bytes FROM captures WHERE page_id=?').bind(pageId).first();
  assert.deepEqual(row,{n:1,bytes:jpeg.length+withComments(jpeg,1).length});
  await request(path+'/rotate-invite','POST',{},owner);
  assert.equal((await request(capture.tiles[1].imageUrl)).status,404);
});

test('a failed part rolls back every new pixel and metadata row; capacity failures and invalid stacks leave no rows', async () => {
  const {reviewId,pageId} = await board();
  const body = {tiles:[{dataUrl:top},{dataUrl:bottom}]};
  const store = async (data,limits=opts) => storeCapture(DB,reviewId,pageId,'Rollback test',readCapture(data),limits);
  const before = await DB.prepare('SELECT count(*) n FROM capture_image_parts').first();
  await DB.prepare("CREATE TRIGGER fail_part BEFORE INSERT ON capture_image_parts WHEN NEW.tile_index=1 BEGIN SELECT RAISE(ABORT,'forced part failure'); END").run();
  await assert.rejects(store(body),/forced part failure/);
  await DB.prepare('DROP TRIGGER fail_part').run();
  await assert.rejects(store(body,{...opts,maxBytes:1}),error => error.status === 409);
  await assert.rejects(store({...body,dataUrl:top}),error => error.status === 400);
  await assert.rejects(store({tiles:Array(25).fill({dataUrl:top})}),error => error.status === 400);
  await assert.rejects(store({tiles:[{dataUrl:largeUrl}]}),error => error.status === 413);
  const pixels = await DB.prepare('SELECT count(*) n FROM capture_image_parts').first();
  const captures = await DB.prepare('SELECT count(*) n FROM captures WHERE review_id=?').bind(reviewId).first();
  assert.deepEqual(pixels,before);
  assert.equal(captures.n,0);
});

test('guest captures follow the same-site page URL and leave the board alone for an invalid image or address', async () => {
  const {path,pageId} = await board();
  const post = (url,dataUrl=top) => request(path+'/captures','POST',{pageId,url,label:'Phone',dataUrl});
  assert.equal((await post('https://example.com/missing','broken image')).status,400);
  assert.equal((await post('https://unrelated.example/path')).status,400);
  assert.equal((await (await request(path)).json()).pages.length,1);
  const first = await post('https://example.com/shop#selection');
  assert.equal(first.status,201);
  const {page,capture} = await first.json();
  assert.equal(page.url,'https://example.com/shop');
  assert.equal(capture.pageId,page.id);
  assert.notEqual(page.id,pageId);
  const retry = await post('https://example.com/shop');
  assert.equal(retry.status,200);
  const same = await retry.json();
  assert.equal(same.capture.id,capture.id);
  assert.equal(same.page.id,page.id);
  assert.equal((await (await request(path)).json()).pages.length,2);
});

test('automatic full-page capture records its actual address and caches independently from viewport captures', async () => {
  const {path,pageId} = await board('www.fernandezgrowthsystems.com');
  const renders = [];
  env.FGS_CAPTURE = {async fetch(_,init) {
    const payload = JSON.parse(init.body);
    renders.push([payload.pageUrl,payload.fullPage]);
    return new Response(jpeg,{headers:{'Content-Type':'image/jpeg','X-FGS-Capture-Scope':payload.fullPage ? 'full-page' : 'viewport'}});
  }};
  try {
    const address = 'https://www.fernandezgrowthsystems.com/tools';
    const take = fullPage => request(path+'/auto-captures','POST',{pageId,url:address,device:'mobile',fullPage});
    const first = await take(true);
    assert.equal(first.status,201);
    const full = await first.json();
    assert.equal(full.page.url,address);
    assert.equal(full.capture.pageId,full.page.id);
    assert.equal(full.capture.label,'Full page · Mobile');
    const cached = await take(true);
    assert.equal(cached.status,200);
    assert.equal((await cached.json()).capture.id,full.capture.id);
    // Advance the local fixture past the browser service's cooldown for a fresh capture.
    await DB.prepare("UPDATE capture_attempts SET attempted_at=attempted_at-12").run();
    const viewport = await take(false);
    assert.equal(viewport.status,201);
    assert.notEqual((await viewport.json()).capture.id,full.capture.id);
    assert.deepEqual(renders,[[address,true],[address,false]]);
  } finally { delete env.FGS_CAPTURE; }
});
