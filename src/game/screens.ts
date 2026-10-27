/**
 * screens.ts — 2D 屏幕流（DOM/CSS 水墨暗色风）：
 * 标题/开场仪式 → 驿站晨间 → 穿缝转场 → （3D 下潜）→ 归航结算 → 夜谈 → 进度页，
 * 外加：暂停菜单、伙计说话框（T）、屏幕通用 AI 标识（合规红线常驻）。
 */
import { nightCn, ARCHETYPES, type Archetype, type NightDef } from './config';
import type { Sfx } from './audio';
import type { LedgerRecord } from './ledger';
import { buildBillCardDom, saveBillCardPng, type BillCardData } from './billcard';
import type { MirrorView } from './mirror';
import type { FarewellView } from './farewell';
import { FINALE_LINE_NAME, type FinaleLine, type PosterView } from './finale';

function h(tag: string, cls?: string, html?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

/** 动态文本进 innerHTML 前转义（告别陈词/海报含玩家名等自由文本） */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const AI_MARK = '本作 3D 资产由 AI 生成 · AI 生成内容已按平台规范标示';

export interface StartChoice {
  name: string;
  archetype: Archetype;
}

/** 幸存者遭遇三选（E2） */
export type SurvivorChoice = 'save' | 'ignore' | 'rob';

export interface SettleView {
  billCard: BillCardData;
  lampText: string;
  lampOk: boolean;
}

/** 晨间住客卡数据（N4 住客回归，#26 常客系统；无住客则缺省走伙计情报行） */
export interface GuestCardView {
  name: string;
  intro: string;
  line: string;
  intel: string;
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

  // ---- 标题 / 开场仪式（≤60s，可跳过；echoTeaser=终幕后回响预告行，§7.5 P1） ----
  title(onStart: (c: StartChoice) => void, echoTeaser?: string) {
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
    if (echoTeaser) scr.append(h('div', 'g-title-echo', echoTeaser));
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

  // ---- 结局海报（N7 终幕：bill-card 风格三变体 + 账本统计印卡 + 柒格终局态；
  //      AI 标识随 mount 常驻，槽 #27「截图即分享」） ----
  poster(view: PosterView, onAgain: () => void) {
    const scr = h('div', 'g-screen g-poster');
    const card = h('div', `finale-card ${view.line}`);
    card.innerHTML = `
      <div class="fc-head"><span class="fc-title">${esc(view.title)}</span><span class="fc-line">${esc(view.lineName)}</span></div>
      <div class="fc-art"><i></i><i></i><i></i><i></i></div>
      <p class="fc-desc">${esc(view.desc)}</p>
      <div class="fc-stats">${view.stats.map(([k, v]) => `<div class="row"><span class="k">${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}</div>
      <div class="fc-nights">${view.nights.map((c) => `<span class="${c.cls}">${esc(c.label)}</span>`).join('')}</div>
      <div class="fc-rule">${esc(view.rule).replace(/\n/g, '<br/>')}</div>
      <div class="fc-foot"><span>长夜驿站 · ${esc(view.playerName)} · ${esc(view.date)}</span><span>本作 3D 资产由 AI 生成</span></div>
    `;
    scr.append(card);
    const row = h('div', 'g-btn-row center');
    const again = h('button', 'g-btn primary', '再看一夜（回响）');
    again.onclick = () => {
      this.sfx.click();
      onAgain();
    };
    row.append(again);
    scr.append(row);
    this.mount(scr);
  }

  // ---- 驿站晨间（hub，按夜配置渲染委托文案；echoMorning=N2 选择回响的一行字，N3 起；
  //      guestCard=N4 住客卡（#26 常客回归，saved 集）；keeperIntel=无住客时的伙计情报行；
  //      liveGen=N7 现场生成缝（C5）：探测可达才亮次选按钮，默认按钮恒为烘焙世界） ----
  morning(
    records: LedgerRecord[],
    def: NightDef,
    onDive: () => void,
    echoMorning?: string,
    guestCard?: GuestCardView,
    keeperIntel?: string,
    liveGen?: { probe: Promise<'on' | 'off'>; onStart: () => void },
  ) {
    const scr = h('div', 'g-screen g-morning');
    scr.innerHTML = `
      <div class="g-hub-head">
        <h2>驿站 · 第${nightCn(def.night)}夜之晨</h2>
        <span class="g-hub-sub">今夜世界：${def.seedName}。灯还亮着，乱流在门外重新缝世界。</span>
      </div>
      ${echoMorning ? `<div class="g-echo-line">${echoMorning}</div>` : ''}
      <div class="g-hub-cols">
        <div class="g-quest">
          <div class="g-quest-tag">今晨委托</div>
          <div class="g-quest-title">${def.quest.title}</div>
          <p class="g-quest-body">${def.quest.body}</p>
          <p class="g-quest-sign">${def.quest.sign}</p>
          ${!guestCard && keeperIntel ? `<p class="g-keeper-intel">${keeperIntel}</p>` : ''}
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
    // N4 住客卡（#26 常客系统首秀）：他就是 N2 被救的人，住下了，给一条口头情报
    if (guestCard) {
      const card = h('div', 'g-guest-card');
      card.innerHTML = `
        <div class="g-guest-name">${guestCard.name}</div>
        <p class="g-guest-intro">${guestCard.intro}</p>
        <p class="g-guest-line">${guestCard.line}</p>
        <p class="g-guest-intel">${guestCard.intel}</p>
      `;
      scr.append(card);
    }
    // N7 终幕（NightDef.finale）：晨间收灯人半张脸出场收走账本（C2 CSS 载体接线，
    // DOM/CSS 剪影演出零新资产——设计 §2「收灯人是谁：留白，N7 只给半张脸」）
    if (def.finale) {
      const stage = h('div', 'g-keeper-stage');
      stage.innerHTML = `<div class="g-keeper-light"></div><div class="g-keeper-figure"></div><div class="g-keeper-face"></div>`;
      scr.append(stage);
      scr.append(h('div', 'g-keeper-cap', '收灯人 · 第一次露了半张脸'));
      scr.append(h('div', 'g-keeper-note', '他把账本从桌上抽走了。「七夜的账，乱流替你收着。往东走，长廊尽头有扇亮着的门——去和你的伙计道个别。」'));
    }
    const row = h('div', 'g-btn-row center');
    const dive = h('button', 'g-btn primary big', def.finale ? '推门下潜 · 终幕' : `推门下潜 · 第${nightCn(def.night)}夜`);
    dive.onclick = () => {
      this.sfx.click();
      onDive();
    };
    row.append(dive);
    // N7 现场生成次选按钮（C5）：探测期禁用占位，可达才启用；不可达直接摘除（默认=烘焙）
    if (liveGen) {
      const live = document.createElement('button');
      live.className = 'g-btn ghost';
      live.textContent = '现场生成 · 探测中…';
      live.disabled = true;
      liveGen.probe.then((s) => {
        if (s === 'on') {
          live.disabled = false;
          live.textContent = '现场生成 · 乱流今夜现缝';
        } else {
          live.remove();
        }
      });
      live.onclick = () => {
        if (live.disabled) return;
        this.sfx.click();
        liveGen.onStart();
      };
      row.append(live);
    }
    scr.append(row);
    this.mount(scr);
  }

  // ---- 穿缝转场（噪点闪白 + 镜头推进，2s；世界未就绪时延长等待，
  //      超过 4s 显示「乱流缝合中…」进度文案，就绪即放行） ----
  seam(onDone: () => void, def: Pick<NightDef, 'night' | 'seedName'>, ready: Promise<void>) {
    this.clear();
    const wrap = h('div', 'g-seam');
    const cvs = document.createElement('canvas');
    cvs.width = Math.min(innerWidth, 1280);
    cvs.height = Math.min(innerHeight, 800);
    wrap.append(cvs);
    const label = h('div', 'g-seam-label', `第${nightCn(def.night)}夜 · ${def.seedName}`);
    wrap.append(label);
    this.box.append(wrap);
    this.current = wrap;

    const g = cvs.getContext('2d');
    const DURATION = 2000;
    const WAIT_TEXT_AFTER = 4000; // 超出此时长显示乱流文案
    const t0 = performance.now();
    let done = false;
    let animDone = false;
    const draw = (t: number, hold: boolean) => {
      if (!g) return;
      const W = cvs.width;
      const H = cvs.height;
      g.fillStyle = '#05060a';
      g.fillRect(0, 0, W, H);
      // 噪点方块，密度随时间上升（等待期保持湍流起伏）
      const density = hold ? 0.45 + Math.sin(t0 + performance.now() * 0.004) * 0.2 : 0.15 + t * 0.75;
      const cell = 26;
      const cs = hold ? 10 : Math.max(6, Math.round(cell * (1 - t * 0.55)));
      for (let y = 0; y < H; y += cs) {
        for (let x = 0; x < W; x += cs) {
          if (Math.random() < density) {
            const v = Math.random() < 0.5 ? 90 + Math.random() * 80 : 170 + Math.random() * 85;
            g.fillStyle = `rgba(${v},${v},${v},${0.5 + Math.random() * 0.5})`;
            g.fillRect(x, y, cs, cs);
          }
        }
      }
      // 镜头推进：中心白洞收缩（穿缝）——等待期不再推进
      if (!hold) {
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
    };
    const finish = () => {
      // 双门闩：转场动画放完 && 世界就绪（ready resolve）才放行——
      // 修 E11 前的隐患：旧版动画一放完就无条件 finish/onDone，ready 晚于 2s 时
      // （慢加载/N7 现场生成 90s 链）onDone 在 worldOk=false 下空转，之后 ready
      // 再 resolve 也唤不回（done 已 true）——穿缝页清掉、阶段悬死。现改为
      // finish 必须双条件齐备，「乱流缝合中…」等待路径随之真正可达。
      if (!animDone || !readyDone || done) return;
      done = true;
      this.clear();
      onDone();
    };
    let readyDone = false;
    ready.then(
      () => {
        readyDone = true;
        finish();
      },
      () => {
        readyDone = true;
        finish();
      },
    );
    const anim = () => {
      if (done) return;
      const elapsed = performance.now() - t0;
      const t = Math.min(1, elapsed / DURATION);
      if (t < 1) {
        draw(t, false);
        requestAnimationFrame(anim);
        return;
      }
      animDone = true;
      finish();
      if (done) return;
      // 世界未就绪：保持湍流等待；超时显示进度文案
      if (elapsed > WAIT_TEXT_AFTER && !label.classList.contains('wait')) {
        label.textContent = '乱流缝合中…';
        label.classList.add('wait');
      }
      draw(1, true);
      requestAnimationFrame(anim);
    };
    requestAnimationFrame(anim);
  }

  // ---- 镜像对照页（N6 核心 wow：归航后、结算前，「世界记得你的总和」） ----
  mirror(view: MirrorView, onContinue: () => void) {
    const scr = h('div', 'g-screen g-mirror');
    const rows = view.rows
      .map((r) => `<div class="g-mirror-row"><span class="mr-left">${r.left}</span><span class="mr-sep">↔</span><span class="mr-right">${r.right}</span></div>`)
      .join('');
    scr.innerHTML = `
      <h2>世界记得你的总和</h2>
      <div class="g-mirror-sub">乱流合上了你的账本，照着它缝完这一夜。</div>
      <div class="g-mirror-rows">${rows}</div>
    `;
    const row = h('div', 'g-btn-row center');
    const next = h('button', 'g-btn primary', '继续走向第七夜');
    next.onclick = () => {
      this.sfx.click();
      onContinue();
    };
    row.append(next);
    scr.append(row);
    this.mount(scr);
  }

  // ---- 告辞页（N7 终幕）：世界透出的半透明底上，陈词打字机式渐显，可跳过 ----
  farewell(view: FarewellView, onContinue: () => void) {
    const scr = h('div', 'g-screen g-farewell');
    scr.innerHTML = `
      <h2>告辞 · 陈词</h2>
      <div class="g-farewell-sub">亮门开着，晨光落在花海上。伙计跳上门边的石墩，翻开他背下来的账本——</div>
    `;
    const blocks = h('div', 'g-farewell-blocks');
    const paras = view.paragraphs.map((text) => {
      const el = h('div', 'g-farewell-p');
      blocks.append(el);
      return { el, text };
    });
    scr.append(blocks);
    const row = h('div', 'g-btn-row center');
    const skip = h('button', 'g-btn ghost', '跳过 ▸▸');
    const next = h('button', 'g-btn primary', '走进亮门 →');
    next.style.display = 'none';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearInterval(timer);
      for (const p of paras) p.el.textContent = p.text; // 打字机收尾：整段补齐
      skip.style.display = 'none';
      next.style.display = '';
    };
    // 打字机：逐字逐段推进（26ms/字；段落切换零间隔——段与段的呼吸由 CSS 段落入场错峰承担）
    let pi = 0;
    let ci = 0;
    const timer = window.setInterval(() => {
      if (pi >= paras.length) {
        finish();
        return;
      }
      const p = paras[pi]!;
      ci += 1;
      p.el.textContent = p.text.slice(0, ci);
      if (ci >= p.text.length) {
        pi += 1;
        ci = 0;
      }
    }, 26);
    skip.onclick = () => {
      this.sfx.click();
      finish();
    };
    next.onclick = () => {
      this.sfx.click();
      onContinue();
    };
    // 点正文任意处=跳过渐显（按钮之外的软跳过）
    blocks.addEventListener('click', finish);
    row.append(skip, next);
    scr.append(row);
    this.mount(scr);
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
  talk(archetype: string, comment: string, onContinue: () => void, echoComment?: string, guestComment?: string) {
    const scr = h('div', 'g-screen g-talk');
    scr.innerHTML = `
      <h2>夜谈 · 灯下</h2>
      <div class="g-talk-scene">驿站的灯重新亮起。伙计——灯芯上那缕小火苗——跳回灯座，看了你一会儿。</div>
    `;
    const bubble = h('div', 'g-talk-bubble');
    bubble.innerHTML = `<span class="g-talk-arch">伙计 · ${archetype}</span><p>${comment}</p>${echoComment ? `<p class="g-talk-echo">${echoComment}</p>` : ''}`;
    scr.append(bubble);
    // N4 住客回归（#26）：有住客时旅人也说一段（评论今夜经历）
    if (guestComment) {
      const gBubble = h('div', 'g-talk-bubble g-talk-guest');
      gBubble.innerHTML = `<span class="g-talk-arch">旅人 · 住客</span><p>${guestComment}</p>`;
      scr.append(gBubble);
    }
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

  // ---- 进度页（按 NIGHTS 配置 + localStorage 解锁链渲染；finaleLine=终局后的柒格终局态） ----
  progress(opts: {
    nights: Array<Pick<NightDef, 'night' | 'seedName'>>;
    unlockedNight: number;
    paidNights: number[];
    currentNight: number;
    finaleLine?: FinaleLine | null;
    onReplay: () => void;
    onNext: (night: number) => void;
    onTitle: () => void;
    sfxEnabled: boolean;
    onToggleSfx: (v: boolean) => boolean;
  }) {
    const CN = '壹贰叁肆伍陆柒捌玖';
    const scr = h('div', 'g-screen g-progress');
    // 七夜网格：已配置夜按解锁/付账渲染，未配置夜（N3+）置灰占位；柒格终局态（.g-night.fin）
    const rows: string[] = [];
    for (let i = 1; i <= 7; i++) {
      const def = opts.nights.find((n) => n.night === i);
      if (!def) {
        rows.push(`<div class="g-night lock"><span class="n-num">${CN[i - 1] ?? i}</span><span class="n-name">未潜入</span><span class="n-state">待解锁</span></div>`);
        continue;
      }
      if (def.night === 7 && opts.finaleLine) {
        rows.push(`<div class="g-night fin"><span class="n-num">${CN[6]}</span><span class="n-name">${def.seedName}</span><span class="n-state">终局 · ${FINALE_LINE_NAME[opts.finaleLine]}</span></div>`);
        continue;
      }
      const paid = opts.paidNights.includes(def.night);
      const unlocked = def.night <= opts.unlockedNight;
      const cls = paid ? 'done' : unlocked ? 'dev' : 'lock';
      const state = paid ? '已付一夜' : unlocked ? '已解锁 · 可下潜' : '待解锁';
      const name = unlocked ? def.seedName : '未潜入';
      rows.push(`<div class="g-night ${cls}"><span class="n-num">${CN[def.night - 1] ?? def.night}</span><span class="n-name">${name}</span><span class="n-state">${state}</span></div>`);
    }
    scr.innerHTML = `
      <h2>七夜 · 进度</h2>
      <div class="g-nights">${rows.join('')}</div>
      <div class="g-prog-note">七夜七张账单付清 = 通关。付不起 = 灯暗一分，不判死档。</div>
    `;
    const row = h('div', 'g-btn-row center');
    const nextNight = opts.currentNight + 1;
    const hasNext = nextNight <= opts.unlockedNight && opts.nights.some((n) => n.night === nextNight);
    if (hasNext) {
      const next = h('button', 'g-btn primary', `推门 · 进入第${nightCn(nextNight)}夜`);
      next.onclick = () => {
        this.sfx.click();
        opts.onNext(nextNight);
      };
      row.append(next);
    }
    const replay = h('button', 'g-btn ghost', `再潜一次 第${nightCn(opts.currentNight)}夜（回响）`);
    replay.onclick = () => {
      this.sfx.click();
      opts.onReplay();
    };
    const back = h('button', 'g-btn ghost', '回到标题');
    back.onclick = () => {
      this.sfx.click();
      opts.onTitle();
    };
    const snd = h('button', 'g-btn ghost', `音效：${opts.sfxEnabled ? '开' : '关'}`);
    let sndOn = opts.sfxEnabled;
    snd.onclick = () => {
      sndOn = !sndOn;
      opts.onToggleSfx(sndOn);
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

  // ---- 幸存者对话卡（E2 遭遇：现场抉择；数字键 1/2/3 快选，鼠标点击亦可） ----
  survivorDialog(plea: string, onChoice: (c: SurvivorChoice) => void) {
    if (this.survEl) return;
    const box = h('div', 'g-surv');
    box.innerHTML = `
      <div class="g-surv-name">雾里的旅人</div>
      <p class="g-surv-plea">「${plea}」</p>
    `;
    const row = h('div', 'g-surv-choices');
    const mk = (c: SurvivorChoice, label: string, cls: string, key: string) => {
      const b = h('button', `g-btn small ${cls}`, `${label} <span class="g-surv-key">${key}</span>`);
      b.onclick = () => {
        this.sfx.click();
        this.closeSurvivorDialog();
        onChoice(c);
      };
      return b;
    };
    row.append(mk('save', '带他去驿站（救）', 'primary', '1'), mk('ignore', '转身走开（不理）', 'ghost', '2'), mk('rob', '抢下油纸包（抢）', 'danger', '3'));
    box.append(row);
    this.box.append(box);
    this.survEl = box;
  }

  private survEl: HTMLElement | null = null;

  closeSurvivorDialog() {
    this.survEl?.remove();
    this.survEl = null;
  }

  get survivorDialogOpen() {
    return this.survEl !== null;
  }

  /** 程序化选择（调试/自动化用）：不开卡直接按结局走 */
  chooseSurvivor(c: SurvivorChoice, onChoice: (c: SurvivorChoice) => void) {
    this.closeSurvivorDialog();
    onChoice(c);
  }

  // ---- 伙计说话框（T） ----
  talkbox(onSubmit: (text: string) => void) {    const box = h('div', 'g-talkbox');
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
    this.closeSurvivorDialog();
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
  survivor_saved: '救旅人',
  survivor_ignored: '无视',
  survivor_robbed: '抢夺',
  survivor_lost: '失踪',
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
    case 'survivor_saved':
      return `把旅人带回了门口，谢礼 ${String(d.bonus ?? 0)} 文`;
    case 'survivor_ignored':
      return `听见呼救，没有回头`;
    case 'survivor_robbed':
      return `夺走旅人油纸包（${String(d.value ?? 0)} 文），循声者至`;
    case 'survivor_lost':
      return `同行的人散在雾里`;
    default:
      return '';
  }
}
