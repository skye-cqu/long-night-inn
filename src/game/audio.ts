/**
 * audio.ts — WebAudio 合成音效（零素材零版权）。
 *
 * 事件即触发（≤100ms 反馈）：所有 play* 都在当前帧发起，无预加载。
 * 总开关 setEnabled；AudioContext 在首次用户手势时 resume（标题页点击）。
 */

type Ctx = AudioContext & { resume(): Promise<void> };

export class Sfx {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  enabled = true;
  /** 心跳循环状态（恐惧/最后 60s） */
  private heartbeatTimer: number | null = null;
  private heartbeatRate = 0;

  /** 首次用户手势调用；重复调用无害 */
  unlock() {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext() as Ctx;
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.55;
        this.master.connect(this.ctx.destination);
      } catch {
        this.ctx = null; // 无 WebAudio 环境静默降级
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setEnabled(v: boolean) {
    this.enabled = v;
    if (!v) this.stopHeartbeat();
    return v;
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  private out(): GainNode | null {
    return this.enabled && this.ctx && this.master ? this.master : null;
  }

  /** 单振荡器音符 */
  private tone(
    type: OscillatorType,
    freq: number,
    t0: number,
    dur: number,
    vol: number,
    freqEnd?: number,
  ) {
    const out = this.out();
    if (!out || !this.ctx) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(out);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** 噪声爆发（穿缝/被抓） */
  private noise(t0: number, dur: number, vol: number, bandHz: number, q = 1) {
    const out = this.out();
    if (!out || !this.ctx) return;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = bandHz;
    bp.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(g).connect(out);
    src.start(t0);
  }

  /** 拾取：叮（两连升音 + 亮闪） */
  pickup() {
    const t = this.now();
    this.tone('sine', 880, t, 0.09, 0.35);
    this.tone('sine', 1318, t + 0.07, 0.14, 0.3);
    this.tone('triangle', 2093, t + 0.12, 0.08, 0.1);
  }

  /** 心跳单拍（低频双击） */
  private thump(t0: number, vol = 0.5) {
    this.tone('sine', 58, t0, 0.12, vol, 40);
    this.tone('sine', 52, t0 + 0.16, 0.1, vol * 0.7, 38);
  }

  /** 心跳循环：rate = 每秒拍数（0=停）。恐惧越深/倒计时越末拍越快 */
  heartbeat(rate: number) {
    if (!this.ctx) return;
    const clamped = Math.min(2.2, Math.max(0, rate));
    if (clamped !== this.heartbeatRate) {
      this.heartbeatRate = clamped;
      if (this.heartbeatTimer !== null) {
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (clamped <= 0 || !this.enabled) return;
      const tick = () => {
        if (this.heartbeatRate <= 0 || !this.enabled) return;
        this.thump(this.now(), 0.4 + Math.min(0.3, this.heartbeatRate * 0.15));
        const period = 1000 / this.heartbeatRate;
        this.heartbeatTimer = window.setTimeout(tick, period);
      };
      tick();
    }
  }

  stopHeartbeat() {
    this.heartbeatRate = 0;
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** 门铃（归航/门关） */
  bell(close = false) {
    const t = this.now();
    if (close) {
      this.tone('triangle', 392, t, 0.5, 0.3);
      this.tone('triangle', 311, t + 0.18, 0.8, 0.3);
      this.noise(t, 0.6, 0.12, 300, 0.7);
    } else {
      this.tone('triangle', 659, t, 0.6, 0.28);
      this.tone('triangle', 988, t + 0.05, 0.7, 0.2);
    }
  }

  /** 穿缝嗖（噪声扫频） */
  seam() {
    const t = this.now();
    this.noise(t, 1.4, 0.4, 420, 0.8);
    this.tone('sawtooth', 120, t, 1.2, 0.12, 1400);
    this.tone('sine', 1800, t + 1.1, 0.25, 0.15, 3000);
  }

  /** 账单结算音（算盘/铜钱琶音） */
  settle(paid: boolean) {
    const t = this.now();
    const seq = paid ? [523, 659, 784, 1047] : [523, 466, 392, 311];
    seq.forEach((f, i) => this.tone('triangle', f, t + i * 0.11, 0.22, 0.24));
    if (!paid) this.tone('sine', 98, t + 0.44, 0.6, 0.28, 60);
  }

  /** 被抓刺音 */
  caught() {
    const t = this.now();
    this.tone('sawtooth', 240, t, 0.45, 0.35, 70);
    this.noise(t, 0.35, 0.4, 900, 0.6);
  }

  /** 低语雷达提示（轻点） */
  whisper() {
    this.tone('sine', 1420, this.now(), 0.06, 0.08);
  }

  /** 说话气泡弹出 */
  talk() {
    this.tone('sine', 620, this.now(), 0.05, 0.1);
  }

  /** UI 点击 */
  click() {
    this.tone('square', 300, this.now(), 0.03, 0.05);
  }

  /** 恐惧预警（实体进入 12m，闷响一下） */
  fearPing() {
    this.tone('sine', 110, this.now(), 0.3, 0.22, 70);
  }

  /** 手电开关咔哒 */
  flash() {
    this.tone('square', 2100, this.now(), 0.02, 0.07);
  }
}
