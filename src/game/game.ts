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
import { ARCHETYPE_LINES, LineBag, pickPlea, pickEnhancedChase, pickWraithLine, pickSanityLowLine, SANITY_ZERO_LINE, WRAITH_GONE_LINE } from './lines';
import { Sfx } from './audio';
import { WorldItems, type LootItem } from './items';
import { Entity } from './entity';
import { Survivor } from './survivor';
import { Echo, readEchoKind, ECHO_MORNING, ECHO_RELIC_TEXT, pickEchoTalk, type EchoKind } from './echo';
import { buildMirrorView, mirrorSummary, readMirrorStats } from './mirror';
import { DustField } from './atmosphere';
import { Guest, readGuestSaved, GUEST_CARD, GUEST_INNKEEPER_INTEL, pickGuestTalk } from './guest';
import { Hud } from './hud';
import { Screens, type SurvivorChoice } from './screens';
import type { WalkControls, PlayerState } from '../walk-controls';
import type { Companion } from '../companion';
import type { VoxelCollision } from '../collision';
import type { NavColumn, NavField } from '../nav';
import type { Object3D, Scene3D, Viewer, Vector3 } from '@manycore/aholo-viewer';

export type Stage = 'boot' | 'title' | 'morning' | 'seam' | 'dive' | 'mirror' | 'settle' | 'talk' | 'progress';

/** 幸存者遭遇结算（E2）：+5 文谢礼 */
const SURVIVOR_BONUS = 5;
/** 抢夺所得「旅人的油纸包」（图鉴第 4 格） */
const PAPER_VALUE = 10;
/** N3 saved 回响「谢礼灯笼」（图鉴追加槽，仅此夜） */
const GIFT_VALUE = 5;
/** 谢礼灯笼视觉源：复用 Lux3D 铜灯笼 GLB（零新资产） */
const GIFT_GLB = './assets/token-lantern.glb';
/** N4 住客回归「古镇银铃」（图鉴系列第 5 格——N2 油纸包第 4 格之后；值在 NightDef.guest.bellValue） */
const BELL_ID = 'bell';
/** 银铃视觉源：复用 Lux3D 怀表 GLB（圆金属件铃形最近，零新资产） */
const BELL_GLB = './assets/token-watch.glb';

/** 当前世界运行时句柄（main.ts 持有并在换夜时原地更新字段） */
export interface WorldHandle {
  nav: NavField;
  collision: VoxelCollision | null;
  /** 已加载世界的夜数（启动=N1） */
  night: number;
}

