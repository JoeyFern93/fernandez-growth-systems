import { automaticCapture, canAutomaticallyCapture, CaptureError } from "./capture.js";

const MAX_SCREENSHOT_BYTES = 1310720;
const MAX_SCREENSHOTS = 10;
const MAX_NOTES = 300;
const MAX_PAGES = 30;
const MAX_TOTAL_SCREENSHOT_BYTES = 200 * 1024 * 1024;
const INVITE = /^[A-Za-z0-9_-]{24}$/;
const ITEM_ID = /^[0-9a-f-]{36}$/;
const CAPTURE_FIELDS = "id, page_id AS pageId, label, width, height";
const NOTE_FIELDS = "id, page_id AS pageId, capture_id AS captureId, x, y, name, text, context, created_at AS createdAt, resolved";

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
  if (expectedHost && host !== expectedHost) fail(400, "Add a page from " + expectedHost + ".");
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
  return {id: owner ? row.id : invite, host: row.host, url: row.url, title: row.title, closed: !!row.closed,
    role: owner ? "owner" : "reviewer", reviewerPath: "/" + row.host + "/" + invite};
}
function lookup(db, invite) {
  return db.prepare("SELECT r.id,r.host,r.url,r.title,r.closed,r.owner_hash,COALESCE(l.invite,r.id) AS active_invite FROM reviews r LEFT JOIN review_links l ON l.review_id=r.id WHERE r.id=? OR r.id=(SELECT review_id FROM review_links WHERE invite=?)").bind(invite, invite).first();
}
function publicPage(env, row) {
  return {id: row.id, url: row.url, label: row.label, autoCaptureAvailable: canAutomaticallyCapture(env, row.url)};
}
function publicCapture(reviewId, row) {
  return {...row, imageUrl: "/api/reviews/" + reviewId + "/captures/" + row.id + "/image"};
}
function publicNote(row) {
  return {...row, context: JSON.parse(row.context), resolved: !!row.resolved};
}
function parseContext(input, host) {
  if (input == null) return "{}";
  if (typeof input !== "object" || Array.isArray(input) || JSON.stringify(input).length > 3600) {
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
  return JSON.stringify(context);
}

function dimensions(data, type) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ascii = (start, length) => String.fromCharCode(...data.subarray(start, start + length));
  if (type === "image/png" && data.length >= 33 && data[0] === 137 && ascii(1, 7) === "PNG\r\n\x1a\n" && ascii(12, 4) === "IHDR") {
    return [view.getUint32(16), view.getUint32(20)];
  }
  if (type === "image/jpeg" && data.length > 8 && data[0] === 255 && data[1] === 216) {
    let pos = 2;
    while (pos + 4 < data.length && data[pos] === 255) {
      while (pos < data.length && data[pos] === 255) pos++;
      const marker = data[pos++];
      if (marker === 0xda || marker === 0xd9 || pos + 2 > data.length) break;
      const size = view.getUint16(pos);
      if (size < 2 || pos + size > data.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 8) {
        return [view.getUint16(pos + 5), view.getUint16(pos + 3)];
      }
      pos += size;
    }
  }
  if (type === "image/webp" && data.length >= 30 && ascii(0,4) === "RIFF" && ascii(8,4) === "WEBP") {
    const chunk = ascii(12,4);
    if (chunk === "VP8X") {
      const uint24 = i => data[i] | data[i + 1] << 8 | data[i + 2] << 16;
      return [1 + uint24(24), 1 + uint24(27)];
    }
    if (chunk === "VP8L" && data[20] === 47) {
      const bits = view.getUint32(21, true);
      return [1 + (bits & 16383), 1 + (bits >>> 14 & 16383)];
    }
    if (chunk === "VP8 " && data[23] === 157 && data[24] === 1 && data[25] === 42) {
      return [view.getUint16(26, true) & 16383, view.getUint16(28, true) & 16383];
    }
  }
  fail(400, "Upload a valid PNG, JPEG, or WebP screenshot.");
}
function fromBase64(encoded) {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(encoded);
  const decoded = atob(encoded);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}
