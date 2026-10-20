// Render web/public/icon.svg into a Windows .ico (PNG-compressed entries, 16-256 px).
//
//   node make-icon.mjs <icon.svg> <out.ico>
//
// Needs @resvg/resvg-js installed where Node can resolve it (build.sh installs
// it into a tools folder and sets NODE_PATH).
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { Resvg } = require(require.resolve('@resvg/resvg-js', { paths: (process.env.NODE_PATH ?? '').split(';').filter(Boolean) }));

const [svgPath, out] = process.argv.slice(2);
const svg = readFileSync(svgPath);
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng());

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(sizes.length, 4);
const dir = Buffer.alloc(16 * sizes.length);
let offset = header.length + dir.length;
sizes.forEach((size, i) => {
  const e = i * 16;
  dir.writeUInt8(size >= 256 ? 0 : size, e); // 0 means 256
  dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
  dir.writeUInt8(0, e + 2); // no palette
  dir.writeUInt8(0, e + 3);
  dir.writeUInt16LE(1, e + 4); // colour planes
  dir.writeUInt16LE(32, e + 6); // bits per pixel
  dir.writeUInt32LE(pngs[i].length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
writeFileSync(out, Buffer.concat([header, dir, ...pngs]));
console.log(`Wrote ${out} (${sizes.join(', ')} px)`);
