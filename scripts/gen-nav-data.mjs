#!/usr/bin/env node
/**
 * gen-nav-data.mjs — 从世界点云（PLY）离线预计算脚手架阶段的导航数据：
 * 走廊包围盒 + 每格地面高度场（两种 up 约定各一份）。产出 public/assets/world-n1.nav.json。
 *
 * 体素碰撞（下一任务）落地后，本文件产出的高度场仅作为兜底/初始机位推导保留。
 *
 * 用法：node scripts/gen-nav-data.mjs [input.ply] [out.json]
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const [plyPath, outPath] = process.argv.length > 2
  ? process.argv.slice(2)
  : [resolve(ROOT, '../资产库/N1雾中松林废站-世界_2026-10-26.ply'), resolve(ROOT, 'public/assets/world-n1.nav.json')];

if (!statSync(plyPath, { throwIfNoEntry: false })) {
  console.error(`找不到输入文件: ${plyPath}`);
  process.exit(1);
}

// ---- 解析 PLY 头 ----
const fd = readFileSync(plyPath);
const headText = fd.subarray(0, 2000).toString('latin1');
const end = headText.indexOf('end_header');
const header = headText.slice(0, end).split(/\r?\n/);
const props = header.filter((l) => l.startsWith('property')).map((l) => l.split(' ').slice(1));
const nV = +header.find((l) => l.startsWith('element vertex')).split(' ')[2];
const headerLen = end + headText.slice(end).indexOf('\n') + 1;
const stride = props.reduce((s, p) => s + (p[0] === 'float' ? 4 : p[0] === 'uchar' ? 1 : 0), 0);
const propOff = (name) => props.slice(0, props.findIndex((p) => p[1] === name)).reduce((s, p) => s + (p[0] === 'float' ? 4 : 1), 0);
const ox = propOff('x'), oy = propOff('y'), oz = propOff('z');

// ---- 统计包围盒 + 按格收集 y ----
const CELL = 0.5;
const QUANTILE = 0.9; // 面向「下侧」的分位点：OpenCV(-Y up) 下侧=+y 取 0.9 分位；+Y up 取 0.1 分位
const MIN_PTS_PER_CELL = 5;

let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
const cellMap = new Map(); // "ix,iz" -> y[]
for (let i = 0; i < nV; i++) {
  const o = headerLen + i * stride;
  const x = fd.readFloatLE(o + ox), y = fd.readFloatLE(o + oy), z = fd.readFloatLE(o + oz);
  if (x < minX) minX = x; if (x > maxX) maxX = x;
  if (y < minY) minY = y; if (y > maxY) maxY = y;
  if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  const key = `${Math.floor((x - minX) / CELL)},${Math.floor((z - minZ) / CELL)}`;
  let arr = cellMap.get(key);
  if (!arr) { arr = []; cellMap.set(key, arr); }
  arr.push(y);
}

const nx = Math.ceil((maxX - minX) / CELL);
const nz = Math.ceil((maxZ - minZ) / CELL);
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

const floorGridNeg = new Array(nx * nz).fill(null); // OpenCV：地面在高 y 侧
const floorGridPos = new Array(nx * nz).fill(null); // glTF 惯例：地面在低 y 侧
for (const [key, ys] of cellMap) {
  if (ys.length < MIN_PTS_PER_CELL) continue;
  ys.sort((a, b) => a - b);
  const [ix, iz] = key.split(',').map(Number);
  const idx = iz * nx + ix;
  floorGridNeg[idx] = +quantile(ys, QUANTILE).toFixed(3);
  floorGridPos[idx] = +quantile(ys, 1 - QUANTILE).toFixed(3);
}
const nonNull = (g) => g.filter((v) => v !== null);
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return +(s[Math.floor(s.length / 2)]).toFixed(3); };
const globalFloorNeg = median(nonNull(floorGridNeg));
const globalFloorPos = median(nonNull(floorGridPos));

const out = {
  bboxMin: [+minX.toFixed(3), +minY.toFixed(3), +minZ.toFixed(3)],
  bboxMax: [+maxX.toFixed(3), +maxY.toFixed(3), +maxZ.toFixed(3)],
  cellSize: CELL,
  nx, nz,
  floorGridNeg, floorGridPos,
  globalFloorNeg, globalFloorPos,
};
writeFileSync(outPath, JSON.stringify(out));
console.log(`nav 数据: ${outPath}`);
console.log(`bbox x[${minX.toFixed(1)},${maxX.toFixed(1)}] y[${minY.toFixed(1)},${maxY.toFixed(1)}] z[${minZ.toFixed(1)},${maxZ.toFixed(1)}] 格子 ${nx}x${nz}`);
console.log(`地面(OpenCV -Y up)=${globalFloorNeg}  地面(+Y up)=${globalFloorPos}  有效格 ${nonNull(floorGridNeg).length}/${nx * nz}`);
