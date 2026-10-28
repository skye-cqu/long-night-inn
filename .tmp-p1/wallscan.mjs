import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = 'D:/Projects/群核Aholo全球3D AI黑客松/游戏工程';
globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.ImageData = class ImageData { constructor(...a){ Object.assign(this, { width: a[1], height: a[2], data: a[0] }); } };
globalThis.self = globalThis; globalThis.window = globalThis;
globalThis.document = { addEventListener(){}, removeEventListener(){}, pointerLockElement: null, hidden: false };
const { VoxelCollision } = await import(pathToFileURL(root + '/.tmp-p1/wc-after.cjs').href);
const meta = JSON.parse(readFileSync(root + '/public/assets/collision-n3.voxel-meta.json', 'utf8'));
const bin = readFileSync(root + '/public/assets/collision-n3.voxel.bin');
const u32 = new Uint32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + Math.floor(bin.byteLength / 4) * 4));
const n = meta.nodeCount >>> 0, dd = meta.leafDataCount >>> 0;
const col = new VoxelCollision(meta, u32.slice(0, n), u32.slice(n, n + dd));
// 胶囊口径占位测试（feet y=2.7，身高 1.5 半 0.12）
const HALF = 1.5 / 2 - 0.12, R = 0.12;
const solidAt = (x, z, feetY) => col.queryCapsule(x, feetY + 1.5 / 2, z, HALF, R, { x: 0, y: 0, z: 0 });
console.log('z=0.55 线（门洞中线）: x 0.6→7.0 每 0.25m，feetY 扫 2.3/2.7/3.1');
for (let x = 0.6; x <= 7.0; x += 0.25) {
  const marks = [2.3, 2.7, 3.1].map(fy => solidAt(x, 0.55, fy) ? '█' : '·');
  console.log(`x=${x.toFixed(2)} ${marks.join('')}`);
}
console.log('\nz=0.25 线:');
for (let x = 0.6; x <= 7.0; x += 0.25) {
  const marks = [2.3, 2.7, 3.1].map(fy => solidAt(x, 0.25, fy) ? '█' : '·');
  console.log(`x=${x.toFixed(2)} ${marks.join('')}`);
}
