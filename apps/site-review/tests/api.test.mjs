import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash, webcrypto} from "node:crypto";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {after, test} from "node:test";
import worker from "../worker.js";

globalThis.crypto ??= webcrypto;
const temp = mkdtempSync(join(tmpdir(), "site-review-test-"));
after(() => rmSync(temp, {recursive: true, force: true}));
const schema = fileURLToPath(new URL("../schema.sql", import.meta.url));
const python = [
  "import sys, json, sqlite3",
  "db = sqlite3.connect(sys.argv[1]); db.row_factory = sqlite3.Row",
  "db.execute('PRAGMA foreign_keys = ON')",
  "jobs = json.load(sys.stdin); out = []",
  "if jobs is None: db.executescript(open(sys.argv[2]).read())",
  "else:",
  " for job in jobs:",
  "  before = db.total_changes",
  "  cur = db.execute(job['sql'], job['args'])",
  "  rows = [dict(r) for r in cur.fetchall()]",
  "  out.append({'results': rows, 'meta': {'changes': db.total_changes-before}})",
  "db.commit(); print(json.dumps(out))"
].join("\n");
function execute(jobs) {
  const result = spawnSync(process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"),
    ["-c", python, join(temp, "reviews.sqlite"), schema], {input: JSON.stringify(jobs), encoding: "utf8", maxBuffer: 5000000});
  if (result.status !== 0) {
    const reason = result.stderr || String(result.error);
    console.error("Local SQLite test process failed:", reason);
    throw new Error(reason);
  }
  return JSON.parse(result.stdout);
}
execute(null);
const DB = {
  prepare(sql) {
    return {
      sql, args: [],
      bind(...args) { return {...this, args}; },
      async run() { return execute([this])[0]; },
      async first() { return execute([this])[0].results[0] || null; }
    };
  },
  async batch(jobs) { return execute(jobs); }
};
const origin = "https://sitereview.fgs.example";
const env = {DB, ASSETS: {fetch: () => new Response("review shell", {headers: {"Content-Type": "text/html"}})}};
async function request(path, method = "GET", body, secret, headers = {}) {
  const req = new Request(origin + path, {method, headers: {"Content-Type": "application/json",
    ...(secret ? {Authorization: "Bearer " + secret} : {}), ...headers}, body: body === undefined ? undefined : JSON.stringify(body)});
  return worker.fetch(req, env);
}
async function api(path, method, body, secret, status = 200) {
  const response = await request(path, method, body, secret);
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}
async function create(host = "example.com") {
  const out = await api("/api/reviews", "POST", {url: host, title: "Round one"}, null, 201);
  const owner = out.ownerPath.split("#owner=")[1];
  assert.ok(owner);
  const path = "/api/reviews/" + out.review.id;
  const board = await api(path);
  return {path, owner, board, out, pageId: board.pages[0].id};
}

