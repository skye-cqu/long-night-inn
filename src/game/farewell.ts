/**
 * farewell.ts — N7 告别陈词（E11/C3；设计 §7 N7「终幕下潜=走过自己造的世界+告别」、
 * §8「N7 告别陈词由账本全程生成」、§6 槽 #9「N7 告别引用第一夜」）。
 *
 * 陈词 = 伙计在亮门边念账本：≥3 段全部从因果账本（ledger.ts，N1 起的全部记录）确定性
 * 拼装——不调 LLM、不掷随机（文案变体按账本事实分岔，mirror.ts 同款手法但去掉随机抽池，
 * 保证 __game.farewellText() 逐句可核对）：
 *  ① 开场引账本：玩家写回的名字 + 第一夜的结局（付清/短付/门关未归/空白页专用行）；
 *  ② 逐夜回顾：夜数 × 当夜结局 × 救/抢/无视/走散/被抓实际计数（计数为零的段不出现，
 *     全零走专用行「这一路你没遇上谁」）+ 总账行；
 *  ③ 伙计告别段：引用夜谈（noise_speak 的次数与最后一句原话；零开口走专用行）
 *     + 随行夜数 + 按伙计原型的收尾行。
 */
import { NIGHTS, nightCn, type Archetype } from './config';
import type { Ledger, LedgerRecord } from './ledger';

export interface FarewellView {
  paragraphs: string[];
}

/** 第一夜结局行（①段）：按 N1 记录分岔，计数为零/缺页走专用行 */
function firstNightLine(records: LedgerRecord[]): string {
  const n1 = records.filter((r) => r.night === 1);
  if (n1.length === 0) return '账本第一页是空的。名字是你后来才亲手写回来的——第一夜的事，纸上没留下，但我记得。';
  const paid = n1.some((r) => r.type === 'paid');
  const unpaid = n1.filter((r) => r.type === 'unpaid').at(-1);
  const doorClose = n1.some((r) => r.type === 'door_close');
  if (paid) return '第一夜你凑齐了二十文，账单两讫，灯亮了一整夜。名字是你那天早上亲手写回账本第一页的。';
  if (unpaid) return `第一夜你短了${String(unpaid.detail.shortfall ?? '?')}文，灯暗了一分——但你在天亮前推开了门。名字是你那天早上亲手写回账本第一页的。`;
  if (doorClose) return '第一夜你没赶上门关，被乱流抛了回来，两手空空。名字是你那天早上亲手写回账本第一页的。';
  return '第一夜的墨迹很淡，像是写着写着灯就暗了。名字是你那天早上亲手写回账本第一页的。';
}

/** 单夜回顾行（②段）：当夜结局 + 遭遇计数；零计数段自然消失 */
function nightLine(night: number, records: LedgerRecord[]): string | null {
  const rs = records.filter((r) => r.night === night);
  if (rs.length === 0) return null;
  const seed = NIGHTS.find((n) => n.night === night)?.seedName ?? '';
  const parts: string[] = [];
  if (rs.some((r) => r.type === 'paid')) parts.push('账单付清');
  else {
    const unpaid = rs.filter((r) => r.type === 'unpaid').at(-1);
    if (unpaid) parts.push(`短付${String(unpaid.detail.shortfall ?? '?')}文`);
    else if (rs.some((r) => r.type === 'door_close')) parts.push('门关未归');
  }
  const cnt = (type: string) => rs.filter((r) => r.type === type).length;
  const saved = cnt('survivor_saved');
  const robbed = cnt('survivor_robbed');
  const ignored = cnt('survivor_ignored');
  const lost = cnt('survivor_lost');
  const caught = cnt('caught');
  const enc: string[] = [];
  if (saved) enc.push(`救下${saved}人`);
  if (robbed) enc.push(`抢了${robbed}回`);
  if (ignored) enc.push(`没理${ignored}声`);
  if (lost) enc.push(`走散${lost}人`);
  if (caught) enc.push(`被抓${caught}次`);
  if (enc.length) parts.push(enc.join('，'));
  return `第${nightCn(night)}夜（${seed}）：${parts.join('；') || '走了，没留字'}。`;
}

