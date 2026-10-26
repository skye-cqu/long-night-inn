/**
 * mirror.ts — N6 镜像对照页「世界记得你的总和」（设计 §7 N6 镜像夜核心 wow、§1 账目
 * 法则「乱流读账不读心」、§6 #27 传播钩子）。
 *
 * 归航后、结算前插入的 DOM 页：读**全部**账本统计（saved/robbed/ignored/lost/caught
 * 计数 + 走过的夜数），三行左右对照拼装——「你救过 x 人 ↔ 世界长出 x 座拱门；
 * 你抢过 y 次 ↔ 世界裂开 y 道缝；你走过 z 夜 ↔ 世界亮着 z 盏灯」。
 * 文案池 ≥6 条（三行各 2 变体 + 计数为零的专用行），按实际计数拼装——
 * 六夜的账在 N6 结成一次总账，页面本身即三线结局的预告片。
 * 实现从简：纯 DOM 文案，不建新系统；无 N6 世界物、零 API、零新资产。
 */
import type { Ledger } from './ledger';

export interface MirrorStats {
  /** 救下旅人次数（survivor_saved） */
  saved: number;
  /** 抢夺次数（survivor_robbed） */
  robbed: number;
  /** 无视求助次数（survivor_ignored） */
  ignored: number;
  /** 旅人失踪次数（survivor_lost） */
  lost: number;
  /** 被实体抓住次数（caught） */
  caught: number;
  /** 走过的夜数（账本出现过的不同夜数） */
  nights: number;
}

export interface MirrorRow {
  /** 左列：你做过的事（按实际计数拼装） */
  left: string;
  /** 右列：世界长出的回应（按实际计数拼装） */
  right: string;
}

export interface MirrorView {
  rows: MirrorRow[];
}

/** 读全部账本 → 镜像统计（乱流读账不读心：只数条目，不做道德判断） */
export function readMirrorStats(ledger: Ledger): MirrorStats {
  const records = ledger.all();
  const count = (type: string) => records.filter((r) => r.type === type).length;
  const nights = new Set(records.map((r) => r.night)).size;
  return {
    saved: count('survivor_saved'),
    robbed: count('survivor_robbed'),
    ignored: count('survivor_ignored'),
    lost: count('survivor_lost'),
    caught: count('caught'),
    nights: Math.max(1, nights),
  };
}

/** 第一行「救」的对照池：拱门意象（世界因善账长出的结构） */
const ARCH_ROWS: Array<{ zero: boolean; left: (n: number) => string; right: (n: number) => string }> = [
  {
    zero: false,
    left: (n) => `你救过 ${n} 人`,
    right: (n) => `世界长出 ${n} 座拱门`,
  },
  {
    zero: false,
    left: (n) => `你在雾里回过头 ${n} 次`,
    right: (n) => `冰面上立起 ${n} 道桥`,
  },
  {
    zero: true,
    left: () => `你还从没把谁带回来过`,
    right: () => `世界没有为你长出任何拱门`,
  },
];

/** 第二行「抢」的对照池：裂缝意象（世界因亏账裂开的地方） */
const CRACK_ROWS: Array<{ zero: boolean; left: (n: number) => string; right: (n: number) => string }> = [
  {
    zero: false,
    left: (n) => `你抢过 ${n} 次`,
    right: (n) => `世界裂开 ${n} 道缝`,
  },
  {
    zero: false,
    left: (n) => `你从呼救的人手里拿走 ${n} 回`,
    right: (n) => `烬土里塌陷 ${n} 口井`,
  },
  {
    zero: true,
    left: () => `你的手还算干净`,
    right: () => `世界替你省下了每一道缝`,
  },
];

/** 第三行「夜」的对照池：灯意象（走过几夜，世界就亮着几盏灯——账本即存在证明） */
const LAMP_ROWS: Array<{ left: (n: number) => string; right: (n: number) => string }> = [
  {
    left: (n) => `你走过 ${n} 夜`,
    right: (n) => `世界亮着 ${n} 盏灯`,
  },
  {
    left: (n) => `你在账本上写满 ${n} 夜`,
    right: (n) => `乱流替你点着 ${n} 盏灯`,
  },
];

/** 按实际统计拼装三行对照（池内随机抽变体；零计数行走专用行） */
export function buildMirrorView(stats: MirrorStats): MirrorView {
  const pick = <T,>(pool: T[]): T => pool[Math.floor(Math.random() * pool.length)]!;
  const archPool = stats.saved > 0 ? ARCH_ROWS.filter((r) => !r.zero) : ARCH_ROWS.filter((r) => r.zero);
  const crackPool = stats.robbed > 0 ? CRACK_ROWS.filter((r) => !r.zero) : CRACK_ROWS.filter((r) => r.zero);
  const arch = pick(archPool);
  const crack = pick(crackPool);
  const lamp = pick(LAMP_ROWS);
  return {
    rows: [
      { left: arch.left(stats.saved), right: arch.right(stats.saved) },
      { left: crack.left(stats.robbed), right: crack.right(stats.robbed) },
      { left: lamp.left(stats.nights), right: lamp.right(stats.nights) },
    ],
  };
}

/** 供调试/验收核对：统计行摘要 */
export function mirrorSummary(stats: MirrorStats): string {
  return `saved=${stats.saved} robbed=${stats.robbed} ignored=${stats.ignored} lost=${stats.lost} caught=${stats.caught} nights=${stats.nights}`;
}
