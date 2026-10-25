#!/usr/bin/env node
/**
 * gen-voxel.mjs — 用 @manycore/aholo-splat-transform（本地免费计算）从世界 PLY
 * 生成体素碰撞数据（voxel-meta.json + voxel.bin），对齐官方 walk-demo 的加载格式。
 *
 * 产出：public/assets/collision.voxel-meta.json + collision.voxel.bin
 * 用法：node scripts/gen-voxel.mjs [input.ply] [outputDir]
 * 注意：包要求 node >= 22.22.1（本机 22.20.0 仅 engines 警告，实测可跑）；
 *       Voxel 任务 backend 默认 cpu（无需 Vulkan）。
 */
import { statSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '@manycore/aholo-splat-transform';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const [plyPath, outDir] = process.argv.length > 2
  ? process.argv.slice(2)
  : [resolve(ROOT, '../资产库/N1雾中松林废站-世界_2026-10-26.ply'), resolve(ROOT, 'public/assets')];

if (!statSync(plyPath, { throwIfNoEntry: false })) {
  console.error(`找不到输入文件: ${plyPath}`);
  process.exit(1);
}

const metaOut = resolve(outDir, 'collision.voxel-meta.json').replaceAll('\\', '/');
const binOut = resolve(outDir, 'collision.voxel.bin').replaceAll('\\', '/');
const plyIn = plyPath.replaceAll('\\', '/');
// splat-transform 的 Voxel.output 是目录（voxel-meta.json + voxel.bin 落在里面），
// 先产到临时目录再平铺归位为运行时期望的两个文件。
const tmpDir = resolve(ROOT, 'node_modules/.voxel-tmp').replaceAll('\\', '/');
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

const pipeline = {
  version: 1,
  tasks: [
    { id: 'read', type: 'Read', config: { inputs: [plyIn], output: 'world' } },
    {
      id: 'voxel',
      type: 'Voxel',
      config: {
        input: 'world',
        output: tmpDir,
        backend: 'cpu',
        voxelResolution: 0.1,
        nodeEncoding: 'raw',
        compression: 'none',
        collisionMesh: false,
      },
      release: ['world'],
    },
  ],
};

console.log(`生成体素碰撞: ${plyIn} -> ${metaOut}`);
const t0 = Date.now();
await run(pipeline);
cpSync(tmpDir + '/voxel-meta.json', metaOut);
cpSync(tmpDir + '/voxel.bin', binOut);
rmSync(tmpDir, { recursive: true, force: true });
console.log(`完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s：${metaOut} + ${binOut}`);