function checkedImage(body) {
  if (typeof body.dataUrl !== "string") fail(400, "Choose a screenshot.");
  const format = /^data:(image\/(?:png|jpeg|webp));base64,/.exec(body.dataUrl);
  if (!format) fail(400, "Use a PNG, JPEG, or WebP screenshot.");
  const encoded = body.dataUrl.slice(format[0].length);
  if (encoded.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4) fail(413, "Use a screenshot under 1.25 MiB.");
  let bytes;
  try { bytes = fromBase64(encoded); } catch { fail(400, "The screenshot could not be read."); }
  if (bytes.length > MAX_SCREENSHOT_BYTES) fail(413, "Use a screenshot under 1.25 MiB.");
  const [width, height] = dimensions(bytes, format[1]);
  if (width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 24000000) {
    fail(400, "Resize this screenshot before uploading.");
  }
  return {encoded, width, height, length: bytes.length, type: format[1]};
}

async function createReview(request, env, db) {
  const body = await readBody(request);
  const url = publicUrl(body.url);
  const title = stringField(body.title, 100, "review title", url.hostname);
  const id = token(18);
  const owner = token(32);
  const pageId = crypto.randomUUID();
  const date = new Date().toISOString();
  const day = date.slice(0, 10);
  const bucket = await hash(day + "/" + (request.headers.get("CF-Connecting-IP") || "local"));
  const results = await db.batch([
    db.prepare("INSERT INTO reviews(id, owner_hash, host, url, title, created_at, creation_bucket) SELECT ?,?,?,?,?,?,? WHERE (SELECT count(*) FROM reviews WHERE creation_bucket=?) < 12 AND (SELECT count(*) FROM reviews WHERE created_at >= ?) < 100")
      .bind(id, await hash(owner), url.hostname, url.href, title, date, bucket, bucket, day),
    db.prepare("INSERT INTO pages(id, review_id, url, label) SELECT ?,id,?,? FROM reviews WHERE id=?")
      .bind(pageId, url.href, url.pathname === "/" ? "Homepage" : url.pathname.slice(0, 100), id)
  ]);
  if (!results[0].meta.changes) fail(429, "The daily review creation limit has been reached. Try again tomorrow.");
  const path = "/" + url.hostname + "/" + id;
  return json({reviewerPath: path, ownerPath: path + "#owner=" + owner,
    review: publicReview({id, host: url.hostname, url: url.href, title, closed: false}, true)}, 201);
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
async function addCapture(request, env, db, review, auto) {
  let body = await readBody(request, auto ? 2000 : 1752000);
  const page = await db.prepare("SELECT id,url FROM pages WHERE review_id=? AND id=?").bind(review.id, String(body.pageId || "")).first();
  if (!page) fail(404, "Page not found.");
  if (auto) {
    if (!["mobile","desktop"].includes(body.device)) fail(400, "Choose a mobile or desktop capture.");
    const current = await db.prepare("SELECT count(*) AS n FROM captures WHERE review_id=?").bind(review.id).first();
    if (current.n >= MAX_SCREENSHOTS) fail(409, "This review already has 10 screenshots.");
    body = await automaticCapture(env, {reviewId: review.id, pageUrl: page.url, device: body.device});
  }
  const image = checkedImage(body);
  const label = stringField(body.label, 100, "screenshot name", "Screenshot");
  // A retry after a lost mobile response must not consume a second screenshot slot.
  const digest = await hash([review.id, page.id, label, image.encoded].join("\0"));
  const id = [digest.slice(0,8),digest.slice(8,12),digest.slice(12,16),digest.slice(16,20),digest.slice(20,32)].join("-");
  const result = await db.prepare("INSERT INTO captures(id,review_id,page_id,label,width,height,media_type,byte_length,image_data) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM reviews WHERE id=? AND closed=0) AND (SELECT count(*) FROM captures WHERE review_id=?) < ? AND (SELECT COALESCE(SUM(byte_length),0) FROM captures) <= ? ON CONFLICT(id) DO NOTHING")
    .bind(id, review.id, page.id, label, image.width, image.height, image.type, image.length, image.encoded, review.id, review.id, MAX_SCREENSHOTS, MAX_TOTAL_SCREENSHOT_BYTES-image.length).run();
  if (!result.meta.changes && !await db.prepare("SELECT id FROM captures WHERE review_id=? AND id=?").bind(review.id, id).first()) {
    fail(409, "The round is closed or screenshot storage is full. You can still leave a page note on an open round.");
  }
  return json({capture: publicCapture(review.active_invite, {id, pageId: page.id, label, width: image.width, height: image.height})}, result.meta.changes ? 201 : 200);
}

async function addNote(request, db, review) {
  const body = await readBody(request);
  if (typeof body.clientId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(body.clientId)) fail(400, "The note identifier is invalid. Please try again.");
  const findExisting = () => db.prepare("SELECT " + NOTE_FIELDS + " FROM notes WHERE review_id=? AND client_id=?").bind(review.id, body.clientId).first();
  const existing = await findExisting();
  if (existing) return json({note: publicNote(existing)});
  if (review.closed) fail(409, "This round is closed for feedback.");
  const pageId = body.pageId;
  const captureId = body.captureId ?? null;
  if (!ITEM_ID.test(pageId) || (captureId !== null && !ITEM_ID.test(captureId))) fail(400, "Choose a valid page or screenshot.");
  const x = body.x ?? null, y = body.y ?? null;
  if ((x !== null || y !== null) && (![x,y].every(v => Number.isFinite(v) && v >= 0 && v <= 1))) fail(400, "Choose a spot on the page.");
  const name = stringField(body.name, 80, "reviewer name");
  const note = stringField(body.text, 3000, "note");
  const details = parseContext(body.context, review.host);
  const id = crypto.randomUUID();
  const result = await db.prepare("INSERT INTO notes(id,review_id,page_id,capture_id,client_id,x,y,name,text,context,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM pages JOIN reviews ON pages.review_id=reviews.id WHERE pages.id=? AND reviews.id=? AND reviews.closed=0) AND (? IS NULL OR EXISTS (SELECT 1 FROM captures WHERE id=? AND page_id=? AND review_id=?)) AND (SELECT count(*) FROM notes WHERE review_id=?) < ? ON CONFLICT(review_id,client_id) DO NOTHING")
    .bind(id, review.id, pageId, captureId, body.clientId, x, y, name, note, details, new Date().toISOString(), pageId, review.id, captureId, captureId, pageId, review.id, review.id, MAX_NOTES).run();
  const saved = await findExisting();
  if (!saved) fail(409, "This note could not be saved. Check that the round is open, the page or screenshot exists, and there are fewer than 300 notes.");
  return json({note: publicNote(saved)}, result.meta.changes ? 201 : 200);
}

async function handleApi(request, env, url) {
  const db = env.DB;
  if (!db) fail(503, "Review storage is currently unavailable.");
  const parts = url.pathname.split("/").slice(1);
  if (parts[0] !== "api" || parts[1] !== "reviews") fail(404, "Route not found.");
  const method = request.method;
  if (!["GET", "HEAD"].includes(method)) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) fail(403, "Open this review to make changes.");
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
    const asset = await db.prepare("SELECT media_type, byte_length" + (method === "HEAD" ? "" : ", image_data") + " FROM captures WHERE review_id=? AND id=?").bind(id, item).first();
    if (!asset) fail(404, "Screenshot not found.");
    return new Response(method === "HEAD" ? null : fromBase64(asset.image_data), {
      headers: {"Content-Type": asset.media_type, "Content-Length": String(asset.byte_length), "Cache-Control": "private, no-store", "Cross-Origin-Resource-Policy": "same-origin"}
    });
  }
  if (parts.length === 4 && route === "notes" && method === "POST") return addNote(request, db, review);
  if (parts.length === 4 && route === "captures" && method === "POST") {
    if (review.closed) fail(409, "This round is closed for feedback.");
    return addCapture(request, env, db, review, false);
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
  if (parts.length === 4 && route === "auto-captures" && method === "POST") return addCapture(request, env, db, review, true);
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
      const expected = error instanceof ApiError || error instanceof CaptureError;
      if (!expected) console.error("Site review request failed", error?.name || "Error");
      response = json({error: expected ? error.message : "Site Review is temporarily unavailable. Please try again."}, expected ? error.status : 503);
    }
    const headers = new Headers(response.headers);
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
