#!/usr/bin/env node
/**
 * gen-nav-band.mjs — 带限 nav 修正（E10，N5/N6 接入；输入=既有 nav json，纯本地零 API）。
 *
 * 背景（E7/E8 留痕 + N4 验收输入①「底向上定带」）：多层世界的顶向下 nav 会把
 * 高位面混进地面场——N5 书架顶带 y≈9–10（58 格）混在真实地面 y≈2–3（141 格）里；
 * N6 双层口袋花园把高台 y≈9.5–10（67 格）与沉降步道 y≈1–2（27 格）混作一层
 * （85% 可走为假象）。运行时 NavField.floorAt 对非空格直接返回该格高度，实体贴地、
 * 玩家防坠网（|navY-脚|<2.5 信任 nav）都会被杂带带偏 → 接入前按锚定带过滤：
 *   - N5：锚定真实地面 y∈[0.5,5.5]（书架顶整体剔除——E7「出生/寻路锚定 y≈2–3」）
 *   - N6：锚定高台层 y∈[7,12]（沉降步道整体剔除——E8「高台锚定、沉降 L 步道不可行」）
 * 处理=带外格 floor 置 null + globalFloor 重置为带内众数（floorAt 兜底值不落到杂带）。
 * 玩家柱墙判据不在本脚本（运行时碰撞走体素胶囊；选点硬规则见 plan-n5/n6-points.mjs）。
 *
 * 用法：node scripts/gen-nav-band.mjs <in.nav.json> <out.nav.json> <yMin> <yMax>
 * 原始（未带限）nav 以 过程留痕/2026-10-26/任务E7、E8/ 产物为准，本脚本可重复执行。
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';

const [inPath, outPath, yMinArg, yMaxArg] = process.argv.slice(2);
if (!inPath || !outPath || yMinArg === undefined || yMaxArg === undefined) {
  console.error('用法: node scripts/gen-nav-band.mjs <in.nav.json> <out.nav.json> <yMin> <yMax>');
  process.exit(1);
}
for (const f of [inPath]) {
  if (!statSync(f, { throwIfNoEntry: false })) { console.error(`找不到 ${f}`); process.exit(1); }
}
const yMin = Number(yMinArg), yMax = Number(yMaxArg);
if (!(yMax > yMin)) { console.error('yMax 必须大于 yMin'); process.exit(1); }

const nav = JSON.parse(readFileSync(inPath, 'utf8'));
const { nx, nz } = nav;
const kept = [];
let dropped = 0;
const hist = {};
const gridPos = new Array(nx * nz).fill(null);
const gridNeg = new Array(nx * nz).fill(null);
for (let k = 0; k < nx * nz; k++) {
  const v = nav.floorGridPos[k];
  if (v === null) continue;
  if (v >= yMin && v <= yMax) {
    gridPos[k] = v;
    gridNeg[k] = nav.floorGridNeg[k] !== null && nav.floorGridNeg[k] >= yMin && nav.floorGridNeg[k] <= yMax ? nav.floorGridNeg[k] : v;
    kept.push(v);
    const b = Math.round(v);
    hist[b] = (hist[b] || 0) + 1;
  } else {
    dropped++;
  }
}
if (kept.length === 0) { console.error(`带 [${yMin},${yMax}] 内 0 格——锚定带错误`); process.exit(1); }
// globalFloor=带内众数（1m 带），floorAt 对空格的兜底不再落到杂带
const mode = Object.entries(hist).sort((a, b) => b[1] - a[1])[0][0];
const out = {
  ...nav,
  floorGridPos: gridPos,
  floorGridNeg: gridNeg,
  globalFloorNeg: Number(mode),
  globalFloorPos: Number(mode),
};
writeFileSync(outPath, JSON.stringify(out));
console.log(`带限 [${yMin}, ${yMax}]：保留 ${kept.length} 格 / 剔除 ${dropped} 格；带内分布 ${JSON.stringify(hist)}；globalFloor→${mode}`);
console.log(`输出: ${outPath}`);
