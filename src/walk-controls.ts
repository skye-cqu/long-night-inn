/**
 * walk-controls.ts — 第一人称行走控制器（WASD + 鼠标指针锁定转向 + 体素碰撞）。
 *
 * 控制器骨架（定步长积分、地面探测、重力/弹簧、胶囊推离、输入聚合）移植自官方
 * walk-demo 的 ViewerWalkMode（MIT，衍生自 SuperSplat Viewer），按本项目裁剪为
 * 第一人称单角色。碰撞数据：scripts/gen-voxel.mjs 本地生成的
 * collision.voxel-meta.json + voxel.bin（@manycore/aholo-splat-transform Voxel 任务，
 * 对齐官方 walk-demo 的加载格式）。体素缺失时退回「地面高度场 + 走廊包围盒」
 * 简化约束（nav.ts，scripts/gen-nav-data.mjs 预计算）。
 */
import { PerspectiveCamera, Vector3 } from '@manycore/aholo-viewer';
import type { NavField } from './nav';
import type { VoxelCollision } from './collision';

const STEP = 1 / 60;
const MAX_SUBSTEPS = 10;
const MOVE_SPEED = 2.2; // m/s，室内走廊速度
const SPRINT_SPEED = 4.2; // 跑：比实体追击(3.1)快，走得掉要靠跑
const CROUCH_SPEED = 1.05; // 蹲行：近乎无声
const CAPSULE_HEIGHT = 1.5;
const CAPSULE_RADIUS = 0.12;
const HOVER_HEIGHT = 0.2;
const EYE_HEIGHT = CAPSULE_HEIGHT - 0.1 - HOVER_HEIGHT; // 1.2
const CROUCH_EYE_HEIGHT = 0.78; // 蹲下视高
const GRAVITY = 9.8;
const ACCEL_GROUNDED = 24;
const MOUSE_SENSITIVITY = 0.0022;
const WALL_MARGIN = 0.35; // 简化碰撞（无体素时）的走廊内缩
const STAMINA_MAX = 100;
const STAMINA_DRAIN = 26; // /s 跑步消耗
const STAMINA_REGEN = 14; // /s 恢复
const STAMINA_SPRINT_MIN = 20; // 低于此值强制回走，恢复过 20 才能再跑
const STEP_UP_MAX = 0.55; // B1 自动踏步：顶面在脚面之上 ≤ 此高度且上方为空的可站障碍由弹簧抬上（高于此=墙）
/** P1 踏步带面限高：顶面超出 nav 地面场此高度=带外高面（=墙，不登记踏步）。B1 修复后玩家
 *  沿台阶/矮家具链式 0.55m 爬升到 nav 带外 1-2m（E14 实测站面 4.2-4.6 vs 带面 2.4），在高面
 *  上撞真墙钉死。余量 0.75=带面悬浮 0.2+一级满高台阶 0.55：带面一级台阶恰好可登、二级封顶。 */
const STEP_UP_BAND_MAX = 0.75;
const WEDGE_TRIGGER = 72; // B1 反死锁：连续「有移动意图但零位移」子步数（≈1.2s）后开始微滑
const WEDGE_INTERVAL = 9; // 触发后每 ~0.15s 微滑一次
/** P1 阶梯探测距离（米）：依次探更远的侧向位，取最远的碰撞安全距离滑出——单一 0.055m 探距
 *  在「缺口在 0.1-0.4m 外」的槽位（如 N3 门洞南侧卡口）永远探不到，玩家被槽壁夹死。 */
const WEDGE_PROBES = [0.055, 0.12, 0.24, 0.4, 0.6]; // 0.6 档：N3 门洞缝沿距直行线≈0.42-0.55，原最大 0.41 探不到

export type Gait = 'walk' | 'sprint' | 'crouch';

/** 物理封路盒（N6 高台 8m 落差口，§11.1 隐形墙；xz AABB，y 向全高有效）。
 *  结构最小化：与 NightDef.barriers 字段同形，避免本文件反向依赖 config。 */
