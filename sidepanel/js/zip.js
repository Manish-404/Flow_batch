// Minimal ZIP writer (STORE method — PNG/JPG/MP4 are already compressed, so deflating
// them costs CPU and saves almost nothing). The archive is assembled as a Blob from
// per-entry parts, so Chrome can spill a large archive to disk instead of holding it in RAM.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

const MAX32 = 0xffffffff;
const CHUNK = 4 * 1024 * 1024;
const te = new TextEncoder();

/** CRC-32 of a Blob, read in chunks so a huge file never lands in one ArrayBuffer. */
export async function crc32Blob(blob, onChunk) {
  let c = 0xffffffff;
  for (let at = 0; at < blob.size; at += CHUNK) {
    const buf = await blob.slice(at, Math.min(at + CHUNK, blob.size)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    onChunk?.(bytes.length);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buf(len, fill) {
  const b = new Uint8Array(len);
  fill(new DataView(b.buffer), b);
  return b;
}

function dosDateTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    date: (((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
  };
}

function uniqueEntry(name, used) {
  // "/" stays a folder separator inside the archive; every other illegal character becomes "_".
  const clean =
    String(name || 'file')
      .split('/')
      .map((seg) => seg.replace(/[\\:*?"<>|\x00-\x1f]+/g, '_').replace(/^\.+/, ''))
      .filter(Boolean)
      .join('/')
      .slice(0, 180) || 'file';
  const key = clean.toLowerCase();
  if (!used.has(key)) {
    used.add(key);
    return clean;
  }
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : '';
  for (let i = 2; ; i++) {
    const next = `${stem}_${i}${ext}`;
    if (!used.has(next.toLowerCase())) {
      used.add(next.toLowerCase());
      return next;
    }
  }
}

/**
 * files: [{ name, blob }] — `name` is the path inside the archive (duplicates get _2, _3…).
 * Returns a Blob of type application/zip.
 */
export async function buildZip(files, { onProgress, signal } = {}) {
  const parts = [];
  const dir = [];
  const used = new Set();
  const { time, date } = dosDateTime(new Date());
  const totalBytes = files.reduce((n, f) => n + f.blob.size, 0) || 1;
  let read = 0;
  let offset = 0;

  for (const f of files) {
    if (signal?.aborted) throw new Error('Cancelled');
    const name = te.encode(uniqueEntry(f.name, used));
    const size = f.blob.size;
    const crc = await crc32Blob(f.blob, (n) => {
      read += n;
      onProgress?.(read / totalBytes);
    });
    const bigSize = size > MAX32 - 1;
    const bigOffset = offset > MAX32 - 1;

    const localExtra = bigSize
      ? buf(20, (v) => {
          v.setUint16(0, 0x0001, true);
          v.setUint16(2, 16, true);
          v.setBigUint64(4, BigInt(size), true);
          v.setBigUint64(12, BigInt(size), true);
        })
      : new Uint8Array(0);

    const local = buf(30 + name.length + localExtra.length, (v, b) => {
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, bigSize ? 45 : 20, true);
      v.setUint16(6, 0x0800, true); // UTF-8 names
      v.setUint16(8, 0, true); // stored
      v.setUint16(10, time, true);
      v.setUint16(12, date, true);
      v.setUint32(14, crc, true);
      v.setUint32(18, bigSize ? MAX32 : size, true);
      v.setUint32(22, bigSize ? MAX32 : size, true);
      v.setUint16(26, name.length, true);
      v.setUint16(28, localExtra.length, true);
      b.set(name, 30);
      b.set(localExtra, 30 + name.length);
    });
    parts.push(local, f.blob);

    // ZIP64 central extra carries only the fields whose 32-bit slot overflowed, in spec order.
    const z64 = [];
    if (bigSize) z64.push(BigInt(size), BigInt(size));
    if (bigOffset) z64.push(BigInt(offset));
    const cExtraLen = z64.length ? 4 + z64.length * 8 : 0;

    dir.push(
      buf(46 + name.length + cExtraLen, (v, b) => {
        v.setUint32(0, 0x02014b50, true);
        v.setUint16(4, z64.length ? 45 : 20, true);
        v.setUint16(6, z64.length ? 45 : 20, true);
        v.setUint16(8, 0x0800, true);
        v.setUint16(10, 0, true);
        v.setUint16(12, time, true);
        v.setUint16(14, date, true);
        v.setUint32(16, crc, true);
        v.setUint32(20, bigSize ? MAX32 : size, true);
        v.setUint32(24, bigSize ? MAX32 : size, true);
        v.setUint16(28, name.length, true);
        v.setUint16(30, cExtraLen, true);
        v.setUint16(32, 0, true); // comment
        v.setUint16(34, 0, true); // disk
        v.setUint16(36, 0, true); // internal attrs
        v.setUint32(38, 0, true); // external attrs
        v.setUint32(42, bigOffset ? MAX32 : offset, true);
        b.set(name, 46);
        if (z64.length) {
          const at = 46 + name.length;
          v.setUint16(at, 0x0001, true);
          v.setUint16(at + 2, z64.length * 8, true);
          z64.forEach((value, i) => v.setBigUint64(at + 4 + i * 8, value, true));
        }
      })
    );
    offset += local.length + size;
  }

  const dirOffset = offset;
  const dirSize = dir.reduce((n, d) => n + d.length, 0);
  const count = files.length;
  parts.push(...dir);

  if (count > 0xffff || dirSize > MAX32 - 1 || dirOffset > MAX32 - 1) {
    const eocdAt = dirOffset + dirSize;
    parts.push(
      buf(56, (v) => {
        v.setUint32(0, 0x06064b50, true);
        v.setBigUint64(4, 44n, true); // size of this record minus 12
        v.setUint16(12, 45, true);
        v.setUint16(14, 45, true);
        v.setUint32(16, 0, true);
        v.setUint32(20, 0, true);
        v.setBigUint64(24, BigInt(count), true);
        v.setBigUint64(32, BigInt(count), true);
        v.setBigUint64(40, BigInt(dirSize), true);
        v.setBigUint64(48, BigInt(dirOffset), true);
      }),
      buf(20, (v) => {
        v.setUint32(0, 0x07064b50, true);
        v.setUint32(4, 0, true);
        v.setBigUint64(8, BigInt(eocdAt), true);
        v.setUint32(16, 1, true);
      })
    );
  }

  parts.push(
    buf(22, (v) => {
      v.setUint32(0, 0x06054b50, true);
      v.setUint16(4, 0, true);
      v.setUint16(6, 0, true);
      v.setUint16(8, Math.min(count, 0xffff), true);
      v.setUint16(10, Math.min(count, 0xffff), true);
      v.setUint32(12, Math.min(dirSize, MAX32), true);
      v.setUint32(16, Math.min(dirOffset, MAX32), true);
      v.setUint16(20, 0, true);
    })
  );

  onProgress?.(1);
  return new Blob(parts, { type: 'application/zip' });
}
