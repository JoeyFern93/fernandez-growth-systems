import { automaticCapture, canAutomaticallyCapture, CaptureError, probeFramePolicy } from "./capture.js";

import { CAPTURE_BODY_LIMIT, CAPTURE_FIELDS, CaptureStorageError, publicCapture, readCapture, storeCapture, storedImage } from "./capture-storage.js";
const MAX_SCREENSHOTS = 10;
const MAX_NOTES = 300;
const MAX_PAGES = 30;
const MAX_TOTAL_SCREENSHOT_BYTES = 200 * 1024 * 1024;
const CREATION_WINDOW_MS = 5 * 60 * 1000;
const CREATION_LIMITS = {creator: 12, network: 36, service: 60};
const INVITE = /^[A-Za-z0-9_-]{24}$/;
// The public key in extension/manifest.json pins this unpacked extension ID.
// An Origin check never substitutes for the review invite or owner credential.
const EXTENSION_ORIGIN = "chrome-extension://knbdankbggjcdbdjcdgacibgbjiaffhg";
const EXTENSION_WRITE_ROUTES = new Set(["pages", "notes", "captures"]);
const ITEM_ID = /^[0-9a-f-]{36}$/;
const NOTE_FIELDS = "id, page_id AS pageId, capture_id AS captureId, x, y, name, text, context, created_at AS createdAt, resolved";
const FGS_HOST = "www.fernandezgrowthsystems.com";
const FGS_ALIASES = new Set(["fernandezgrowthsystems.com", FGS_HOST, "ferngrowthsystems.com", "www.ferngrowthsystems.com"]);
const FGS_ROUTES = new Set(["/", "/index", "/tools", "/tools/room-measure", "/replay", "/build-fix-sprint", "/growth-systems-review", "/ongoing-growth-support", "/inquiry-privacy", "/thank-you", "/404"]);

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new ApiError(status, message); }
function json(data, status = 200) {
  return Response.json(data, {status, headers: {"Cache-Control": "private, no-store"}});
}

async function readBody(request, maxBytes = 16384) {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    fail(415, "Send a JSON request.");
  }
  if (Number(request.headers.get("Content-Length")) > maxBytes) fail(413, "This submission is too large.");
  const reader = request.body?.getReader();
  if (!reader) fail(400, "A request body is required.");
  const parts = [];
  let count = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    count += value.byteLength;
    if (count > maxBytes) {
      await reader.cancel();
      fail(413, "This submission is too large.");
    }
    parts.push(value);
  }
  let body;
  try { body = JSON.parse(await new Blob(parts).text()); } catch { fail(400, "The request could not be read."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "A JSON object is required.");
  return body;
}

function publicUrl(input, expectedHost) {
  if (typeof input !== "string" || input.length > 2048) fail(400, "Enter a public website address.");
  let url;
  try {
    const value = input.trim();
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : "https://" + value);
  } catch { fail(400, "Enter a valid public website address."); }
  const host = url.hostname.toLowerCase();
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|corp|test|invalid|onion|arpa)$/.test(host)) {
    fail(400, "Use a public website address without a password or custom port.");
  }
  if (expectedHost && host !== expectedHost && !(FGS_ALIASES.has(host) && FGS_ALIASES.has(expectedHost))) {
    fail(400, "Add a page from " + expectedHost + ".");
  }
  if (FGS_ALIASES.has(host)) {
    url.hostname = FGS_HOST;
    url.protocol = "https:";
  }
  url.hash = "";
  return url;
}

function stringField(value, maximum, label, fallback = "") {
  if (value === undefined || value === null || value === "") value = fallback;
  if (typeof value !== "string") fail(400, "Enter a valid " + label + ".");
  const clean = value.trim();
  if (!clean || clean.length > maximum) fail(400, "Enter a " + label + " of 1 to " + maximum + " characters.");
  return clean;
}

