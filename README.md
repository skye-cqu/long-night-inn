# 长夜驿站 · 游戏工程

《长夜驿站》可玩 Demo 的 web 运行时。脚手架（阶段二任务1）实现：aholo-viewer
本地加载 3DGS 世界（N1 雾中松林废站）→ 包围盒推导初始机位 → 第一人称行走
（WASD + 鼠标指针锁定，稀疏体素碰撞）→ 伙伴「伙计」随行。

**阶段二任务2（2026-10-26）：N1 教学夜完整玩法垂直切片**——一夜四阶段循环
`标题/开场仪式 → 驿站晨间(2D) → 穿缝转场 → N1 下潜(3D) → 归航结算 → 夜谈 → 进度页`，
含：4 分钟天亮倒计时、3 件战利品（贪婪回路：越深越值钱）、实体「闻声而动」（一招：
循声而来/见影则追，queryRay 视线）、伙计系统（恐惧表迟滞/低语雷达/T 说话=大噪音/
三原型台词池）、账单结算与账单卡（canvas 导出 PNG）、因果账本（localStorage，
导演 agent 输入种子）、WebAudio 合成音效（零素材）。

## 命令

```sh
npm install
npm run dev        # 开发：http://localhost:5173
npm run build      # tsc 检查 + vite 构建（viewer 以 external + importmap 方式随 dist/vendor 发货）
npm run preview    # 预览生产构建
npm run merge:glb  # 重新合并 资产库/ 的行走+idle GLB → public/assets/huoji.glb（读 ../资产库/，勿移动资产库）
npm run voxel      # 从世界 PLY 本地生成体素碰撞数据 → public/assets/collision.*（读 ../资产库/）
node scripts/gen-voxel-n3.mjs  # N3 版同上 → collision-n3.voxel-*（再接 gen-nav-from-voxel.mjs 出 world-n3.nav.json）
```

## 结构

```
src/
  main.ts            装配：viewer 初始化、资产加载、渲染循环、__game 调试 API
  walk-controls.ts   第一人称控制器：走/跑(Shift+体力)/蹲(C)步态 + 体素碰撞 + 噪音等级输出
  collision.ts       稀疏体素碰撞场（官方 walk-demo VoxelCollision 移植，MIT；queryRay=视线检测）
  companion.ts       伙计：GLB 蒙皮动画 + lerp 跟随 + 恐惧迟滞（fear 越高跟越紧反应越慢）
  nav.ts             简化碰撞兜底数据（高度场）
  game/              ---- N1 玩法垂直切片 ----
    game.ts          游戏流状态机（Stage）+ 下潜玩法编排 + 事件（拾取/被抓/归航/门关）
    config.ts        多夜配置：N1 雾中松林废站 / N2 水墨江南×锈蚀废土 / N3 雪原×唐风夜市
    items.ts         战利品 + 归航之门 + 暖光点（N3 雪夜灯笼暖光，基元零新资产）
    entity.ts        实体「闻声而动」AI：游荡/循声/追击/抓捕 + LOS + 强化演出（darken/eyeBoost）
    echo.ts          N2 选择回响首秀（N3）：账本 survivor 结局 → 谢礼灯笼/寻仇残影/叙事物件+晨间字
    hud.ts           下潜 HUD：倒计时/目标框/图鉴/操作栏/噪音体力条/暗角/恐惧染色/雪雾/红晕
    screens.ts       2D 屏幕流：标题仪式/晨间(含回响字)/穿缝转场/结算/夜谈(含回响评语)/进度/暂停菜单
    billcard.ts      今夜账单卡（DOM 卡 + canvas 重绘导出 PNG，传播物料 P1）
    lines.ts         伙计台词池：3 原型 × 10 场景（≥16 条/原型）+ 夜谈按账本事件选池 + N3 强化追击/残影池
    ledger.ts        因果账本 localStorage（schema 见文件头注释，导演 agent 契约）
    audio.ts         WebAudio 合成音效：拾取/心跳/门铃/穿缝/结算/被抓（零素材）
    shapes.ts        手搓 UV 椭球几何（viewer 未导出 Sphere/Box 几何类）
scripts/             （同脚手架）GLB 动画合并 / 体素生成 / 高度场预计算
public/assets/       world-n1/n2/n3.spz / huoji.glb / collision(-n2/-n3).voxel-* / world-n1/n2/n3.nav.json
```

## 玩法速查（N1 教学夜）