test("anonymous review round, shared uploads and pins, closure, invite replacement and project isolation", async () => {
  const {path, owner, pageId, board, out} = await create();
  const second = await create("different.example");
  assert.equal(board.pages[0].url, "https://example.com/");
  assert.equal(board.review.role, "reviewer");
  assert.ok(!JSON.stringify(board).includes(owner));
  assert.equal((await request(out.reviewerPath)).status, 200);
  assert.equal((await request(out.reviewerPath.replace("example.com","other.example"))).status, 404);
  await api(path, "GET", undefined, second.owner, 403);
  await api(path + "/pages", "POST", {url:"example.com/contact"}, null, 403);
  const {page} = await api(path + "/pages", "POST", {url:"example.com/contact"}, owner, 201);
  const again = await api(path + "/pages", "POST", {url:"example.com/contact"}, owner);
  assert.equal(again.page.id, page.id);
  await api(path + "/pages", "POST", {url:"other.example/contact"}, owner, 400);
  await api(path + "/auto-captures", "POST", {pageId,device:"mobile"}, null, 422);
  await api(path + "/auto-captures", "POST", {pageId,device:"mobile"}, owner, 422);

  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVXYAAAAASUVORK5CYII=";
  const image = {pageId, label:"Phone view", dataUrl:"data:image/png;base64," + png, width:99, height:99};
  const {capture} = await api(path + "/captures", "POST", image, null, 201);
  const imageRetry = await api(path + "/captures", "POST", image);
  assert.equal(imageRetry.capture.id, capture.id);
  assert.equal(capture.width, 1);
  assert.equal(capture.height, 1);
  assert.equal((await request(capture.imageUrl)).headers.get("Content-Type"), "image/png");
  const content = await (await request(capture.imageUrl)).arrayBuffer();
  assert.deepEqual(Buffer.from(content), Buffer.from(png, "base64"));
  await api(second.path + "/captures/" + capture.id + "/image", "GET", undefined, null, 404);
  await api(path + "/captures", "POST", {...image, dataUrl:"data:image/png;base64,AAAA"}, null, 400);
  await api(path + "/captures", "POST", {...image, dataUrl:"a".repeat(1800000)}, null, 413);
  const input = {name:"Sam",text:"Increase the button contrast",clientId:crypto.randomUUID(),pageId,
    captureId:capture.id,x:0.4,y:0.22,context:{browser:"Safari",viewport:{width:390,height:844},pageUrl:"https://example.com/checkout"}};
  const {note} = await api(path + "/notes", "POST", input, null, 201);
  const retry = await api(path + "/notes", "POST", input);
  assert.equal(retry.note.id, note.id);
  assert.equal((await api(path, "GET", undefined, owner)).notes[0].context.viewport.width, 390);
  assert.equal((await api(second.path)).notes.length, 0);
  await api(second.path + "/notes", "POST", {...input, pageId:second.pageId, context:{}}, null, 409);
  await api(path + "/notes", "POST", {...input,clientId:crypto.randomUUID(),x:2}, null, 400);
  await api(path + "/notes/" + note.id, "PATCH", {resolved:true}, null, 403);
  const fixed = await api(path + "/notes/" + note.id, "PATCH", {resolved:true}, owner);
  assert.equal(fixed.note.resolved, true);
  await api(path, "PATCH", {closed:true}, owner);
  await api(path + "/notes", "POST", {...input,clientId:crypto.randomUUID()}, null, 409);
  await api(path + "/captures", "POST", image, null, 409);
  const closedRetry = await api(path + "/notes", "POST", input);
  assert.equal(closedRetry.note.id, note.id);
  await api(path, "PATCH", {closed:false}, owner);
  const rotated = await api(path + "/rotate-invite", "POST", {}, owner);
  assert.notEqual(rotated.reviewerPath, out.reviewerPath);
  await api(path, "GET", undefined, null, 404);
  const active = "/api/reviews/" + rotated.reviewerPath.split("/").pop();
  const refreshed = await api(active);
  assert.equal(refreshed.notes[0].id, note.id);
  assert.equal((await request(refreshed.captures[0].imageUrl)).status, 200);
  assert.equal((await request(capture.imageUrl)).status, 404);
  assert.equal((await api(path,"GET", undefined, owner)).review.reviewerPath, rotated.reviewerPath);
});

test("creation validates the input and rejects cross-site writes", async () => {
  for (const url of ["http://localhost/path","https://127.0.0.1","https://[::1]","javascript:alert()","https://user:pass@example.com","https://example.com:8080/"]) {
    await api("/api/reviews", "POST", {url}, null, 400);
  }
  const denied = await request("/api/reviews","POST",{url:"example.com"},null,{Origin:"https://elsewhere.example"});
  assert.equal(denied.status, 403);
});

test("first-use Chrome can create after a shared network's old daily quota, with short scoped burst guards", async t => {
  let clock = Date.parse("2027-01-04T12:00:01Z");
  t.mock.method(Date, "now", () => clock);
  const ip = "203.0.113.26";
  const extension = "chrome-extension://knbdankbggjcdbdjcdgacibgbjiaffhg";
  const headers = {Origin:extension, "CF-Connecting-IP":ip};
  const create = (body = {}, h = headers) => request("/api/reviews", "POST", {url:"coastaltidelabs.com", ...body}, null, h);
  function seed(n, bucket) {
    const prefix = crypto.randomUUID();
    execute(Array.from({length:n}, (_,i) => ({
      sql:"INSERT INTO reviews(id,owner_hash,host,url,title,created_at,creation_bucket) VALUES(?,?,?,?,?,?,?)",
      args:[prefix+i,"test","seed.example","https://seed.example/","Previously started",
        new Date(clock).toISOString(),bucket]
    })));
  }
  function count(pattern) {
    return execute([{sql:"SELECT count(*) AS n FROM reviews WHERE creation_bucket GLOB ?",args:[pattern]}])[0].results[0].n;
  }
  const oldBucket = createHash("sha256").update("2027-01-04/"+ip).digest("hex");
  seed(12,oldBucket);
  seed(88,"other historical networks");
  assert.equal((await create()).status,201, "An unchanged 1.0.0 extension recovers immediately");

  const creatorId = crypto.randomUUID();
  const first = await create({creatorId});
  assert.equal(first.status,201);
  const {review} = await first.json();
  const bucket = execute([{sql:"SELECT creation_bucket FROM reviews WHERE id=?",args:[review.id]}])[0].results[0].creation_bucket;
  const network = bucket.slice(0,bucket.lastIndexOf(":")+1), slot = network.slice(0,network.lastIndexOf(":",network.length-2)+1);
  seed(11,bucket);
  const limited = await create({creatorId});
  assert.equal(limited.status,429);
  assert.equal(limited.headers.get("Retry-After"),"299");
  assert.match((await limited.json()).error,/this browser/);
  assert.equal((await create({creatorId:crypto.randomUUID()})).status,201,"A different installation on the same Wi-Fi can start");

  seed(36-count(network+"*"),network+"other-installations");
  const shared = await create({creatorId:crypto.randomUUID()});
  assert.equal(shared.status,429);
  assert.match((await shared.json()).error,/this network/);
  assert.equal((await create({},{"CF-Connecting-IP":"203.0.113.99"})).status,201);

  seed(60-count(slot+"*"),slot+"other-networks");
  const service = await create({},{"CF-Connecting-IP":"203.0.113.88"});
  assert.equal(service.status,429);
  assert.match((await service.json()).error,/Site Review is handling/);
  assert.equal((await request("/api/reviews/"+review.id)).status,200);
  clock+=300000;
  assert.equal((await create({creatorId})).status,201,"Existing or new devices recover when the brief burst ends");
});

