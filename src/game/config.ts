/**
 * config.ts — 多夜玩法配置（NightDef）。
 *
 * 每夜一份 NightDef：世界资产（spz/体素碰撞/nav，按夜懒加载）+ 实体参数 + 信物表 +
 * 账单额 + 雾强度 + 幸存者槽位。N1 = 「雾中松林废站」原行为原样迁移（数值一个不改）；
 * N2 = 「水墨江南 × 锈蚀废土」。战利品点位用 nav.json 可导航网格校准（N2 用
 * 过程留痕/2026-10-26/游戏工程-N2接入/plan-n2-points.mjs 的体素 BFS 选点）。
 * 深度 = 到门的水平距离（贪婪回路：越深越值钱）。
 */

export interface LootDef {
  id: string;
  /** 图鉴名 */
  name: string;
  /** 价值（文） */
  value: number;
  /** 位置（世界坐标，floorAt 之上约 1m 悬浮） */
  x: number;
  z: number;
  /** 视觉占位色（GLB 加载失败回退椭球时使用） */
  color: number;
  glowColor: number;
  /** 形状占位：bottle=竖长椭球 lantern=球+环 watch=扁盒 */
  shape: 'bottle' | 'lantern' | 'watch';
  /** Lux3D 信物 GLB（拾取物视觉源；加载失败 console.warn 并回退椭球占位） */
  glb?: string;
}

/** 实体参数（行为 AI 四态共用，数值按夜配置） */
export interface EntityDef {
  /** 实体名（锈声者/……） */
  name: string;
  /** 游荡区 */
  wanderMin: { x: number; z: number };
  wanderMax: { x: number; z: number };
  wanderSpeed: number;
  investigateSpeed: number;
  chaseSpeed: number;
  /** 视线追击距离（手电开=×flashlightRangeMul） */
  sightRange: number;
  /** 手电侦测倍率 */
  flashlightRangeMul: number;
  /** 丢失视线多久放弃 */
  loseSightSeconds: number;
  /** 抓捕距离 */
  catchRadius: number;
  /** 噪音半径倍率：玩家噪声等级(0..1) → 实体可闻半径（米） */
  noiseRadiusMax: number;
  /** 高噪（说话/奔跑）近距离直接追击 */
  chaseNoiseLevel: number;
  /** 实体 GLB（加载失败回退黑色拉长椭球占位） */
  glb: string;
  /** 出生点（下潜开始 teleport 到此） */
  start: { x: number; z: number };
  /** 强化演出（N3 起）：GLB 材质压暗系数 0..0.8（0=原样；材质叠加，不改几何） */
  darken?: number;
  /** 强化演出：红眼缩放倍率（>1 更大更亮；缺省 1） */
  eyeBoost?: number;
  /** 强化实体：首次进入追击时伙计说强化版台词（n3_chase 池） */
  enhanced?: boolean;
}

/** 幸存者槽位（遭遇玩法 E2 接入；E1 只立 flag 与挂点，不生成） */
export interface SurvivorSlot {
  enabled: boolean;
  x: number;
  z: number;
  glb: string;
}

/** 黑暗理智（N4 恐惧表机制强化，设计 §3.6「手电=看得见但招实体；关灯=安全但看不清」落地） */
export interface SanityDef {
  /** 黑暗区半径（米）：手电关且离最近暖光点（灯笼×3+归航门暖光柱）超过该距离=黑暗区 */
  darkRadius: number;
  /** 黑暗区内每秒扣减（理智 0..100） */
  drainPerSec: number;
  /** 低于该值：屏幕边缘水波纹暗角 + 伙计慌（台词池） */
  lowThreshold: number;
  /** 理智归零：实体无视视线/距离追击该秒数（「你的呼吸声在黑暗里传得很远」） */
  blackoutBlindSeconds: number;
  /** 归零惩罚结束后理智回弹值 */
  blackoutRecover: number;
}

/** 住客回归（N4，§6 #26 常客系统首秀） */
export interface GuestDef {
  /** 「古镇银铃」落点：主街最深处死胡同凹室（plan-n4-points.mjs 硬规则验证，两种住客集都刷） */
  bell: { x: number; z: number };
  /** 银铃价值（文），图鉴系列第 5 格（N2 油纸包=第 4 格之后） */
  bellValue: number;
}