export interface BarrierBox {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface PlayerState {
  position: Vector3;
  yaw: number;
  speed: number;
  grounded: boolean;
  /** 当前步态（噪音等级与动画用） */
  gait: Gait;
  /** 是否在水平移动 */
  moving: boolean;
  /** 体力 0..100 */
  stamina: number;
}

export class WalkControls {
  readonly position = new Vector3();
  yaw = 0;
  pitch = 0;
  speed = 0;
  grounded = false;
  /** 蹲行开关（C 切换） */
  crouched = false;
  stamina = STAMINA_MAX;
  gait: Gait = 'walk';

  private velocity = new Vector3();
  private keys: Record<string, boolean> = {};
  /** 自动化调试用持久输入（__game.setInput 驱动） */
  private debugInput = { forward: 0, strafe: 0 };
  private pointerLocked = false;
  private accumulator = 0;
  private collision: VoxelCollision | null;
  private nav: NavField;
  /** 物理封路盒（N6 落差口隐形墙；空=无） */
  private barriers: BarrierBox[] = [];
  private container: HTMLElement;
  private enabled = false;
  /** 文本输入模式（伙计说话框聚焦时）：吞掉移动键，不 preventDefault */
  private textMode = false;
  private eyeSmooth = EYE_HEIGHT;
  private staminaLock = false;
  /** B1 踏步目标面（碰撞侧低矮可站障碍的顶面 y；null=无）与保持时长 */
  private stepUpY: number | null = null;
  private stepUpHold = 0;
  /** B1 反死锁：连续「有移动意图但位移≈0」的子步计数 + 最近一次水平推离方向（微滑选边参考） */
  private wedgeSteps = 0;
  private lastPushXZ = { x: 0, z: 0 };
  /** P1 带面顶棚网格：nav 可站柱按 0.5m 格取最大高度后做 2m 半径极大滤波——「这一片地形的
   *  带内上限」。踏步/上推带限的参照面（单格 floorAt 对带内地形起伏会误杀合法上坡，
   *  见 N4 主街带面 -4.4..-1.6；摊棚/家具顶高出带面 ≥0.75/0.9m 仍被挡）。 */
  private bandCeil: Float32Array | null = null;
  private bandCeilNx = 0;
  private bandCeilNz = 0;

  constructor(container: HTMLElement, nav: NavField, collision: VoxelCollision | null) {
    this.container = container;
    this.nav = nav;
    this.collision = collision;
    this.buildBandCeil(nav);

    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    container.addEventListener('mousedown', this.onMouseDown);
    addEventListener('mousemove', this.onMouseMove);
    addEventListener('blur', this.clearInput);
    document.addEventListener('visibilitychange', () => document.hidden && this.clearInput());
  }

  startAt(x: number, z: number, yaw: number) {
    this.yaw = yaw;
    this.pitch = 0;
    this.velocity.set(0, 0, 0);
    this.position.set(x, this.nav.floorAt(x, z) + EYE_HEIGHT, z);
    if (this.collision) {
      this.resolveSpawnCollision();
      const gy = this.probeGround();
      if (gy !== null) {
        this.grounded = true;
        this.velocity.y = 0;
        this.position.y = gy + HOVER_HEIGHT + EYE_HEIGHT;
      }
    }
    this.accumulator = 0;
    this.stepUpY = null;
    this.stepUpHold = 0;
    this.wedgeSteps = 0;
    this.enabled = true;
  }

  /** 每帧推进：定步长物理 + 相机应用 */
  update(dtRaw: number, camera: PerspectiveCamera) {
    const dt = Math.min(Math.max(dtRaw, 0), 0.5);
    if (this.enabled) {
      this.accumulator = Math.min(this.accumulator + dt, MAX_SUBSTEPS * STEP);
      while (this.accumulator >= STEP) {
        this.step(STEP);
        this.accumulator -= STEP;
      }
    }
    this.applyCamera(camera);
  }

  get playerState(): PlayerState {
    return {
      position: this.position,
      yaw: this.yaw,
      speed: this.speed,
      grounded: this.grounded,
      gait: this.gait,
      moving: this.speed > 0.25,
      stamina: this.stamina,
    };
  }

  get isPointerLocked() {
    return this.pointerLocked;
  }

  /** 说话框等文本输入聚焦时：键盘交给输入框，停止移动 */
  setTextInputMode(v: boolean) {
    this.textMode = v;
    if (v) this.keys = {};
  }

