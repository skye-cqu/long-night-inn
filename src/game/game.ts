/**
 * game.ts — 游戏流状态机与下潜玩法编排（多夜）。
 *
 * 一夜四阶段（设计 §2）：晨间整备(2D) → 穿缝转场 → 下潜(3D) → 归航结算 → 夜谈 → 进度页。
 * main.ts 只负责 viewer 装配与渲染循环；本模块拥有全部阶段流转、玩法规则与 HUD 驱动。
 * 夜配置见 config.ts NightDef：换夜=重建世界物/实体视觉 + 懒加载该夜世界资产
 * （穿缝转场期间等待，超 4s 显示「乱流缝合中…」）。
 */
import { NIGHTS, type Archetype, type NightDef } from './config';
import { Ledger, loadUnlockedNight, saveUnlockedNight, type LedgerEventType } from './ledger';
import { ARCHETYPE_LINES, LineBag } from './lines';
import { Sfx } from './audio';
import { WorldItems, type LootItem } from './items';
import { Entity } from './entity';
import { Hud } from './hud';
import { Screens } from './screens';
import type { WalkControls } from '../walk-controls';
import type { Companion } from '../companion';
import type { VoxelCollision } from '../collision';
import type { NavField } from '../nav';
import type { Scene3D } from '@manycore/aholo-viewer';

export type Stage = 'boot' | 'title' | 'morning' | 'seam' | 'dive' | 'settle' | 'talk' | 'progress';

/** 当前世界运行时句柄（main.ts 持有并在换夜时原地更新字段） */
export interface WorldHandle {
  nav: NavField;
  collision: VoxelCollision | null;
  /** 已加载世界的夜数（启动=N1） */
  night: number;
}

export interface GameDeps {
  scene: Scene3D;
  world: WorldHandle;
  /** 按夜懒加载世界资产（spz/体素/nav），完成后更新 world 句柄 */
  loadNightWorld(def: NightDef): Promise<void>;
  controls: WalkControls;
  companion: Companion;
  appContainer: HTMLElement;
  uiRoot: HTMLElement;
  hint: HTMLElement;
}

/** FTUE 计时（冷加载→第一次拾取 ≤60s 验收用） */
export interface FtueState {
  bootAt: number;
  diveStartAt: number | null;
  firstPickupMs: number | null;
}

export class Game {
  stage: Stage = 'boot';
  private sfx = new Sfx();
  private ledger = new Ledger();
  private bag: LineBag;
  private items!: WorldItems;
  private entity: Entity;
  private hud: Hud;
  private screens: Screens;
  private archetype: Archetype = '毒舌';
  private playerName = '无名掌柜';
  private paused = false;
  private flashlight = false;
  private runStartTs = 0;
  private ftue: FtueState = { bootAt: performance.now(), diveStartAt: null, firstPickupMs: null };

  // 多夜：当前夜索引 + 世界加载状态
  private nightIdx = 0;
  /** 已加载世界的夜数（main.ts 启动即载第 1 夜） */
  private worldNight = 1;
  private worldReady: Promise<void> = Promise.resolve();

  // 下潜运行时
  private timeLeft: number = NIGHTS[0]!.diveSeconds;
  private held: LootItem[] = [];
  private caughtCount = 0;
  private nearMiss = 0;
  private spoken = 0;
  private diveOver = false;
  private noiseEmitAcc = 0;
  private noiseSmooth = 0;
  private whisperNext = 0;
  private ambientNext = 0;
  private fearLineT = -99;
  private wasChasing = false;

  constructor(private deps: GameDeps) {
    this.bag = new LineBag(ARCHETYPE_LINES[this.archetype]);
    this.hud = new Hud(deps.uiRoot, NIGHTS[0]!.loot, deps.appContainer);
    this.screens = new Screens(deps.uiRoot, this.sfx);
    this.entity = new Entity(deps.scene, deps.world.nav, deps.world.collision, NIGHTS[0]!.entity);
    this.setNight(0); // 重建第 1 夜世界物 + 实体 GLB 视觉 + HUD 夜标签（GLB 标题页期间后台热身）
    this.hud.show(false);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    addEventListener('keydown', this.onKeyDown);
  }