export interface NightDef {
  night: number;
  seedName: string;
  /** 晨间委托文案（title 含账单额） */
  quest: { title: string; body: string; sign: string };
  /** 账单（文） */
  bill: number;
  /** 天亮门关倒计时（秒） */
  diveSeconds: number;
  /** 本夜世界资产（按夜懒加载；N1 启动即载） */
  world: { spz: string; nav: string; voxelMeta: string; voxelBin: string };
  /** 门（出口）位置与归航半径 */
  door: { x: number; z: number };
  doorReturnRadius: number;
  /** 玩家出生点 */
  spawn: { x: number; z: number; yaw: number };
  loot: LootDef[];
  /** 拾取距离 */
  pickupRadius: number;
  entity: EntityDef;
  /** 噪音等级（HUD 噪音条 & 实体侦测用） */
  noise: { crouch: number; walk: number; sprint: number; pickup: number; speak: number };
  /** 伙计低语雷达 */
  whisper: { range: number; interval: number };
  /** 恐惧表：实体 <fearRange 米伙计开始慌 */
  fearRange: number;
  /** 最后 N 秒倒计时变红+心跳 */
  dangerSeconds: number;
  /** 移动速度（参照值；实际行走速度在 walk-controls.ts） */
  speed: { walk: number; sprint: number; crouch: number };
  /** 体力（奔跑） */
  stamina: { max: number; drainPerSec: number; regenPerSec: number; sprintMin: number };
  /** 回响模式（再潜一次）：战利品价值随机微变范围 */
  echoJitter: number;
  /** CSS 雾层强度 0..1（开阔地形补偿；0=无雾层，N1 保持原样） */
  fog: number;
  /** 雾层色调：plain=灰蓝（N2）/ snow=雪雾白偏冷（N3，带缓漂移）/ deepsea=水下青雾（N4）；缺省 plain */
  fogTint?: 'plain' | 'snow' | 'deepsea';
  /** 暖光点（零新资产：主街两侧发光小球+点光；N3 雪夜灯笼暖光；N4 兼作黑暗理智的「灯下安全区」锚） */
  warmLamps?: Array<{ x: number; z: number }>;
  /** 悬浮微尘粒子（N4 深海氛围，three Points ≤200 点零贴图；缺省关） */
  dust?: boolean;
  /** 黑暗理智（N4 恐惧表机制强化，设计 §3.6 噪音/光照槽；缺省=不启用，N1–N3 零变化） */
  sanity?: SanityDef;
  /** 住客回归（N4，§6 #26 常客系统首秀；缺省=不启用） */
  guest?: GuestDef;
  /** N2 选择回响锚点（N3 专用，世界坐标已过 plan-n3-points 硬规则验证） */
  echoAnchors?: {
    /** saved 谢礼灯笼（可拾取 +5 文） */
    gift: { x: number; z: number };
    /** robbed 寻仇残影游荡中心（不攻击） */
    wraith: { x: number; z: number };
    /** ignored 行李 / lost 半个油纸包（叙事物件，E 察看） */
    relic: { x: number; z: number };
  };
  /** 幸存者槽位（flag 先立着，玩法 E2 做） */
  survivor: SurvivorSlot;
}

