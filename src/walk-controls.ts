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

export type Gait = 'walk' | 'sprint' | 'crouch';

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
  private container: HTMLElement;
  private enabled = false;
  /** 文本输入模式（伙计说话框聚焦时）：吞掉移动键，不 preventDefault */
  private textMode = false;
  private eyeSmooth = EYE_HEIGHT;
  private staminaLock = false;

  constructor(container: HTMLElement, nav: NavField, collision: VoxelCollision | null) {
    this.container = container;
    this.nav = nav;
    this.collision = collision;

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

    if (this.collision) {
      this.stepVoxel(dt, targetX, targetZ);
    } else {
      this.stepSimplified(dt, targetX, targetZ);
    }
    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** 体素碰撞路径（官方 ViewerWalkMode 同法：地面弹簧/重力 + 胶囊推离） */
  private groundYFiltered: number | null = null;

  private stepVoxel(dt: number, targetX: number, targetZ: number) {
    const rawGroundY = this.probeGround();
    if (rawGroundY !== null) {
      if (this.groundYFiltered === null) this.groundYFiltered = rawGroundY;
      else this.groundYFiltered += (rawGroundY - this.groundYFiltered) * (1 - Math.exp(-20 * dt));
    } else {
      this.groundYFiltered = null;
    }
    const groundY = this.groundYFiltered ?? rawGroundY;

    if (groundY !== null) {
      const targetY = groundY + HOVER_HEIGHT + this.eyeSmooth;
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

  /** 移动胶囊推出实体体素（官方 demo 同法） */
  private resolveCollision() {
    if (!this.collision) return;
    const centerY = this.position.y - EYE_HEIGHT + CAPSULE_HEIGHT * 0.5;
    const half = CAPSULE_HEIGHT * 0.5 - CAPSULE_RADIUS;
    const push = { x: 0, y: 0, z: 0 };
    if (this.collision.queryCapsule(this.position.x, centerY, this.position.z, half, CAPSULE_RADIUS, push)) {
      this.position.x += push.x;
      this.position.y += push.y;
      this.position.z += push.z;
      if (push.y < -1e-4 && this.velocity.y > 0) this.velocity.y = 0;
      if (!this.grounded && push.y > 1e-4 && this.velocity.y < 0) {
        this.velocity.y = 0;
        this.grounded = true;
      }
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