  /** 当前夜配置 */
  get def(): NightDef {
    return NIGHTS[this.nightIdx]!;
  }

  // ---- 阶段流转 ----

  /** 资产就绪：进标题 */
  begin() {
    this.goto('title');
  }

  /** FTUE 计时锚点（main.ts 模块加载时刻，≈冷加载起点） */
  markBoot(ms: number) {
    this.ftue.bootAt = ms;
  }

  goto(stage: Stage) {
    switch (stage) {
      case 'title':
        this.stage = 'title';
        this.screens.title((c) => {
          this.playerName = c.name;
          this.archetype = c.archetype;
          this.bag = new LineBag(ARCHETYPE_LINES[this.archetype]);
          this.goto('morning');
        });
        break;
      case 'morning':
        this.stage = 'morning';
        this.hud.show(false);
        this.deps.hint.style.opacity = '0';
        this.screens.morning(this.ledger.all(), this.def, () => this.goto('seam'));
        break;
      case 'seam': {
        this.stage = 'seam';
        this.sfx.seam();
        // 穿缝转场与该夜世界加载并行：转场本體 2s，未就绪则湍流等待（超 4s 显示进度文案）
        let worldOk = this.worldNight === this.def.night;
        const ready = this.ensureWorld(this.def).then(() => {
          worldOk = true;
        });
        ready.catch((e) => {
          console.error('[世界] 本夜世界加载失败，退回晨间:', e);
          this.deps.hint.textContent = '乱流撕碎了今夜的世界……先回驿站吧。';
          if (this.stage === 'seam') this.goto('morning');
        });
        this.screens.seam(() => {
          if (worldOk) this.beginDive();
        }, this.def, ready);
        break;
      }
      case 'dive':
        // 调试直达：跳过转场（仍保证该夜世界就绪）
        this.ensureWorld(this.def).then(
          () => this.beginDive(),
          (e) => console.error('[世界] 加载失败（调试直达）:', e),
        );
        break;
      case 'settle':
        this.stage = 'settle';
        this.hud.show(false);
        this.deps.controls.setRuntimeEnabled(false);
        this.sfx.stopHeartbeat();
        this.openSettle();
        break;
      case 'talk':
        this.stage = 'talk';
        this.openTalk();
        break;
      case 'progress': {
        this.stage = 'progress';
        const current = this.def.night;
        const paidNights = [...new Set(this.ledger.all().filter((r) => r.type === 'paid').map((r) => r.night))];
        this.screens.progress({
          nights: NIGHTS,
          unlockedNight: Math.max(loadUnlockedNight(), current),
          paidNights,
          currentNight: current,
          onReplay: () => this.goto('seam'), // 回响：再潜一次（items.reset 在 beginDive 处理）
          onNext: (night) => this.enterNight(night),
          onTitle: () => this.goto('title'),
          sfxEnabled: this.sfx.enabled,
          onToggleSfx: (v) => this.sfx.setEnabled(v),
        });
        break;
      }
    }
  }

  /** 进入指定夜（1 起算）：换配置 + 回晨间（世界资产在晨间/穿缝期间后台加载） */
  enterNight(night: number): boolean {
    const idx = NIGHTS.findIndex((n) => n.night === night);
    if (idx < 0) return false;
    this.setNight(idx);
    this.goto('morning');
    return true;
  }

  /** 换夜：重建世界物与实体视觉、刷新 HUD，并后台预取该夜世界 */
  private setNight(idx: number) {
    this.nightIdx = idx;
    const def = this.def;
    if (this.items) this.items.dispose(this.deps.scene);
    this.items = new WorldItems(this.deps.scene, this.deps.world.nav, def.loot, def.door);
    this.items.reset();
    this.items.loot.forEach((i) => (i.root.visible = false)); // 非下潜阶段藏起世界物
    this.entity.applyNight(this.deps.world.nav, this.deps.world.collision, def.entity, this.deps.scene);
    this.entity.root.visible = false;
    this.hud.setNight(def);
    this.ensureWorld(def); // 晨间屏幕期间后台预取
  }

  /** 该夜世界资产就绪（已加载则立即返回；失败 reject） */
  private ensureWorld(def: NightDef): Promise<void> {
    if (def.night === this.worldNight) return this.worldReady;
    this.worldReady = this.deps.loadNightWorld(def).then(() => {
      this.worldNight = def.night;
    });
    return this.worldReady;
  }

