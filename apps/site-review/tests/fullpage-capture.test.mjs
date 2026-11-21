import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {existsSync} from "node:fs";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import captureWorker, {automaticCapture, canAutomaticallyCapture, probeFramePolicy, renderViaCallback} from "../capture.js";

const db = {prepare: () => ({bind() { return this; }}), batch: () => [{},{meta:{changes:1}}]};
const fixtureJpeg = await readFile(new URL("./mobile-preview.jpg", import.meta.url));
const endpoint = "https://fgs-capture.invalid/capture";
const input = (pageUrl, fullPage = true) => ({pageUrl, fullPage, reviewId:"local-round", device:"mobile"});
const blocked = "https://private-name.clientdomain.com";
const site = "https://shop.clientdomain.com";
const parent = "https://sitereview.fernandezgrowthsystems.com";

function network(t, respond) {
  return t.mock.method(globalThis, "fetch", async (value, init) => {
    const url = new URL(value);
    if (url.host === "cloudflare-dns.com") {
      const privateName = url.searchParams.get("name") === new URL(blocked).hostname;
      const records = url.searchParams.get("type") === "A" ? [{type:1,data:privateName ? "10.1.1.20" : "93.184.215.14"}] : [];
      return Response.json({Status:0,Answer:records});
    }
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "manual");
    assert.ok(!new Headers(init.headers).has("Cookie"));
    assert.ok(!new Headers(init.headers).has("Authorization"));
    assert.notEqual(url.origin, blocked);
    return respond(url, init);
  });
}

test("frame checks honor final successful headers, CSP precedence and public DNS", async t => {
  const visited = [];
  network(t, (url, init) => {
    visited.push(url.pathname);
    assert.equal(init.method, "HEAD");
    const headers = {"/blocked":{"X-Frame-Options":"SAMEORIGIN"}, "/reframed":{"X-Frame-Options":"DENY","Content-Security-Policy":"frame-ancestors *"},
      "/never":{"Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'"}, "/redirect":{"Location":"/blocked"},
      "/private":{"Location": blocked}, "/challenge":{"X-Frame-Options":"DENY"}};
    return new Response(null, {status: headers[url.pathname]?.Location ? 302 : url.pathname === "/challenge" ? 403 : 200,
      headers:headers[url.pathname]});
  });
  for (const [name, policy] of [["/blocked","blocked"], ["/reframed","unknown"], ["/never","blocked"], ["/redirect","blocked"],
    ["/private","unknown"], ["/challenge","unknown"]]) assert.equal(await probeFramePolicy(site+name, parent), policy);
  const count = visited.length;
  assert.equal(await probeFramePolicy(site+"/blocked", parent),"blocked");
  assert.equal(visited.length,count,"repeat frame checks use the previous headers");
});

test("trusted host uses full-page Quick Action only on explicit request and reports actual image dimensions", async () => {
  const options = [];
  const renderer = {quickAction:async (name,args) => {
    assert.equal(name,"screenshot"); options.push(args);
    return new Response(fixtureJpeg,{headers:{"Content-Type":"image/jpeg"}});
  }};
  const FGS_CAPTURE = {fetch:(url,init) => captureWorker.fetch(new Request(url, init),{BROWSER:renderer})};
  for (const full of [false,true]) {
    const shot = await automaticCapture({DB:db,FGS_CAPTURE}, input("https://www.fernandezgrowthsystems.com/services",full));
    assert.equal(shot.label,full ? "Full page · Mobile" : "Mobile screenshot");
    assert.equal(shot.height,844); assert.equal(shot.width,390);
    assert.equal(options.at(-1).screenshotOptions.fullPage,full);
    assert.equal(options.at(-1).screenshotOptions.captureBeyondViewport,full);
  }
  assert.equal(canAutomaticallyCapture({BROWSER:renderer},site),false,"no unrestricted Quick Action for an outside hostname");
  const stale = {fetch:() => new Response(fixtureJpeg)};
  await assert.rejects(automaticCapture({DB:db, FGS_CAPTURE:stale},input("https://www.fernandezgrowthsystems.com")),/Full-page capture is unavailable/);
  for (const url of ["https://a.internal/", "https://127.0.0.1/", "https://[::1]/", "https://joe:s@"+new URL(site).hostname+"/"]) {
    const response = await captureWorker.fetch(new Request(endpoint,{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify(input(url))}),{BROWSER:renderer});
    assert.equal(response.status,422);
  }
});

