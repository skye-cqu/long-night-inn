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
import { nightCn, type LootDef, type NightDef } from './config';

/** 图鉴占位字标（TODO(Lux3D 信物)：替换为信物 GLB 缩略图） */
const ICONS: Record<string, string> = { bottle: '瓶', lantern: '灯', watch: '表', pack: '包' };

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
  private nightLabel: HTMLElement;
  private codexRow: HTMLElement;
  private codexSlots: Array<{ id: string; value: number; slot: HTMLElement; val: HTMLElement }> = [];
  /** 本夜信物表（buildCodex 时记住；resetCodex 按它重建，清掉 pushCodexSlot 的特殊槽） */
  private codexDefs: LootDef[] = [];
  private noiseFill: HTMLElement;
  private staminaFill: HTMLElement;
  private prompt: HTMLElement;
  private bubbleEl: HTMLElement;
  private bubbleText: HTMLElement;
  private bubbleArch: HTMLElement;
  private vignette: HTMLElement;
  private fearTint: HTMLElement;
  private flashEl: HTMLElement;
  private fogEl: HTMLElement;
  private fogLevel = 0;
  private app: HTMLElement;
  private bubbleTimer: number | null = null;
  private redFlashEl: HTMLElement;
  /** 黑暗理智（N4）：理智条 + 水波纹暗角层（只有配置 sanity 的夜启用） */
  private sanityRow: HTMLElement;
  private sanityFill: HTMLElement;
  private madEl: HTMLElement;
  private sanityEnabled = false;

  constructor(uiRoot: HTMLElement, defs: LootDef[], appContainer: HTMLElement) {
    this.app = appContainer;
    this.root = el('div', 'g-hud');
    this.root.innerHTML = '';

    // 左上：目标框
    const goalBox = el('div', 'g-goal');
    this.nightLabel = el('div', 'g-goal-night', '第一夜 · 雾中松林废站');
    goalBox.append(this.nightLabel);
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
    this.codexRow = el('div', 'g-codex-row');
    codex.append(this.codexRow);
    this.root.append(codex);
    this.buildCodex(defs);

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
    // 理智条（N4 黑暗理智）：默认隐藏，setNight 按 def.sanity 启用
    this.sanityRow = el('div', 'g-meter-row g-sanity-row');
    this.sanityRow.style.display = 'none';
    this.sanityRow.append(el('span', 'g-meter-lab', '理智'));
    const sanityBar = el('div', 'g-bar');
    this.sanityFill = el('div', 'g-bar-fill g-san');
    sanityBar.append(this.sanityFill);
    this.sanityRow.append(sanityBar);
    meters.append(this.sanityRow);
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

    // 暗角 + 恐惧染色 + 黑屏闪（全屏层）+ 红晕闪（N3 残影）+ 雾层（开阔夜补偿，opacity=setFog）
    this.fogEl = el('div', 'g-fog');
    this.vignette = el('div', 'g-vig');
    this.fearTint = el('div', 'g-fear');
    this.flashEl = el('div', 'g-flash');
    this.redFlashEl = el('div', 'g-redflash');
    // 理智 <30 的水波纹暗角（N4 黑暗理智；CSS 动画零新资产）
    this.madEl = el('div', 'g-mad');
    uiRoot.append(this.fogEl, this.vignette, this.fearTint, this.madEl, this.flashEl, this.redFlashEl, this.root);
  }

  /** 换夜：夜标签 + 图鉴重建 + 雾强度与色调 + 理智条启用（下潜 HUD 显示时生效） */
  setNight(def: NightDef) {
    this.nightLabel.textContent = `第${nightCn(def.night)}夜 · ${def.seedName}`;
    this.buildCodex(def.loot);
    this.fogLevel = def.fog;
    this.fogEl.classList.toggle('snow', def.fogTint === 'snow');
    this.fogEl.classList.toggle('deepsea', def.fogTint === 'deepsea');
    this.applyFog();
    this.sanityEnabled = !!def.sanity;
    this.sanityRow.style.display = this.sanityEnabled ? '' : 'none';
    if (this.sanityEnabled) this.setSanity(100, true);
    else this.madEl.classList.remove('on');
  }

  /** 按信物表重建图鉴格 */
  private buildCodex(defs: LootDef[]) {
    this.codexDefs = defs;
    this.codexRow.innerHTML = '';
    this.codexSlots = [];
    for (const def of defs) {
      const slot = el('div', 'g-codex-slot');
      slot.append(el('div', 'g-codex-icon', ICONS[def.shape] ?? '物'));
      slot.append(el('div', 'g-codex-name', def.name));
      const val = el('div', 'g-codex-val', `${def.value} 文`);
      slot.append(val);
      this.codexSlots.push({ id: def.id, value: def.value, slot, val });
      this.codexRow.append(slot);
    }
  }

  /** 追加图鉴格（E2：抢夺所得「旅人的油纸包」——不在当晚信物表内的特殊所得） */
  pushCodexSlot(id: string, shape: string, name: string, value: number) {
    const slot = el('div', 'g-codex-slot');
    slot.append(el('div', 'g-codex-icon', ICONS[shape] ?? '物'));
    slot.append(el('div', 'g-codex-name', name));
    const val = el('div', 'g-codex-val', `${value} 文`);
    slot.append(val);
    this.codexSlots.push({ id, value, slot, val });
    this.codexRow.append(slot);
    return id;
  }

  show(v: boolean) {
    this.root.style.display = v ? '' : 'none';
    this.applyFog();
    if (!v) {
      this.setVignette('off');
      this.setFear(0);
      this.setPrompt(null);
      this.madEl.classList.remove('on');
    }
  }

  /** 雾层只在下潜 HUD 显示时生效 */
  private applyFog() {
    this.fogEl.style.opacity = this.root.style.display === 'none' ? '0' : String(this.fogLevel);
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

  /** 重建为本夜信物表并全灭：清掉 pushCodexSlot 追加的特殊所得槽（beginDive 每局调用，跨局不残留） */
  resetCodex() {
    this.buildCodex(this.codexDefs);
  }

  setCodex(takenIds: string[]) {
    // 槽位自带 id/value（信物表 + E2 特殊所得），按 id 点亮
    for (const c of this.codexSlots) {
      const taken = takenIds.includes(c.id);
      c.slot.classList.toggle('lit', taken);
      if (taken) c.val.textContent = `${c.value} 文 ✓`;
    }
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

  /** 黑暗理智（N4）：理智条 0..100 + 低理智水波纹暗角（仅 sanity 启用夜生效） */
  setSanity(v: number, enabled: boolean, lowThreshold = 30) {
    if (!enabled) return;
    const c = Math.min(100, Math.max(0, v));
    this.sanityFill.style.width = `${Math.round(c)}%`;
    this.sanityFill.classList.toggle('low', c < lowThreshold);
    this.madEl.classList.toggle('on', c < lowThreshold);
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

  /** 黑屏一瞬（默认 0.9s 渐隐=被抓；坠落软复位传 300=闪黑 0.3s） */
  flashBlack(fadeMs = 900) {
    this.flashEl.style.transition = 'none';
    this.flashEl.style.opacity = '1';
    requestAnimationFrame(() => {
      this.flashEl.style.transition = `opacity ${fadeMs}ms`;
      this.flashEl.style.opacity = '0';
    });
  }

  /** 红晕一瞬（N3 寻仇残影逼近：屏幕短暂红晕，~0.7s 渐隐） */
  flashRed(fadeMs = 700) {
    this.redFlashEl.style.transition = 'none';
    this.redFlashEl.style.opacity = '1';
    requestAnimationFrame(() => {
      this.redFlashEl.style.transition = `opacity ${fadeMs}ms`;
      this.redFlashEl.style.opacity = '0';
    });
  }
}
