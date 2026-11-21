import {readFile} from 'node:fs/promises';
import path from 'node:path';

// The public download contains only files the extension runs or displays.
const releaseFiles = [
  'manifest.json', 'worker.js', 'full-capture.js', 'overlay.js', 'popup.html', 'popup.css', 'popup.js',
  'icons/16.png', 'icons/32.png', 'icons/48.png', 'icons/128.png'
];

const crcTable = Uint32Array.from({length: 256}, (_, entry) => {
  let crc = entry;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// The small package uses standard uncompressed ZIP entries. Fixed metadata
// gives the same release identical bytes on Windows and on Cloudflare.
export async function extensionZip(directory) {
  const records = [];
  const entries = [];
  let offset = 0;
  for (const file of releaseFiles) {
    const data = await readFile(path.join(directory, file));
    const name = Buffer.from(file);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);      // ZIP 2.0
    local.writeUInt16LE(0x21, 12);   // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    records.push(local, name, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    local.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(offset, 42);
    entries.push(entry, name);
    offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(entries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(releaseFiles.length, 8);
  end.writeUInt16LE(releaseFiles.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, central, end]);
}
