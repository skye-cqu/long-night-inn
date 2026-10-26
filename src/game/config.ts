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
}

/** 幸存者槽位（遭遇玩法 E2 接入；E1 只立 flag 与挂点，不生成） */
export interface SurvivorSlot {
  enabled: boolean;
  x: number;
  z: number;
  glb: string;
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

/** 第二夜「水墨江南 × 锈蚀废土」——世界=world-n2（plan-n2-points.mjs 体素 BFS 选点） */
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
  // 选点（plan-n2-points.mjs）：门=主连通块外缘；浅/中/深=门 BFS 深度 1/2/3m
  door: { x: -4.45, z: 1.05 },
  doorReturnRadius: 1.5,
  spawn: { x: -4.45, z: 1.05, yaw: -2.83 },
  loot: [
    { id: 'oil', name: '灯油瓶', value: 8, x: -4.95, z: 0.55, color: 0xffb347, glowColor: 0xff9a2e, shape: 'bottle', glb: './assets/token-oil.glb' },
    { id: 'lantern', name: '铜灯笼', value: 10, x: -5.45, z: 0.05, color: 0xc9834a, glowColor: 0xffb35c, shape: 'lantern', glb: './assets/token-lantern.glb' },
    { id: 'watch', name: '旧怀表', value: 15, x: -5.45, z: -0.95, color: 0xd8d8e0, glowColor: 0xfff2cc, shape: 'watch', glb: './assets/token-watch.glb' },
  ],
  pickupRadius: 1.6,
  entity: {
    name: '锈声者',
    // 游荡区=plan-n2-points.mjs 深度>40% 区域 bbox
    wanderMin: { x: -5.7, z: -1.2 },
    wanderMax: { x: -4.2, z: 0.3 },
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
    start: { x: -5.0, z: -0.5 },
  },
  noise: { crouch: 0.08, walk: 0.35, sprint: 1.0, pickup: 0.55, speak: 1.0 },
  whisper: { range: 20, interval: 8 },
  fearRange: 12,
  dangerSeconds: 60,
  speed: { walk: 2.2, sprint: 4.2, crouch: 1.05 },
  stamina: { max: 100, drainPerSec: 26, regenPerSec: 14, sprintMin: 20 },
  echoJitter: 2,
  fog: 0.55, // 开阔地形：CSS 雾层压远景（补偿 splt 无体积雾）
  survivor: { enabled: true, x: -4.95, z: 0.05, glb: './assets/survivor.glb' }, // 槽位已规划（岔路口），玩法 E2 接入
};

/** 全部已配置夜（进度页/解锁链按此渲染） */
export const NIGHTS: NightDef[] = [N1, N2];

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