export interface GameDeps {
  scene: Scene3D;
  viewer: Viewer;
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
  /** 幸存者遭遇（E2；N1 survivor.enabled=false 全程为 null） */
  private survivor: Survivor | null = null;
  private survivorOutcome: '' | '救下旅人' | '无视求助' | '抢夺旅人' | '旅人失踪' = '';
  private survivorBonus = 0;
  /** N2 选择回响（N3 起）：结局集 + 晨间一行字 + 世界内显形（beginDive 重建） */
  private echo: Echo | null = null;
  private echoKind: EchoKind | null = null;
  private echoMorning: string | null = null;
  /** 住客回归（N4，#26 常客系统）：N2 结局=saved → 旅人住下；银铃两种集都刷（beginDive 重建） */
  private guest: Guest | null = null;
  private guestSaved = false;
  /** 黑暗理智（N4 恐惧表强化，§3.6）：0..100，归零=实体盲追（数值在 NightDef.sanity） */
  private sanity = 100;
  private sanityBlindT = -99;
  private sanityLineT = -99;
  /** 悬浮微尘粒子（N4 氛围，three Points 零贴图） */
  private dust: DustField | null = null;
  /** 强化实体首次追击台词（每局一次） */
  private enhancedChaseShown = false;
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
  /** 本夜第几次下潜（回响抖动只按「本夜第几次潜」计，setNight 清零——跨夜不泄漏） */
  private nightRunCount = 0;
  /** 当夜 nav 可站柱缓存与最低可站面（坠落软复位用；beginDive 守卫通过后刷新） */
  private navColumns: NavColumn[] = [];
  private navFloorMin = 0;

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
        this.screens.morning(
          this.ledger.all(),
          this.def,
          () => this.goto('seam'),
          this.echoMorning ?? undefined,
          this.guestCard(),
          this.keeperIntel() ?? undefined,
        );
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
      case 'mirror':
        // 镜像对照页（N6）：归航后、结算前，「世界记得你的总和」
        this.stage = 'mirror';
        this.screens.mirror(buildMirrorView(readMirrorStats(this.ledger)), () => this.goto('settle'));
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
    this.nightRunCount = 0; // 抖动按「本夜第几次潜」计：换夜（含 enterNight 重进）清零
    const def = this.def;
    if (this.items) this.items.dispose(this.deps.scene);
    this.items = new WorldItems(this.deps.scene, this.deps.world.nav, def.loot, def.door, def.warmLamps, def.barriers);
    this.items.reset();
    this.items.loot.forEach((i) => (i.root.visible = false)); // 非下潜阶段藏起世界物
    this.entity.applyNight(this.deps.world.nav, this.deps.world.collision, def.entity, this.deps.scene);
    this.entity.root.visible = false;
    // N2 选择回响：读账本定结局集（世界物在 beginDive 世界就绪后显形——nav 须为本夜的）
    if (this.echo) {
      this.echo.dispose();
      this.echo = null;
    }
    this.echoKind = def.echoAnchors ? readEchoKind(this.ledger) : null;
    this.echoMorning = this.echoKind ? ECHO_MORNING[this.echoKind] : null;
    // 住客回归（N4）：换夜重建世界物 + 读 N2 结局定住客（晨间卡/夜谈用；银铃 beginDive 显形）
    if (this.guest) {
      this.guest.dispose();
      this.guest = null;
    }
    if (this.dust) {
      this.dust.dispose();
      this.dust = null;
    }
    if (def.guest) this.guestSaved = readGuestSaved(this.ledger);
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
    // 换夜竞态守卫：调试直达 goto('dive') 会捕获换夜前已 resolve 的 worldReady 微任务，
    // 可能把新夜配置跑在旧世界上（静默坠穿）。不一致=拒绝下潜，回晨间重走世界加载门控。
    if (this.worldNight !== this.def.night) {
      console.error(
        `[守卫] 拒绝下潜：世界=第${this.worldNight}夜，配置=第${this.def.night}夜。回晨间重走加载门控。`,
      );
      this.goto('morning');
      return;
    }
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
    this.enhancedChaseShown = false;

    // 回响重玩：战利品价值微变（±echoJitter 文）——只看「本夜第几次潜」，换夜首潜不抖
    this.items.reset(this.nightRunCount > 0 ? def.echoJitter : 0);
    // 世界已就绪（守卫通过）：实体重挂本夜导航/碰撞后再落位（修 setNight 时挂旧 nav 的跨夜残留）
    this.entity.retarget(this.deps.world.nav, this.deps.world.collision);
    this.entity.teleport(def.entity.start.x, def.entity.start.z);
    this.entity.forceState('wander');

    // 坠落软复位基线：缓存当夜 nav 可站柱与最低可站面（守卫已保证 world=本夜）
    this.navColumns = this.deps.world.nav.columns;
    this.navFloorMin = this.navColumns.reduce((m, c) => Math.min(m, c.y), Infinity);

    // 幸存者遭遇槽（E2）：本夜启用才生成；结局与谢礼按本局重置
    this.survivorOutcome = '';
    this.survivorBonus = 0;
    if (def.survivor.enabled) {
      if (!this.survivor) {
        this.survivor = new Survivor(this.deps.scene, this.deps.world.nav, def.survivor.x, def.survivor.z);
        this.survivor.load(def.survivor.glb, this.deps.viewer, this.deps.scene).catch((e: unknown) =>
          console.warn('[旅人] GLB 加载失败，保留占位:', e),
        );
      }
      this.survivor.state = 'waiting';
      this.survivor.announced = false;
      this.survivor.place(def.survivor.x, def.survivor.z);
    } else if (this.survivor) {
      this.survivor.root.visible = false;
    }

