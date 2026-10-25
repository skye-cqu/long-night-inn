/**
 * config.ts — N1「雾中松林废站」玩法配置。
 *
 * 所有可调数值集中在此（战利品点位用 nav.json 可导航网格校准过：走廊 x∈[-13,1.1]、
 * z∈[-1.2,1.8] 均有地面高度，见 2026-10-26 nav 采样）。改点位/价值/时长只动这里。
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
  /** 视觉占位色 */
  color: number;
  glowColor: number;
  /** 形状占位：bottle=竖长椭球 lantern=球+环 watch=扁盒（TODO(Lux3D 信物) 替换） */
  shape: 'bottle' | 'lantern' | 'watch';
}

export const N1 = {
  night: 1,
  seedName: '雾中松林废站',
  /** 账单（文）：收灯人 N1 灯油钱 */
  bill: 20,
  /** 天亮门关倒计时（秒） */
  diveSeconds: 240,
  /** 门（出口）位置与归航半径 */
  door: { x: -12.3, z: 0.35 },
  doorReturnRadius: 1.5,
  /** 玩家出生点：门前，朝走廊深处（+X） */
  spawn: { x: -11.8, z: 0.35, yaw: 0 },
  loot: [
    // 浅：出门 3m；中：~8m；深：走廊尽头 ~13m
    { id: 'oil', name: '灯油瓶', value: 6, x: -9.0, z: 0.9, color: 0xffb347, glowColor: 0xff9a2e, shape: 'bottle' },
    { id: 'lantern', name: '铜灯笼', value: 8, x: -4.5, z: -0.5, color: 0xc9834a, glowColor: 0xffb35c, shape: 'lantern' },
    { id: 'watch', name: '旧怀表', value: 12, x: 0.7, z: 0.3, color: 0xd8d8e0, glowColor: 0xfff2cc, shape: 'watch' },
  ] as LootDef[],
  /** 拾取距离 */
  pickupRadius: 1.6,
  /** 实体「闻声而动」参数 */
  entity: {
    /** 游荡区（深处） */
    wanderMin: { x: -3.5, z: -1.2 },
    wanderMax: { x: 0.8, z: 1.8 },
    wanderSpeed: 1.1,
    investigateSpeed: 2.6,
    chaseSpeed: 3.1, // 略快于走(2.2)，慢于跑(4.2)：跑得掉，走不掉
    /** 视线追击距离（手电开=×2） */
    sightRange: 8,
    /** 手电侦测倍率 */
    flashlightRangeMul: 2,
    /** 丢失视线多久放弃 */
    loseSightSeconds: 4,
    /** 抓捕距离 */
    catchRadius: 0.95,
    /** 噪音半径倍率：玩家噪声等级(0..1) → 实体可闻半径（米） */
    noiseRadiusMax: 22,
    /** 高噪（说话/奔跑）近距离直接追击 */
    chaseNoiseLevel: 0.85,
  },
  /** 噪音等级（HUD 噪音条 & 实体侦测用）：蹲 0.08 / 走 0.35 / 跑 1.0 / 拾取 0.55 / 说话 1.0 */
  noise: { crouch: 0.08, walk: 0.35, sprint: 1.0, pickup: 0.55, speak: 1.0 },
  /** 伙计低语雷达：实体 <20m 每 8s 一条方位提示 */
  whisper: { range: 20, interval: 8 },
  /** 恐惧表：实体 <12m 伙计开始慌 */
  fearRange: 12,
  /** 最后 N 秒倒计时变红+心跳 */
  dangerSeconds: 60,
  /** 移动速度 */
  speed: { walk: 2.2, sprint: 4.2, crouch: 1.05 },
  /** 体力（奔跑） */
  stamina: { max: 100, drainPerSec: 26, regenPerSec: 14, sprintMin: 20 },
  /** 回响模式（再潜一次）：战利品价值随机微变范围 */
  echoJitter: 2,
} as const;

export type N1Config = typeof N1;

/** 伙计原型（开场三选一，决定台词池） */
export type Archetype = '毒舌' | '胆小' | '神秘';

export const ARCHETYPES: Array<{ id: Archetype; tag: string; desc: string }> = [
  { id: '毒舌', tag: '嘴比灯亮', desc: '损友型：越危险越嘴硬，被抓了还要嘲讽你。' },
  { id: '胆小', tag: '火苗很小', desc: '惊弓鸟型：全程心惊肉跳，但从不真的丢下你。' },
  { id: '神秘', tag: '记性太好', desc: '半仙型：说话只说一半，另一半在明晚应验。' },
];
