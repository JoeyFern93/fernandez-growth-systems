// Project owners can submit existing URLs, but cannot change network policy.
// These platforms operate the public DNS for their own tenant hostnames.
const DEMO_HOST = "sitereview.fernandezgrowthsystems.com";
const DEFAULT_HOSTS = "fernandezgrowthsystems.com,www.fernandezgrowthsystems.com";
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOSTED_PREVIEWS = [
  { suffix: ".pages.dev", depth: 2 },
  { suffix: ".netlify.app", depth: 1 },
  { suffix: ".vercel.app", depth: 1 },
  { suffix: ".github.io", depth: 1 },
  { suffix: ".webflow.io", depth: 1, assets: ["cdn.prod.website-files.com", "assets.website-files.com"] },
  { suffix: ".wixsite.com", depth: 1, assets: ["static.wixstatic.com", "static.parastorage.com"] },
  { suffix: ".myshopify.com", depth: 1, assets: ["cdn.shopify.com"] }
];
const MAX_BYTES = 1280 * 1024;
const FULL_BYTES = 10 * 1024 * 1024;
const SERVICE_URL = "https://fgs-capture.invalid/capture";
const VIEWPORTS = {
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 900, isMobile: false, hasTouch: false }
};

export class CaptureError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function eligibleHosts(env) {
  const hosts = (env.CAPTURE_HOSTS ?? DEFAULT_HOSTS).toLowerCase().split(",");
  return new Set(hosts.map(host => host.trim()).filter(host =>
    /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}$/.test(host) &&
    !/\.(?:localhost|local|internal|intranet|test|invalid|onion|home|lan)$/.test(host)
  ));
}

function hostedPreview(hostname) {
  return HOSTED_PREVIEWS.find(({ suffix, depth }) => {
    if (!hostname.endsWith(suffix)) return false;
    const labels = hostname.slice(0, -suffix.length).split(".");
    return labels.length <= depth && labels.every(label => HOST_LABEL.test(label));
  });
}

function eligibleUrl(env, pageUrl) {
  if (typeof pageUrl !== "string" || pageUrl.length > 2048) return false;
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) return false;
    if (url.hostname === DEMO_HOST) return url.pathname === "/demo" || url.pathname.startsWith("/demo/");
    return eligibleHosts(env).has(url.hostname) || Boolean(hostedPreview(url.hostname));
  } catch {
    return false;
  }
}

function publicHttps(value) {
  try {
    if (typeof value !== "string" || value.length > 4096) return null;
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(url.hostname) ||
        /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|test|invalid|onion|arpa)$/.test(url.hostname)) return null;
    url.hash = "";
    return url;
  } catch { return null; }
}

function externalPage(pageUrl) {
  const url = publicHttps(pageUrl);
  return Boolean(url && url.hostname !== DEMO_HOST && !url.search && pageUrl.length <= 2048);
}

export function canAutomaticallyCapture(env, pageUrl) {
  const service = typeof env.FGS_CAPTURE?.fetch === "function";
  if (eligibleUrl(env, pageUrl)) return service || typeof env.BROWSER?.quickAction === "function";
  return externalPage(pageUrl) && (service || typeof env.BROWSER?.launch === "function");
}

// This code runs in Cloudflare Workers with public-only global fetch, no private
// network bindings and global_fetch_strictly_public. The network checks the
// destination at connect time as well as the hostname checks here.
const CAPTURE_AGENT = "FGS-Site-Review/1.0 (+https://sitereview.fernandezgrowthsystems.com/)";
const redirectStatus = status => [301, 302, 303, 307, 308].includes(status);

function publicAddress(ip) {
  if (typeof ip !== "string") return false;
  if (ip.includes(":")) {
    try {
      const host = new URL("https://[" + ip + "]/").hostname.slice(1, -1);
      // Allow native global unicast only. Exclude special-purpose, transition
      // and documentation prefixes within 2000::/3.
      return /^[23][0-9a-f]{3}:/.test(host) && !/^(?:2001:(?:[0-9a-f]{1,2}|1[0-9a-f]{2}|db8):|2002:|3fff:)/.test(host);
    } catch { return false; }
  }
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some(n => !/^\d{1,3}$/.test(n) || +n > 255)) return false;
  const [a,b,c] = parts.map(Number);
  return !(a < 1 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 ||
    a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 &&
    (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99) ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}