/** 总账行（②段收尾）：聚合计数；遭遇计数全零走专用行（mirror 手法） */
function totalsLine(records: LedgerRecord[]): string {
  const cnt = (type: string) => records.filter((r) => r.type === type).length;
  const nights = new Set(records.filter((r) => r.night <= 6).map((r) => r.night)).size;
  const saved = cnt('survivor_saved');
  const robbed = cnt('survivor_robbed');
  const ignored = cnt('survivor_ignored');
  const lost = cnt('survivor_lost');
  const caught = cnt('caught');
  const enc: string[] = [];
  if (saved) enc.push(`救过${saved}人`);
  if (robbed) enc.push(`抢过${robbed}回`);
  if (ignored) enc.push(`没理${ignored}声呼救`);
  if (lost) enc.push(`走散了${lost}人`);
  const encText = enc.length
    ? `六夜总账：付了${nights}夜灯油钱，路上${enc.join('，')}${caught ? `，被抓过${caught}次` : '，一次也没被抓住'}。`
    : caught
      ? `六夜总账：付了${nights}夜灯油钱，路上没遇上谁，也没丢下谁——就是被抓过${caught}次。`
      : '六夜总账：付了钱，赶了路，一次也没被抓住。你没遇上谁，也没丢下谁——账本干干净净。';
  return encText;
}

/** 伙计告别段（③段）：夜谈引用 + 随行记忆 + 原型收尾 */
const ARCH_FAREWELL: Record<Archetype, string> = {
  毒舌:
    '行了，就送到这。灯芯上那点位置我腾出来了——下辈子换你当灯芯，换我来喊你起床。走到亮门里去吧，别回头，回头我要笑场。',
  胆小:
    '我、我跟了你七夜，一步都没敢落下……现在轮到我先走了，你别笑我。亮门里面很暖的，比灯座还暖。去吧，我看着你进去。',
  神秘:
    '灯芯守影，影散灯在。我记下的每一笔都会留在这个世界的缝里——哪天你听见花海里有翻纸的声音，那是我在对账。去吧。',
};

function companionLines(records: LedgerRecord[], nights: number, archetype: Archetype): string[] {
  const speaks = records.filter((r) => r.type === 'noise_speak');
  const memory =
    speaks.length > 0
      ? `这一路你开口跟我说话${speaks.length}次。最后那句是「${String(speaks.at(-1)!.detail.text ?? '').slice(0, 24)}」——灯芯上记事，比纸牢靠，我一个字都没忘。`
      : '这一路你话不多。也好——灯芯上记事，比纸牢靠，你走过的每一步我都替你记着呢。';
  return [
    `我们一起走过了${nights || 1}个夜晚。`,
    memory,
    ARCH_FAREWELL[archetype],
  ];
}

/** 拼装告别陈词（≥3 段；确定性——同账本同输入必然同文） */
export function buildFarewell(ledger: Ledger, playerName: string, archetype: Archetype): FarewellView {
  const records = ledger.all();
  const nights = new Set(records.filter((r) => r.night <= 6).map((r) => r.night)).size;
  const p1 = `「${playerName}，账本收灯人收走了，但我早就背下来了。」`;
  const p2 = [firstNightLine(records), ...[1, 2, 3, 4, 5, 6].map((n) => nightLine(n, records)).filter((s): s is string => s !== null), totalsLine(records)].join('\n');
  const p3 = companionLines(records, nights, archetype).join('\n');
  return { paragraphs: [p1, p2, p3] };
}

/** 调试/验收：陈词纯文本（__game.farewellText 逐句核对账本来源用） */
export function farewellText(view: FarewellView): string {
  return view.paragraphs.join('\n\n');
}
