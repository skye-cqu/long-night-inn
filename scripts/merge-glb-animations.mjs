#!/usr/bin/env node
/**
 * merge-glb-animations.mjs — 把 idle GLB 的动画通道并入行走 GLB，产出双动画 huoji.glb。
 *
 * 原理：GLB = 12B 头 + JSON chunk + BIN chunk。两个 GLB 出自同一 Lux3D 绑骨管线，
 * 骨架节点树一致（脚本会校验节点名序列，不一致则按名字重映射，再不行就报错退出）。
 * 做法：把 idle 的 BIN 追加到 walk 的 BIN 尾部，拷贝动画用到的 bufferView/accessor
 * （索引平移重编），animation.channels 的 target.node 重映射到 walk 的节点索引。
 * 不触碰任何 BIN 原始数据，只做搬运与重编号。
 *
 * 用法：node scripts/merge-glb-animations.mjs [walk.glb] [idle.glb] [out.glb]
 * 默认路径指向 资产库/ 下 2026-10-26 的伙计资产，输出 public/assets/huoji.glb。
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const DEFAULTS = [
  resolve(ROOT, '../资产库/伙计-行走动画_2026-10-26.glb'),
  resolve(ROOT, '../资产库/伙计-idle动画_2026-10-26.glb'),
  resolve(ROOT, 'public/assets/huoji.glb'),
];
const [walkPath, idlePath, outPath] = process.argv.length > 2 ? process.argv.slice(2) : DEFAULTS;

function parseGLB(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: 非 GLB（magic 不符）`);
  if (buf.readUInt32LE(4) !== 2) throw new Error(`${file}: 仅支持 glTF 2.0`);
  let off = 12;
  let json = null;
  let bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json || !bin) throw new Error(`${file}: 缺 JSON 或 BIN chunk`);
  return { json, bin, binFileLength: buf.length };
}

function align4(n) { return n + ((4 - (n % 4)) % 4); }

function buildGLB(json, bin) {
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = ((4 - (jsonBuf.length % 4)) % 4);
  const jsonPadded = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = ((4 - (bin.length % 4)) % 4);
  const binPadded = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);
  const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonPadded.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonPadded.copy(out, 20);
  const binOff = 20 + jsonPadded.length;
  out.writeUInt32LE(binPadded.length, binOff);
  out.writeUInt32LE(0x004e4942, binOff + 4);
  binPadded.copy(out, binOff + 8);
  return out;
}

/** 计算动画时长（取全部 sampler input accessor 的 max） */
function animDuration(gltf, anim) {
  let dur = 0;
  for (const s of anim.samplers) {
    const acc = gltf.accessors[s.input];
    if (acc?.max?.length) dur = Math.max(dur, ...acc.max);
  }
  return dur;
}

// ---- 读取两份 GLB ----
for (const f of [walkPath, idlePath]) {
  if (!statSync(f, { throwIfNoEntry: false })) {
    console.error(`找不到输入文件: ${f}`);
    process.exit(1);
  }
}
const W = parseGLB(walkPath);
const I = parseGLB(idlePath);
console.log(`walk GLB: ${(W.binFileLength / 1e6).toFixed(1)}MB, animations=${W.json.animations?.length ?? 0}, nodes=${W.json.nodes?.length ?? 0}`);
console.log(`idle GLB: ${(I.binFileLength / 1e6).toFixed(1)}MB, animations=${I.json.animations?.length ?? 0}, nodes=${I.json.nodes?.length ?? 0}`);

if (!I.json.animations?.length) { console.error('idle GLB 无动画'); process.exit(1); }
if (!W.json.animations?.length) { console.error('walk GLB 无动画'); process.exit(1); }
const idleAnim = I.json.animations[0];