async function publicDns(hostname, signal) {
  const groups = await Promise.all(["A", "AAAA"].map(async type => {
    const response = await fetch("https://cloudflare-dns.com/dns-query?name=" + encodeURIComponent(hostname) + "&type=" + type,
      {headers: {Accept: "application/dns-json"}, redirect: "error", signal});
    if (!response.ok) throw new Error("DNS unavailable");
    const answer = await response.json();
    if (answer.Status !== 0) throw new Error("DNS lookup failed");
    return (answer.Answer || []).filter(row => row.type === 1 || row.type === 28).map(row => row.data);
  }));
  const addresses = groups.flat();
  return addresses.length > 0 && addresses.every(publicAddress);
}

function publicFetcher(signal) {
  const hosts = new Map();
  return async (url, method, headers = {}) => {
    if (!hosts.has(url.hostname)) {
      if (hosts.size >= 16) throw new Error("Too many asset domains");
      hosts.set(url.hostname, publicDns(url.hostname, signal));
    }
    if (!await hosts.get(url.hostname)) throw new Error("Public address required");
    return fetch(url.href, {method, redirect: "manual", credentials: "omit",
      headers: {"User-Agent": CAPTURE_AGENT, ...headers}, signal});
  };
}

// Report a definite block only. An unrecognised source expression, unavailable
// HEAD, or ambiguous policy leaves the normal live-preview attempt available.
const frameResults = new Map();
export async function probeFramePolicy(pageUrl, embedOrigin) {
  const key = embedOrigin + "\n" + pageUrl;
  const result = frameResults.get(key);
  if (result && result.until > Date.now()) return result.value;
  const value = await readFramePolicy(pageUrl, embedOrigin);
  if (frameResults.size >= 256) frameResults.delete(frameResults.keys().next().value);
  frameResults.set(key, {value, until: Date.now() + 15 * 60 * 1000});
  return value;
}

async function readFramePolicy(pageUrl, embedOrigin) {
  try {
    let url = publicHttps(pageUrl);
    const parent = publicHttps(embedOrigin);
    if (!url || !parent || url.search || url.hostname === DEMO_HOST) return "unknown";
    const read = publicFetcher(AbortSignal.timeout(4000));
    for (let hops = 0; url && hops <= 3; hops++) {
      const response = await read(url, "HEAD");
      await response.body?.cancel();
      if (redirectStatus(response.status)) {
        const location = response.headers.get("Location");
        url = location ? publicHttps(new URL(location, url).href) : null;
        continue;
      }
      if (!response.ok) return "unknown";
      const policies = (response.headers.get("content-security-policy") || "").split(",");
      let hasAncestors = false;
      for (const policy of policies) {
        const directive = policy.split(";").map(s => s.trim()).find(s => /^frame-ancestors(?:\s|$)/i.test(s));
        if (!directive) continue;
        hasAncestors = true;
        const sources = directive.toLowerCase().split(/\s+/).slice(1);
        const excludesParent = source => {
          if (source === "'none'") return true;
          if (source === "'self'") return url.origin !== parent.origin;
          const host = /^(https?:\/\/)?(\*\.)?([a-z0-9.-]+)(?::(\d+|\*))?\/?$/.exec(source);
          if (!host) return false;
          // HTTP source expressions can upgrade to HTTPS in CSP.
          if (host[4] && host[4] !== "*" && host[4] !== "443" && host[4] !== "80") return true;
          return host[2] ? !parent.hostname.endsWith("." + host[3]) : parent.hostname !== host[3];
        };
        if (sources.every(excludesParent)) return "blocked";
      }
      if (hasAncestors) return "unknown";
      const xfo = (response.headers.get("x-frame-options") || "").trim().toLowerCase();
      return xfo === "deny" || xfo === "sameorigin" && url.origin !== parent.origin ? "blocked" : "unknown";
    }
  } catch { /* A failed probe does not disqualify a live preview. */ }
  return "unknown";
}

