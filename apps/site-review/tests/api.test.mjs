import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {webcrypto} from "node:crypto";
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
