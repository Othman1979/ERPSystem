import { inflateSync } from 'node:zlib';

/**
 * WOFF 1.0 → plain sfnt (TrueType / OpenType) bytes, using Node's native zlib.
 *
 * Why: fontkit unwraps WOFF with `tiny-inflate`, a pure-JS inflate, and
 * pdfmake builds fresh fontkit objects for every document. Decompressing the
 * glyph, GSUB and GPOS tables again for every PDF cost about two seconds
 * (TRADE-21). Unwrapped once per process, the same bytes parse in
 * milliseconds. The tables are copied unchanged, so the glyphs, shaping and
 * metrics are identical.
 *
 * Layout (https://www.w3.org/TR/WOFF/): 44-byte header, then one 20-byte
 * directory entry per table (tag, offset, compLength, origLength, origChecksum);
 * a table is zlib-compressed when compLength < origLength.
 */
export function woffToSfnt(woff: Buffer): Buffer {
  if (woff.length < 44 || woff.toString('latin1', 0, 4) !== 'wOFF') throw new Error('Not a WOFF 1.0 font');
  const flavor = woff.readUInt32BE(4);
  const numTables = woff.readUInt16BE(12);

  const tables = Array.from({ length: numTables }, (_, i) => {
    const at = 44 + i * 20;
    const offset = woff.readUInt32BE(at + 4);
    const compLength = woff.readUInt32BE(at + 8);
    const origLength = woff.readUInt32BE(at + 12);
    const raw = woff.subarray(offset, offset + compLength);
    const data = compLength < origLength ? inflateSync(raw) : raw;
    if (data.length !== origLength) throw new Error('Corrupt WOFF table');
    return { tag: woff.subarray(at, at + 4), checksum: woff.readUInt32BE(at + 16), data };
  });

  // sfnt: 12-byte header, 16-byte table records sorted by tag, tables 4-byte aligned.
  tables.sort((a, b) => Buffer.compare(a.tag, b.tag));
  let entrySelector = 0;
  while (1 << (entrySelector + 1) <= numTables) entrySelector++;
  const searchRange = (1 << entrySelector) * 16;

  const headerSize = 12 + numTables * 16;
  const total = tables.reduce((sum, t) => sum + ((t.data.length + 3) & ~3), headerSize);
  const out = Buffer.alloc(total);
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(numTables, 4);
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(numTables * 16 - searchRange, 10);

  let offset = headerSize;
  tables.forEach((t, i) => {
    const rec = 12 + i * 16;
    t.tag.copy(out, rec);
    out.writeUInt32BE(t.checksum, rec + 4);
    out.writeUInt32BE(offset, rec + 8);
    out.writeUInt32BE(t.data.length, rec + 12);
    t.data.copy(out, offset);
    offset += (t.data.length + 3) & ~3;
  });
  return out;
}