/** 第一夜「雾中松林废站」——阶段二原值原样迁移（除新增 glb/fog/survivor 挂点） */
export const N1: NightDef = {
  night: 1,
  seedName: '雾中松林废站',
  quest: {
    title: '收灯人 · 灯油钱 20 文',
    body: '「雾中松林废站里散着些旧物——灯油瓶、铜灯笼、还有块旧怀表。捡回来抵账。<br/>天亮门关前回来。回不来的，东西就归乱流。」',
    sign: '—— 收灯人（没露脸）',
  },
  bill: 20,
  diveSeconds: 240,
  world: {
    spz: './assets/world-n1.spz',
    nav: './assets/world-n1.nav.json',
    voxelMeta: './assets/collision.voxel-meta.json',
    voxelBin: './assets/collision.voxel.bin',
  },
  door: { x: -12.3, z: 0.35 },
  doorReturnRadius: 1.5,
  spawn: { x: -11.8, z: 0.35, yaw: 0 },
  loot: [
    // 浅：出门 3m；中：~8m；深：走廊尽头 ~13m
    { id: 'oil', name: '灯油瓶', value: 6, x: -9.0, z: 0.9, color: 0xffb347, glowColor: 0xff9a2e, shape: 'bottle', glb: './assets/token-oil.glb' },
    { id: 'lantern', name: '铜灯笼', value: 8, x: -4.5, z: -0.5, color: 0xc9834a, glowColor: 0xffb35c, shape: 'lantern', glb: './assets/token-lantern.glb' },
    { id: 'watch', name: '旧怀表', value: 12, x: 0.7, z: 0.3, color: 0xd8d8e0, glowColor: 0xfff2cc, shape: 'watch', glb: './assets/token-watch.glb' },
  ],
  pickupRadius: 1.6,
  entity: {
    name: '缝坏的账物',
    wanderMin: { x: -3.5, z: -1.2 },
    wanderMax: { x: 0.8, z: 1.8 },
    wanderSpeed: 1.1,
    investigateSpeed: 2.6,
    chaseSpeed: 3.1, // 略快于走(2.2)，慢于跑(4.2)：跑得掉，走不掉
    sightRange: 8,
    flashlightRangeMul: 2,
    loseSightSeconds: 4,
    catchRadius: 0.95,
    noiseRadiusMax: 22,
    chaseNoiseLevel: 0.85,
    glb: './assets/entity-n1.glb',
    start: { x: -1.5, z: 0.4 },
  },
  noise: { crouch: 0.08, walk: 0.35, sprint: 1.0, pickup: 0.55, speak: 1.0 },
  whisper: { range: 20, interval: 8 },
  fearRange: 12,
  dangerSeconds: 60,
  speed: { walk: 2.2, sprint: 4.2, crouch: 1.05 },
  stamina: { max: 100, drainPerSec: 26, regenPerSec: 14, sprintMin: 20 },
  echoJitter: 2,
  fog: 0, // N1 走廊：无额外雾层（视觉原样）
  survivor: { enabled: false, x: 0, z: 0, glb: './assets/survivor.glb' },
};

/** 第二夜「水墨江南 × 锈蚀废土」——世界=world-n2（plan-n2-points.mjs 体素 BFS 选点；
 * E2 起玩家柱口径=连续实心 ≥0.5m 才算墙（贴地植被可穿），可走 41%/主块 148 格） */