- 开场仪式（≤60s 可跳过）：掌柜名（默认无名掌柜）+ 伙计原型三选一（毒舌/胆小/神秘）。
- 下潜 4:00：捡 灯油瓶(6文·浅)/铜灯笼(8文·中)/旧怀表(12文·深)，凑 20 文账单，
  天亮门关前回门口按 E 归航。门关未归/被抓 = 丢当日战利品被抛回（不判死）。
- 实体一招：闻声而动（跑>说话>走>蹲，拾取中噪）+ 视线 8m 内追击（手电开×2）。
- 操作：WASD 走 / Shift 跑 / C 蹲 / E 拾取·推门 / F 手电 / T 说话（=大噪音）/ ESC 菜单。
- 回响模式：进度页「再潜一次」——同一世界，战利品价值 ±2 文微变，账本继续记账。

## 玩法速查（N3 雪原 × 唐风夜市）

- 第三夜：实体强化（雾影同源，材质压暗+红眼增亮；追速 3.5 / 侦测 10m / 手电×2.5 侦测），
  账单 40 文，信物 封冻的灯油 10 / 未点的红灯笼 12 / 当铺旧怀表 18。
- **N2 选择回响首秀**（设计 #25「世界记得你」）：进 N3 读 N2 账本 survivor 结局，显形 ≥2 处回响——
  救→主街入口谢礼灯笼（E 拾取 +5 文，仅此夜）+晨间字；抢→主街游荡寻仇残影（不攻击，
  靠近红晕+紧张台词，绕开即散）+晨间字；不理→门口被丢弃的行李（E 察看）；救而失→半个油纸包。
  账本无 N2 记录 → 默认「不理」集。雪夜氛围：白偏冷雪雾层 + 主街暖光点 ×3。
- 调试：`__game.night.echo`（回响状态）/ `__game.api.echoInteract()`（E 交互回响物）；
  造账本：N2 遭遇三选后归航结算，或直接写 localStorage `long-night-inn:ledger:v1` 后刷新。

## 调试 API（console）

`__game.state`（phase/fps/errors）/ `__game.night`（stage/倒计时/战利品/实体/恐惧/FTUE
计时）/ `__game.goto(stage)`（title/morning/dive/settle/talk/progress 直达，验收入口）/
`__game.api.*`（pickup/speak/setTimer/flash/entityChase/entityTeleport/showItems/
itemPositions/setArchetype/returnHome/ledger/ledgerReset/sfx/hud）+ 脚手架期全集
（setInput/setSprint/setCrouch/getPos/setYaw/turn/setCam/tuneCompanion/setFollow/
showCompanion/showWorld/setBg/viewer/V3）。移动/拾取均可用 dispatchEvent 派发
KeyboardEvent 驱动（注意带 `key` 与 `code` 两个字段）。URL 参数：`?debug=1` 显示技术
HUD；`?up=-1` 世界翻转对照。

## 关键事实（沿用脚手架结论）

1. N1 世界渲染空间 +Y up；viewer npm 包 mesh/GLTF 渲染正常；vite 需 exclude viewer
   （worker 相对路径），build 用 importmap + dist/vendor 方案。
2. **viewer 未在模块层导出 Sphere/Box 等几何类**（只有命名空间内部），占位几何用
   BufferGeometry+BufferAttribute 手搓（game/shapes.ts）。
3. **实体不做体素胶囊推离**：实体胶囊(半径 0.34)比玩家(0.12)粗，会在走廊收窄段被
   推力逐帧抵消移动（追击速度剩 ~10%）；实体用包围盒钳制+地面高度场，LOS 仍走
   queryRay（2026-10-26 实测坑，详见 entity.ts 头注）。
4. 手电效果：splat 不受场景灯影响，亮度用 CSS filter（brightness 1.32/0.84）+ 暗角
   radial-gradient 切换实现；点光只影响 mesh（伙计/战利品/实体）。

## 已知限制（下一任务输入）

- 实体/信物/门全部为基元占位（代码内 TODO(Lux3D 实体/信物) 标记替换点）。
- 实体不撞墙（半穿行，志怪皮遮掩）；伙计无寻路仍可能贴走廊边。
- 账单卡 canvas 导出在中控台无头环境不落盘（真浏览器正常下载）。
- 键盘/指针锁定已过 playwright 合成键验证；未做移动端触控。
- 生产构建 33MB huoji.glb 全量下发；伙计动画混合为线性权重。