  /** 阶段切换：暂停/恢复输入（镜头应用不受影响） */
  setRuntimeEnabled(v: boolean) {
    this.enabled = v;
    if (!v) {
      this.keys = {};
      this.debugInput = { forward: 0, strafe: 0 };
    }
  }

  /** 换夜：替换导航高度场与体素碰撞（新世界资产就绪后调用） */
  setWorld(nav: NavField, collision: VoxelCollision | null) {
    this.nav = nav;
    this.collision = collision;
    this.buildBandCeil(nav);
  }

  /** 换夜：替换物理封路盒（隐形墙；缺省空=无，N1–N5 零变化） */
  setBarriers(list: BarrierBox[]) {
    this.barriers = list;
  }

  // ---- 内部 ----

  private step(dt: number) {
    // 输入 → 期望水平速度（步态：蹲 > 走 > 跑，跑耗体力）
    const fwd = { x: Math.cos(this.yaw), z: Math.sin(this.yaw) };
    const right = { x: -fwd.z, z: fwd.x }; // fwd × up（up=+Y）
    const keyF = (this.keys.KeyW || this.keys.ArrowUp ? 1 : 0) - (this.keys.KeyS || this.keys.ArrowDown ? 1 : 0);
    const keyS = (this.keys.KeyD || this.keys.ArrowRight ? 1 : 0) - (this.keys.KeyA || this.keys.ArrowLeft ? 1 : 0);
    const moving =
      keyF !== 0 || keyS !== 0 || Math.abs(this.debugInput.forward) > 0.01 || Math.abs(this.debugInput.strafe) > 0.01;
    const wantSprint = (this.keys.ShiftLeft || this.keys.ShiftRight) && moving && !this.crouched;
    // 体力闸：耗尽锁定，恢复过阈值再放开
    if (this.stamina <= 0.5) this.staminaLock = true;
    if (this.stamina >= STAMINA_SPRINT_MIN) this.staminaLock = false;
    const sprinting = wantSprint && !this.staminaLock;
    this.gait = this.crouched ? 'crouch' : sprinting ? 'sprint' : 'walk';
    const moveSpeed = this.gait === 'sprint' ? SPRINT_SPEED : this.gait === 'crouch' ? CROUCH_SPEED : MOVE_SPEED;
    if (sprinting) this.stamina = Math.max(0, this.stamina - STAMINA_DRAIN * dt);
    else this.stamina = Math.min(STAMINA_MAX, this.stamina + STAMINA_REGEN * dt);

    // 蹲起视高平滑
    const eyeTarget = this.crouched ? CROUCH_EYE_HEIGHT : EYE_HEIGHT;
    this.eyeSmooth += (eyeTarget - this.eyeSmooth) * Math.min(1, 10 * dt);

    let mx = fwd.x * keyF + right.x * keyS + fwd.x * this.debugInput.forward + right.x * this.debugInput.strafe;
    let mz = fwd.z * keyF + right.z * keyS + fwd.z * this.debugInput.forward + right.z * this.debugInput.strafe;
    const len = Math.hypot(mx, mz);
    const targetX = len > 1e-6 ? (mx / len) * moveSpeed : 0;
    const targetZ = len > 1e-6 ? (mz / len) * moveSpeed : 0;

    const subX0 = this.position.x;
    const subZ0 = this.position.z;
    if (this.collision) {
      this.stepVoxel(dt, targetX, targetZ);
    } else {
      this.stepSimplified(dt, targetX, targetZ);
    }
    this.resolveBarriers();
    // B1 反死锁（格边/凸角咬合）：有移动意图却持续零位移（推离与位移逐子步完全抵消）时，
    // 沿垂直于移动方向做碰撞安全的微滑——即验收报告里玩家「多方向连按 10s 挣脱」的自动化。
    if (
      Math.hypot(targetX, targetZ) > 0.4 &&
      this.grounded &&
      Math.hypot(this.position.x - subX0, this.position.z - subZ0) < 6e-4
    ) {
      this.wedgeSteps++;
      if (this.wedgeSteps >= WEDGE_TRIGGER) {
        this.applyWedgeNudge(targetX, targetZ);
        this.wedgeSteps -= WEDGE_INTERVAL;
      }
    } else {
      this.wedgeSteps = 0;
    }
    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** 物理封路（N6 高台落差口）：玩家胶囊水平推出封路盒外（沿最浅穿入轴），
   *  并清掉指向盒内的速度分量防抖。只作用水平位置——体素墙照旧、实体不受限
   *  （实体是「乱流缝坏的东西」半穿行，见 entity.ts moveTo 注）。 */
  private resolveBarriers() {
    const r = CAPSULE_RADIUS + 0.05;
    for (const b of this.barriers) {
      const px = this.position.x;
      const pz = this.position.z;
      if (px <= b.x0 - r || px >= b.x1 + r || pz <= b.z0 - r || pz >= b.z1 + r) continue;
      const dl = px - (b.x0 - r);
      const dr = b.x1 + r - px;
      const dn = pz - (b.z0 - r);
      const ds = b.z1 + r - pz;
      const m = Math.min(dl, dr, dn, ds);
      if (m === dl) {
        this.position.x = b.x0 - r;
        if (this.velocity.x < 0) this.velocity.x = 0;
      } else if (m === dr) {
        this.position.x = b.x1 + r;
        if (this.velocity.x > 0) this.velocity.x = 0;
      } else if (m === dn) {
        this.position.z = b.z0 - r;
        if (this.velocity.z < 0) this.velocity.z = 0;
      } else {
        this.position.z = b.z1 + r;
        if (this.velocity.z > 0) this.velocity.z = 0;
      }
    }
  }

  /** 体素碰撞路径（官方 ViewerWalkMode 同法：地面弹簧/重力 + 胶囊推离） */
  private groundYFiltered: number | null = null;

  private stepVoxel(dt: number, targetX: number, targetZ: number) {
    let rawGroundY = this.probeGround();
    // 防坠网（E2 起）：N2 清洗后点云残留地面裂缝/孔洞列——probe 会穿透薄板打到深层
    // 杂面或探空直坠。nav 高度场（带内选面，与玩家目视地面一致）离脚底 2.5m 内时
    // 信任 nav：取 probe/nav 较高面为地面——裂缝上方照常行走，真高台跌落（高差
    // >2.5m）不受影响。N1 可走面 probe 与 nav 一致，此分支不改变结果——N1 零变化。
    const navY = this.nav.floorAt(this.position.x, this.position.z);
    const feet = this.position.y - EYE_HEIGHT;
    if (Number.isFinite(navY) && Math.abs(navY - feet) < 2.5) {
      rawGroundY = rawGroundY === null ? navY : Math.max(rawGroundY, navY);
    }
    if (rawGroundY !== null) {
      if (this.groundYFiltered === null) this.groundYFiltered = rawGroundY;
      else this.groundYFiltered += (rawGroundY - this.groundYFiltered) * (1 - Math.exp(-20 * dt));
    } else {
      this.groundYFiltered = null;
    }
    const groundY = this.groundYFiltered ?? rawGroundY;
    // B1 自动踏步：探地射线从脚部向下，看不见「顶面高于脚面」的台阶——这种台阶以前被
    // 胶囊水平推离挡成死墙。resolveCollision 识别出 ≤STEP_UP_MAX 的可站顶面（stepUpY）
    // 时以其为地面目标，弹簧把玩家抬上去；探地中位追平台阶面（站稳）或保持超 1s 即撤除。
    let groundFinal = groundY;
    if (this.stepUpY !== null) {
      groundFinal = groundFinal === null ? this.stepUpY : Math.max(groundFinal, this.stepUpY);
      this.stepUpHold += dt;
      if ((rawGroundY !== null && rawGroundY >= this.stepUpY - 0.05) || this.stepUpHold > 1) {
        this.stepUpY = null;
        this.stepUpHold = 0;
      }
    }

    if (groundFinal !== null) {
      const targetY = groundFinal + HOVER_HEIGHT + this.eyeSmooth;
      const displacement = this.position.y - targetY;
      if (displacement > 0.1) {
        // 高于地面：重力下落
        this.velocity.y -= GRAVITY * dt;
        const nextY = this.position.y + this.velocity.y * dt;
        if (nextY <= targetY) {
          this.position.y = targetY;
          this.velocity.y = 0;
        } else {
          this.position.y = nextY;
        }
        this.grounded = false;
      } else {
        // 贴地弹簧（走坡/台阶平滑）
        const spring = -800 * displacement - 57 * this.velocity.y;
        this.velocity.y += spring * dt;
        this.grounded = true;
      }
    } else {
      this.velocity.y -= GRAVITY * dt;
      this.grounded = false;
    }

    // 水平速度平滑逼近
    const blend = Math.min(1, (this.grounded ? ACCEL_GROUNDED : 6) * dt);
    this.velocity.x += (targetX - this.velocity.x) * blend;
    this.velocity.z += (targetZ - this.velocity.z) * blend;

    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;
    this.resolveCollision();
  }

  /** 简化碰撞路径（无体素数据时兜底） */
  private stepSimplified(dt: number, targetX: number, targetZ: number) {
    this.velocity.x = targetX;
    this.velocity.z = targetZ;
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    const { bboxMin, bboxMax } = this.nav;
    this.position.x = Math.min(Math.max(this.position.x, bboxMin[0] + WALL_MARGIN), bboxMax[0] - WALL_MARGIN);
    this.position.z = Math.min(Math.max(this.position.z, bboxMin[2] + WALL_MARGIN), bboxMax[2] - WALL_MARGIN);
    const floorY = this.nav.floorAt(this.position.x, this.position.z);
    const targetEye = floorY + this.eyeSmooth;
    const dy = targetEye - this.position.y;
    this.position.y += dy * Math.min(1, (dy > 0 ? 6 : 14) * dt);
    this.grounded = true;
  }

  /** 五采样向下 raycast 取中位地面高度（官方 demo 同法） */
  private probeGround(): number | null {
    if (!this.collision) return null;
    const oy = this.position.y - EYE_HEIGHT;
    const r = CAPSULE_RADIUS;
    const samples: Array<[number, number]> = [
      [0, 0],
      [-r, 0],
      [r, 0],
      [0, r],
      [0, -r],
    ];
    const ys: number[] = [];
    for (const [ox, oz] of samples) {
      const hit = this.collision.queryRay(this.position.x + ox, oy, this.position.z + oz, 0, -1, 0, 1.0);
      if (hit) ys.push(hit.y);
    }
    if (ys.length === 0) return null;
    ys.sort((a, b) => a - b);
    const mid = Math.floor(ys.length / 2);
    return ys.length % 2 === 1 ? ys[mid]! : (ys[mid - 1]! + ys[mid]!) * 0.5;
  }

  /** P1 带面参照：当前位置所在格的「带面顶棚」（0.5m 格 + 2m 半径极大滤波；无格/空格退
   *  回 floorAt）。踏步登记与竖直上推共用——家具/摊棚顶高出此面 ≥0.75/0.9m 即视为带外
   *  高面（=墙）。 */
  private localMaxFloor(): number {
    const base = this.nav.floorAt(this.position.x, this.position.z);
    const g = this.bandCeil;
    if (!g) return base;
    const ix = Math.max(0, Math.min(this.bandCeilNx - 1, Math.floor((this.position.x - this.nav.bboxMin[0]) / 0.5)));
    const iz = Math.max(0, Math.min(this.bandCeilNz - 1, Math.floor((this.position.z - this.nav.bboxMin[2]) / 0.5)));
    const v = g[iz * this.bandCeilNx + ix]!;
    return Number.isFinite(v) ? Math.max(base, v) : base;
  }

  /** 构建带面顶棚网格（换夜一次）：可站柱高度按 0.5m 格取最大 → 2m 半径极大滤波 */
  private buildBandCeil(nav: NavField) {
    const cell = 0.5;
    const nx = Math.max(1, Math.ceil((nav.bboxMax[0] - nav.bboxMin[0]) / cell));
    const nz = Math.max(1, Math.ceil((nav.bboxMax[2] - nav.bboxMin[2]) / cell));
    const raw = new Float32Array(nx * nz).fill(-1e9);
    for (const c of nav.columns) {
      const ix = Math.max(0, Math.min(nx - 1, Math.floor((c.x - nav.bboxMin[0]) / cell)));
      const iz = Math.max(0, Math.min(nz - 1, Math.floor((c.z - nav.bboxMin[2]) / cell)));
      const j = iz * nx + ix;
      if (c.y > raw[j]!) raw[j] = c.y;
    }
    const R = 4; // 4 格 × 0.5m = 2m 半径（带内地形起伏的局部范围；N4 主街带面跨 2.8m）
    const out = new Float32Array(nx * nz).fill(-1e9);
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        let m = -1e9;
        const z0 = Math.max(0, iz - R), z1 = Math.min(nz - 1, iz + R);
        const x0 = Math.max(0, ix - R), x1 = Math.min(nx - 1, ix + R);
        for (let zz = z0; zz <= z1; zz++) {
          const row = zz * nx;
          for (let xx = x0; xx <= x1; xx++) {
            const v = raw[row + xx]!;
            if (v > m) m = v;
          }
        }
        out[iz * nx + ix] = m;
      }
    }
    this.bandCeil = out;
    this.bandCeilNx = nx;
    this.bandCeilNz = nz;
  }

