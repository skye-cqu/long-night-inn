/**
 * finale.ts — N7 三线结局判定 + 结局海报数据（E11/C4，设计 §2「七夜大潮」三线结局、
 * §7 N7 终幕结算、§6 槽 #27 传播钩子「截图即分享」）。
 *
 * 判定完全确定性（乱流读账不读心）：只数账本条目，不掷随机、不读心。三线最终规则
 * （按序短路，①优先于②优先于③——欠账是最重的因果，奇观次之，花海是干净账的回报）：
 *  ① 亏 · 灰烬（debt）：夜一至六存在「整夜无 paid 记录」的欠账夜（未潜/门关/放弃/短付
 *     后未回潜补账都算），或全账 robbed > saved（抢夺多于救人）；
 *  ② 乱 · 奇观（chaos）：不属亏，且 caught ≥ 3（被乱流反复咬住），或 saved ≥ 3 且
 *     robbed ≥ 3（救抢双高互咬——账付清了，但路子太野）；
 *  ③ 善 · 花海（good）：其余——六夜账单全付清且 saved ≥ robbed（含全零：没遇上谁，
 *     也没欠过谁）。
 * 三线氛围滤镜（#app.finale-debt 灰烬去饱和 / .finale-chaos 奇观色错位 / 善=原样）
 * 在 N7 下潜开始即应用（世界从落进来的那一刻就是你的账本显形），告辞页/海报沿用。
 */
import type { Ledger } from './ledger';

export type FinaleLine = 'good' | 'debt' | 'chaos';

export interface FinaleStats {
  /** 账本出现过的夜数（1..6） */
  nights: number;
  /** 有 paid 记录的夜数（1..6） */
  paidNights: number;
  /** 欠账夜数 = 6 - paidNights */
  debtNights: number;
  saved: number;
  robbed: number;
  ignored: number;
  lost: number;
  caught: number;
}

export interface FinaleJudgement {
  line: FinaleLine;
  stats: FinaleStats;
  /** 有 paid 记录的夜列表（柒格逐夜付/欠用） */
  paidList: number[];
  /** 有任何记录的夜列表（柒格「欠」vs「未至」区分用） */
  visitedList: number[];
  rule: string;
}

/** 三线判定规则原文（海报 .fc-rule 与 __game.finale.rule 用同一份） */
export const FINALE_RULE = [
  '三线判定（按序短路）：',
  '① 亏 · 灰烬：夜一至六存在整夜未付清的欠账夜，或全账抢夺多于救人；',
  '② 乱 · 奇观：不属亏，且被抓 ≥3 次，或救人 ≥3 且抢夺 ≥3（双高互咬）；',
  '③ 善 · 花海：其余——六夜账单全付清且救人 ≥ 抢夺（含全零）。',
].join('\n');

export const FINALE_LINE_NAME: Record<FinaleLine, string> = {
  good: '善 · 花海',
  debt: '亏 · 灰烬',
  chaos: '乱 · 奇观',
};

/** 读账本 → 三线判定（确定性：同账本必然同线） */
export function judgeFinale(ledger: Ledger): FinaleJudgement {
  const records = ledger.all();
  const cnt = (t: string) => records.filter((r) => r.type === t).length;
  const paidList = [1, 2, 3, 4, 5, 6].filter((n) =>
    records.some((r) => r.night === n && r.type === 'paid'),
  );
  const nightsSet = new Set(records.filter((r) => r.night >= 1 && r.night <= 6).map((r) => r.night));
  const visitedList = [1, 2, 3, 4, 5, 6].filter((n) => nightsSet.has(n));
  const stats: FinaleStats = {
    nights: visitedList.length,
    paidNights: paidList.length,
    debtNights: 6 - paidList.length,
    saved: cnt('survivor_saved'),
    robbed: cnt('survivor_robbed'),
    ignored: cnt('survivor_ignored'),
    lost: cnt('survivor_lost'),
    caught: cnt('caught'),
  };
  let line: FinaleLine;
  if (stats.debtNights > 0 || stats.robbed > stats.saved) line = 'debt';
  else if (stats.caught >= 3 || (stats.saved >= 3 && stats.robbed >= 3)) line = 'chaos';
  else line = 'good';
  return { line, stats, paidList, visitedList, rule: FINALE_RULE };
}