export const N2: NightDef = {
  night: 2,
  seedName: '水墨江南 × 锈蚀废土',
  quest: {
    title: '收灯人 · 灯油钱 30 文',
    body: '「昨晚的废站你走过一遭了。今晚乱流缝了片新地界——白墙湿了锈，河埠头堆着旧机器。<br/>东西比昨晚值钱，那个锈声的东西也比昨晚饿。天亮前回来。」',
    sign: '—— 收灯人（没露脸）',
  },
  bill: 30,
  diveSeconds: 240,
  world: {
    spz: './assets/world-n2.spz',
    nav: './assets/world-n2.nav.json',
    voxelMeta: './assets/collision-n2.voxel-meta.json',
    voxelBin: './assets/collision-n2.voxel.bin',
  },
  // 选点（plan-n2-points.mjs，E2 重选）：门=主连通块外缘最远角；浅/中/深=门 BFS 6/11.5/17m
  door: { x: -8.95, z: -2.45 },
  doorReturnRadius: 1.5,
  spawn: { x: -8.95, z: -2.45, yaw: 0.98 },
  loot: [
    { id: 'oil', name: '灯油瓶', value: 8, x: -6.95, z: 0.55, color: 0xffb347, glowColor: 0xff9a2e, shape: 'bottle', glb: './assets/token-oil.glb' },
    { id: 'lantern', name: '铜灯笼', value: 10, x: -1.45, z: 1.55, color: 0xc9834a, glowColor: 0xffb35c, shape: 'lantern', glb: './assets/token-lantern.glb' },
    { id: 'watch', name: '旧怀表', value: 15, x: 0.55, z: -1.95, color: 0xd8d8e0, glowColor: 0xfff2cc, shape: 'watch', glb: './assets/token-watch.glb' },
  ],
  pickupRadius: 1.6,
  entity: {
    name: '锈声者',
    // 游荡区=plan-n2-points.mjs 深度>40% 区域 bbox
    wanderMin: { x: -5.2, z: -2.7 },
    wanderMax: { x: 1.8, z: 4.3 },
    wanderSpeed: 1.1,
    investigateSpeed: 2.6,
    chaseSpeed: 3.3, // 比 N1 缝坏的账物更快半步
    sightRange: 9, // 开阔地看得更远
    flashlightRangeMul: 2,
    loseSightSeconds: 4,
    catchRadius: 0.95,
    noiseRadiusMax: 22,
    chaseNoiseLevel: 0.85,
    glb: './assets/entity-n2.glb',
    start: { x: -2.0, z: 3.05 },
  },
  noise: { crouch: 0.08, walk: 0.35, sprint: 1.0, pickup: 0.55, speak: 1.0 },
  whisper: { range: 20, interval: 8 },
  fearRange: 12,
  dangerSeconds: 60,
  speed: { walk: 2.2, sprint: 4.2, crouch: 1.05 },
  stamina: { max: 100, drainPerSec: 26, regenPerSec: 14, sprintMin: 20 },
  echoJitter: 2,
  fog: 0.55, // 开阔地形：CSS 雾层压远景（补偿 splt 无体积雾）
  // 幸存者槽位：灯笼侧走廊（nav 带内选面 floor≈2.9 的实心格，门 BFS ~7m——油瓶与灯笼
  // 之间的路上有人）。首选 (-2.2,1.05) 列体素探空（点云清洗残留孔洞，探地直坠 -8.5m），
  // 弃用；pass 判据兜不住孔洞列，改用 nav 带面格实测，E2 遭遇玩法接入
  survivor: { enabled: true, x: -2.95, z: 1.05, glb: './assets/survivor.glb' },
};

/** 第三夜「雪原 × 唐风夜市」——世界=world-n3（任务E3：一条 29–31m 主街沿 X + 北侧店铺
 * 廊道障碍带 + 死胡同凹槽 6 处 + 塌拱遮挡；中位截面 3.5/4.5m，走廊式尺度达标）。
 * 选点=过程留痕/2026-10-26/游戏工程-N3接入/plan-n3-points.mjs（体素 BFS + E3 硬规则：
 * ①门=主导带 y≈2 外缘最远格（裸选会落到 y≈9 店铺顶）；②每个兴趣点柱与可站立柱同带面
 * ——同带邻 ≥2 格 |Δfloor|≤0.45m，防 N2 式「两级地面相邻柱」坠穿（验收-N2夜 §五-1）；
 * ③实体出生与门同带面（band 2，游荡区 75/103 格同带，按带验收）。
 * 机制槽（设计 §7 N3）：实体强化（雾影同源 GLB，追速 3.5/侦测 10m/手电×2.5）
 * + N2 选择回响首秀（§6 #25「世界记得你」——echo.ts 按账本 survivor 结局显形 ≥2 处回响）。 */
