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

export function canAutomaticallyCapture(env, pageUrl) {
  const available = typeof env.BROWSER?.quickAction === "function" || typeof env.FGS_CAPTURE?.fetch === "function";
  return available && eligibleUrl(env, pageUrl);
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

function renderScreenshot(env, pageUrl, device) {
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
    screenshotOptions: { type: "jpeg", quality: 77, fullPage: false, captureBeyondViewport: false }
  });
}

// Private service binding target. The .invalid name never resolves in public
// DNS. Only a binding can send this exact request to the private Worker.
const captureWorker = {
  async fetch(request, env) {
    if (request.method !== "POST" || request.url !== SERVICE_URL) return new Response(null, { status: 404 });
    if (typeof env.BROWSER?.quickAction !== "function") return new Response(null, { status: 503 });
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
      const rendered = await renderScreenshot(env, input.pageUrl, input.device);
      if (!rendered.ok) return new Response(null, { status: rendered.status === 429 ? 429 : 422 });
      return new Response(rendered.body, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" } });
    } catch {
      return new Response(null, { status: 503 });
    }
  }
};

export default captureWorker;

export async function automaticCapture(env, { reviewId, pageUrl, device }) {
  if (!Object.hasOwn(VIEWPORTS, device)) {
    throw new CaptureError(400, "Choose a mobile or desktop screenshot.");
  }
  if (!eligibleUrl(env, pageUrl)) {
    throw new CaptureError(422, "Automatic screenshots are unavailable for this page. Upload a screenshot to add pins.");
  }
  if (!canAutomaticallyCapture(env, pageUrl)) {
    throw new CaptureError(503, "Automatic screenshots are currently unavailable. Upload a screenshot to continue.");
  }
  await reserveAttempt(env.DB, reviewId);
  const viewport = VIEWPORTS[device];
  let response;
  try {
    response = typeof env.BROWSER?.quickAction === "function"
      ? await renderScreenshot(env, pageUrl, device)
      : await env.FGS_CAPTURE.fetch(SERVICE_URL, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pageUrl, device })
        });
  } catch {
    throw new CaptureError(503, "The screenshot service could not complete this capture. Upload a screenshot or try again later.");
  }
  if (response.status === 429) {
    throw new CaptureError(429, "The screenshot service is at its usage limit. Upload a screenshot or try again later.");
  }
  if (response.status >= 500) {
    throw new CaptureError(503, "The screenshot service is unavailable. Upload a screenshot or try again later.");
  }
  if (!response.ok) {
    throw new CaptureError(422, "The website could not be captured automatically. Upload a screenshot to continue.");
  }
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    throw new CaptureError(422, "This screenshot is too large. Upload a smaller screenshot to continue.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES || bytes[0] !== 255 || bytes[1] !== 216) {
    throw new CaptureError(422, "The service did not return a usable screenshot. Upload a screenshot to continue.");
  }
  let binary = "";
  for (let start = 0; start < bytes.length; start += 16384) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 16384));
  }
  return {
    width: viewport.width,
    height: viewport.height,
    label: device === "mobile" ? "Mobile screenshot" : "Desktop screenshot",
    dataUrl: "data:image/jpeg;base64," + btoa(binary)
  };
}