async function reserveAttempt(db, reviewId) {
  // D1 serializes writes. This single conditional INSERT reserves the attempt
  // before starting billed work, including two concurrent dashboard tabs.
  const [, result] = await db.batch([
    db.prepare("DELETE FROM capture_attempts WHERE attempted_at < unixepoch('now','start of day','-1 day')"),
    db.prepare(`
      INSERT INTO capture_attempts (attempted_at, review_id)
      SELECT unixepoch(), ?1
      WHERE NOT EXISTS (
        SELECT 1 FROM capture_attempts WHERE attempted_at > unixepoch() - 11
      )
      AND (SELECT COUNT(*) FROM capture_attempts
           WHERE attempted_at >= unixepoch('now','start of day')) < 16
      AND (SELECT COUNT(*) FROM capture_attempts WHERE review_id = ?1
           AND attempted_at >= unixepoch('now','start of day')) < 6
    `).bind(reviewId)
  ]);
  if (result.meta.changes > 0) return;

  const usage = await db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(review_id = ?1), 0) AS forReview
    FROM capture_attempts WHERE attempted_at >= unixepoch('now','start of day')
  `).bind(reviewId).first();
  if (usage.total >= 16 || usage.forReview >= 6) {
    throw new CaptureError(429, "The daily automatic screenshot limit has been reached. Upload a screenshot or try again after midnight UTC.");
  }
  throw new CaptureError(429, "Automatic screenshots run one at a time. Try again in 11 seconds or upload a screenshot.");
}

function requestPatterns(env, pageUrl) {
  const { hostname } = new URL(pageUrl);
  // A configured apex/www pair may redirect between those two names. Never
  // allow all subdomains of an input hostname or add a user-supplied pattern.
  const alternate = hostname.startsWith("www.") ? hostname.slice(4) : "www." + hostname;
  const hosts = [hostname];
  if (eligibleHosts(env).has(alternate)) hosts.push(alternate);
  const provider = hostedPreview(hostname);
  if (provider?.assets) hosts.push(...provider.assets);
  return hosts.map(host => "^https://" + host.replaceAll(".", "\\.") + "(?:/|$)");
}

function renderScreenshot(env, pageUrl, device, fullPage) {
  const viewport = VIEWPORTS[device];
  const isProviderPreview = Boolean(hostedPreview(new URL(pageUrl).hostname));
  return env.BROWSER.quickAction("screenshot", {
    url: pageUrl,
    viewport: { ...viewport, deviceScaleFactor: 1 },
    allowRequestPattern: requestPatterns(env, pageUrl),
    // Shared hosting previews use their static layout. A reviewer can capture
    // the live browser tab to preserve interactions and client-rendered states.
    setJavaScriptEnabled: !isProviderPreview,
    rejectResourceTypes: ["websocket", "eventsource", "media"],
    gotoOptions: { waitUntil: "load", timeout: 10000 },
    actionTimeout: 5000,
    screenshotOptions: { type: "jpeg", quality: fullPage ? 71 : 77, fullPage, captureBeyondViewport: fullPage }
  });
}

function base64(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let binary = "";
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(binary);
}

function decodeBase64(value) {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(value);
  const raw = atob(value), bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function boundedBytes(response, maximum) {
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw new CaptureError(413, "This image or resource is too large.");
  }
  const reader = response.body?.getReader();
  const parts = [];
  let length = 0;
  if (reader) for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new CaptureError(413, "This image or resource is too large.");
    }
    parts.push(value);
  }
  return new Uint8Array(await new Blob(parts).arrayBuffer());
}

function jpegSize(bytes) {
  if (bytes.length < 11 || bytes[0] !== 255 || bytes[1] !== 216) return null;
  for (let i = 2; i + 4 < bytes.length;) {
    if (bytes[i++] !== 255) return null;
    while (i < bytes.length && bytes[i] === 255) i++;
    const marker = bytes[i++];
    if (marker === 217 || marker === 218) return null;
    const length = bytes[i] * 256 + bytes[i + 1];
    if (length < 2 || i + length > bytes.length) return null;
    if ([192,193,194].includes(marker) && length >= 8) {
      return {height: bytes[i+3]*256 + bytes[i+4], width: bytes[i+5]*256 + bytes[i+6]};
    }
    i += length;
  }
  return null;
}

// Browser Run's session-level network allowlist is fixed at launch. Even
// popups, service workers and requests outside the page CDP target cannot use
// the network directly. Only requests explicitly fulfilled below can load.
function cdpClient(socket, onEvent, signal) {
  let next = 0;
  const pending = new Map();
  function stop() {
    for (const entry of pending.values()) entry.reject(new Error("Browser session ended"));
    pending.clear();
  }
  signal.addEventListener("abort", stop, {once: true});
  socket.addEventListener("close", stop);
  socket.addEventListener("message", ({data}) => {
    const message = JSON.parse(data);
    if (!message.id) return onEvent(message);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error("Browser command failed"));
    else entry.resolve(message.result);
  });
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Capture timed out"));
    const id = ++next;
    pending.set(id, {resolve, reject});
    socket.send(JSON.stringify({id, method, params, sessionId}));
  });
}

async function renderPublicPage(browser, pageUrl, device, publicRead) {
  const viewport = VIEWPORTS[device];
  const signal = AbortSignal.timeout(23000);
  const session = await browser.launch({keepAlive: 25000, guardrails: {allowedDomains: ["fgs-offline.invalid"]}});
  let socket;
  try {
    const upgrade = await session.webSocket.fetch("https://browser-binding.invalid", {headers: {Upgrade: "websocket"}});
    socket = upgrade.webSocket;
    if (!socket) throw new Error("Browser connection unavailable");
    socket.accept();
    let tab, mainFrame, requests = 0, inFlight = 0, transferred = 0;
    const waiting = [];
    let documentReady = false, unavailable = false, redirects = 0;
    let expected = pageUrl;
    const rootHosts = new Set([new URL(pageUrl).hostname]);
    const permittedTypes = new Set(["Document","Stylesheet","Image","Font","Script","XHR","Fetch"]);
    const call = cdpClient(socket, event => {
      if (event.sessionId !== tab || event.method !== "Fetch.requestPaused") return;
      const p = event.params;
      const fail = () => call("Fetch.failRequest", {requestId: p.requestId, errorReason: "BlockedByClient"}, tab);
      async function fulfill() {
        const url = publicHttps(p.request.url);
        const doc = p.resourceType === "Document";
        if (!url || p.request.method !== "GET" || !permittedTypes.has(p.resourceType) ||
            doc && (p.frameId !== mainFrame || url.href !== expected || documentReady) ||
            (p.resourceType === "XHR" || p.resourceType === "Fetch") && !rootHosts.has(url.hostname) ||
            ++requests > 110) return fail();
        if (inFlight >= 4) await new Promise(resolve => waiting.push(resolve));
        else inFlight++;
        try {
          if (signal.aborted || transferred >= 22 * 1024 * 1024) throw new Error("Capture budget exceeded");
          const response = await publicRead(url.href, p.request.headers.Accept || "*/*");
          if (redirectStatus(response.status)) {
            const location = response.headers.get("Location");
            const next = location && publicHttps(new URL(location, url).href);
            await response.body?.cancel();
            if (!next || doc && ++redirects > 4) throw new Error("Unsupported redirect");
            if (doc) { expected = next.href; rootHosts.add(next.hostname); }
            await call("Fetch.fulfillRequest", {requestId: p.requestId, responseCode: response.status,
              responseHeaders: [{name:"location", value:next.href}]}, tab);
            return;
          }
          if (doc && (!response.ok || response.headers.get("cf-mitigated") === "challenge" ||
              !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.headers.get("content-type") || ""))) {
            await response.body?.cancel();
            throw new Error("Website did not provide a public HTML page");
          }
          const bytes = await boundedBytes(response, 4 * 1024 * 1024);
          transferred += bytes.length;
          const responseHeaders = [];
          // Keep origin protections and resource types. Cookies, authentication
          // and service-worker registration never pass into the capture session.
          for (const name of ["content-type","content-language","content-security-policy","x-frame-options",
            "x-content-type-options","access-control-allow-origin","cross-origin-resource-policy",
            "cross-origin-opener-policy","cross-origin-embedder-policy","permissions-policy","referrer-policy"]) {
            if (response.headers.has(name)) responseHeaders.push({name, value: response.headers.get(name)});
          }
          if (doc) responseHeaders.push({name: "content-security-policy", value:
            "sandbox allow-scripts allow-same-origin; connect-src https:; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'"});
          await call("Fetch.fulfillRequest", {requestId: p.requestId, responseCode: response.status, responseHeaders, body: base64(bytes)}, tab);
          if (doc) documentReady = true;
        } catch {
          if (doc) unavailable = true;
          await fail();
        } finally {
          if (waiting.length) waiting.shift()();
          else inFlight--;
        }
      }
      fulfill().catch(() => {});
    }, signal);
    const target = await call("Target.createTarget", {url: "about:blank"});
    tab = (await call("Target.attachToTarget", {targetId: target.targetId, flatten: true})).sessionId;
    const page = (method, params) => call(method, params, tab);
    await page("Page.enable");
    // The document has no interactive clients, popups, frames or workers.
    // Keep non-HTTP realtime transports out of this offline rendering page.
    await page("Page.addScriptToEvaluateOnNewDocument", {source:
      "for (const name of ['RTCPeerConnection','webkitRTCPeerConnection','WebSocket','WebTransport']) Object.defineProperty(globalThis,name,{value:undefined,configurable:false});"});
    await page("Emulation.setDeviceMetricsOverride", {width: viewport.width, height: viewport.height,
      deviceScaleFactor: 1, mobile: viewport.isMobile});
    await page("Network.setBypassServiceWorker", {bypass: true});
    await page("Fetch.enable", {patterns: [{urlPattern:"*",requestStage:"Request"}]});
    mainFrame = (await page("Page.getFrameTree")).frameTree.frame.id;
    const navigation = await page("Page.navigate", {url: pageUrl});
    if (navigation.errorText || unavailable) throw new CaptureError(422, "The website declined the automatic screenshot.");
    const layout = await page("Runtime.evaluate", {awaitPromise:true, returnByValue:true,
      expression: `(async () => {
        const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
        const start = Date.now();
        while (document.readyState !== "complete" && Date.now() - start < 7000) await pause(100);
        for (const image of document.querySelectorAll("img[loading=lazy]")) image.loading = "eager";
        let y = 0;
        while (y < document.documentElement.scrollHeight && Date.now() - start < 10500 && y < 60000) {
          window.scrollTo(0, y); y += Math.max(200, innerHeight); await pause(65);
        }
        window.scrollTo(0, 0);
        await pause(350);
        return document.readyState;
      })()`});
    if (!documentReady || unavailable || layout.exceptionDetails) throw new CaptureError(422, "The website could not be captured.");
    const size = (await page("Page.getLayoutMetrics")).cssContentSize;
    const width = Math.ceil(size.width), height = Math.ceil(size.height);
    if (width <= 0 || height <= 0 || width > 8192 || height > 60000 || width * height > 60000000) {
      throw new CaptureError(413, "This page is too large for one full-page image.");
    }
    const screenshot = await page("Page.captureScreenshot", {format:"jpeg", quality:71, captureBeyondViewport:true,
      clip:{x:0, y:0, width, height, scale:1}});
    if (!screenshot.data || screenshot.data.length > Math.ceil(FULL_BYTES / 3) * 4) throw new CaptureError(413, "Image too large");
    return new Response(decodeBase64(screenshot.data), {headers: {"Content-Type":"image/jpeg"}});
  } finally {
    try { socket?.close(); } finally { await browser.closeSession(session.sessionId); }
  }
}

// Called by the private Worker's RPC entrypoint. It receives one anonymous
// read capability scoped to this capture. The outside network request executes
// back in the Pages Worker, whose global fetch is configured strictly public.
export async function renderViaCallback(browser, pageUrl, device, read) {
  if (!externalPage(pageUrl) || !Object.hasOwn(VIEWPORTS, device) || typeof read !== "function") {
    return new Response(null,{status:422});
  }
  try {
    const image = await renderPublicPage(browser, pageUrl, device, read);
    return new Response(image.body,{headers:{"Content-Type":"image/jpeg","Cache-Control":"no-store","X-FGS-Capture-Scope":"full-page"}});
  } catch (error) {
    return new Response(null,{status:error instanceof CaptureError ? error.status : 503});
  }
}

function captureReader() {
  const read = publicFetcher(AbortSignal.timeout(24000));
  let requests = 0;
  return async (href, accept) => {
    const url = publicHttps(href);
    if (!url || ++requests > 110) return new Response(null,{status:403});
    const response = await read(url, "GET", {Accept: typeof accept === "string" && accept.length < 512 ? accept : "*/*"});
    // Only expose public resource and policy fields to the renderer, including
    // on RPC. Cookie/authentication headers stay out of the return value.
    const headers = new Headers();
    for (const name of ["location","cf-mitigated","content-type","content-length","content-language","content-security-policy",
      "x-frame-options","x-content-type-options","access-control-allow-origin","cross-origin-resource-policy",
      "cross-origin-opener-policy","cross-origin-embedder-policy","permissions-policy","referrer-policy"]) {
      if (response.headers.has(name)) headers.set(name,response.headers.get(name));
    }
    return new Response(response.body,{status:response.status,headers});
  };
}

// Private service binding target. The .invalid name never resolves in public
// DNS. Only a binding can send this exact request to the private Worker.
const captureWorker = {
  async fetch(request, env) {
    if (request.method !== "POST" || request.url !== SERVICE_URL) return new Response(null, { status: 404 });
    if (typeof env.BROWSER?.quickAction !== "function" && typeof env.BROWSER?.launch !== "function") return new Response(null, { status: 503 });
    if (!request.headers.get("content-type")?.startsWith("application/json")) return new Response(null, { status: 415 });
    const body = await request.text();
    if (body.length > 4096) return new Response(null, { status: 413 });
    let input;
    try {
      input = JSON.parse(body);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!input || !Object.hasOwn(VIEWPORTS, input.device) || !eligibleUrl(env, input.pageUrl)) {
      return new Response(null, { status: 422 });
    }
    try {
      const rendered = await renderScreenshot(env, input.pageUrl, input.device, input.fullPage === true);
      if (!rendered.ok) return new Response(null, { status: rendered.status === 429 ? 429 : 422 });
      return new Response(rendered.body, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store",
        "X-FGS-Capture-Scope": input.fullPage === true ? "full-page" : "viewport" } });
    } catch (error) {
      return new Response(null, { status: error instanceof CaptureError ? error.status : 503 });
    }
  }
};

export default captureWorker;

export async function automaticCapture(env, { reviewId, pageUrl, device, fullPage = false }) {
  if (!Object.hasOwn(VIEWPORTS, device)) {
    throw new CaptureError(400, "Choose a mobile or desktop screenshot.");
  }
  if (!eligibleUrl(env, pageUrl) && !(fullPage === true && externalPage(pageUrl))) {
    throw new CaptureError(422, "Automatic screenshots are unavailable for this page. Upload a screenshot to add pins.");
  }
  if (!canAutomaticallyCapture(env, pageUrl)) {
    throw new CaptureError(503, "Automatic screenshots are currently unavailable. Upload a screenshot to continue.");
  }
  await reserveAttempt(env.DB, reviewId);
  let response;
  try {
    const trusted = eligibleUrl(env, pageUrl);
    const direct = trusted ? typeof env.BROWSER?.quickAction === "function" : typeof env.BROWSER?.launch === "function";
    if (!trusted) {
      const read = captureReader();
      response = direct ? await renderViaCallback(env.BROWSER, pageUrl, device, read) :
        await env.FGS_CAPTURE.renderPublic(pageUrl, device, read);
    } else {
      response = direct ? await renderScreenshot(env, pageUrl, device, fullPage) : await env.FGS_CAPTURE.fetch(SERVICE_URL, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pageUrl, device, fullPage })
        });
    }
    if (!direct && response.ok && fullPage && response.headers.get("X-FGS-Capture-Scope") !== "full-page") {
      await response.body?.cancel();
      throw new CaptureError(503, "Full-page capture is unavailable. Capture the open tab with the Chrome extension.");
    }
  } catch (error) {
    if (error instanceof CaptureError) throw error;
    throw new CaptureError(503, "The screenshot service could not complete this capture. Upload a screenshot or try again later.");
  }
  if (response.status === 429) {
    throw new CaptureError(429, "The screenshot service is at its usage limit. Upload a screenshot or try again later.");
  }
  if (response.status >= 500) {
    throw new CaptureError(503, "The screenshot service is unavailable. Upload a screenshot or try again later.");
  }
  if (response.status === 413) throw new CaptureError(422, "This page is too large for one image. Capture a section with the Chrome extension.");
  if (!response.ok) {
    throw new CaptureError(422, "The website could not be captured automatically. Upload a screenshot to continue.");
  }
  const bytes = await boundedBytes(response, fullPage ? FULL_BYTES : MAX_BYTES);
  const size = jpegSize(bytes);
  if (!size || !size.width || !size.height || size.width > 8192 || size.height > 60000 || size.width * size.height > 60000000) {
    throw new CaptureError(422, "The service did not return a usable screenshot. Upload a screenshot to continue.");
  }
  return {
    ...size,
    label: fullPage ? "Full page · " + (device === "mobile" ? "Mobile" : "Desktop") :
      device === "mobile" ? "Mobile screenshot" : "Desktop screenshot",
    dataUrl: "data:image/jpeg;base64," + base64(bytes)
  };
}
