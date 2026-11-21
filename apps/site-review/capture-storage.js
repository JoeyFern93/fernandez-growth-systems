// Capture metadata stays on the original row so existing reviews keep their image URLs.
// Larger images use individually readable parts within D1's per-row size limit.
const KiB = 1024;
const MiB = KiB * KiB;
const INLINE_LIMIT = 1.25 * MiB;
const CAPTURE_LIMIT = 10 * MiB;
const MAX_TILES = 24;
const PART_CHARS = 1024 * KiB; // A multiple of four: each part decodes independently.
const PARTS_TYPE = 'application/x-fgs-capture-parts';

export const CAPTURE_BODY_LIMIT = 4 * Math.ceil(CAPTURE_LIMIT / 3) + 24 * KiB;
export const CAPTURE_FIELDS = "id, page_id AS pageId, label, width, height, CASE WHEN media_type='application/x-fgs-capture-parts' THEN image_data END AS layout";
export class CaptureStorageError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new CaptureStorageError(status, message); }

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
function readImage(dataUrl, tile) {
  if (typeof dataUrl !== 'string') fail(400, 'Choose a screenshot.');
  const format = /^data:(image\/(?:png|jpeg|webp));base64,/.exec(dataUrl);
  if (!format) {
    if (dataUrl.length > Math.ceil(INLINE_LIMIT / 3) * 4 + 128) fail(413, 'Use a JPEG for a larger screenshot.');
    fail(400, 'Use a PNG, JPEG, or WebP screenshot.');
  }
  const type = format[1], encoded = dataUrl.slice(format[0].length);
  const longJpeg = !tile && type === 'image/jpeg';
  const maximum = longJpeg ? CAPTURE_LIMIT : INLINE_LIMIT;
  const overflow = longJpeg ? 'Use a screenshot of 10 MiB or less.' : 'Use a screenshot or tile of 1.25 MiB or less.';
  if (encoded.length > 4 * Math.ceil(maximum / 3)) fail(413, overflow);
  if (!encoded.length || /[^A-Za-z0-9+/=]/.test(encoded)) fail(400, 'The screenshot could not be read.');
  let bytes;
  try { bytes = fromBase64(encoded); } catch { fail(400, 'The screenshot could not be read.'); }
  if (bytes.length > maximum) fail(413, overflow);
  const [width, height] = dimensions(bytes, type);
  if (width < 1 || height < 1 || width > 16384 || height > (longJpeg ? 60000 : 16384) ||
      width * height > (longJpeg ? 60000000 : 24000000)) fail(400, 'Resize this screenshot before uploading.');
  return {width, height, type, encoded, length: bytes.length};
}

export function readCapture(body) {
  const tiled = body.tiles !== undefined;
  let entries;
  if (tiled) {
    if (body.dataUrl !== undefined || !Array.isArray(body.tiles) || !body.tiles.length || body.tiles.length > MAX_TILES) {
      fail(400, 'Use one screenshot or up to 24 image tiles.');
    }
    entries = body.tiles;
  } else entries = [body];
  let height = 0, length = 0;
  const images = [];
  for (const entry of entries) {
    const image = readImage(entry?.dataUrl, tiled);
    if (images.length && image.width !== images[0].width) fail(400, 'Screenshot tiles must have the same width.');
    height += image.height;
    length += image.length;
    if (height > 100000) fail(400, 'The full-page screenshot is too tall.');
    if (length > CAPTURE_LIMIT) fail(413, 'Use a screenshot of 10 MiB or less.');
    images.push(image);
  }
  return {tiled, images, width: images[0].width, height, length};
}

const createParts = `CREATE TABLE IF NOT EXISTS capture_image_parts (
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  tile_index INTEGER NOT NULL,
  part_index INTEGER NOT NULL,
  image_data TEXT NOT NULL,
  PRIMARY KEY(capture_id, tile_index, part_index)
) WITHOUT ROWID`;

export function publicCapture(invite, {layout, ...row}) {
  const imageUrl = '/api/reviews/' + invite + '/captures/' + row.id + '/image';
  const capture = {...row, imageUrl};
  const manifest = layout && JSON.parse(layout);
  if (manifest?.tiled) {
    capture.tiles = manifest.images.map(({width, height}, index) => ({width, height, imageUrl: imageUrl + '?tile=' + index}));
  }
  return capture;
}