// ---- 节点索引映射：优先同序直映，否则按名字 ----
let nodeMap;
if (W.json.nodes.length === I.json.nodes.length &&
    W.json.nodes.every((n, i) => n.name === I.json.nodes[i].name)) {
  nodeMap = I.json.nodes.map((_, i) => i);
  console.log('节点序列一致，动画通道节点索引直映');
} else {
  const wByName = new Map(W.json.nodes.map((n, i) => [n.name, i]));
  nodeMap = I.json.nodes.map((n) => wByName.get(n.name));
  const missing = nodeMap.filter((v) => v === undefined).length;
  if (missing > 0) { console.error(`按名重映射仍有 ${missing} 个节点缺失，放弃合并`); process.exit(1); }
  console.log('节点序列不一致，已按名字重映射');
}

// ---- 收集 idle 动画依赖的 accessor / bufferView ----
const usedAccessors = new Set();
for (const s of idleAnim.samplers) { usedAccessors.add(s.input); usedAccessors.add(s.output); }
const usedBufferViews = new Set();
for (const ai of usedAccessors) {
  const bv = I.json.accessors[ai].bufferView;
  if (bv === undefined) throw new Error('动画 accessor 未用 bufferView（内联 min/max），不支持');
  if (I.json.bufferViews[bv].buffer !== 0) throw new Error('动画 bufferView 不在 buffer 0，不支持');
  usedBufferViews.add(bv);
}

// ---- 追加 BIN（只拷动画用到的 bufferView 字节段，不搬 idle 的网格/贴图）----
let tailLen = align4(W.bin.length);
const slices = [];
const bvIndexMap = new Map();
const bvBase = W.json.bufferViews.length;
[...usedBufferViews].sort((a, b) => a - b).forEach((oldIdx, k) => {
  const src = I.json.bufferViews[oldIdx];
  const slice = I.bin.subarray(src.byteOffset, src.byteOffset + src.byteLength);
  const newOffset = tailLen;
  slices.push(slice);
  tailLen += slice.length;
  W.json.bufferViews.push({ ...src, byteOffset: newOffset });
  bvIndexMap.set(oldIdx, bvBase + k);
});
const newBin = Buffer.concat([W.bin, ...slices]);
const accIndexMap = new Map();
const accBase = W.json.accessors.length;
[...usedAccessors].sort((a, b) => a - b).forEach((oldIdx, k) => {
  const src = I.json.accessors[oldIdx];
  W.json.accessors.push({ ...src, bufferView: bvIndexMap.get(src.bufferView) });
  accIndexMap.set(oldIdx, accBase + k);
});

// ---- 组装新动画 ----
const mergedAnim = {
  name: 'Idle_Loop',
  channels: idleAnim.channels.map((ch) => ({
    ...ch,
    target: { ...ch.target, node: nodeMap[ch.target.node] },
  })),
  samplers: idleAnim.samplers.map((s) => ({
    ...s,
    input: accIndexMap.get(s.input),
    output: accIndexMap.get(s.output),
  })),
};
// 原动画改成语义名，运行时按名字找 clip
W.json.animations[0].name = W.json.animations[0].name?.match(/walk/i) ? W.json.animations[0].name : 'Walk_Loop';
W.json.animations.push(mergedAnim);
W.json.buffers[0].byteLength = newBin.length;

// ---- 写出并校验 ----
const out = buildGLB(W.json, newBin);
writeFileSync(outPath, out);
const check = parseGLB(outPath);
console.log(`\n产出: ${outPath} (${(out.length / 1e6).toFixed(1)}MB)`);
console.log(`校验重析: animations=${check.json.animations.length}`);
for (const a of check.json.animations) {
  console.log(`  - ${a.name}: ${a.channels.length} 通道, ${a.samplers.length} 采样器, 时长 ${animDuration(check.json, a).toFixed(3)}s`);
}
const walkClip = check.json.animations.find((a) => /walk/i.test(a.name));
const idleClip = check.json.animations.find((a) => /idle/i.test(a.name));
if (!walkClip || !idleClip || check.json.animations.length !== 2) {
  console.error('合并结果不符合预期（应恰好 2 个动画：Walk_Loop + Idle_Loop）');
  process.exit(1);
}
console.log('\nOK：双动画合并成功');