  /** 移动胶囊推出实体体素（官方 demo 同法） */
  private resolveCollision() {
    if (!this.collision) return;
    const centerY = this.position.y - EYE_HEIGHT + CAPSULE_HEIGHT * 0.5;
    const half = CAPSULE_HEIGHT * 0.5 - CAPSULE_RADIUS;
    const push: { x: number; y: number; z: number; topY?: number | null } = { x: 0, y: 0, z: 0 };
    if (this.collision.queryCapsule(this.position.x, centerY, this.position.z, half, CAPSULE_RADIUS, push)) {
      // P1 竖直上推带限：贴墙时胶囊底缘与体素咬合，推离的 y 分量会逐子步把玩家「爬」上
      // 任意高墙沿（E14 实测站面被顶到 nav 带外 1-2m，在高面上撞真墙钉死）——推上后的
      // 脚面会超出「带面顶棚+0.9」的（localMaxFloor=2m 半径地形上限，带内上坡/门廊台阶
      // 照常可推上；摊棚/家具顶在带面之上 ≥1m，按墙处理）。
      if (push.y > 1e-4) {
        const maxFeet = this.localMaxFloor() + STEP_UP_BAND_MAX + 0.15;
        if (this.position.y - EYE_HEIGHT + push.y > maxFeet) push.y = 0;
      }
      this.position.x += push.x;
      this.position.y += push.y;
      this.position.z += push.z;
      if (push.y < -1e-4 && this.velocity.y > 0) this.velocity.y = 0;
      if (!this.grounded && push.y > 1e-4 && this.velocity.y < 0) {
        this.velocity.y = 0;
        this.grounded = true;
      }
      // B1：记录水平推离（微滑选边参考）；低矮可站障碍登记为踏步目标——
      // 顶面在脚面之上 ≤STEP_UP_MAX 且上方为空（collision 侧判定）才可踏；
      // P1：再加带面限高（topY ≤ 附近 nav 最高面+0.75，五采样同推上带限）——带外高面=墙，
      // 防沿台阶/矮家具链式爬升出带。
      this.lastPushXZ.x = push.x;
      this.lastPushXZ.z = push.z;
      const topY = push.topY ?? null;
      const feetY = this.position.y - EYE_HEIGHT;
      if (
        topY !== null &&
        topY > feetY - 0.05 &&
        topY - feetY <= STEP_UP_MAX &&
        topY <= this.localMaxFloor() + STEP_UP_BAND_MAX &&
        Math.hypot(this.velocity.x, this.velocity.z) > 0.3
      ) {
        if (this.stepUpY === null || topY > this.stepUpY) this.stepUpY = topY;
        this.stepUpHold = 0;
      }
    }
  }