export async function storeCapture(db, reviewId, pageId, label, shot, {maxCount, maxBytes, hash}) {
  const first = shot.images[0];
  let identity = first.encoded;
  if (shot.tiled || shot.length > INLINE_LIMIT) {
    // Hash each part separately so a large base64 copy is never needed for the whole stack.
    const digests = [];
    for (const image of shot.images) {
      for (let offset = 0; offset < image.encoded.length; offset += PART_CHARS) {
        digests.push(await hash(image.encoded.slice(offset, offset + PART_CHARS)));
      }
      digests.push(image.type + '/' + image.length);
    }
    identity = (shot.tiled ? 'tiles:' : 'parts:') + digests.join('|');
  }
  const digest = await hash([reviewId, pageId, label, identity].join('\0'));
  const id = [digest.slice(0,8),digest.slice(8,12),digest.slice(12,16),digest.slice(16,20),digest.slice(20,32)].join('-');
  const segmented = shot.tiled || shot.length > INLINE_LIMIT;
  const manifest = segmented ? JSON.stringify({tiled:shot.tiled, images:shot.images.map(image => ({
    width:image.width, height:image.height, length:image.length, type:image.type, parts:Math.ceil(image.encoded.length / PART_CHARS)
  }))}) : null;
  const insert = db.prepare(`INSERT INTO captures(id,review_id,page_id,label,width,height,media_type,byte_length,image_data)
    SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM reviews WHERE id=? AND closed=0)
    AND (SELECT count(*) FROM captures WHERE review_id=?) < ?
    AND (SELECT COALESCE(SUM(byte_length),0) FROM captures) <= ? ON CONFLICT(id) DO NOTHING`)
    .bind(id, reviewId, pageId, label, shot.width, shot.height, segmented ? PARTS_TYPE : first.type,
      shot.length, manifest || first.encoded, reviewId, reviewId, maxCount, maxBytes - shot.length);

  let result;
  if (segmented) {
    // Older databases acquire this additive table on their first segmented upload.
    await db.prepare(createParts).run();
    const writes = [insert];
    for (const [index, image] of shot.images.entries()) {
      for (let pos = 0; pos < image.encoded.length; pos += PART_CHARS) {
        writes.push(db.prepare(`INSERT INTO capture_image_parts(capture_id,tile_index,part_index,image_data)
          SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM captures WHERE review_id=? AND id=?)
          ON CONFLICT(capture_id,tile_index,part_index) DO NOTHING`)
          .bind(id, index, pos / PART_CHARS, image.encoded.slice(pos, pos + PART_CHARS), reviewId, id));
      }
    }
    // The parent and all pixels become visible together, or D1 rolls the entire batch back.
    [result] = await db.batch(writes);
  } else result = await insert.run();
  const created = result.meta.changes > 0;
  if (!created && !await db.prepare('SELECT id FROM captures WHERE review_id=? AND id=?').bind(reviewId,id).first()) {
    fail(409, 'The round is closed or screenshot storage is full. You can still leave a page note on an open round.');
  }
  return {created, row:{id, pageId, label, width:shot.width, height:shot.height, layout:manifest}};
}

export async function storedImage(db, reviewId, captureId, tileQuery, method) {
  if (tileQuery !== null && !/^(?:0|[1-9]\d?)$/.test(tileQuery)) fail(404, 'Screenshot tile not found.');
  const index = Number(tileQuery);
  // HEAD only needs the small manifest for segmented images.
  const pixels = method === 'HEAD' ? "CASE WHEN media_type='application/x-fgs-capture-parts' THEN image_data END" : 'image_data';
  const asset = await db.prepare('SELECT media_type,byte_length,' + pixels + ' AS payload FROM captures WHERE review_id=? AND id=?')
    .bind(reviewId,captureId).first();
  if (!asset) fail(404, 'Screenshot not found.');
  let type = asset.media_type, length = asset.byte_length, body = null;
  if (type === PARTS_TYPE) {
    const image = JSON.parse(asset.payload).images[index];
    if (!image) fail(404, 'Screenshot tile not found.');
    type = image.type;
    length = image.length;
    if (method !== 'HEAD') {
      let part = 0;
      body = new ReadableStream({async pull(controller) {
        const row = await db.prepare('SELECT image_data FROM capture_image_parts WHERE capture_id=? AND tile_index=? AND part_index=?')
          .bind(captureId,index,part).first();
        if (!row) throw new Error('Stored screenshot is incomplete.');
        controller.enqueue(fromBase64(row.image_data));
        if (++part === image.parts) controller.close();
      }});
    }
  } else {
    if (index !== 0) fail(404, 'Screenshot tile not found.');
    if (method !== 'HEAD') body = fromBase64(asset.payload);
  }
  return new Response(body, {headers:{'Content-Type':type,'Content-Length':String(length),
    'Cache-Control':'private, no-store','Cross-Origin-Resource-Policy':'same-origin'}});
}