  private beginDive() {
    const def = this.def;
    this.screens.closeAll();
    this.stage = 'dive';
    this.paused = false;
    this.diveOver = false;
    this.timeLeft = def.diveSeconds;
    this.held = [];
    this.caughtCount = 0;
    this.nearMiss = 0;
    this.spoken = 0;
    this.flashlight = false;
    this.runStartTs = Date.now();
    this.ftue.diveStartAt = performance.now();
    this.ambientNext = 12;
    this.whisperNext = 8;

    // 回响重玩：战利品价值微变（±echoJitter 文）
    this.items.reset(this.runCount > 0 ? def.echoJitter : 0);
    this.entity.teleport(def.entity.start.x, def.entity.start.z);
    this.entity.forceState('wander');

    const { spawn } = def;
    this.deps.controls.startAt(spawn.x, spawn.z, spawn.yaw);
    this.deps.controls.setRuntimeEnabled(true);
    this.deps.companion.position.set(
      spawn.x - Math.cos(spawn.yaw) * 1.4,
      this.deps.world.nav.floorAt(spawn.x, spawn.z),
      spawn.z,
    );
    this.deps.companion.fear = 0;
    this.entity.root.visible = true;
    this.hud.show(true);
    this.hud.setVignette('dark'); // 手电初始关闭：暗角压视野=安全
    this.hud.setCountdown(this.timeLeft, false);
    this.hud.setGoal(0, this.items.loot.length, 0, def.bill);
    this.hud.setCodex([], def.loot);
    this.deps.hint.textContent = '点击画面进入行走模式 · WASD 移动 / 鼠标转向 / E 拾取 / F 手电 / T 说话';
    this.deps.hint.style.opacity = '1';
    this.hud.bubble(this.bag.scene('opening'), this.archetype, 6000);
  }

  private runCount = 0;

  private endDive(lostAll: boolean, reason: 'return' | 'door' | 'giveup') {
    if (this.diveOver) return;
    this.diveOver = true;
    this.stage = 'settle';
    const def = this.def;
    this.deps.companion.fear = 0;
    this.deps.controls.setRuntimeEnabled(false);
    this.deps.controls.setInput(0, 0);
    this.deps.controls.setSprint(false);
    this.sfx.stopHeartbeat();
    this.hud.show(false);
    this.deps.hint.style.opacity = '0';

    const lostValue = lostAll ? this.held.reduce((s, i) => s + i.value, 0) : 0;
    if (lostAll) this.held = [];

    if (reason === 'return') {
      this.ledger.add(def.night, 'return', { secondsLeft: Math.round(this.timeLeft) });
    } else {
      // 门关 / 放弃：丢当日全部战利品，被乱流抛回驿站（不判死）
      this.ledger.add(def.night, 'door_close', { lostValue, gaveUp: reason === 'giveup' });
    }
    // 夜进度：结算即解锁下一夜（灯暗一分不判死档）
    saveUnlockedNight(def.night + 1);
    this.runCount++;
    this.sfx.bell(reason === 'return');
    this.goto('settle');
  }

  private openSettle() {
    const def = this.def;
    const total = this.held.reduce((s, i) => s + i.value, 0);
    const paid = total >= def.bill;
    if (paid) this.ledger.add(def.night, 'paid', { total, bill: def.bill });
    else this.ledger.add(def.night, 'unpaid', { total, bill: def.bill, shortfall: def.bill - total });
    this.sfx.settle(paid);
    const quip = this.bag.scene('settle');
    this.screens.settle(
      {
        lampOk: paid,
        lampText: paid ? '账单付清，灯亮着——锚稳，一夜无事。' : `短付 ${def.bill - total} 文：灯暗了一分，驿站开始「漂」……`,
        billCard: {
          night: def.night,
          seedName: def.seedName,
          looted: this.held.map((i) => ({ name: i.def.name, value: i.value })),
          total,
          bill: def.bill,
          paid,
          caught: this.caughtCount,
          nearMiss: this.nearMiss,
          spoken: this.spoken,
          quip,
          date: new Date().toISOString().slice(0, 10),
        },
      },
      () => this.goto('talk'),
    );
  }