export const N3: NightDef = {
  night: 3,
  seedName: '雪原 × 唐风夜市',
  quest: {
    title: '收灯人 · 灯油钱 40 文',
    body: '「雪把夜市的吆喝声冻住了。今晚那条街上，有东西把你记住了——它比前两晚都饿。<br/>雪雾里散着唐市的旧物。四十文。天亮前回来。」',
    sign: '—— 收灯人（没露脸）',
  },
  bill: 40,
  diveSeconds: 240,
  world: {
    spz: './assets/world-n3.spz',
    nav: './assets/world-n3.nav.json',
    voxelMeta: './assets/collision-n3.voxel-meta.json',
    voxelBin: './assets/collision-n3.voxel.bin',
  },
  // 门/出生=主街西端（门 BFS 0m，带面 2.4，同带邻 3 格）；yaw 朝街心浅点（atan2(-0.5,2.5)≈-0.2）
  door: { x: -1.45, z: 0.75 },
  doorReturnRadius: 1.5,
  spawn: { x: -1.45, z: 0.75, yaw: -0.22 },
  loot: [
    // 门 BFS：浅 6.0m / 中 12.0m / 深 18.5m ↔ 10/12/18 文深度梯度；带面 2.3/1.7/3.3 均同带邻 ≥2
    { id: 'oil', name: '封冻的灯油', value: 10, x: 2.55, z: -1.25, color: 0xffb347, glowColor: 0xff9a2e, shape: 'bottle', glb: './assets/token-oil.glb' },
    { id: 'lantern', name: '未点的红灯笼', value: 12, x: 7.55, z: -1.25, color: 0xc9834a, glowColor: 0xffb35c, shape: 'lantern', glb: './assets/token-lantern.glb' },
    { id: 'watch', name: '当铺旧怀表', value: 18, x: 14.55, z: -0.75, color: 0xd8d8e0, glowColor: 0xfff2cc, shape: 'watch', glb: './assets/token-watch.glb' },
  ],
  pickupRadius: 1.6,
  entity: {
    name: '餍足的雾影',
    // 游荡区=plan-n3-points 深度 >55% 区域 bbox（z 内收 0.2m 避开包围盒钳制缘）
    wanderMin: { x: 6.3, z: -1.8 },
    wanderMax: { x: 16.3, z: 2.3 },
    wanderSpeed: 1.2,
    investigateSpeed: 2.8,
    chaseSpeed: 3.5, // 实体强化：比 N2 锈声者再快半步（跑 4.2 甩得掉，走 2.2 甩不掉）
    sightRange: 10, // 侦测 10m（N1 8 / N2 9）
    flashlightRangeMul: 2.5, // 手电 ×2.5（N1/N2 ×2）：雪夜开灯更危险
    loseSightSeconds: 3.5,
    catchRadius: 0.95,
    noiseRadiusMax: 22,
    chaseNoiseLevel: 0.85,
    glb: './assets/entity-n1.glb', // N1 雾影同源 GLB（Lux3D 复用）；强化=材质压暗+红眼增亮（entity.ts applyNight）
    start: { x: 12.05, z: 0.75 }, // 深段带面 1.8，与门同带（band 2），玩家必经带上
    darken: 0.55,
    eyeBoost: 1.4,
    enhanced: true,
  },
  noise: { crouch: 0.08, walk: 0.35, sprint: 1.0, pickup: 0.55, speak: 1.0 },
  whisper: { range: 20, interval: 8 },
  fearRange: 12,
  dangerSeconds: 60,
  speed: { walk: 2.2, sprint: 4.2, crouch: 1.05 },
  stamina: { max: 100, drainPerSec: 26, regenPerSec: 14, sprintMin: 20 },
  echoJitter: 2,
  fog: 0.42, // 雪雾白偏冷（fogTint='snow'），浓度低于 N2 0.55
  fogTint: 'snow',
  // 暖光点 ×3（主街两侧，plan-n3-points 硬规则验证带面 2.8/2.4/2.1）
  warmLamps: [
    { x: 1.05, z: 0.75 },
    { x: 6.55, z: 0.75 },
    { x: 12.05, z: -0.25 },
  ],
  // 回响锚点（门口 2–5m 主街段；带面 2.7/2.7/2.4 均同带邻 ≥2）
  echoAnchors: {
    gift: { x: 0.55, z: -1.25 },
    wraith: { x: 5.55, z: -0.25 },
    relic: { x: -0.45, z: -1.25 },
  },
  // N3 无幸存者遭遇（遭遇是 N2 机制槽；N3 只承接其回响）
  survivor: { enabled: false, x: 0, z: 0, glb: './assets/survivor.glb' },
};