function token(size) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
}
function publicReview(row, owner) {
  const invite = row.active_invite || row.id;
  return {id: owner ? row.id : invite, host: row.host, url: publicUrl(row.url).href, title: row.title, closed: !!row.closed,
    role: owner ? "owner" : "reviewer", reviewerPath: "/" + row.host + "/" + invite};
}
function lookup(db, invite) {
  return db.prepare("SELECT r.id,r.host,r.url,r.title,r.closed,r.owner_hash,COALESCE(l.invite,r.id) AS active_invite FROM reviews r LEFT JOIN review_links l ON l.review_id=r.id WHERE r.id=? OR r.id=(SELECT review_id FROM review_links WHERE invite=?)").bind(invite, invite).first();
}
function publicPage(env, row) {
  const url = publicUrl(row.url);
  const route = url.pathname.replace(/\.html$/, "").replace(/\/$/, "") || "/";
  const demoHost = url.hostname === "sitereview.fernandezgrowthsystems.com" || /^(?:[\w-]+\.)?fgs-site-review\.pages\.dev$/.test(url.hostname);
  const live = (url.hostname === FGS_HOST && FGS_ROUTES.has(route)) || (demoHost && url.pathname.startsWith("/demo/"));
  return {id: row.id, url: url.href, label: row.label, frameMode: live ? "live" : "unknown",
    autoCaptureAvailable: canAutomaticallyCapture(env, url.href)};
}
function publicNote(row) {
  return {...row, context: JSON.parse(row.context), resolved: !!row.resolved};
}
function parseAnnotation(value) {
  if (!value || typeof value !== "object" || !["point","draw"].includes(value.kind)) {
    fail(400, "Choose a point or draw on the page.");
  }
  const {kind, width, height} = value;
  if (![width, height].every(n => Number.isInteger(n) && n >= 1 && n <= 100000)) {
    fail(400, "The marked area has an invalid size.");
  }
  function position(pair) {
    if (!Array.isArray(pair) || pair.length !== 2 ||
        !pair.every(n => Number.isFinite(n) && n >= 0 && n <= 1)) fail(400, "Keep the mark inside the page.");
    return pair.map(n => Math.round(n * 10000) / 10000);
  }
  if (kind === "point") return {kind, width, height, point: position(value.point)};
  if (!Array.isArray(value.strokes) || !value.strokes.length || value.strokes.length > 24) {
    fail(400, "A drawing can contain up to 24 strokes.");
  }
  let total = 0;
  const strokes = value.strokes.map(stroke => {
    if (!Array.isArray(stroke) || !stroke.length || stroke.length > 256 || (total += stroke.length) > 640) {
      fail(400, "The drawing is too detailed. Undo a stroke and try again.");
    }
    return stroke.map(position);
  });
  return {kind, width, height, strokes};
}
function parseContext(input, host) {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) fail(400, "Choose a valid feedback location.");
  const {annotation, ...details} = input;
  if (JSON.stringify(details).length > 3600) {
    fail(400, "The note's device details are too large.");
  }
  const context = {};
  const strings = ["browser", "device", "os", "timezone", "language", "source", "mode", "elementLabel", "selector"];
  const numbers = ["viewportWidth", "viewportHeight", "scrollX", "scrollY"];
  for (const key of strings) if (typeof input[key] === "string") context[key] = input[key].slice(0, 350);
  for (const key of numbers) if (Number.isFinite(input[key])) context[key] = input[key];
  for (const key of ["liveViewport", "viewport", "screen"]) {
    if (Number.isFinite(input[key]?.width) && Number.isFinite(input[key]?.height)) {
      context[key] = {width: input[key].width, height: input[key].height};
    }
  }
  if (input.element && typeof input.element === "object") {
    context.element = {};
    for (const key of ["tag", "label", "selector"]) {
      if (typeof input.element[key] === "string") context.element[key] = input.element[key].slice(0, 350);
    }
  }
  if (input.pageUrl) context.pageUrl = publicUrl(input.pageUrl, host).href;
  if (annotation !== undefined) {
    context.annotation = parseAnnotation(annotation);
    context.mode = context.annotation.kind;
  }
  return context;
}