  private openTalk() {
    // 夜谈：伙计评论本夜（本次下潜）第一条账本记录
    const runRecords = this.ledger.all().filter((r) => r.ts >= this.runStartTs && r.night === this.def.night);
    const first = runRecords[0];
    const type: LedgerEventType = first ? first.type : 'return';
    this.screens.talk(this.archetype, this.bag.talk(type as never), () => this.goto('progress'));
  }

  // ---- 主循环 tick（main 每帧调用） ----

  update(dt: number, t: number) {
    if (this.stage !== 'dive' || this.paused || this.diveOver) return;
    const def = this.def;
    const { controls, companion } = this.deps;

    // 倒计时
    this.timeLeft -= dt;
    const danger = this.timeLeft <= def.dangerSeconds;
    this.hud.setCountdown(this.timeLeft, danger && this.timeLeft > 0);
    if (this.timeLeft <= 0) {
      this.hud.bubble(this.bag.scene('doorclose'), this.archetype, 5000);
      this.endDive(true, 'door');
      return;
    }

    // 玩家噪音（连续移动噪声 + HUD 噪音条）
    const ps = controls.playerState;
    const moveNoise = ps.moving
      ? ps.gait === 'sprint'
        ? def.noise.sprint
        : ps.gait === 'crouch'
          ? def.noise.crouch
          : def.noise.walk
      : 0;
    this.noiseSmooth += (moveNoise - this.noiseSmooth) * Math.min(1, 6 * dt);
    this.hud.setNoise(this.noiseSmooth);
    this.hud.setStamina(ps.stamina / 100);
    this.noiseEmitAcc += dt;
    if (this.noiseEmitAcc >= 0.45) {
      this.noiseEmitAcc = 0;
      if (moveNoise > 0) this.entity.hear({ x: ps.position.x, z: ps.position.z, level: moveNoise });
    }

    // 实体
    const tick = this.entity.update(dt, t, ps.position, this.flashlight);
    const dist = tick.dist;

    // 抓捕
    if (tick.caught) {
      this.onCaught();
      return;
    }

    // 恐惧表（伙计看得见的机制）
    const fear = Math.max(0, Math.min(1, 1 - dist / def.fearRange));
    companion.fear = fear;
    this.hud.setFear(tick.state === 'chase' ? Math.max(fear, 0.55) : fear * 0.7);
    if (fear > 0.5 && t - this.fearLineT > 14) {
      this.fearLineT = t;
      this.sfx.fearPing();
      this.hud.bubble(this.bag.scene('fear'), this.archetype, 5000);
    }

    // 追击逼近计数（账单卡「遭遇」）
    if (tick.state === 'chase' && !this.wasChasing && dist < 9) this.nearMiss++;
    this.wasChasing = tick.state === 'chase';

    // 低语雷达：实体 <whisper.range 每 whisper.interval 秒方位提示
    if (dist < def.whisper.range && t > this.whisperNext) {
      this.whisperNext = t + def.whisper.interval;
      this.sfx.whisper();
      const dir = this.relativeDir(ps.position, ps.yaw, this.entity.pos.x, this.entity.pos.z);
      this.hud.bubble(this.bag.scene('whisper').replace('{dir}', dir), this.archetype, 4500);
    }

    // 心跳：恐惧或最后 dangerSeconds 秒
    const hbRate = Math.max(fear > 0.35 ? 0.8 + fear : 0, danger ? 1.0 + (1 - this.timeLeft / def.dangerSeconds) * 1.1 : 0);
    this.sfx.heartbeat(hbRate);

    // 间歇碎碎念
    if (t > this.ambientNext) {
      this.ambientNext = t + 40 + Math.random() * 20;
      this.hud.bubble(this.bag.scene('dive'), this.archetype, 4500);
    }

    // 交互提示
    const near = this.items.nearest(ps.position);
    const doorD = Math.hypot(ps.position.x - def.door.x, ps.position.z - def.door.z);
    if (near && near.dist < def.pickupRadius) {
      this.hud.setPrompt(`按 E 拾取 · ${near.item.def.name}（${near.item.value} 文）`);
    } else if (doorD < def.doorReturnRadius) {
      const canReturn = this.held.length > 0 || this.caughtCount > 0 || this.timeLeft < 30;
      this.hud.setPrompt(canReturn ? '按 E 推门归航' : '门在这里。天亮前带着值钱物回来。');
    } else {
      this.hud.setPrompt(null);
    }

    this.items.update(t, dt);
  }