  /** B1 反死锁微滑：沿垂直于当前移动方向的两侧做阶梯距离探测，取碰撞安全的最远侧滑出。
   *  优先沿最近推离方向的切向侧（沿障碍面滑出的自然方向）；两侧都撞（凹角）则不动——
   *  凹角本来就该挡住。移动前先在目标位置做胶囊碰撞测试，保证永不进墙体素。
   *  P1 两处强化：①方向与门槛改用本帧移动意图（被正面墙顶死时 velocity≈0，旧判定永不
   *  触发——E14 实测 N3 主街 12s+ 零位移零微滑）；②探测距离阶梯化（0.055→0.4m），
   *  缺口在零点几米外的槽位也能一次滑到。 */
  private applyWedgeNudge(intentX: number, intentZ: number) {
    if (!this.collision) return;
    const len = Math.hypot(intentX, intentZ);
    if (len < 0.2) return;
    const dx = intentX / len;
    const dz = intentZ / len;
    const centerY = this.position.y - EYE_HEIGHT + CAPSULE_HEIGHT * 0.5;
    const half = CAPSULE_HEIGHT * 0.5 - CAPSULE_RADIUS;
    // 每侧取「最远的碰撞安全探测距离」（找不到则该侧不可用）。不做单调假设——近距被
    // 转角体素挡住、远距是缺口的情形（N3 门洞卡口）恰要跳过近距取远距；终点已过
    // queryCapsule 验证，永不落进墙体素。
    const reach = (px: number, pz: number): number => {
      let best = 0;
      for (const d of WEDGE_PROBES) {
        if (!this.collision!.queryCapsule(
          this.position.x + px * (d + 0.01),
          centerY,
          this.position.z + pz * (d + 0.01),
          half,
          CAPSULE_RADIUS,
          { x: 0, y: 0, z: 0 },
        )) best = d;
      }
      return best;
    };
    let pick: { x: number; z: number; d: number } | null = null;
    for (const side of [-1, 1]) {
      const px = -dz * side;
      const pz = dx * side;
      const d = reach(px, pz);
      if (d <= 0) continue;
      if (px * this.lastPushXZ.x + pz * this.lastPushXZ.z > 0.01 || pick === null) {
        pick = { x: px, z: pz, d };
        if (px * this.lastPushXZ.x + pz * this.lastPushXZ.z > 0.01) break; // 背离推离侧优先且已得
      }
    }
    if (pick) {
      this.position.x += pick.x * pick.d;
      this.position.z += pick.z * pick.d;
    }
  }