/** 第四夜「深海 × 灯笼古镇」——世界=world-n4（任务E5 第 2 笔，worldId 3FO4K4QHI28T，
 * 平台标签 outdoor(Beta)：渲染/碰撞实测通过见 N4接入验收记录）。44m 竖向场景，
 * E5 的顶向下 nav 被灯笼 canopy 截胡（主带 y≈23.6）不可用；本夜 nav 用
 * scripts/gen-nav-n4.mjs「底向上定带 y≈-3、带内选面」修正版重生成
 * （主块 973→606 格但带面纯净：全部落在 -4.4..-1.6，无 canopy/摊顶混入）。
 * 选点=过程留痕/2026-10-26/游戏工程-N4接入/plan-n4-points.mjs（体素 BFS + E3 硬规则
 * 同款：门/兴趣点主导带 ±0.6m、同带邻 ≥2 格 |Δfloor|≤0.45m；死胡同凹室放宽为
 * 「全部可走邻同带」——端点天然 ≤1 邻）。
 * 机制槽（设计 §7 N4）：住客回归（§6 #26 常客系统首秀，guest.ts 按 N2 账本结局分岔）
 * + 黑暗理智（恐惧表机制强化，§3.6 噪音/光照槽落地：手电关+离灯>6m 每秒 -2，
 * <30 水波纹暗角+伙计慌，归零=实体盲追 10s+回 30）。
 * 实体=雾影同源 GLB（entity-n1.glb，不压暗——深海青雾已压视野），追速 3.3/侦测 9m，
 * 手电侦测 ×1.5（N3 ×2.5→回落：青雾里开灯是「看得见 vs 招实体」的理智天平，不是纯危险）。 */