  // ---- 事件 ----

  private onCaught() {
    const def = this.def;
    this.caughtCount++;
    const lost = this.held.length;
    this.sfx.caught();
    this.hud.flashBlack();
    this.held = []; // 当日战利品散落（丢失），不判死
    this.ledger.add(def.night, 'caught', { lost, at: this.deps.controls.position.toArray?.() ?? null });
    // 被拖回门口
    const { spawn } = def;
    this.deps.controls.startAt(spawn.x, spawn.z, spawn.yaw);
    this.hud.setGoal(this.heldCount(), this.items.loot.length, 0, def.bill);
    setTimeout(() => this.hud.bubble(this.bag.scene('caught'), this.archetype, 6000), 500);
  }

  private tryPickup() {
    const def = this.def;
    const ps = this.deps.controls.playerState;
    const near = this.items.nearest(ps.position);
    if (!near || near.dist >= def.pickupRadius) return false;
    const item = this.items.take(near.item);
    this.held.push(item);
    this.sfx.pickup();
    if (this.ftue.firstPickupMs === null) {
      this.ftue.firstPickupMs = performance.now() - this.ftue.bootAt;
    }
    this.ledger.add(def.night, 'loot', {
      id: item.def.id,
      name: item.def.name,
      value: item.value,
      deep: Math.hypot(item.def.x - def.door.x, item.def.z - def.door.z) > 10,
    });
    this.hud.setCodex(
      this.held.map((i) => i.def.id),
      def.loot,
    );
    this.hud.setGoal(this.heldCount(), this.items.loot.length, this.heldValue(), def.bill);
    this.hud.bubble(this.bag.scene('pickup'), this.archetype, 3800);
    // 拾取=中噪
    this.entity.hear({ x: ps.position.x, z: ps.position.z, level: def.noise.pickup });
    return true;
  }

  private tryReturn() {
    const def = this.def;
    const ps = this.deps.controls.playerState;
    const doorD = Math.hypot(ps.position.x - def.door.x, ps.position.z - def.door.z);
    if (doorD >= def.doorReturnRadius) return false;
    const canReturn = this.held.length > 0 || this.caughtCount > 0 || this.timeLeft < 30;
    if (!canReturn) return false;
    this.endDive(false, 'return');
    return true;
  }

  private toggleFlashlight() {
    this.flashlight = !this.flashlight;
    this.sfx.flash();
    this.hud.setVignette(this.flashlight ? 'bright' : 'dark');
  }

