/**
 * ledger.ts — 因果账本（localStorage 持久化）。
 *
 * 世界观根：乱流读「账」不读「心」——这里的每条记录是导演 agent 缝明晚世界的
 * 输入种子（设计 §1 账目法则、§9 导演 agent 输入=因果账本）。
 *
 * 字段说明（给导演 agent 的契约注释）：
 * - night: 第几夜（1..7，回响夜在 1 上重复但 ts 不同）
 * - ts: 毫秒时间戳（排序与「昨晚」判定用）
 * - type: 事件类型
 *     loot            拾取战利品   detail: { id, name, value, deep: 是否深处 }
 *     caught          被实体抓住   detail: { lost: 丢失战利品数, at: 抓捕点 }
 *     noise_speak     与伙计说话（大噪音） detail: { text }
 *     door_close      门关未归     detail: { lostValue }
 *     unpaid          账单未付清   detail: { total, bill, shortfall }
 *     paid            账单付清     detail: { total, bill }        (v1.1 增补)
 *     return          归航         detail: { secondsLeft }        (v1.1 增补)
 *     survivor_saved  幸存者·救下（带回门口） detail: { bonus }    (E2 增补)
 *     survivor_ignored 幸存者·无视求助          detail: {}        (E2 增补)
 *     survivor_robbed 幸存者·抢夺（得油纸包+大噪音） detail: { value } (E2 增补)
 *     survivor_lost   幸存者·旅人失踪（玩家被抓/门关） detail: {}    (E2 增补)
 * - detail: 任意 JSON（导演 agent 自行解释；多余字段无害）
 * 导演 agent 只读不写；游戏运行时追加。schema 向后兼容（只增字段不改语义）。
 */

export type LedgerEventType =
  | 'loot'
  | 'caught'
  | 'noise_speak'
  | 'door_close'
  | 'unpaid'
  | 'paid'
  | 'return'
  | 'survivor_saved'
  | 'survivor_ignored'
  | 'survivor_robbed'
  | 'survivor_lost';

export interface LedgerRecord {
  night: number;
  ts: number;
  type: LedgerEventType;
  detail: Record<string, unknown>;
}

const KEY = 'long-night-inn:ledger:v1';

export function loadLedger(): LedgerRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as LedgerRecord[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function save(records: LedgerRecord[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(records));
  } catch {
    /* 隐私模式等 localStorage 不可用时静默降级（本次会话内存态仍可用） */
  }
}

export class Ledger {
  private records: LedgerRecord[] = [];

  constructor() {
    this.records = loadLedger();
  }

  add(night: number, type: LedgerEventType, detail: Record<string, unknown> = {}): LedgerRecord {
    const rec: LedgerRecord = { night, ts: Date.now(), type, detail };
    this.records.push(rec);
    save(this.records);
    return rec;
  }

  /** 某夜全部记录（按时间序） */
  nightRecords(night: number): LedgerRecord[] {
    return this.records.filter((r) => r.night === night);
  }

  /** 某夜第一条记录（夜谈评论对象） */
  firstOf(night: number): LedgerRecord | null {
    return this.nightRecords(night)[0] ?? null;
  }

  all(): LedgerRecord[] {
    return [...this.records];
  }

  /** 调试：清空账本 */
  reset() {
    this.records = [];
    save(this.records);
  }
}

// ---- 夜进度（解锁链，localStorage）----
// 结算即解锁下一夜（灯暗一分不判死档，见设计 §3）；进度页按此渲染 N1✓ N2(解锁) N3+(置灰)。

const UNLOCKED_KEY = 'long-night-inn:unlocked-night:v1';

export function loadUnlockedNight(): number {
  try {
    const raw = localStorage.getItem(UNLOCKED_KEY);
    const n = raw ? Number.parseInt(raw, 10) : 1;
    return Number.isFinite(n) && n >= 1 ? n : 1;
  } catch {
    return 1;
  }
}

export function saveUnlockedNight(night: number) {
  try {
    const cur = loadUnlockedNight();
    if (night > cur) localStorage.setItem(UNLOCKED_KEY, String(night));
  } catch {
    /* localStorage 不可用时静默降级（本次会话内存态仍可用） */
  }
}
