// Writes a minimal standard 3MF: one mesh object, a base-material group of
// colours, and a material index on every triangle. Slicers (Bambu Studio,
// PrusaSlicer, OrcaSlicer) read those as colour regions for multi-filament
// printing. Pure: no Node APIs, so it runs in the browser too.

import type { IndexedMesh } from './stl.ts';

export interface Material {
  name: string;
  /** #rrggbb */
  color: string;
}

/**
 * `faceMaterial[i]` is the index into `materials` for triangle i (0 = the
 * first material). Returns the bytes of a .3mf file.
 */
export function write3mf(mesh: IndexedMesh, materials: Material[], faceMaterial: Uint8Array, name = 'accessory'): Uint8Array {
  const P = mesh.positions, T = mesh.triangles;
  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  parts.push('<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n');
  parts.push(` <metadata name="Title">${escapeXml(name)}</metadata>\n`);
  parts.push(' <metadata name="Application">Gus Gus Goose fitter</metadata>\n');
  parts.push(' <resources>\n  <basematerials id="1">\n');
  for (const m of materials) parts.push(`   <base name="${escapeXml(m.name)}" displaycolor="${m.color.toUpperCase()}FF" />\n`);
  parts.push('  </basematerials>\n');
  parts.push(`  <object id="2" name="${escapeXml(name)}" type="model" pid="1" pindex="0">\n   <mesh>\n    <vertices>\n`);
  for (let i = 0; i < P.length; i += 3) parts.push(`     <vertex x="${f(P[i])}" y="${f(P[i + 1])}" z="${f(P[i + 2])}" />\n`);
  parts.push('    </vertices>\n    <triangles>\n');
  for (let i = 0; i < T.length; i += 3) {
    const m = faceMaterial[i / 3] ?? 0;
    parts.push(m === 0
      ? `     <triangle v1="${T[i]}" v2="${T[i + 1]}" v3="${T[i + 2]}" />\n`
      : `     <triangle v1="${T[i]}" v2="${T[i + 1]}" v3="${T[i + 2]}" pid="1" p1="${m}" />\n`);
  }
  parts.push('    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build>\n  <item objectid="2" />\n </build>\n</model>\n');
  const model = new TextEncoder().encode(parts.join(''));
  const contentTypes = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />\n</Types>\n');
  const rels = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />\n</Relationships>\n');
  return zipStore([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rels],
    ['3D/3dmodel.model', model],
  ]);
}

const f = (n: number) => (Math.round(n * 10000) / 10000).toString();
const escapeXml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

/** A zip archive with every entry stored uncompressed. */
export function zipStore(entries: [string, Uint8Array][]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true); lv.setUint16(12, 0x21, true); // time/date: fixed
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);
  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of [...locals, ...centrals, end]) { out.set(b, o); o += b.length; }
  return out;
}

let table: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