export const N4: NightDef = {
  night: 4,
  seedName: '深海 × 灯笼古镇',
  quest: {
    title: '收灯人 · 灯油钱 45 文',
    body: '「今晚乱流把一条街沉进了海底——灯笼在水里亮着，衣裳却不湿。青雾深处散着古镇的旧物。<br/>四十五文。那街上的东西，听得见你的喘息。」',
    sign: '—— 收灯人（没露脸）',
  },
  bill: 45,
  diveSeconds: 240,
  world: {
    spz: './assets/world-n4.spz',
    nav: './assets/world-n4.nav.json',
    voxelMeta: './assets/collision-n4.voxel-meta.json',
    voxelBin: './assets/collision-n4.voxel.bin',
  },
  // 门/出生=主街东端（plan-n4-points 主导带外缘最远格，带面 -3.1 同带邻 3）；朝街心浅点（西偏北）
  door: { x: 14.45, z: 2.25 },
  doorReturnRadius: 1.5,
  spawn: { x: 14.45, z: 2.25, yaw: -2.68 },
  loot: [
    // 门 BFS：浅 10.5m / 中 21.5m / 深 31m ↔ 12/14/20 文深度梯度；带面 -2.8/-2.1/-2.7 均同带邻 ≥2
    { id: 'oil', name: '沉船旧灯油', value: 12, x: 7.45, z: -1.25, color: 0xffb347, glowColor: 0xff9a2e, shape: 'bottle', glb: './assets/token-oil.glb' },
    { id: 'lantern', name: '水浸的纸灯笼', value: 14, x: -3.05, z: -1.75, color: 0xc9834a, glowColor: 0xffb35c, shape: 'lantern', glb: './assets/token-lantern.glb' },
    { id: 'watch', name: '当铺防水怀表', value: 20, x: -12.05, z: -1.25, color: 0xd8d8e0, glowColor: 0xfff2cc, shape: 'watch', glb: './assets/token-watch.glb' },
  ],
  pickupRadius: 1.6,
  entity: {
    name: '沉底的雾影',
    // 游荡区=plan-n4-points 深度 >55% 主街段 bbox（z 内收 0.2m 避开包围盒钳制缘；
    // 不含南侧银铃凹室——深处拾荒时给玩家留一条无实体走廊）
    wanderMin: { x: -16.1, z: -2.3 },
    wanderMax: { x: -0.5, z: 2.3 },
    wanderSpeed: 1.2,
    investigateSpeed: 2.8,
    chaseSpeed: 3.3, // 雾影同源：与 N2 锈声者同速（跑 4.2 甩得掉，走 2.2 甩不掉）
    sightRange: 9, // 侦测 9m（N2 同值；N1 8 / N3 10）
    flashlightRangeMul: 1.5, // 手电 ×1.5（N1/N2 ×2、N3 ×2.5）：N4 天平在理智条，不在纯侦测惩罚
    loseSightSeconds: 4,
    catchRadius: 0.95,
    noiseRadiusMax: 22,
    chaseNoiseLevel: 0.85,
    glb: './assets/entity-n1.glb', // 雾影同源 GLB（Lux3D 复用，零新资产）；不压暗（青雾+黑暗理智承担压迫感）
    start: { x: -9.05, z: -1.75 }, // 深段带面 -2.7，与门同主导带（y≈-3），玩家必经带上
  },
  noise: { crouch: 0.08, walk: 0.35, sprint: 1.0, pickup: 0.55, speak: 1.0 },
  whisper: { range: 20, interval: 8 },
  fearRange: 12,
  dangerSeconds: 60,
  speed: { walk: 2.2, sprint: 4.2, crouch: 1.05 },
  stamina: { max: 100, drainPerSec: 26, regenPerSec: 14, sprintMin: 20 },
  echoJitter: 2,
  fog: 0.5, // 水下青雾（fogTint='deepsea' 冷青偏色，浓度介于 N2 0.55 与 N3 0.42 之间）
  fogTint: 'deepsea',
  dust: true, // 悬浮微尘/气泡粒子（three Points ≤200 点，零贴图零新资产）
  // 暖光点 ×3（门侧 15%/32%/50% 深度，plan-n4-points 硬规则验证带面 -3.0/-2.8/-2.1
  // 同带邻 4/4、2/2、2/3——过程留痕/游戏工程-N4接入/verify-points-n4.mjs）。
  // 灯位实测调优（N4接入验收记录 §理智）：首版 25/50/75% 布灯时主街全程离灯 ≤4.5m，
  // 黑暗区（>6m）在主街不存在，理智机制空转；改门侧布灯后深半场（x<-4）与南侧凹室
  // 成黑暗区——「越深越黑」与贪婪回路同向，浅半场+门口=灯下安全区。
  // 兼作黑暗理智「灯下安全区」锚，归航门暖光柱为第 4 锚（出生/归航必在灯下）
  warmLamps: [
    { x: 12.95, z: -1.75 },
    { x: 7.45, z: -1.25 },
    { x: 1.95, z: -1.75 },
  ],
  // 黑暗理智（§3.6）：黑暗区=手电关且离暖光点>6m；-2/s；<30 水波纹暗角+伙计慌；
  // 归零=实体无视视线盲追 10s（「你的呼吸声在黑暗里传得很远」）+理智回 30
  sanity: { darkRadius: 6, drainPerSec: 2, lowThreshold: 30, blackoutBlindSeconds: 10, blackoutRecover: 30 },
  // 住客回归（§6 #26）：银铃落点=主街最深处死胡同凹室（带面 -2.9，全邻同带，
  // 门 BFS 30.5m——「主街最深处有件好东西」的实体承诺，两种住客集都刷，值 12 文）
  guest: { bell: { x: -10.55, z: 2.75 }, bellValue: 12 },
  // N4 无幸存者遭遇（遭遇是 N2 机制槽；N4 承接其住客回归）
  survivor: { enabled: false, x: 0, z: 0, glb: './assets/survivor.glb' },
};

/** 全部已配置夜（进度页/解锁链按此渲染） */
export const NIGHTS: NightDef[] = [N1, N2, N3, N4];

/** 夜数中文序号（1→一） */
export function nightCn(night: number): string {
  return '一二三四五六七八九'[night - 1] ?? String(night);
}

/** 伙计原型（开场三选一，决定台词池） */
export type Archetype = '毒舌' | '胆小' | '神秘';

export const ARCHETYPES: Array<{ id: Archetype; tag: string; desc: string }> = [
  { id: '毒舌', tag: '嘴比灯亮', desc: '损友型：越危险越嘴硬，被抓了还要嘲讽你。' },
  { id: '胆小', tag: '火苗很小', desc: '惊弓鸟型：全程心惊肉跳，但从不真的丢下你。' },
  { id: '神秘', tag: '记性太好', desc: '半仙型：说话只说一半，另一半在明晚应验。' },
];
