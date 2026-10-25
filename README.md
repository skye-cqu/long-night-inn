# 长夜驿站 · 游戏工程

《长夜驿站》可玩 Demo 的 web 运行时。脚手架阶段（2026-10-26）已实现：aholo-viewer
本地加载 3DGS 世界（N1 雾中松林废站）→ 包围盒推导初始机位 → 第一人称行走
（WASD + 鼠标指针锁定，稀疏体素碰撞）→ 伙伴「伙计」随行（身后偏右 ~1.5m lerp
跟随，Walk_Loop / Idle_Loop 双动画切换，合并自 Lux3D 产出的两份 GLB）。玩法
循环（追逐、拾取、逃脱）是下一任务。

## 命令

```sh
npm install
npm run dev        # 开发：http://localhost:5173
npm run build      # tsc 检查 + vite 构建（viewer 以 external + importmap 方式随 dist/vendor 发货）
npm run preview    # 预览生产构建
npm run merge:glb  # 重新合并 资产库/ 的行走+idle GLB → public/assets/huoji.glb（读 ../资产库/，勿移动资产库）
npm run voxel      # 从世界 PLY 本地生成体素碰撞数据 → public/assets/collision.*（读 ../资产库/）
```

## 结构

```
src/
  main.ts            装配：viewer 初始化（对齐官网 render-runtime）、加载、渲染循环、HUD、__game 调试 API
  walk-controls.ts   第一人称控制器：定步长物理 + 体素碰撞（移植官方 walk-demo ViewerWalkMode）
  collision.ts       稀疏体素碰撞场（官方 walk-demo VoxelCollision 移植，MIT）
  companion.ts       伙计：loadGLTF + AnimationPlugin 蒙皮动画 + lerp 跟随
  nav.ts             简化碰撞兜底数据（高度场，scripts/gen-nav-data.mjs 预计算）
scripts/
  merge-glb-animations.mjs  GLB 动画合并（零 API，本地字节搬运）
  gen-voxel.mjs             体素碰撞生成（@manycore/aholo-splat-transform，本地 CPU）
  gen-nav-data.mjs          高度场/包围盒预计算
public/assets/              world-n1.spz / huoji.glb / collision.voxel-* / world-n1.nav.json
```

调试 API（console）：`__game.state` / `setInput(f,s)` / `getPos()` / `setYaw()` /
`turn()` / `setFollow(bool)`（冻结跟随取证）/ `showCompanion(bool)` / `showWorld(bool)` /
`tuneCompanion(rad)`（伙计朝向微调）/ `viewer()`。URL 参数：`?up=-1` 对照世界翻转。

## 关键事实（2026-10-26 脚手架验证）

1. **N1 世界渲染空间是 +Y up**（不是 go/no-go 报告写的 OpenCV -Y up——该结论来自
   翻转不敏感的黑屏测试；本次用 ?up 双向渲染 + studio 官方截图亮度梯度同号判定修正。
   官方 quickstart 的 -Y up 说明仅适用于 bear.sog 等原始资产）。
2. viewer npm 包 mesh/GLTF 渲染正常（一度误判为不渲染——实为取证机位永远背对
   跟随中的伙计），wiring 照官方 walk-demo：`loadGLTF(buf, {textureLoader:
   downloadTexture})` + `AnimationPlugin` + `bindSkinned`。
3. vite 必须把 viewer 排除出预打包与 bundle（worker 相对路径），build 用
   importmap + dist/vendor 方案。

## 已知限制（下一任务输入）

- 伙计朝向按 glTF 惯例 +Z 前向假设，未目视确认是否倒退走（读图通道不可用）；
  如倒退：`__game.tuneCompanion(Math.PI)` 后回填 companion.ts 的 modelYawAdjust。
- 碰撞胶囊半径 0.12m/高 1.5m，走廊世界校准；复杂世界需调 voxelResolution。
- 伙计不撞墙时可能贴走廊边（跟随目标钳制），无寻路。
- 键盘/指针锁定在无头环境未测真实按键（go/no-go 已证键盘事件可消费）；GPU
  环境实测 128fps。
- 生产构建把 33MB huoji.glb 全量下发（含未压缩纹理），后续做 Draco/KTX2 压缩。
- 伙计动画混合为线性权重，未做官方 demo 的 Fall/jump 状态。