test("retries recover the same private review without spending quota, including after invite rotation", async () => {
  const creationKey = crypto.randomUUID().replaceAll("-","") + crypto.randomUUID().replaceAll("-","");
  const body = {url:"https://idempotent.example/first",creatorId:crypto.randomUUID(),creationKey};
  const create = values => request("/api/reviews","POST",values,null,{"CF-Connecting-IP":"203.0.113.101"});
  const replies = await Promise.all([create(body),create(body)]);
  assert.deepEqual(replies.map(r=>r.status).sort(),[200,201]);
  const [one,two] = await Promise.all(replies.map(r=>r.json()));
  assert.deepEqual(one,two);
  const owner = one.ownerPath.split("#owner=")[1];
  const apiPath = "/api/reviews/"+one.review.id;
  const board = await api(apiPath,"GET",undefined,owner);
  assert.equal(board.pages.length,1);
  assert.ok(!JSON.stringify(board).includes(creationKey));
  assert.equal((await create({...body,url:"https://idempotent.example/other"})).status,409);
  assert.equal((await api(apiPath,"GET",undefined,owner)).pages.length,1);
  const rotated = await api(apiPath+"/rotate-invite","POST",{},owner);
  const recovered = await (await create(body)).json();
  assert.equal(recovered.reviewerPath,rotated.reviewerPath);
  assert.equal(recovered.ownerPath,one.ownerPath);
  assert.equal((await create({...body,creationKey:"small"})).status,400);
  assert.equal((await create({...body,creatorId:"fake"})).status,400);
});

test("Chrome companion can create, capture and annotate only the invited review", async () => {
  // Exercise the origin Chrome actually assigns the packaged manifest.
  const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url),"utf8"));
  const digest = createHash("sha256").update(Buffer.from(manifest.key,"base64")).digest("hex");
  const id = digest.slice(0,32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit,16)));
  const extension = "chrome-extension://" + id;
  const client = {Origin:extension};
  for (const origin of [extension+"x", extension+"/", "null", "https://external.example"]) {
    const blocked = await request("/api/reviews","POST",{url:"client.example"},null,{Origin:origin});
    assert.equal(blocked.status,403);
    assert.equal(blocked.headers.has("Access-Control-Allow-Origin"),false);
  }
  const created = await request("/api/reviews","POST",{url:"client.example"},null,client);
  assert.equal(created.status,201);
  assert.equal(created.headers.get("Access-Control-Allow-Origin"),extension);
  const {review, ownerPath} = await created.json();
  const path = "/api/reviews/" + review.id;
  const owner = ownerPath.split("#owner=")[1];
  const preflight = await request(path+"/captures","OPTIONS",undefined,null,{
    ...client,"Access-Control-Request-Method":"POST","Access-Control-Request-Headers":"authorization, content-type"
  });
  assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Methods"),"POST");
  assert.equal((await request(path,"OPTIONS",undefined,null,{...client,"Access-Control-Request-Method":"PATCH"})).status,403);
  assert.equal((await request(path+"/pages","OPTIONS",undefined,null,{
    ...client,"Access-Control-Request-Method":"POST","Access-Control-Request-Headers":"x-unexpected"
  })).status,403);
  const board = await (await request(path,"GET",undefined,null,client)).json();
  assert.equal(board.review.role,"reviewer");
  assert.equal((await request(path+"/pages","POST",{url:"client.example/team"},null,client)).status,403);
  assert.equal((await request(path+"/pages","POST",{url:"other.example/team"},owner,client)).status,400);
  const added = await request(path+"/pages","POST",{url:"client.example/team"},owner,client);
  assert.equal(added.status,201);
  const {page} = await added.json();
  const jpeg = readFileSync(new URL("./mobile-preview.jpg",import.meta.url));
  const image = await request(path+"/captures","POST",{pageId:page.id,dataUrl:"data:image/jpeg;base64,"+jpeg.toString("base64")},null,client);
  assert.equal(image.status,201);
  const note = await request(path+"/notes","POST",{
    pageId:page.id,clientId:crypto.randomUUID(),text:"Change this heading.",context:{mode:"live",pageUrl:page.url,elementLabel:"Team"}
  },null,client);
  assert.equal(note.status,201);
  const saved = (await note.json()).note;
  assert.equal(saved.context.elementLabel,"Team");
  assert.equal(saved.name,"Guest");
  for (const [suffix,method,body] of [["","PATCH",{closed:true}],["/rotate-invite","POST",{}],["/auto-captures","POST",{pageId:page.id,device:"mobile"}]]) {
    assert.equal((await request(path+suffix,method,body,owner,client)).status,403);
  }
  assert.equal((await request(path,"PATCH",{closed:true},owner)).status,200);
  assert.equal((await request(path+"/captures","POST",{pageId:page.id},owner,client)).status,409);
});