    // N2 选择回响显形（N3）：世界已就绪（守卫通过，nav=本夜），按账本结局集重建世界物
    if (def.echoAnchors && this.echoKind) {
      if (this.echo) this.echo.dispose();
      this.echo = new Echo(this.deps.scene, this.deps.world.nav, def.echoAnchors);
      this.echo.spawn(this.echoKind, GIFT_GLB);
    }

    // 住客回归（N4，#26）：银铃显形（两种住客集都刷）；present 只驱动晨间卡/夜谈
    if (def.guest) {
      if (!this.guest) this.guest = new Guest(this.deps.scene, this.deps.world.nav, def.guest);
      this.guest.spawn(this.guestSaved, BELL_GLB);
    }

    // 黑暗理智（N4，§3.6）：每局回满；水下微尘只在 N4 下潜可见
    this.sanity = 100;
    this.sanityBlindT = -99;
    this.sanityLineT = -99;
    this.hud.setSanity(100, !!def.sanity, def.sanity?.lowThreshold ?? 30);
    if (def.dust) {
      if (!this.dust) this.dust = new DustField(this.deps.scene, this.deps.world.nav);
      this.dust.setVisible(true);
    }

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
    this.hud.resetCodex(); // 重建本夜图鉴：清掉上局 pushCodexSlot 的特殊所得（跨局不残留）
    this.deps.hint.textContent = '点击画面进入行走模式 · WASD 移动 / 鼠标转向 / E 拾取 / F 手电 / T 说话';
    this.deps.hint.style.opacity = '1';
    // 伙计开场：本夜专属池（N5 匮乏夜 ≥2 条）优先，缺省按原型通用开场池
    const opening =
      def.openingLines && def.openingLines.length > 0
        ? def.openingLines[Math.floor(Math.random() * def.openingLines.length)]!
        : this.bag.scene('opening');
    this.hud.bubble(opening, this.archetype, 6000);
  }

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
    // 回响世界物随本局收摊（结局集与晨间字保留到夜谈/进度）；微尘层只在下潜可见
    if (this.echo) {
      this.echo.dispose();
      this.echo = null;
    }
    this.dust?.setVisible(false);

    const lostValue = lostAll ? this.held.reduce((s, i) => s + i.value, 0) : 0;
    if (lostAll) this.held = [];

    // 幸存者遭遇结算（E2）：带回门口=救下（+5 文谢礼）；门关/放弃=旅人失踪
    if (this.survivor?.state === 'following') {
      if (reason === 'return') {
        this.survivor.state = 'saved';
        this.survivor.root.visible = false;
        this.survivorOutcome = '救下旅人';
        this.survivorBonus = SURVIVOR_BONUS;
        this.ledger.add(def.night, 'survivor_saved', { bonus: SURVIVOR_BONUS });
      } else {
        this.survivor.state = 'lost';
        this.survivor.root.visible = false;
        this.survivorOutcome = '旅人失踪';
        this.ledger.add(def.night, 'survivor_lost', {});
      }
    }

    if (reason === 'return') {
      this.ledger.add(def.night, 'return', { secondsLeft: Math.round(this.timeLeft) });
    } else {
      // 门关 / 放弃：丢当日全部战利品，被乱流抛回驿站（不判死）
      this.ledger.add(def.night, 'door_close', { lostValue, gaveUp: reason === 'giveup' });
    }
    // 夜进度：结算即解锁下一夜（灯暗一分不判死档）
    saveUnlockedNight(def.night + 1);
    this.nightRunCount++;
    this.sfx.bell(reason === 'return');
    // 镜像夜（N6）：结算前先看「世界记得你的总和」（归航才结总账——门关/放弃不遮这一页）
    this.goto(this.def.mirrorPage ? 'mirror' : 'settle');
  }

  private openSettle() {
    const def = this.def;
    const total = this.held.reduce((s, i) => s + i.value, 0) + this.survivorBonus;
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
          tagline: def.tagline,
          looted: this.held.map((i) => ({ name: i.def.name, value: i.value })),
          total,
          bill: def.bill,
          paid,
          caught: this.caughtCount,
          nearMiss: this.nearMiss,
          spoken: this.spoken,
          survivor: this.survivorOutcome || undefined,
          quip,
          date: new Date().toISOString().slice(0, 10),
        },
      },
      () => this.goto('talk'),
    );
  }

  private openTalk() {
    // 夜谈：伙计评论本夜（本次下潜）第一条账本记录；N3 起追加 N2 选择回响的评语（世界记得你）；
    // N4 有住客时旅人也说一段（#26 常客系统：评论 N4 经历，池 ≥2 条）
    const runRecords = this.ledger.all().filter((r) => r.ts >= this.runStartTs && r.night === this.def.night);
    const first = runRecords[0];
    const type: LedgerEventType = first ? first.type : 'return';
    this.screens.talk(
      this.archetype,
      this.bag.talk(type as never),
      () => this.goto('progress'),
      this.echoKind ? pickEchoTalk(this.echoKind) : undefined,
      this.def.guest && this.guestSaved ? pickGuestTalk() : undefined,
    );
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

    // 坠落软复位（兜底）：掉出世界（低于 nav 最低可站面 5m）→ 托回最近可站柱
    if (this.checkFallReset(ps)) return;
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

    // 追击逼近计数（账单卡「遭遇」）；强化实体首进追击 → 伙计强化版台词（替换当刻恐惧话）
    if (tick.state === 'chase' && !this.wasChasing) {
      if (dist < 9) this.nearMiss++;
      if (def.entity.enhanced && !this.enhancedChaseShown) {
        this.enhancedChaseShown = true;
        this.fearLineT = t;
        this.sfx.fearPing();
        this.hud.bubble(pickEnhancedChase(), this.archetype, 5200);
      }
    }
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

    // 幸存者遭遇（E2）：接近低语一次 + 跟随/待机动画 + 交谈提示
    if (this.survivor?.isPresent) {
      const sv = this.survivor;
      sv.update(dt, ps.position, ps.yaw);
      const sd = Math.hypot(sv.pos.x - ps.position.x, sv.pos.z - ps.position.z);
      if (sv.state === 'waiting') {
        if (sd < 5 && !sv.announced) {
          sv.announced = true;
          this.sfx.whisper();
          this.hud.bubble(this.bag.scene('survivor').replace('{dir}', this.relativeDir(ps.position, ps.yaw, sv.pos.x, sv.pos.z)), this.archetype, 5000);
        }
        if (sd < 2.5 && !this.screens.survivorDialogOpen) this.hud.setPrompt('按 E 与旅人交谈');
      }
    }

    // 黑暗理智（N4 恐惧表机制强化，§3.6 噪音/光照槽）：手电关且离暖光点>darkRadius=黑暗区，
    // 每秒 -drainPerSec；手电开或近灯不扣（不做被动回复——压力来源只有「灯」，
    // 归零=实体盲追+回 recover，见 sanityZero()）。暖光锚=灯笼×3+归航门暖光柱
    // （门口=灯下安全区：锚定法则，出生/归航不扣理智）
    if (def.sanity) {
      const ps0 = { x: ps.position.x, z: ps.position.z };
      let nearest = Math.hypot(def.door.x - ps0.x, def.door.z - ps0.z);
      for (const lamp of def.warmLamps ?? []) nearest = Math.min(nearest, Math.hypot(lamp.x - ps0.x, lamp.z - ps0.z));
      const inDark = !this.flashlight && nearest > def.sanity.darkRadius;
      if (inDark) this.sanity = Math.max(0, this.sanity - def.sanity.drainPerSec * dt);
      this.hud.setSanity(this.sanity, true, def.sanity.lowThreshold);
      if (this.sanity < def.sanity.lowThreshold && t - this.sanityLineT > 12) {
        // 低理智：水波纹暗角（hud.setSanity 已开）+ 伙计慌（低频）
        this.sanityLineT = t;
        this.sfx.fearPing();
        this.hud.bubble(pickSanityLowLine(), this.archetype, 5000);
      }
      if (this.sanity <= 0 && t > this.sanityBlindT + def.sanity.blackoutBlindSeconds) {
        this.sanityBlindT = t;
        this.sanity = def.sanity.blackoutRecover;
        this.entity.enrage(def.sanity.blackoutBlindSeconds, t);
        this.hud.flashRed();
        this.hud.bubble(SANITY_ZERO_LINE, this.archetype, 6000);
        console.warn(`[理智] 归零：实体盲追 ${def.sanity.blackoutBlindSeconds}s，理智回 ${def.sanity.blackoutRecover}`);
      }
    }

    // 住客回归（N4）：银铃浮动
    this.guest?.update(dt, t);

    // N2 选择回响（N3）：残影逼近=紧张台词+红晕；绕开=散去（edge 各一次）
    if (this.echo) {
      const et = this.echo.update(dt, t, ps.position);
      if (et.wraithNear) {
        this.sfx.whisper();
        this.hud.flashRed();
        this.hud.bubble(pickWraithLine(), this.archetype, 5000);
      }
      if (et.wraithGone) {
        this.hud.bubble(WRAITH_GONE_LINE, this.archetype, 4500);
      }
    }

    // 交互提示
    const near = this.items.nearest(ps.position);
    const echoNear = this.echo?.nearInteractable(ps.position) ?? null;
    const bellInRange = this.guest?.isBellInRange(ps.position, def.pickupRadius) ?? false;
    const doorD = Math.hypot(ps.position.x - def.door.x, ps.position.z - def.door.z);
    if (near && near.dist < def.pickupRadius) {
      this.hud.setPrompt(`按 E 拾取 · ${near.item.def.name}（${near.item.value} 文）`);
    } else if (bellInRange) {
      this.hud.setPrompt(`按 E 拾取 · 古镇银铃（${def.guest?.bellValue ?? 12} 文）`);
    } else if (echoNear && echoNear.dist < (echoNear.kind === 'gift' ? def.pickupRadius : 2.0)) {
      this.hud.setPrompt(echoNear.kind === 'gift' ? '按 E 收下 · 谢礼灯笼（+5 文）' : '按 E 察看');
    } else if (doorD < def.doorReturnRadius) {
      const canReturn = this.held.length > 0 || this.caughtCount > 0 || this.timeLeft < 30;
      this.hud.setPrompt(canReturn ? '按 E 推门归航' : '门在这里。天亮前带着值钱物回来。');
    } else if (!(this.survivor?.isPresent && this.survivor.state === 'waiting' && Math.hypot(this.survivor.pos.x - ps.position.x, this.survivor.pos.z - ps.position.z) < 2.5)) {
      this.hud.setPrompt(null);
    }

    this.items.update(t, dt);
    this.dust?.update(t);
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
    // 旅人独立判定从简：玩家被抓 → 跟随中的旅人失踪（不做旅人独立被抓）
    if (this.survivor?.state === 'following') {
      this.survivor.state = 'lost';
      this.survivor.root.visible = false;
      this.survivorOutcome = '旅人失踪';
      this.ledger.add(def.night, 'survivor_lost', {});
      setTimeout(() => this.hud.bubble(this.bag.scene('lost'), this.archetype, 5500), 3200);
    }
    // 被拖回门口
    const { spawn } = def;
    this.deps.controls.startAt(spawn.x, spawn.z, spawn.yaw);
    this.hud.setCodex(this.held.map((i) => i.def.id));
    this.hud.setGoal(this.heldCount(), this.items.loot.length + (this.survivorOutcome === '抢夺旅人' ? 1 : 0), this.heldValue(), def.bill);
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
    this.hud.setCodex(this.held.map((i) => i.def.id));
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

  // ---- 幸存者遭遇（E2）----

  /** E 开对话卡（等待状态 2.5m 内；不开卡返回 false 走后续交互） */
  private trySurvivorTalk(): boolean {
    const sv = this.survivor;
    if (!sv || sv.state !== 'waiting' || this.screens.survivorDialogOpen) return false;
    const ps = this.deps.controls.playerState;
    const d = Math.hypot(sv.pos.x - ps.position.x, sv.pos.z - ps.position.z);
    if (d >= 2.5) return false;
    this.screens.survivorDialog(pickPlea(), (c) => this.applySurvivorChoice(c));
    return true;
  }

  /** 三选落地：救（跟随）/ 不理（记账即止）/ 抢（油纸包+大噪音） */
  applySurvivorChoice(choice: SurvivorChoice) {
    const sv = this.survivor;
    if (!sv || sv.state !== 'waiting') return;
    const def = this.def;
    const ps = this.deps.controls.playerState;
    if (choice === 'save') {
      sv.state = 'following';
      this.hud.bubble(this.bag.scene('saved'), this.archetype, 4500);
    } else if (choice === 'ignore') {
      sv.state = 'ignored';
      this.survivorOutcome = '无视求助';
      this.ledger.add(def.night, 'survivor_ignored', {});
    } else {
      // 抢：得「旅人的油纸包」（图鉴第 4 格，值 10 文）+ 大噪音（实体立刻循声而来）
      sv.state = 'robbed';
      sv.root.visible = false;
      this.survivorOutcome = '抢夺旅人';
      this.ledger.add(def.night, 'survivor_robbed', { value: PAPER_VALUE });
      this.held.push(this.makePaperItem());
      this.hud.pushCodexSlot('paper', 'pack', '旅人的油纸包', PAPER_VALUE);
      this.hud.setCodex(this.held.map((i) => i.def.id));
      this.hud.setGoal(this.heldCount(), this.items.loot.length + 1, this.heldValue(), def.bill);
      this.sfx.pickup();
      this.entity.hear({ x: ps.position.x, z: ps.position.z, level: def.noise.speak });
      this.hud.bubble(this.bag.scene('rob'), this.archetype, 5000);
    }
  }

  /** 旅人的油纸包：不落地的特殊所得（held 计入账单总额） */
  private makePaperItem(): LootItem {
    return {
      def: {
        id: 'paper',
        name: '旅人的油纸包',
        value: PAPER_VALUE,
        x: 0,
        z: 0,
        color: 0xc9a86b,
        glowColor: 0xffe2b0,
        shape: 'watch',
      },
      root: null as unknown as Object3D,
      pos: null as unknown as Vector3,
      baseY: 0,
      taken: false,
      value: PAPER_VALUE,
    };
  }

  // ---- N2 选择回响（N3）----

  /** E 交互回响物：谢礼灯笼拾取（+5 文）/ 叙事物件察看（一句描述）。未命中返回 false */
  private tryEcho(): boolean {
    const echo = this.echo;
    if (!echo || !this.echoKind) return false;
    const ps = this.deps.controls.playerState;
    if (echo.isGiftInRange(ps.position, this.def.pickupRadius)) {
      echo.takeGift();
      this.held.push(this.makeGiftItem());
      this.sfx.pickup();
      this.hud.pushCodexSlot('gift', 'lantern', '谢礼灯笼', GIFT_VALUE);
      this.hud.setCodex(this.held.map((i) => i.def.id));
      this.hud.setGoal(this.heldCount(), this.items.loot.length + this.specialHeldCount(), this.heldValue(), this.def.bill);
      this.ledger.add(this.def.night, 'loot', { id: 'gift', name: '谢礼灯笼', value: GIFT_VALUE, deep: false, echo: 'saved' });
      this.hud.bubble('灯笼收下了。灯芯暖了一分——他托乱流说，谢谢你那天没走开。', this.archetype, 5200);
      return true;
    }
    if ((echo.kind === 'ignored' || echo.kind === 'lost') && echo.isRelicInRange(ps.position, 2.0)) {
      echo.markRelicSeen();
      this.sfx.whisper();
      this.hud.bubble(ECHO_RELIC_TEXT[echo.kind], this.archetype, 6200);
      return true;
    }
    return false;
  }

  /** 谢礼灯笼：不落地的特殊所得（同油纸包模式） */
  private makeGiftItem(): LootItem {
    return {
      def: {
        id: 'gift',
        name: '谢礼灯笼',
        value: GIFT_VALUE,
        x: 0,
        z: 0,
        color: 0xffb35c,
        glowColor: 0xffd9a0,
        shape: 'lantern',
      },
      root: null as unknown as Object3D,
      pos: null as unknown as Vector3,
      baseY: 0,
      taken: false,
      value: GIFT_VALUE,
    };
  }

  /** held 里的特殊所得数（油纸包/谢礼灯笼/古镇银铃——图鉴目标总数用） */
  private specialHeldCount(): number {
    return this.held.filter((i) => i.def.id === 'paper' || i.def.id === 'gift' || i.def.id === BELL_ID).length;
  }

  // ---- 住客回归（N4，#26 常客系统）----

  /** E 拾取银铃（两种住客集都刷；值 12 文，图鉴系列第 5 格）。未命中返回 false */
  private tryBell(): boolean {
    const guest = this.guest;
    const def = this.def;
    if (!guest || !def.guest) return false;
    const ps = this.deps.controls.playerState;
    if (!guest.isBellInRange(ps.position, def.pickupRadius)) return false;
    const value = def.guest.bellValue;
    guest.takeBell();
    this.held.push(this.makeBellItem(value));
    this.sfx.pickup();
    this.hud.pushCodexSlot(BELL_ID, 'lantern', '古镇银铃', value);
    this.hud.setCodex(this.held.map((i) => i.def.id));
    this.hud.setGoal(this.heldCount(), this.items.loot.length + this.specialHeldCount(), this.heldValue(), def.bill);
    this.ledger.add(def.night, 'loot', { id: BELL_ID, name: '古镇银铃', value, deep: true, guest: guest.present ? 'saved' : 'none' });
    this.hud.bubble(
      guest.present ? '银铃收下了。住客说得没错——镇子最深处，果然留着好东西。' : '银铃收下了。伙计的鼻子比狗还灵……这铃声在水里也传得很远。',
      this.archetype,
      5200,
    );
    // 拾取=中噪（同战利品）
    this.entity.hear({ x: ps.position.x, z: ps.position.z, level: def.noise.pickup });
    return true;
  }

  /** 古镇银铃：不落地的特殊所得（同油纸包/谢礼灯笼模式） */
  private makeBellItem(value: number): LootItem {
    return {
      def: {
        id: BELL_ID,
        name: '古镇银铃',
        value,
        x: 0,
        z: 0,
        color: 0xd8dee8,
        glowColor: 0xcfe0ea,
        shape: 'lantern',
      },
      root: null as unknown as Object3D,
      pos: null as unknown as Vector3,
      baseY: 0,
      taken: false,
      value,
    };
  }

  /** 晨间住客卡（saved 集；无住客=undefined） */
  private guestCard() {
    if (!this.def.guest || !this.guestSaved) return undefined;
    return GUEST_CARD;
  }

  /** 无住客时的伙计情报行（银铃照刷，情报换人给） */
  private keeperIntel() {
    if (!this.def.guest || this.guestSaved) return null;
    return GUEST_INNKEEPER_INTEL;
  }

  private toggleFlashlight() {
    this.flashlight = !this.flashlight;
    this.sfx.flash();
    this.hud.setVignette(this.flashlight ? 'bright' : 'dark');
    // 第二招「见光追」（N5 匮乏夜）：手电开启瞬间实体直接获得玩家位置（开启瞬间才触发）
    if (this.flashlight && this.entity.flashlightPing(performance.now() / 1000)) {
      this.hud.bubble('你的光照到了它——它顺着光柱摸过来了！', this.archetype, 5000);
    }
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
      if (!this.tryPickup() && !this.trySurvivorTalk() && !this.tryEcho() && !this.tryBell()) this.tryReturn();
    } else if (e.code === 'KeyF') {
      this.toggleFlashlight();
    } else if (e.code === 'KeyT') {
      e.preventDefault();
      this.openTalkbox();
    } else if (this.screens.survivorDialogOpen && (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3')) {
      // 遭遇现场抉择：指针锁定时鼠标点不了，数字键 1/2/3 快选
      const c: SurvivorChoice = e.code === 'Digit1' ? 'save' : e.code === 'Digit2' ? 'ignore' : 'rob';
      this.screens.closeSurvivorDialog();
      this.applySurvivorChoice(c);
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

  // ---- 坠落软复位（志怪兜底；行走控制器主体不动） ----

  /** y 低于当夜 nav 最低可站面 -5m=掉出世界 → 托回最近可站柱。保留已拾取物与计时；
   *  黑闪 0.3s + 「乱流托住了你」一行字。仅下潜阶段生效（update 只在 dive 跑）。 */
  private checkFallReset(ps: PlayerState): boolean {
    if (this.navColumns.length === 0 || ps.position.y >= this.navFloorMin - 5) return false;
    let best = this.navColumns[0]!;
    let bestD = Infinity;
    for (const c of this.navColumns) {
      const d = (c.x - ps.position.x) ** 2 + (c.z - ps.position.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    this.deps.controls.startAt(best.x, best.z, ps.yaw);
    this.hud.flashBlack(300);
    this.hud.bubble('乱流托住了你。', this.archetype, 3200);
    console.warn(
      `[兜底] 坠落软复位：托回可站柱 (${best.x.toFixed(1)}, ${best.z.toFixed(1)}) 带面 y=${best.y.toFixed(1)}`,
    );
    return true;
  }

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
      survivor: this.survivor?.debug ?? null,
      survivorOutcome: this.survivorOutcome,
      survivorBonus: this.survivorBonus,
      echo: this.echo?.debug ?? { kind: this.echoKind, morning: this.echoMorning },
      guest: this.guest?.debug ?? { present: this.guestSaved, bellTaken: false, bell: null },
      /** 镜像对照页统计（N6）：与账本一致性核对用（saved/robbed/ignored/lost/caught/nights） */
      mirrorStats: mirrorSummary(readMirrorStats(this.ledger)),
      sanity: +this.sanity.toFixed(1),
      sanityBlindLeft: this.def.sanity
        ? +Math.max(0, this.def.sanity.blackoutBlindSeconds - (this.entity.debug.tAcc - this.sanityBlindT)).toFixed(1)
        : 0,
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
        // 与按键路径同款：见光追（N5 sightTrick）在调试 API 上同样触发
        const pinged = this.flashlight && this.entity.flashlightPing(performance.now() / 1000);
        return { on: this.flashlight, sightTrick: pinged };
      },
      entityChase: () => this.entity.forceState('chase'),
      entityTeleport: (x: number, z: number) => this.entity.teleport(x, z),
      /** 实体调试：冻结（不再循声/追击）——遭遇玩法自动化测试用 */
      entityFreeze: (v: boolean) => {
        this.entity.calmUntil = v ? Number.POSITIVE_INFINITY : 0;
        return v;
      },
      /** 遭遇调试：不开卡直接按三选落地（自动化驱动用） */
      survivorChoice: (c: SurvivorChoice) => this.applySurvivorChoice(c),
      /** 遭遇调试：传送旅人（跟随/遭遇测试用） */
      survivorTeleport: (x: number, z: number) => {
        const sv = this.survivor;
        if (!sv) return false;
        sv.place(x, z);
        return true;
      },
      /** 遭遇调试：开对话卡（不出 E 也能触发） */
      survivorDialog: () => this.trySurvivorTalk(),
      /** 回响调试（N3）：E 交互回响物（拾谢礼灯笼/察看叙事物件）；状态见 __game.night.echo */
      echoInteract: () => this.tryEcho(),
      /** 住客调试（N4）：E 交互银铃；状态见 __game.night.guest */
      bellInteract: () => this.tryBell(),
      /** 黑暗理智调试（N4）：直接置理智值（归零流程自动化驱动用）；状态见 __game.night.sanity */
      setSanity: (v: number) => {
        this.sanity = Math.min(100, Math.max(0, v));
        return this.sanity;
      },
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
