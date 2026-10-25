/**
 * hud.ts — 下潜 HUD 三件套 + 暗角/手电/恐惧视觉层。
 *
 * - 左上：夜数 + 账单目标框（「N1 账单 20 文：已捡 x/3」）
 * - 左下：战利品图鉴（3 格，拾取点亮）
 * - 顶部中间：天亮倒计时（最后 60s 变红脉动）
 * - 底部：操作栏 + 噪音指示条 + 体力条
 * - 暗角 vignette：手电关=强暗角（安全但看不清）/ 开=视野亮（CSS brightness）
 * - 恐惧染色：实体逼近时红色内晕随恐惧表加深
 * 全部 DOM/CSS 实现（水墨暗色风），不占渲染预算。
 */
import type { LootDef } from './config';

/** 图鉴占位字标（TODO(Lux3D 信物)：替换为信物 GLB 缩略图） */
const ICONS: Record<string, string> = { bottle: '瓶', lantern: '灯', watch: '表' };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class Hud {
  readonly root: HTMLElement;
  private goal: HTMLElement;
  private countdown: HTMLElement;
  private codexSlots: Array<{ slot: HTMLElement; val: HTMLElement }> = [];
  private noiseFill: HTMLElement;
  private staminaFill: HTMLElement;
  private prompt: HTMLElement;
  private bubbleEl: HTMLElement;
  private bubbleText: HTMLElement;
  private bubbleArch: HTMLElement;
  private vignette: HTMLElement;
  private fearTint: HTMLElement;
  private flashEl: HTMLElement;
  private app: HTMLElement;
  private bubbleTimer: number | null = null;

  constructor(uiRoot: HTMLElement, defs: LootDef[], appContainer: HTMLElement) {
    this.app = appContainer;
    this.root = el('div', 'g-hud');
    this.root.innerHTML = '';

    // 左上：目标框
    const goalBox = el('div', 'g-goal');
    goalBox.append(el('div', 'g-goal-night', '第一夜 · 雾中松林废站'));
    this.goal = el('div', 'g-goal-bill');
    goalBox.append(this.goal);
    goalBox.append(el('div', 'g-goal-hint', '天亮门关前，带着值钱物回门口'));
    this.root.append(goalBox);

    // 顶部中间：倒计时
    this.countdown = el('div', 'g-count');
    this.root.append(this.countdown);

    // 左下：图鉴
    const codex = el('div', 'g-codex');
    codex.append(el('div', 'g-codex-title', '今夜图鉴'));
    const row = el('div', 'g-codex-row');
    for (const def of defs) {
      const slot = el('div', 'g-codex-slot');
      slot.append(el('div', 'g-codex-icon', ICONS[def.shape] ?? '物'));
      slot.append(el('div', 'g-codex-name', def.name));
      const val = el('div', 'g-codex-val', `${def.value} 文`);
      slot.append(val);
      this.codexSlots.push({ slot, val });
      row.append(slot);
    }
    codex.append(row);
    this.root.append(codex);

    // 底部中间：操作栏
    const bar = el('div', 'g-keys');
    const keys: Array<[string, string]> = [
      ['WASD', '走'],
      ['Shift', '跑'],
      ['C', '蹲'],
      ['E', '拾取/推门'],
      ['F', '手电'],
      ['T', '说话'],
      ['ESC', '菜单'],
    ];
    for (const [k, v] of keys) {
      const kb = el('span', 'g-key', k);
      bar.append(kb, el('span', 'g-keylab', v) as never);
    }
    this.root.append(bar);

    // 底部右侧：噪音 + 体力条
    const meters = el('div', 'g-meters');
    const noiseRow = el('div', 'g-meter-row');
    noiseRow.append(el('span', 'g-meter-lab', '噪音'));
    const noiseBar = el('div', 'g-bar');
    this.noiseFill = el('div', 'g-bar-fill g-noise');
    noiseBar.append(this.noiseFill);
    noiseRow.append(noiseBar);
    const stamRow = el('div', 'g-meter-row');
    stamRow.append(el('span', 'g-meter-lab', '体力'));
    const stamBar = el('div', 'g-bar');
    this.staminaFill = el('div', 'g-bar-fill g-stam');
    stamBar.append(this.staminaFill);
    stamRow.append(stamBar);
    meters.append(noiseRow, stamRow);
    this.root.append(meters);

    // 中心提示
    this.prompt = el('div', 'g-prompt');
    this.root.append(this.prompt);

    // 伙计气泡
    this.bubbleEl = el('div', 'g-bubble');
    this.bubbleArch = el('span', 'g-bubble-arch', '伙计');
    this.bubbleText = el('span', 'g-bubble-text');
    this.bubbleEl.append(this.bubbleArch, this.bubbleText);
    this.root.append(this.bubbleEl);

    // 暗角 + 恐惧染色 + 黑屏闪（全屏层）
    this.vignette = el('div', 'g-vig');
    this.fearTint = el('div', 'g-fear');
    this.flashEl = el('div', 'g-flash');
    uiRoot.append(this.vignette, this.fearTint, this.flashEl, this.root);
  }

  show(v: boolean) {
    this.root.style.display = v ? '' : 'none';
    if (!v) {
      this.setVignette('off');
      this.setFear(0);
      this.setPrompt(null);
    }
  }

  setCountdown(secLeft: number, danger: boolean) {
    const m = Math.floor(Math.max(0, secLeft) / 60);
    const s = Math.floor(Math.max(0, secLeft) % 60);
    this.countdown.textContent = `天亮 ${m}:${String(s).padStart(2, '0')}`;
    this.countdown.classList.toggle('danger', danger);
  }

  setGoal(collected: number, total: number, value: number, bill: number) {
    this.goal.textContent = `账单 ${bill} 文 · 已捡 ${collected}/${total} · 身上 ${value} 文`;
    this.goal.classList.toggle('ok', value >= bill);
  }

  setCodex(takenIds: string[], defs: LootDef[]) {
    defs.forEach((def, i) => {
      const c = this.codexSlots[i]!;
      const taken = takenIds.includes(def.id);
      c.slot.classList.toggle('lit', taken);
      if (taken) c.val.textContent = `${def.value} 文 ✓`;
    });
  }

  setPrompt(text: string | null) {
    this.prompt.textContent = text ?? '';
    this.prompt.style.opacity = text ? '1' : '0';
  }

  setNoise(level: number) {
    this.noiseFill.style.width = `${Math.round(Math.min(1, Math.max(0, level)) * 100)}%`;
    this.noiseFill.parentElement!.classList.toggle('hot', level >= 0.85);
  }

  setStamina(v: number) {
    this.staminaFill.style.width = `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`;
  }

  /** 伙计说话气泡（自动消失） */
  bubble(text: string, archetype: string, ms = 4200) {
    this.bubbleArch.textContent = `伙计·${archetype}`;
    this.bubbleText.textContent = text;
    this.bubbleEl.classList.add('on');
    if (this.bubbleTimer !== null) clearTimeout(this.bubbleTimer);
    this.bubbleTimer = window.setTimeout(() => this.bubbleEl.classList.remove('on'), ms);
  }

  hideBubble() {
    this.bubbleEl.classList.remove('on');
    if (this.bubbleTimer !== null) clearTimeout(this.bubbleTimer);
  }

  /** 暗角/视野：off=转场等 / dark=手电关（强暗角+压暗）/ bright=手电开（亮+弱暗角） */
  setVignette(mode: 'off' | 'dark' | 'bright') {
    this.vignette.className = 'g-vig ' + (mode === 'off' ? 'vig-off' : mode === 'dark' ? 'vig-dark' : 'vig-bright');
    this.app.classList.toggle('flash-on', mode === 'bright');
    this.app.classList.toggle('flash-off', mode === 'dark');
  }

  /** 恐惧表视觉（0..1）：红色内晕 */
  setFear(f: number) {
    this.fearTint.style.opacity = String(Math.min(0.85, Math.max(0, f) * 0.85));
  }

  /** 黑屏一瞬（被抓） */
  flashBlack() {
    this.flashEl.style.transition = 'none';
    this.flashEl.style.opacity = '1';
    requestAnimationFrame(() => {
      this.flashEl.style.transition = 'opacity 0.9s';
      this.flashEl.style.opacity = '0';
    });
  }
}