test("FGS aliases, previously issued links and notes on a second live page", async () => {
  const {out, board, path, owner, pageId} = await create("http://fernandezgrowthsystems.com");
  assert.equal(board.pages[0].url, "https://www.fernandezgrowthsystems.com/");
  assert.equal(board.pages[0].frameMode, "live");

  // Old invitations stored their original hostname in both tables.
  execute([
    {sql:"UPDATE reviews SET host=?,url=? WHERE id=?",args:["fernandezgrowthsystems.com","http://fernandezgrowthsystems.com/",out.review.id]},
    {sql:"UPDATE pages SET url=? WHERE id=?",args:["http://fernandezgrowthsystems.com/",pageId]}
  ]);
  const legacy = await api(path);
  assert.equal((await request(legacy.review.reviewerPath)).status, 200);
  assert.match(legacy.review.reviewerPath, /^\/fernandezgrowthsystems\.com\//);
  assert.equal(legacy.pages[0].url, "https://www.fernandezgrowthsystems.com/");
  const original = {pageId, clientId:crypto.randomUUID(), name:"Pat", text:"Please change this heading",
    context:{mode:"live", pageUrl:"https://www.fernandezgrowthsystems.com/growth-systems-review",elementLabel:"Deliverables"}};
  await api(path+"/notes","POST",{...original,context:{mode:"live",pageUrl:"https://other.example/"}},null,400);
  const saved = await api(path+"/notes","POST",original,null,201);
  assert.equal(saved.page.url, original.context.pageUrl);
  assert.equal(saved.note.pageId, saved.page.id);
  assert.notEqual(saved.note.pageId,pageId);
  const retry = await api(path+"/notes","POST",original);
  assert.equal(retry.note.id,saved.note.id);
  assert.equal(retry.page.id,saved.page.id);
  const second = await api(path+"/notes","POST",{...original, clientId:crypto.randomUUID()},null,201);
  assert.equal(second.note.pageId,saved.page.id);
  const updated = await api(path,"GET",undefined,owner);
  assert.equal(updated.pages.length,2);
  assert.equal(updated.notes.length,2);
});

test("guest fallback generates a mobile image once and reuses it across invitations", async () => {
  const {path,pageId} = await create("www.fernandezgrowthsystems.com/tools");
  const jpeg = readFileSync(new URL("./mobile-preview.jpg", import.meta.url));
  let renders = 0;
  env.FGS_CAPTURE = {async fetch(url, init) {
    renders++;
    assert.equal(JSON.parse(init.body).pageUrl,"https://www.fernandezgrowthsystems.com/tools");
    return new Response(jpeg,{headers:{"Content-Type":"image/jpeg"}});
  }};
  try {
    const body = {pageId,device:"mobile"};
    const first = await api(path+"/auto-captures","POST",body,null,201);
    const cached = await api(path+"/auto-captures","POST",body);
    assert.equal(cached.capture.id,first.capture.id);
    assert.equal(cached.capture.width,390);
    assert.equal(cached.capture.height,844);
    await api(path+"/auto-captures","POST",{...body,refresh:true},null,403);
    assert.equal(renders,1);
  } finally {
    delete env.FGS_CAPTURE;
  }
});