  private openTalkbox() {
    if (this.screens.talkboxOpen) return;
    this.deps.controls.setTextInputMode(true);
    this.screens.talkbox((text) => {
      this.deps.controls.setTextInputMode(false);
      this.spoken++;
      this.sfx.talk();
      // 说话=大噪音（教学点：跟伙计说话要挑时候）
      const ps = this.deps.controls.playerState;
      this.entity.hear({ x: ps.position.x, z: ps.position.z, level: this.def.noise.speak });
      this.ledger.add(this.def.night, 'noise_speak', { text });
      this.hud.bubble(this.bag.scene('speak'), this.archetype, 4500);
    });
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.stage !== 'dive' || this.paused) {
      return;
    }
    if (this.screens.talkboxOpen) return; // 输入框自己的 keydown 处理
    if (e.code === 'KeyE') {
      if (!this.tryPickup()) this.tryReturn();
    } else if (e.code === 'KeyF') {
      this.toggleFlashlight();
    } else if (e.code === 'KeyT') {
      e.preventDefault();
      this.openTalkbox();
    }
  };

  private onPointerLockChange = () => {
    const locked = document.pointerLockElement !== null;
    if (!locked && this.stage === 'dive' && !this.diveOver) {
      if (this.screens.talkboxOpen) {
        // ESC 在说话框上：只关框，不弹菜单
        this.screens.closeTalkbox();
        this.deps.controls.setTextInputMode(false);
        return;
      }
      this.paused = true;
      this.sfx.stopHeartbeat();
      this.screens.pause(
        () => {
          this.screens.closeAll();
          this.paused = false;
          this.deps.hint.textContent = '点击画面继续 · WASD 移动 / E 拾取 / F 手电 / T 说话';
        },
        () => {
          this.screens.closeAll();
          this.paused = false;
          this.endDive(true, 'giveup');
        },
        this.sfx.enabled,
        (v) => this.sfx.setEnabled(v),
      );
    }
  };

  // ---- 辅助 ----

  private heldCount() {
    return this.held.length;
  }

  private heldValue() {
    return this.held.reduce((s, i) => s + i.value, 0);
  }

  /** 实体相对玩家的方位词（低语雷达用） */
  private relativeDir(player: { x: number; z: number }, yaw: number, ex: number, ez: number): string {
    const dx = ex - player.x;
    const dz = ez - player.z;
    const fwdDot = (Math.cos(yaw) * dx + Math.sin(yaw) * dz) / (Math.hypot(dx, dz) || 1);
    const rightDot = (-Math.sin(yaw) * dx + Math.cos(yaw) * dz) / (Math.hypot(dx, dz) || 1);
    if (fwdDot > 0.5) return '前方';
    if (fwdDot < -0.5) return '背后';
    return rightDot > 0 ? '右边' : '左边';
  }

  // ---- 调试/自动化接口（window.__game 暴露） ----

  get debug() {
    return {
      stage: this.stage,
      night: this.def.night,
      paused: this.paused,
      player: this.playerName,
      archetype: this.archetype,
      flashlight: this.flashlight,
      timeLeft: +this.timeLeft.toFixed(1),
      held: this.held.map((i) => ({ id: i.def.id, value: i.value })),
      heldValue: this.heldValue(),
      caught: this.caughtCount,
      nearMiss: this.nearMiss,
      spoken: this.spoken,
      fear: +this.deps.companion.fear.toFixed(2),
      entity: this.entity.debug,
      ftue: this.ftue,
      sfx: this.sfx.enabled,
    };
  }

  get api() {
    return {
      goto: (s: Stage) => this.goto(s),
      /** 进入指定夜（1 起算）：换配置回晨间，世界后台加载 */
      enterNight: (n: number) => this.enterNight(n),
      pickup: () => this.tryPickup(),
      speak: (text: string) => {
        this.spoken++;
        const ps = this.deps.controls.playerState;
        this.entity.hear({ x: ps.position.x, z: ps.position.z, level: this.def.noise.speak });
        this.ledger.add(this.def.night, 'noise_speak', { text });
        this.hud.bubble(this.bag.scene('speak'), this.archetype, 4500);
      },
      setTimer: (sec: number) => {
        this.timeLeft = Math.max(0, sec);
      },
      flash: (on?: boolean) => {
        this.flashlight = on ?? !this.flashlight;
        this.hud.setVignette(this.flashlight ? 'bright' : 'dark');
        return this.flashlight;
      },
      entityChase: () => this.entity.forceState('chase'),
      entityTeleport: (x: number, z: number) => this.entity.teleport(x, z),
      /** 取证：隐藏/显示战利品与门（像素差对照用） */
      showItems: (v: boolean) => {
        this.items.loot.forEach((i) => (i.root.visible = v && !i.taken));
        this.items.doorRoot.visible = v;
        return v;
      },
      /** 取证：单件战利品显隐（webp 贴图上屏检验等像素级对照用） */
      showItem: (id: string, v: boolean) => {
        const it = this.items.loot.find((i) => i.def.id === id);
        if (!it) return false;
        it.root.visible = v && !it.taken;
        return true;
      },
      itemPositions: () => this.items.loot.map((i) => ({ id: i.def.id, x: i.def.x, z: i.def.z, taken: i.taken, value: i.value })),
      setArchetype: (a: Archetype) => {
        this.archetype = a;
        this.bag = new LineBag(ARCHETYPE_LINES[a]);
      },
      returnHome: () => this.endDive(false, 'return'),
      ledger: () => this.ledger.all(),
      ledgerReset: () => this.ledger.reset(),
      sfx: (v: boolean) => this.sfx.setEnabled(v),
      hud: this.hud,
    };
  }
}
