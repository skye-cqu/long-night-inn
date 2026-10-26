/**
 * billcard.ts — 「今夜账单卡」（传播物料 P1：截图即分享）。
 *
 * DOM 卡片用于在结算页展示；「保存图片」按钮用 Canvas2D 重绘同款并导出 PNG。
 * 生成类内容合规：卡面常驻 AI 生成标识（红线 §3）。
 */

export interface BillCardData {
  night: number;
  seedName: string;
  /** 夜型字样（N5=「匮乏夜」/ N6=「镜像夜」；缺省不显示，N1–N4 卡面零变化） */
  tagline?: string;
  looted: Array<{ name: string; value: number }>;
  total: number;
  bill: number;
  paid: boolean;
  caught: number;
  nearMiss: number;
  spoken: number;
  /** 幸存者遭遇结局字样（E2）：救下旅人/无视求助/抢夺旅人/旅人失踪；无遭遇则缺省 */
  survivor?: string;
  quip: string;
  date: string; // YYYY-MM-DD
}

function fmt(n: number) {
  return `${n} 文`;
}

/** 遭遇行文本（DOM 卡与 canvas 导出共用，E2 追加幸存者结局字样） */
function encounterLine(d: BillCardData): string {
  return (
    `遭遇：${d.caught > 0 ? `被实体抓住 ×${d.caught}` : '全身而退'}${d.nearMiss ? ` · 逼近 ${d.nearMiss} 次` : ''}${d.spoken ? ` · 黑暗开口 ${d.spoken} 次` : ''}` +
    (d.survivor ? ` · ${d.survivor}` : '')
  );
}

/** 结算页内嵌的 DOM 卡片（视觉与导出 PNG 同款） */
export function buildBillCardDom(d: BillCardData): HTMLElement {
  const card = document.createElement('div');
  card.className = 'bill-card';
  const items = d.looted.length
    ? d.looted.map((l) => `<span class="bc-item">${l.name}·${l.value}文</span>`).join('')
    : '<span class="bc-item bc-dim">两手空空</span>';
  card.innerHTML = `
    <div class="bc-head">
      <span class="bc-title">今夜账单</span>
      <span class="bc-night">第${'一二三四五六七'[d.night - 1] ?? d.night}夜 · ${d.seedName}${d.tagline ? `<b class="bc-tag">${d.tagline}</b>` : ''}</span>
    </div>
    <div class="bc-loot">${items}<span class="bc-total">共 ${fmt(d.total)}</span></div>
    <div class="bc-bill">账单 ${fmt(d.bill)} → ${d.paid ? '<b class="bc-ok">付清 · 灯亮</b>' : `<b class="bc-bad">差 ${fmt(d.bill - d.total)} · 灯暗一分</b>`}</div>
    <div class="bc-mid">
      <span>${encounterLine(d)}</span>
    </div>
    <div class="bc-quip">「${d.quip}」 —— 伙计</div>
    <div class="bc-foot"><span>长夜驿站 · ${d.date}</span><span class="bc-ai">本作 3D 资产由 AI 生成</span></div>
  `;
  return card;
}

/** Canvas 重绘并触发 PNG 下载 */
export function saveBillCardPng(d: BillCardData) {
  const W = 720;
  const H = 420;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  if (!g) return;

  // 底：墨色 + 微噪
  g.fillStyle = '#0d0f14';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(180,190,210,${Math.random() * 0.03})`;
    g.fillRect(Math.random() * W, Math.random() * H, 2, 2);
  }
  // 边框（双线，账本感）
  g.strokeStyle = '#c9a86b';
  g.lineWidth = 2;
  g.strokeRect(14, 14, W - 28, H - 28);
  g.strokeStyle = 'rgba(201,168,107,0.4)';
  g.lineWidth = 1;
  g.strokeRect(22, 22, W - 44, H - 44);

  const ink = '#e8e2d4';
  const gold = '#c9a86b';

  g.fillStyle = ink;
  g.font = 'bold 34px "KaiTi","STKaiti",serif';
  g.fillText('今夜账单', 44, 74);
  g.font = '18px "KaiTi","STKaiti",serif';
  g.fillStyle = gold;
  g.fillText(`第${'一二三四五六七'[d.night - 1] ?? d.night}夜 · ${d.seedName}${d.tagline ? ' · ' + d.tagline : ''}`, 210, 72);

  // 战利品
  g.fillStyle = ink;
  g.font = '20px "KaiTi","STKaiti",serif';
  const lootText =
    (d.looted.length ? d.looted.map((l) => `${l.name}·${l.value}文`).join('　') : '两手空空') + `　→ 共 ${d.total} 文`;
  g.fillText(lootText, 44, 126);

  // 账单结果
  g.font = 'bold 22px "KaiTi","STKaiti",serif';
  g.fillStyle = d.paid ? '#8fd48a' : '#e07a6a';
  g.fillText(d.paid ? `账单 ${d.bill} 文 · 付清，灯亮` : `账单 ${d.bill} 文 · 差 ${d.bill - d.total} 文，灯暗一分`, 44, 168);

  // 遭遇
  g.font = '18px "KaiTi","STKaiti",serif';
  g.fillStyle = '#b8c0cf';
  const mid = encounterLine(d);
  g.fillText(mid, 44, 204);

  // 伙计吐槽（自动换行简化：单行截断）
  g.fillStyle = gold;
  g.font = '19px "KaiTi","STKaiti",serif';
  const quip = `「${d.quip}」—— 伙计`;
  g.fillText(quip.length > 30 ? quip.slice(0, 30) + '…' : quip, 44, 252);

  // 分隔与页脚
  g.strokeStyle = 'rgba(201,168,107,0.5)';
  g.beginPath();
  g.moveTo(44, 352);
  g.lineTo(W - 44, 352);
  g.stroke();
  g.fillStyle = '#8a93a6';
  g.font = '15px system-ui,sans-serif';
  g.fillText(`长夜驿站 · ${d.date}`, 44, 382);
  const ai = '本作 3D 资产由 AI 生成';
  g.fillText(ai, W - 44 - g.measureText(ai).width, 382);

  // 下载
  c.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `长夜账单-第${d.night}夜-${d.date}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 'image/png');
}