// Real Chromium exercises the production CDP commands. Pipe transport has no
// network route; DNS and all public fixture responses are supplied by this test.
const chrome = process.env.FGS_CHROME_BIN || [
  join(process.env.ProgramFiles || "", "Google/Chrome/Application/chrome.exe"),
  "/usr/bin/chromium","/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].find(existsSync);
function browserBinding(profiles) {
  let processHandle, finished;
  return {
    async launch(options) {
      assert.deepEqual(options.guardrails.allowedDomains,["fgs-offline.invalid"]);
      const profile = await mkdtemp(join(tmpdir(),"fgs-fullpage-"));
      profiles.push(profile);
      processHandle = spawn(chrome, ["--headless=new","--no-sandbox","--disable-gpu","--disable-background-networking",
        "--disable-component-update","--no-first-run","--no-default-browser-check","--remote-debugging-pipe",
        "--host-resolver-rules=MAP * ~NOTFOUND","--user-data-dir="+profile],{stdio:["ignore","ignore","ignore","pipe","pipe"],windowsHide:true});
      finished = once(processHandle,"exit");
      const socket = new EventTarget();
      let buffer = "";
      processHandle.stdio[4].setEncoding("utf8").on("data", chunk => {
        buffer += chunk;
        let pos;
        while ((pos=buffer.indexOf("\0")) >= 0) {
          const data = buffer.slice(0,pos); buffer=buffer.slice(pos+1);
          socket.dispatchEvent(new MessageEvent("message",{data}));
        }
      });
      processHandle.stdio[3].on("error",()=>{});
      socket.send = data => processHandle.stdio[3].write(data+"\0");
      socket.close = () => socket.dispatchEvent(new Event("close"));
      socket.accept = ()=>{};
      return {webSocket:{fetch:async()=>({webSocket:socket})}, sessionId:"local"};
    },
    async closeSession(id) {
      assert.equal(id,"local");
      processHandle.stdio[3].end();
      await finished;
    }
  };
}
test("an isolated browser renders below-fold content from public HTML, CSS and scripts, with no private request or cookies", {skip: !chrome}, async t => {
  const paths = [], profiles=[];
  t.after(async () => {for(const profile of profiles) await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const publicPage = '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css">'+
    '<main>Start of page</main><footer>Below the fold</footer><script src="/layout.js"></script><img src="'+blocked+'/secret">';
  network(t, url => {
    paths.push(url.pathname);
    if (url.pathname === "/go") return new Response(null,{status:301,headers:{Location:"/one"}});
    if (url.pathname === "/one") return new Response(publicPage,{headers:{"Content-Type":"text/html","Set-Cookie":"private=discard; Secure",
      "Content-Security-Policy":"default-src 'self'; img-src https:; frame-ancestors 'none'","X-Frame-Options":"DENY"}});
    if (url.pathname === "/style.css") return new Response("*{margin:0} img{display:none} footer{height:350px;background:green}",{headers:{"Content-Type":"text/css"}});
    if (url.pathname === "/layout.js") return new Response("document.querySelector('main').style.height = document.cookie ? '200px' : '2650px';",
      {headers:{"Content-Type":"application/javascript"}});
    if (url.pathname === "/forbidden") return new Response("Access denied",{status:403,headers:{"Content-Type":"text/html"}});
    return new Response(null,{status:404});
  });
  const browser = browserBinding(profiles);
  const env = {DB:db, FGS_CAPTURE:{
    fetch() { throw new Error("Outside hosts must use the callback-scoped RPC"); },
    renderPublic:(url, device, read) => renderViaCallback(browser, url, device, read)
  }};
  const shot = await automaticCapture(env,input(site+"/go"));
  assert.equal(shot.height,3000);
  assert.equal(shot.width,390);
  assert.ok(paths.includes("/layout.js") && paths.includes("/style.css"));
  assert.equal(paths.includes("/secret"),false);
  await assert.rejects(automaticCapture(env,input(site+"/forbidden")), /declined|could not be captured/);
});