// ---- 结局海报（bill-card 风格三变体的数据；DOM 在 screens.poster） ----

export interface PosterNightCell {
  /** 格内短字（夜序号+付/欠/—，柒格第 7 格=终局短名） */
  label: string;
  /** ok=付清 bad=欠账 dim=未至 fin=终局 */
  cls: string;
}

export interface PosterView {
  line: FinaleLine;
  lineName: string;
  /** 大标题（三变体各一） */
  title: string;
  /** 一句话判词 */
  desc: string;
  playerName: string;
  date: string;
  /** 账本统计印卡行（k → v） */
  stats: Array<[string, string]>;
  /** 柒格终局态（1..7） */
  nights: PosterNightCell[];
  rule: string;
}

const POSTER_COPY: Record<FinaleLine, { title: string; desc: string }> = {
  good: {
    title: '七夜账清 · 花海满开',
    desc: '账单两讫，救下的比夺走的多。乱流把你的长廊缝成了一片花海——灯，亮到了最后。',
  },
  debt: {
    title: '灯暗一分 · 灰烬斜落',
    desc: '账上有欠，手里有抢。长廊尽头没有花——只有灰烬，替你数着没付清的那几文。',
  },
  chaos: {
    title: '乱流大潮 · 奇观错位',
    desc: '账付清了，但乱流咬过你太多次。花海开成了不属于这个世界的颜色——它记得每一口。',
  },
};

/** 拼装海报数据（柒格：1..6 夜付/欠/未至 + 第 7 格终局态） */
export function buildPosterView(j: FinaleJudgement, playerName: string): PosterView {
  const cells: PosterNightCell[] = [];
  const CN = '一二三四五六';
  for (let n = 1; n <= 6; n++) {
    const paid = j.paidList.includes(n);
    const visited = paid || j.visitedList.includes(n);
    cells.push(paid
      ? { label: `${CN[n - 1]}付`, cls: 'ok' }
      : visited
        ? { label: `${CN[n - 1]}欠`, cls: 'bad' }
        : { label: `${CN[n - 1]}—`, cls: 'dim' });
  }
  const finShort = j.line === 'good' ? '花海' : j.line === 'debt' ? '灰烬' : '奇观';
  cells.push({ label: `柒·${finShort}`, cls: 'fin' });
  return {
    line: j.line,
    lineName: FINALE_LINE_NAME[j.line],
    title: POSTER_COPY[j.line].title,
    desc: POSTER_COPY[j.line].desc,
    playerName,
    date: new Date().toISOString().slice(0, 10),
    stats: [
      ['七夜走过', `${j.stats.nights} / 6 夜`],
      ['账单付清', `${j.stats.paidNights} / 6 夜${j.stats.debtNights ? ` · 欠 ${j.stats.debtNights} 夜` : ''}`],
      ['救下旅人', `${j.stats.saved} 人`],
      ['抢夺旅人', `${j.stats.robbed} 回`],
      ['无视呼救', `${j.stats.ignored} 声`],
      ['旅人走散', `${j.stats.lost} 人`],
      ['被实体抓住', `${j.stats.caught} 次`],
    ],
    nights: cells,
    rule: FINALE_RULE,
  };
}

// ---- 终局存档（localStorage：柒格终局态 + 标题页回响预告行的数据源） ----

const FINALE_KEY = 'long-night-inn:finale-line:v1';

export function saveFinaleLine(line: FinaleLine) {
  try {
    localStorage.setItem(FINALE_KEY, line);
  } catch {
    /* localStorage 不可用时静默降级（本次会话内流程不受影响） */
  }
}

export function loadFinaleLine(): FinaleLine | null {
  try {
    const raw = localStorage.getItem(FINALE_KEY);
    return raw === 'good' || raw === 'debt' || raw === 'chaos' ? raw : null;
  } catch {
    return null;
  }
}