async function creationTokens(key) {
  if (key === undefined) return {id: token(18), owner: token(32)};
  if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) fail(400, "The review request could not be identified.");
  // A lost response can be reconstructed with the private per-request key.
  // The two independent outputs keep the public invite separate from ownership.
  async function derive(purpose, bytes) {
    const input = new TextEncoder().encode("FGS review creation v1/" + purpose + "/" + key);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    return btoa(String.fromCharCode(...digest.subarray(0, bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  return {id: await derive("invite", 18), owner: await derive("owner", 32)};
}

async function createReview(request, env, db) {
  const body = await readBody(request);
  const url = publicUrl(body.url);
  const title = stringField(body.title, 100, "review title", url.hostname);
  if (body.creatorId !== undefined && (typeof body.creatorId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.creatorId))) {
    fail(400, "The browser's review identifier is invalid.");
  }
  const {id, owner} = await creationTokens(body.creationKey);
  const ownerHash = await hash(owner);
  const now = Date.now();
  const slot = Math.floor(now / CREATION_WINDOW_MS);
  const prefix = "burst:" + slot + ":";
  const ip = request.headers.get("CF-Connecting-IP");
  const network = prefix + (ip ? await hash(prefix + ip) : "unknown") + ":";
  const channel = request.headers.get("Origin") === EXTENSION_ORIGIN ? "extension" : "web";
  // Older clients have no installation identifier. Keep their different sites
  // and interfaces independent, and never treat an unknown IP as one user.
  const identity = body.creatorId || (ip ? channel + "/" + url.hostname : id);
  const bucket = network + await hash(prefix + identity);
  const countsSql = `SELECT count(*) AS service,
      count(CASE WHEN creation_bucket GLOB ? THEN 1 END) AS network,
      count(CASE WHEN creation_bucket=? THEN 1 END) AS creator
    FROM reviews WHERE creation_bucket GLOB ?`;
  const countsArgs = [ip ? network + "*" : "none", bucket, prefix + "*"];
  const results = await db.batch([
    db.prepare(`INSERT INTO reviews(id, owner_hash, host, url, title, created_at, creation_bucket)
      SELECT ?,?,?,?,?,?,? FROM (${countsSql}) WHERE creator<? AND network<? AND service<?
      ON CONFLICT(id) DO NOTHING`)
      .bind(id, ownerHash, url.hostname, url.href, title, new Date(now).toISOString(), bucket, ...countsArgs,
        CREATION_LIMITS.creator, CREATION_LIMITS.network, CREATION_LIMITS.service),
    db.prepare(`INSERT INTO pages(id, review_id, url, label) SELECT ?,id,?,? FROM reviews
      WHERE id=? AND owner_hash=? AND url=? ON CONFLICT(review_id,url) DO NOTHING`)
      .bind(crypto.randomUUID(), url.href, url.pathname === "/" ? "Homepage" : url.pathname.slice(0, 100), id, ownerHash, url.href)
  ]);
  const created = results[0].meta.changes > 0;
  let row = {id, host: url.hostname, url: url.href, title, closed: false};
  if (!created) {
    const existing = body.creationKey && await lookup(db, id);
    if (!existing) {
      const counts = await db.prepare(countsSql).bind(...countsArgs).first();
      let reason = "Site Review is handling a burst of new reviews.";
      if (counts.creator >= CREATION_LIMITS.creator) reason = body.creatorId
        ? "Several reviews were just started from this browser."
        : "Several reviews were just started for this website on this network.";
      else if (counts.network >= CREATION_LIMITS.network) reason = "Several reviews were just started on this network.";
      const seconds = Math.max(1, Math.ceil(((slot + 1) * CREATION_WINDOW_MS - Date.now()) / 1000));
      const minutes = Math.ceil(seconds / 60);
      const response = json({error: reason + " Try again in " + minutes + (minutes === 1 ? " minute." : " minutes.") +
        " Existing review links still work.", retryAfterSeconds: seconds}, 429);
      response.headers.set("Retry-After", String(seconds));
      return response;
    }
    if (existing.id !== id || existing.owner_hash !== ownerHash || existing.url !== url.href) {
      fail(409, "This review request already belongs to a different page. Start a new review.");
    }
    row = existing;
  }
  const review = publicReview(row, true);
  return json({reviewerPath: review.reviewerPath, ownerPath: "/" + row.host + "/" + id + "#owner=" + owner, review},
    created ? 201 : 200);
}

async function ensureCapturePage(db, review, url) {
  const label = url.pathname === "/" ? "Homepage" : url.pathname.slice(0, 100);
  await db.prepare(`INSERT INTO pages(id,review_id,url,label)
    SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM reviews WHERE id=? AND closed=0)
    AND (SELECT count(*) FROM pages WHERE review_id=?) < ?
    ON CONFLICT(review_id,url) DO NOTHING`)
    .bind(crypto.randomUUID(), review.id, url.href, label, review.id, review.id, MAX_PAGES).run();
  const row = await db.prepare("SELECT id,url,label FROM pages WHERE review_id=? AND url=?").bind(review.id, url.href).first();
  if (!row) fail(409, "This review is closed or has reached its page limit.");
  return row;
}
async function addPage(request, env, db, review) {
  const body = await readBody(request);
  const url = publicUrl(body.url, review.host);
  const label = stringField(body.label, 100, "page name", url.pathname === "/" ? "Homepage" : url.pathname.slice(0, 100));
  const result = await db.prepare("INSERT INTO pages(id,review_id,url,label) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM reviews WHERE id=? AND closed=0) AND (SELECT COUNT(*) FROM pages WHERE review_id=?) < ? ON CONFLICT(review_id,url) DO NOTHING")
    .bind(crypto.randomUUID(), review.id, url.href, label, review.id, review.id, MAX_PAGES).run();
  const page = await db.prepare("SELECT id,url,label FROM pages WHERE review_id=? AND url=?").bind(review.id, url.href).first();
  if (!page) fail(409, "The round is closed or already has 30 pages.");
  return json({page: publicPage(env, page)}, result.meta.changes ? 201 : 200);
}
async function addCapture(request, env, db, review, auto, owner) {
  let body = await readBody(request, auto ? 4096 : CAPTURE_BODY_LIMIT);
  const startingPageId = String(body.pageId || "");
  let page = await db.prepare("SELECT id,url,label FROM pages WHERE review_id=? AND id=?")
    .bind(review.id, startingPageId).first();
  if (!page) fail(404, "Page not found.");
  const responseFor = (row, created = false) => {
    const response = {capture: publicCapture(review.active_invite, row)};
    if (page.id !== startingPageId) response.page = publicPage(env,page);
    return json(response, created ? 201 : 200);
  };
  const target = body.url === undefined ? publicUrl(page.url) : publicUrl(body.url, review.host);
  if (target.href !== publicUrl(page.url).href) {
    page = await db.prepare("SELECT id,url,label FROM pages WHERE review_id=? AND url=?").bind(review.id,target.href).first();
  }
  if (auto) {
    if (!["mobile","desktop"].includes(body.device)) fail(400, "Choose a mobile or desktop capture.");
    if (body.refresh === true && !owner) fail(403, "Use the owner link to replace the automatic preview.");
    const mobile = body.device === "mobile", fullPage = body.fullPage === true;
    if (page && body.refresh !== true) {
      const label = fullPage ? "Full page \u00b7 " + (mobile ? "Mobile" : "Desktop") : (mobile ? "Mobile screenshot" : "Desktop screenshot");
      const size = fullPage ? "" : " AND width=? AND height=?";
      const dims = fullPage ? [] : [mobile ? 390 : 1440, mobile ? 844 : 900];
      const cached = await db.prepare("SELECT " + CAPTURE_FIELDS + " FROM captures WHERE review_id=? AND page_id=? AND label=?" + size + " ORDER BY rowid DESC LIMIT 1")
        .bind(review.id, page.id, label, ...dims).first();
      if (cached) return responseFor(cached);
    }
    const current = await db.prepare("SELECT count(*) AS n FROM captures WHERE review_id=?").bind(review.id).first();
    if (current.n >= MAX_SCREENSHOTS) fail(409, "This review already has 10 screenshots.");
    body = await automaticCapture(env, {reviewId: review.id, pageUrl:target.href, device:body.device, fullPage});
  }
  const label = stringField(body.label, 100, "screenshot name", "Screenshot");
  const shot = readCapture(body);
  if (!page) page = await ensureCapturePage(db, review, target);
  const {row, created} = await storeCapture(db, review.id, page.id, label, shot, {
    maxCount: MAX_SCREENSHOTS, maxBytes: MAX_TOTAL_SCREENSHOT_BYTES, hash
  });
  return responseFor(row, created);
}

async function noteResponse(env, db, reviewId, row, startingPageId, status = 200) {
  const response = {note: publicNote(row)};
  if (row.pageId !== startingPageId) {
    const page = await db.prepare("SELECT id,url,label FROM pages WHERE review_id=? AND id=?").bind(reviewId, row.pageId).first();
    if (page) response.page = publicPage(env, page);
  }
  return json(response, status);
}

async function addNote(request, env, db, review) {
  const body = await readBody(request, 48 * 1024);
  if (typeof body.clientId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(body.clientId)) fail(400, "The note identifier is invalid. Please try again.");
  const findExisting = () => db.prepare("SELECT " + NOTE_FIELDS + " FROM notes WHERE review_id=? AND client_id=?").bind(review.id, body.clientId).first();
  const existing = await findExisting();
  if (existing) return noteResponse(env, db, review.id, existing, body.pageId);
  if (review.closed) fail(409, "This round is closed for feedback.");
  const pageId = body.pageId;
  const captureId = body.captureId ?? null;
  if (!ITEM_ID.test(pageId) || (captureId !== null && !ITEM_ID.test(captureId))) fail(400, "Choose a valid page or screenshot.");
  const context = parseContext(body.context, review.host);
  const point = context.annotation?.point;
  const x = point?.[0] ?? body.x ?? null, y = point?.[1] ?? body.y ?? null;
  if ((x !== null || y !== null) && (![x,y].every(v => Number.isFinite(v) && v >= 0 && v <= 1))) fail(400, "Choose a spot on the page.");
  const name = stringField(body.name, 80, "reviewer name", "Guest");
  const note = stringField(body.text, 3000, "note");
  let navigatedUrl = null;
  if (!captureId && context.pageUrl) {
    const startingPage = await db.prepare("SELECT url FROM pages WHERE review_id=? AND id=?").bind(review.id, pageId).first();
    if (!startingPage) fail(404, "The selected page is not part of this review.");
    if (publicUrl(startingPage.url).href !== context.pageUrl) navigatedUrl = new URL(context.pageUrl);
  }
  const id = crypto.randomUUID();
  const writes = [];
  if (navigatedUrl) {
    // Following a link should only add a page to the board when somebody
    // actually comments on it. The page and note share one D1 transaction.
    const label = navigatedUrl.pathname === "/" ? "Homepage" : navigatedUrl.pathname.slice(0, 100);
    writes.push(db.prepare(`
      INSERT INTO pages(id,review_id,url,label)
      SELECT ?1,?2,?3,?4 WHERE EXISTS (SELECT 1 FROM reviews WHERE id=?2 AND closed=0)
        AND (SELECT COUNT(*) FROM pages WHERE review_id=?2) < ?5
        AND (SELECT COUNT(*) FROM notes WHERE review_id=?2) < ?6
        AND NOT EXISTS (SELECT 1 FROM notes WHERE review_id=?2 AND client_id=?7)
      ON CONFLICT(review_id,url) DO NOTHING`)
      .bind(crypto.randomUUID(), review.id, navigatedUrl.href, label, MAX_PAGES, MAX_NOTES, body.clientId));
  }
  const destination = navigatedUrl ? "p.url" : "p.id";
  writes.push(db.prepare(`
    INSERT INTO notes(id,review_id,page_id,capture_id,client_id,x,y,name,text,context,created_at)
    SELECT ?1,?2,p.id,?3,?4,?5,?6,?7,?8,?9,?10 FROM pages p JOIN reviews r ON r.id=p.review_id
    WHERE p.review_id=?2 AND ${destination}=?11 AND r.closed=0
      AND (?3 IS NULL OR EXISTS (SELECT 1 FROM captures WHERE id=?3 AND page_id=p.id AND review_id=?2))
      AND (SELECT COUNT(*) FROM notes WHERE review_id=?2) < ?12
    ON CONFLICT(review_id,client_id) DO NOTHING`)
    .bind(id, review.id, captureId, body.clientId, x, y, name, note, JSON.stringify(context), new Date().toISOString(), navigatedUrl?.href || pageId, MAX_NOTES));
  const results = await db.batch(writes);
  const saved = await findExisting();
  if (!saved) fail(409, "This note could not be saved. Check that the review is open and has room for this page and note.");
  return noteResponse(env, db, review.id, saved, pageId, results.at(-1).meta.changes ? 201 : 200);
}

function extensionMethod(pathname) {
  if (pathname === "/api/reviews") return "POST";
  const [, api, reviews, invite, operation, ...rest] = pathname.split("/");
  if (api !== "api" || reviews !== "reviews" || !INVITE.test(invite || "") || rest.length) return null;
  if (operation === undefined) return "GET";
  return EXTENSION_WRITE_ROUTES.has(operation) ? "POST" : null;
}

async function handleApi(request, env, url) {
  const db = env.DB;
  if (!db) fail(503, "Review storage is currently unavailable.");
  const parts = url.pathname.split("/").slice(1);
  if (parts[0] !== "api" || parts[1] !== "reviews") fail(404, "Route not found.");
  const method = request.method;
  const origin = request.headers.get("Origin");
  if (origin === EXTENSION_ORIGIN) {
    const allowed = extensionMethod(url.pathname);
    if (method === "OPTIONS") {
      if (!allowed || request.headers.get("Access-Control-Request-Method") !== allowed) {
        fail(403, "This action is unavailable in the extension.");
      }
      const requested = request.headers.get("Access-Control-Request-Headers") || "";
      if (requested && requested.split(",").some(h => !["content-type", "authorization", "accept"].includes(h.trim().toLowerCase()))) {
        fail(403, "Unsupported extension request headers.");
      }
      return new Response(null, {status:204, headers:{
        "Access-Control-Allow-Methods":allowed, "Access-Control-Allow-Headers":"Content-Type, Authorization, Accept",
        "Cache-Control":"private, no-store"
      }});
    }
    if (method !== allowed) fail(403, "This action is unavailable in the extension.");
  } else if (origin && origin !== url.origin && !["GET", "HEAD"].includes(method)) {
    fail(403, "Open this review to make changes.");
  }
  if (parts.length === 2 && method === "POST") return createReview(request, env, db);
  const [, , invite, route, item, action] = parts;
  if (!INVITE.test(invite || "") || parts.length > 6) fail(404, "Review not found.");
  const review = await lookup(db, invite);
  if (!review) fail(404, "Review not found.");
  const id = review.id;
  const authorization = request.headers.get("Authorization");
  let owner = false;
  if (authorization) {
    const credential = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
    if (!credential || await hash(credential[1]) !== review.owner_hash) fail(403, "This owner link is invalid.");
    owner = true;
  }
  if (!owner && review.active_invite !== invite) fail(404, "This invite has been replaced. Ask the review owner for a current link.");
  if (parts.length === 3 && method === "GET") {
    const [pages, captures, notes] = await db.batch([
      db.prepare("SELECT id,url,label FROM pages WHERE review_id=? ORDER BY rowid").bind(id),
      db.prepare("SELECT " + CAPTURE_FIELDS + " FROM captures WHERE review_id=? ORDER BY rowid").bind(id),
      db.prepare("SELECT " + NOTE_FIELDS + " FROM notes WHERE review_id=? ORDER BY created_at,rowid").bind(id)
    ]);
    return json({review: publicReview(review, owner), pages: pages.results.map(r => publicPage(env, r)),
      captures: captures.results.map(r => publicCapture(review.active_invite, r)), notes: notes.results.map(publicNote)});
  }
  if (parts.length === 6 && route === "captures" && ITEM_ID.test(item) && action === "image" && ["GET","HEAD"].includes(method)) {
    return storedImage(db, id, item, url.searchParams.get("tile"), method);
  }
  if (parts.length === 6 && route === "pages" && ITEM_ID.test(item) && action === "frame-policy" && method === "GET") {
    const page = await db.prepare("SELECT url FROM pages WHERE review_id=? AND id=?").bind(id, item).first();
    if (!page) fail(404, "This page is outside the review.");
    const status = await probeFramePolicy(page.url, url.origin);
    return json({blocked: status === "blocked"});
  }
  if (parts.length === 4 && route === "notes" && method === "POST") return addNote(request, env, db, review);
  if (parts.length === 4 && ["captures","auto-captures"].includes(route) && method === "POST") {
    if (review.closed) fail(409, "This round is closed for feedback.");
    return addCapture(request, env, db, review, route === "auto-captures", owner);
  }
  if (!owner) fail(403, "Use your private owner link for this change.");
  if (parts.length === 4 && route === "rotate-invite" && method === "POST") {
    await readBody(request);
    const replacement = token(18);
    await db.prepare("INSERT INTO review_links(review_id,invite) VALUES(?,?) ON CONFLICT(review_id) DO UPDATE SET invite=excluded.invite").bind(id,replacement).run();
    const updated = publicReview({...review, active_invite: replacement}, true);
    return json({review: updated, reviewerPath: updated.reviewerPath});
  }
  if (parts.length === 3 && method === "PATCH") {
    const body = await readBody(request);
    if (typeof body.closed !== "boolean") fail(400, "Choose whether the round is closed.");
    await db.prepare("UPDATE reviews SET closed=? WHERE id=?").bind(+body.closed, id).run();
    return json({review: publicReview({...review, closed: body.closed}, owner)});
  }
  if (parts.length === 5 && route === "notes" && ITEM_ID.test(item) && method === "PATCH") {
    const body = await readBody(request);
    if (typeof body.resolved !== "boolean") fail(400, "Choose a note status.");
    const changed = await db.prepare("UPDATE notes SET resolved=? WHERE review_id=? AND id=? RETURNING " + NOTE_FIELDS).bind(+body.resolved, id, item).first();
    if (!changed) fail(404, "Note not found.");
    return json({note: publicNote(changed)});
  }
  if (review.closed) fail(409, "This round is closed for feedback.");
  if (parts.length === 4 && route === "pages" && method === "POST") return addPage(request, env, db, review);
  fail(404, "Route not found.");
}

async function routeRequest(request, env, url) {
  if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 2 && INVITE.test(parts[1]) && ["GET","HEAD"].includes(request.method)) {
    const row = await lookup(env.DB, parts[1]);
    if (!row || row.host !== parts[0]) return new Response("Review not found. Check the complete invite link.", {status: 404});
    return env.ASSETS.fetch(new Request(new URL("/", url), {method: request.method}));
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let response;
    try { response = await routeRequest(request, env, url); }
    catch (error) {
      const expected = error instanceof ApiError || error instanceof CaptureError || error instanceof CaptureStorageError;
      if (!expected) console.error("Site review request failed", error?.name || "Error");
      response = json({error: expected ? error.message : "Site Review is temporarily unavailable. Please try again."}, expected ? error.status : 503);
    }
    const headers = new Headers(response.headers);
    if (request.headers.get("Origin") === EXTENSION_ORIGIN && extensionMethod(url.pathname)) {
      headers.set("Access-Control-Allow-Origin", EXTENSION_ORIGIN);
      headers.append("Vary", "Origin");
    }
    const demo = url.pathname.startsWith("/demo/");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    headers.set("X-Frame-Options", demo ? "SAMEORIGIN" : "DENY");
    headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' https:; frame-ancestors " + (demo ? "'self'" : "'none'") + "; base-uri 'none'; form-action 'none'; object-src 'none'");
    if (url.pathname === "/live.js") headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    if (response.headers.get("Content-Type")?.includes("text/html")) headers.set("Cache-Control", "private, no-store");
    return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
  }
};
