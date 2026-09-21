// Minimal, dependency-free ZIP support for playbook packages: a writer
// (deflate or store, UTF-8 names, explicit folder entries so empty folders
// survive) and a defensive reader for imports (size limits, CRC checks, no
// encryption, no ZIP64). Paths inside an archive are validated by the caller.
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | (Math.floor(d.getSeconds() / 2) & 31),
    date: (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

export class ZipError extends Error {
  constructor(message, code = 'invalid_package') {
    super(message);
    this.code = code;
  }
}

/**
 * Build a ZIP archive.
 * @param entries [{ name: 'Folder/sub/file.json', data: Buffer|string, mtime?: Date }]
 *                or folders: { name: 'Folder/sub/', dir: true }
 */
export function createZip(entries, { maxTotal = 512 * 1024 * 1024 } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  let total = 0;
  if (entries.length > 65000) throw new ZipError('Too many files for one package.', 'package_too_large');
  for (const e of entries) {
    const dir = Boolean(e.dir);
    const name = dir && !e.name.endsWith('/') ? `${e.name}/` : e.name;
    const nameBuf = Buffer.from(name, 'utf8');
    const data = dir ? Buffer.alloc(0) : Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    total += data.length;
    if (total > maxTotal) throw new ZipError('The workspace is too large to package.', 'package_too_large');
    const crc = dir ? 0 : crc32(data);
    let method = 0;
    let body = data;
    if (!dir && data.length > 64) {
      const deflated = zlib.deflateRawSync(data, { level: 6 });
      if (deflated.length < data.length) {
        method = 8;
        body = deflated;
      }
    }
    const { time, date } = dosDateTime(e.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: Unix, spec 2.0 (keeps permissions on macOS/Linux)
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    // Unix mode in the high word, MS-DOS directory flag in the low byte.
    central.writeUInt32LE(dir ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
    if (offset > 0xfffffff0) throw new ZipError('The workspace is too large to package.', 'package_too_large');
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

export function isZip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 22 && buf.readUInt32LE(0) === 0x04034b50;
}

/**
 * Read a ZIP archive defensively. Returns [{ name, dir, data }].
 * Rejects encrypted entries, ZIP64, unknown compression, CRC mismatches and
 * anything beyond the size limits (zip bombs).
 */
export function readZip(buf, { maxEntries = 5000, maxTotal = 200 * 1024 * 1024, maxFile = 50 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('This file is not a ZIP package.');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('This file is not a valid ZIP package (no central directory).');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('ZIP64 packages are not supported.');
  if (count > maxEntries) throw new ZipError(`The package has too many files (${count}; the limit is ${maxEntries}).`);
  if (cdOffset + cdSize > buf.length) throw new ZipError('The ZIP package is truncated.');
  const out = [];
  let p = cdOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('The ZIP package is damaged (bad directory entry).');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x0800 ? rawName.toString('utf8') : rawName.toString('latin1')).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x0001) throw new ZipError(`"${name}" is encrypted. Encrypted packages are not supported.`);
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('ZIP64 packages are not supported.');
    const dir = name.endsWith('/');
    if (dir) {
      out.push({ name, dir: true, data: null });
      continue;
    }
    if (size > maxFile) throw new ZipError(`"${name}" is too large (${Math.round(size / 1048576)} MB; the limit is ${Math.round(maxFile / 1048576)} MB).`);
    total += size;
    if (total > maxTotal) throw new ZipError(`The package is too large when unpacked (limit ${Math.round(maxTotal / 1048576)} MB).`);
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new ZipError(`The ZIP package is damaged ("${name}").`);
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + compSize > buf.length) throw new ZipError(`The ZIP package is truncated ("${name}").`);
    const comp = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(comp, { maxOutputLength: Math.max(size, 1) });
      } catch {
        throw new ZipError(`"${name}" could not be decompressed.`);
      }
    } else throw new ZipError(`"${name}" uses an unsupported compression method (${method}).`);
    if (data.length !== size || crc32(data) !== crc) throw new ZipError(`"${name}" is damaged (checksum mismatch).`);
    out.push({ name, dir: false, data });
  }
  return out;
}
