/**
 * screens.ts — 2D 屏幕流（DOM/CSS 水墨暗色风）：
 * 标题/开场仪式 → 驿站晨间 → 穿缝转场 → （3D 下潜）→ 归航结算 → 夜谈 → 进度页，
 * 外加：暂停菜单、伙计说话框（T）、屏幕通用 AI 标识（合规红线常驻）。
 */
import { ARCHETYPES, type Archetype } from './config';
import type { Sfx } from './audio';
import type { LedgerRecord } from './ledger';
import { buildBillCardDom, saveBillCardPng, type BillCardData } from './billcard';

function h(tag: string, cls?: string, html?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

const AI_MARK = '本作 3D 资产由 AI 生成 · AI 生成内容已按平台规范标示';

export interface StartChoice {
  name: string;
  archetype: Archetype;
}

export interface SettleView {
  billCard: BillCardData;
  lampText: string;
  lampOk: boolean;
}

export class Screens {
  private box: HTMLElement;
  private current: HTMLElement | null = null;

  constructor(uiRoot: HTMLElement, private sfx: Sfx) {
    this.box = h('div', 'g-screens');
    uiRoot.append(this.box);
  }

  private clear() {
    this.box.innerHTML = '';
    this.current = null;
  }

  private mount(node: HTMLElement) {
    this.clear();
    node.append(h('div', 'g-ai-mark', AI_MARK));
    this.box.append(node);
    this.current = node;
    return node;
  }

  get isOpen() {
    return this.current !== null;
  }

  // ---- 标题 / 开场仪式（≤60s，可跳过） ----
  title(onStart: (c: StartChoice) => void) {
    const nameInput = document.createElement('input');
    nameInput.className = 'g-name-input';
    nameInput.value = '';
    nameInput.placeholder = '无名掌柜（回车确认）';
    nameInput.maxLength = 12;

    let archetype: Archetype | null = null;
    const cardEls: HTMLElement[] = [];

    const scr = h('div', 'g-screen g-title');
    scr.innerHTML = `
      <div class="g-title-quote">乱流每晚把世界重新缝合一次。<br/>只有被「记住」的，不会重组。</div>
      <h1 class="g-title-main">长夜驿站</h1>
      <div class="g-title-sub">第一夜 · 雾中松林废站</div>
    `;
    const nameRow = h('div', 'g-title-row');
    nameRow.append(h('label', 'g-title-lab', '掌柜名：'), nameInput);
    scr.append(nameRow);

    const archRow = h('div', 'g-arch-row');
    for (const a of ARCHETYPES) {
      const card = h('div', 'g-arch-card');
      card.innerHTML = `<div class="g-arch-name">${a.id}</div><div class="g-arch-tag">${a.tag}</div><div class="g-arch-desc">${a.desc}</div>`;
      card.onclick = () => {
        this.sfx.click();
        archetype = a.id;
        cardEls.forEach((c) => c.classList.remove('sel'));
        card.classList.add('sel');
      };
      cardEls.push(card);
      archRow.append(card);
    }
    scr.append(archRow);

    const btnRow = h('div', 'g-btn-row');
    const go = h('button', 'g-btn primary', '推门 · 开始第一夜');
    const skip = h('button', 'g-btn ghost', '跳过仪式（默认名 + 随机伙计）');
    go.onclick = () => {
      this.sfx.unlock();
      this.sfx.click();
      const name = nameInput.value.trim() || '无名掌柜';
      const arch = archetype ?? ARCHETYPES[Math.floor(Math.random() * ARCHETYPES.length)]!.id;
      onStart({ name, archetype: arch });
    };
    skip.onclick = () => {
      this.sfx.unlock();
      onStart({ name: '无名掌柜', archetype: ARCHETYPES[Math.floor(Math.random() * ARCHETYPES.length)]!.id });
    };
    btnRow.append(go, skip);
    scr.append(btnRow);

    nameInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const arch = archetype ?? ARCHETYPES[Math.floor(Math.random() * ARCHETYPES.length)]!.id;
        this.sfx.unlock();
        this.sfx.click();
        onStart({ name: nameInput.value.trim() || '无名掌柜', archetype: arch });
      }
    });

    this.mount(scr);
    setTimeout(() => nameInput.focus(), 50);
  }

  // ---- 驿站晨间（hub） ----
  morning(records: LedgerRecord[], night: number, seedName: string, bill: number, onDive: () => void) {
    const scr = h('div', 'g-screen g-morning');
    scr.innerHTML = `
      <div class="g-hub-head">
        <h2>驿站 · 第${'一二三四五六七'[night - 1] ?? night}夜之晨</h2>
        <span class="g-hub-sub">今夜世界：${seedName}。灯还亮着，乱流在门外重新缝世界。</span>
      </div>
      <div class="g-hub-cols">
        <div class="g-quest">
          <div class="g-quest-tag">今晨委托</div>
          <div class="g-quest-title">收灯人 · 灯油钱 ${bill} 文</div>
          <p class="g-quest-body">「雾中松林废站里散着些旧物——灯油瓶、铜灯笼、还有块旧怀表。捡回来抵账。<br/>天亮门关前回来。回不来的，东西就归乱流。」</p>
          <p class="g-quest-sign">—— 收灯人（没露脸）</p>
        </div>
        <div class="g-ledger">
          <div class="g-quest-tag">因果账本</div>
          ${
            records.length === 0
              ? '<p class="g-ledger-empty">账本第一页<b>之前</b>的页，全被撕掉了。<br/>今晚开始重新记。</p>'
              : `<ul class="g-ledger-list">${records
                  .slice(-8)
                  .map((r) => `<li><span class="ll-type">${LEDGER_LABEL[r.type] ?? r.type}</span><span class="ll-detail">${ledgerDetailText(r)}</span></li>`)
                  .join('')}</ul>`
          }
        </div>
      </div>
    `;
    const row = h('div', 'g-btn-row center');
    const dive = h('button', 'g-btn primary big', '推门下潜 · 第一夜');
    dive.onclick = () => {
      this.sfx.click();
      onDive();
    };
    row.append(dive);
    scr.append(row);
    this.mount(scr);
  }

  // ---- 穿缝转场（噪点闪白 + 镜头推进，1.5–2.5s） ----
  seam(onDone: () => void, seedName = '雾中松林废站') {
    this.clear();
    const wrap = h('div', 'g-seam');
    const cvs = document.createElement('canvas');
    cvs.width = Math.min(innerWidth, 1280);
    cvs.height = Math.min(innerHeight, 800);
    wrap.append(cvs);
    const label = h('div', 'g-seam-label', `第一夜 · ${seedName}`);
    wrap.append(label);
    this.box.append(wrap);
    this.current = wrap;

    const g = cvs.getContext('2d');
    const DURATION = 2000;
    const t0 = performance.now();
    const cell = 26;
    const anim = () => {
      const t = Math.min(1, (performance.now() - t0) / DURATION);
      if (g) {
        const W = cvs.width;
        const H = cvs.height;
        g.fillStyle = '#05060a';
        g.fillRect(0, 0, W, H);
        // 噪点方块，密度随时间上升
        const density = 0.15 + t * 0.75;
        const cs = Math.max(6, Math.round(cell * (1 - t * 0.55)));
        for (let y = 0; y < H; y += cs) {
          for (let x = 0; x < W; x += cs) {
            if (Math.random() < density) {
              const v = Math.random() < 0.5 ? 90 + Math.random() * 80 : 170 + Math.random() * 85;
              g.fillStyle = `rgba(${v},${v},${v},${0.5 + Math.random() * 0.5})`;
              g.fillRect(x, y, cs, cs);
            }
          }
        }
        // 镜头推进：中心白洞收缩（穿缝）
        const r = Math.max(W, H) * (1.15 - t * 1.05);
        const grad = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(1, r));
        grad.addColorStop(0, `rgba(255,250,235,${0.9 * t})`);
        grad.addColorStop(0.7, `rgba(255,245,220,${0.35 * t})`);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
        // 末段闪白
        if (t > 0.86) {
          g.fillStyle = `rgba(255,252,240,${(t - 0.86) / 0.14})`;
          g.fillRect(0, 0, W, H);
        }
      }
      if (t < 1) requestAnimationFrame(anim);
      else {
        this.clear();
        onDone();
      }
    };
    requestAnimationFrame(anim);
  }

  // ---- 归航结算（账单卡） ----
  settle(view: SettleView, onContinue: () => void) {
    const scr = h('div', 'g-screen g-settle');
    scr.innerHTML = `
      <h2>归航 · 结算</h2>
      <div class="g-settle-lamp ${view.lampOk ? 'ok' : 'bad'}">${view.lampText}</div>
    `;
    scr.append(buildBillCardDom(view.billCard));
    const row = h('div', 'g-btn-row center');
    const save = h('button', 'g-btn ghost', '保存账单图片');
    save.onclick = () => {
      this.sfx.click();
      saveBillCardPng(view.billCard);
    };
    const next = h('button', 'g-btn primary', '夜谈 →');
    next.onclick = () => {
      this.sfx.click();
      onContinue();
    };
    row.append(save, next);
    scr.append(row);
    this.mount(scr);
  }

  // ---- 夜谈 ----
  talk(archetype: string, comment: string, onContinue: () => void) {
    const scr = h('div', 'g-screen g-talk');
    scr.innerHTML = `
      <h2>夜谈 · 灯下</h2>
      <div class="g-talk-scene">驿站的灯重新亮起。伙计——灯芯上那缕小火苗——跳回灯座，看了你一会儿。</div>
    `;
    const bubble = h('div', 'g-talk-bubble');
    bubble.innerHTML = `<span class="g-talk-arch">伙计 · ${archetype}</span><p>${comment}</p>`;
    scr.append(bubble);
    const row = h('div', 'g-btn-row center');
    const next = h('button', 'g-btn primary', '看今夜进度 →');
    next.onclick = () => {
      this.sfx.click();
      onContinue();
    };
    row.append(next);
    scr.append(row);
    this.mount(scr);
  }

  // ---- 进度页 ----
  progress(
    onReplay: () => void,
    onTitle: () => void,
    sfxEnabled: boolean,
    onToggleSfx: (v: boolean) => boolean,
  ) {
    const scr = h('div', 'g-screen g-progress');
    scr.innerHTML = `
      <h2>七夜 · 进度</h2>
      <div class="g-nights">
        <div class="g-night done"><span class="n-num">壹</span><span class="n-name">雾中松林废站</span><span class="n-state">已付一夜</span></div>
        <div class="g-night dev"><span class="n-num">贰</span><span class="n-name">水墨江南 × 锈蚀废土</span><span class="n-state">开发中</span></div>
        ${[3, 4, 5, 6, 7]
          .map(
            (i) =>
              `<div class="g-night lock"><span class="n-num">${'叁肆伍陆柒'[i - 3]}</span><span class="n-name">未潜入</span><span class="n-state">待解锁</span></div>`,
          )
          .join('')}
      </div>
      <div class="g-prog-note">七夜七张账单付清 = 通关。付不起 = 灯暗一分，不判死档。</div>
    `;
    const row = h('div', 'g-btn-row center');
    const replay = h('button', 'g-btn primary', `再潜一次 第一夜（回响）`);
    replay.onclick = () => {
      this.sfx.click();
      onReplay();
    };
    const back = h('button', 'g-btn ghost', '回到标题');
    back.onclick = () => {
      this.sfx.click();
      onTitle();
    };
    const snd = h('button', 'g-btn ghost', `音效：${sfxEnabled ? '开' : '关'}`);
    let sndOn = sfxEnabled;
    snd.onclick = () => {
      sndOn = !sndOn;
      onToggleSfx(sndOn);
      snd.textContent = `音效：${sndOn ? '开' : '关'}`;
    };
    row.append(replay, snd, back);
    scr.append(row);
    this.mount(scr);
  }

  // ---- 暂停菜单（下潜中 ESC/失锁弹出） ----
  pause(onResume: () => void, onGiveUp: () => void, sfxEnabled: boolean, onToggleSfx: (v: boolean) => void) {
    let sndOn = sfxEnabled;
    const scr = h('div', 'g-screen g-pause');
    scr.innerHTML = `<h2>暂停</h2><div class="g-pause-sub">天亮在等你。乱流也在。</div>`;
    const row = h('div', 'g-btn-row col');
    const resume = h('button', 'g-btn primary', '继续下潜');
    resume.onclick = () => {
      this.sfx.click();
      onResume();
    };
    const snd = h('button', 'g-btn ghost', `音效：${sfxEnabled ? '开' : '关'}`);
    snd.onclick = () => {
      sndOn = !sndOn;
      onToggleSfx(sndOn);
      snd.textContent = `音效：${sndOn ? '开' : '关'}`;
    };
    const give = h('button', 'g-btn ghost danger', '放弃今夜（丢当日战利品，回驿站）');
    give.onclick = () => {
      this.sfx.click();
      onGiveUp();
    };
    row.append(resume, snd, give);
    scr.append(row);
    this.mount(scr);
  }

  // ---- 伙计说话框（T） ----
  talkbox(onSubmit: (text: string) => void) {
    const box = h('div', 'g-talkbox');
    const input = document.createElement('input');
    input.className = 'g-talkbox-input';
    input.placeholder = '对伙计说点什么……（回车送出 · 这会产生大噪音）';
    input.maxLength = 60;
    const send = h('button', 'g-btn primary small', '说');
    send.onclick = () => {
      const t = input.value.trim();
      if (t) {
        onSubmit(t);
        this.closeTalkbox();
      }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const t = input.value.trim();
        if (t) {
          onSubmit(t);
          this.closeTalkbox();
        }
      } else if (e.key === 'Escape') {
        this.closeTalkbox();
      }
    });
    box.append(input, send);
    this.box.append(box);
    setTimeout(() => input.focus(), 30);
    this.talkboxEl = box;
  }

  private talkboxEl: HTMLElement | null = null;

  closeTalkbox() {
    this.talkboxEl?.remove();
    this.talkboxEl = null;
  }

  get talkboxOpen() {
    return this.talkboxEl !== null;
  }

  closeAll() {
    this.clear();
    this.closeTalkbox();
  }
}

const LEDGER_LABEL: Record<string, string> = {
  loot: '拾得',
  caught: '被抓',
  noise_speak: '开口',
  door_close: '门关',
  unpaid: '欠账',
  paid: '付清',
  return: '归航',
};

function ledgerDetailText(r: LedgerRecord): string {
  const d = r.detail;
  switch (r.type) {
    case 'loot':
      return `${String(d.name)} · ${String(d.value)} 文${d.deep ? '（深处）' : ''}`;
    case 'caught':
      return `丢战利品 ×${String(d.lost ?? 0)}，被拖回门口`;
    case 'noise_speak':
      return `「${String(d.text ?? '').slice(0, 14)}」`;
    case 'door_close':
      return `门关未归，散失 ${String(d.lostValue ?? 0)} 文`;
    case 'unpaid':
      return `短付 ${String(d.shortfall ?? 0)} 文，灯暗一分`;
    case 'paid':
      return `${String(d.total ?? 0)} 文两讫`;
    case 'return':
      return `剩 ${String(d.secondsLeft ?? 0)}s 推门`;
    default:
      return '';
  }
}