  /** 出生点被卡住时向上抬升直到脱离实体（官方 demo 同法） */
  private resolveSpawnCollision() {
    if (!this.collision) return;
    const half = CAPSULE_HEIGHT * 0.5 - CAPSULE_RADIUS;
    const push = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 100; i++) {
      const center = this.position.y - EYE_HEIGHT + CAPSULE_HEIGHT * 0.5;
      if (!this.collision.queryCapsule(this.position.x, center, this.position.z, half, CAPSULE_RADIUS, push)) break;
      this.position.y += Math.max(push.y, CAPSULE_RADIUS);
    }
  }

  applyCamera(camera: PerspectiveCamera) {
    const cp = Math.cos(this.pitch);
    const fwd = {
      x: Math.cos(this.yaw) * cp,
      y: Math.sin(this.pitch),
      z: Math.sin(this.yaw) * cp,
    };
    camera.position.set(this.position.x, this.position.y, this.position.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(
      new Vector3(this.position.x + fwd.x, this.position.y + fwd.y, this.position.z + fwd.z),
    );
    camera.updateMatrixWorld(true);
  }

  // ---- 调试/自动化接口 ----

  setInput(forward: number, strafe: number) {
    this.debugInput.forward = Math.min(Math.max(forward, -1), 1);
    this.debugInput.strafe = Math.min(Math.max(strafe, -1), 1);
    return { ...this.debugInput };
  }

  /** 自动化：按住/松开跑（等同 Shift） */
  setSprint(v: boolean) {
    this.keys.ShiftLeft = v;
    return v;
  }

  /** 自动化：蹲下开关 */
  setCrouch(v: boolean) {
    this.crouched = v;
    return v;
  }

  setYaw(yaw: number) {
    this.yaw = yaw;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.enabled) return;
    if (this.textMode) return; // 文本框聚焦：键盘归输入框
    this.keys[e.code] = true;
    if (e.code === 'KeyC') this.crouched = !this.crouched;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys[e.code] = false;
  };

  private onMouseDown = (e: MouseEvent) => {
    if (!this.enabled || e.button !== 0) return;
    if (e.target instanceof Node && !this.container.contains(e.target)) return;
    this.container.requestPointerLock?.();
  };

  private onPointerLockChange = () => {
    this.pointerLocked = document.pointerLockElement === this.container;
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.enabled || !this.pointerLocked) return;
    this.yaw -= e.movementX * MOUSE_SENSITIVITY;
    this.pitch -= e.movementY * MOUSE_SENSITIVITY;
    this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
  };

  private clearInput = () => {
    this.keys = {};
    this.debugInput = { forward: 0, strafe: 0 };
  };
}
