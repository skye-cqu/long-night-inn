/**
 * entity.ts — N1 实体「闻声而动」（一招：循声而来，见影则追）。
 *
 * 行为（全部可学习——好玩五律第 2 条）：
 * - 平时在走廊深处游荡；
 * - 噪音事件（奔跑>说话>走路>蹲行，拾取中噪）把它吸引到噪音点（investigate）；
 * - 对玩家有视线（体素 queryRay）且距离 <8m（手电开 ×2），或近距离听到高噪（跑/喊）→ 追击；
 * - 追击速度 3.1m/s：快于走(2.2)、慢于跑(4.2)——想活命得跑，想跑得远省体力；
 * - 抓到 = 玩家丢当日战利品被拖回门口（「笑看死亡」，不判死）；抓住后实体回深处饱食冷却。
 *
 * 视觉占位：深黑半透明拉长胶囊（拉长椭球）+ 双红眼 + 跟随点光。
 * // TODO(Lux3D 实体)：text-to-3D 产出「缝坏的账物」形体（行为种子决定形态）后替换。
 */
import { Mesh, MeshPhongMaterial, Object3D, PointLight, Vector3 } from '@manycore/aholo-viewer';
import type { Scene3D } from '@manycore/aholo-viewer';
import type { VoxelCollision } from '../collision';
import type { NavField } from '../nav';
import type { N1Config } from './config';
import { sphereGeometry } from './shapes';

export type EntityState = 'wander' | 'investigate' | 'chase' | 'linger';

export interface NoiseEvent {
  x: number;
  z: number;
  /** 0..1：蹲 0.08 / 走 0.35 / 拾取 0.55 / 跑与喊 1.0 */
  level: number;
}

export interface EntityTick {
  caught: boolean;
  dist: number;
  hasLOS: boolean;
  state: EntityState;
}

const ENTITY_HEIGHT = 2.2; // 拉长胶囊视觉高

export class Entity {
  readonly root = new Object3D();
  readonly pos = new Vector3();
  state: EntityState = 'wander';
  /** 抓捕冷却（抓住后回深处消化，教学夜的宽限） */
  calmUntil = 0;

  private nav: NavField;
  private collision: VoxelCollision | null;
  private cfg: N1Config['entity'];
  private target = { x: 0, z: 0 };
  private lingerT = 0;
  private noLosT = 0;
  private lastSeen: { x: number; z: number } | null = null;
  private body: Mesh;
  private eyeL: Mesh;
  private eyeR: Mesh;
  private light: PointLight;
  private tAcc = 0;

  constructor(scene: Scene3D, nav: NavField, collision: VoxelCollision | null, cfg: N1Config['entity'], start: { x: number; z: number }) {
    this.nav = nav;
    this.collision = collision;
    this.cfg = cfg;

    // TODO(Lux3D 实体)：占位形体——深黑半透明拉长椭球
    this.body = new Mesh(
      sphereGeometry(18, 14),
      new MeshPhongMaterial({ color: 0x05070a, transparent: true, opacity: 0.72, shininess: 30 }),
    );
    this.body.scale.set(0.68, ENTITY_HEIGHT / 1.0, 0.68);
    this.root.add(this.body as never);

    const eyeMat = new MeshPhongMaterial({ color: 0xff2a1a, shininess: 120 });
    this.eyeL = new Mesh(sphereGeometry(8, 6), eyeMat);
    this.eyeR = new Mesh(sphereGeometry(8, 6), eyeMat);
    this.eyeL.position.set(-0.11, 0.72, 0.3);
    this.eyeR.position.set(0.11, 0.72, 0.3);
    this.root.add(this.eyeL as never);
    this.root.add(this.eyeR as never);

    this.light = new PointLight(0xff3322, 0.9, 6, 1.6);
    this.light.position.y = 0.6;
    this.root.add(this.light as never);

    scene.add(this.root as never);
    scene.notifySceneChange?.();

    this.pos.set(start.x, nav.floorAt(start.x, start.z) + ENTITY_HEIGHT * 0.5, start.z);
    this.pickWanderTarget();
  }

  /** 噪音入口：听到 → 去看；高噪近距离 → 直接追 */
  hear(noise: NoiseEvent) {
    const d = Math.hypot(noise.x - this.pos.x, noise.z - this.pos.z);
    const radius = noise.level * this.cfg.noiseRadiusMax;
    if (d > radius) return;
    const now = this.tAcc;
    if (now < this.calmUntil) return; // 饱食冷却
    if (noise.level >= this.cfg.chaseNoiseLevel && d < radius * 0.7) {
      this.state = 'chase';
      this.noLosT = 0;
    } else if (this.state !== 'chase') {
      this.state = 'investigate';
      this.target = { x: noise.x, z: noise.z };
    }
  }

  /** 调试：强制状态/传送 */
  forceState(s: EntityState) {
    this.state = s;
    this.calmUntil = 0;
  }

  teleport(x: number, z: number) {
    this.pos.set(x, this.nav.floorAt(x, z) + ENTITY_HEIGHT * 0.5, z);
  }

  get debug() {
    return {
      state: this.state,
      pos: { x: +this.pos.x.toFixed(2), y: +this.pos.y.toFixed(2), z: +this.pos.z.toFixed(2) },
      target: { x: +this.target.x.toFixed(2), z: +this.target.z.toFixed(2) },
      moved: +this.movedAcc.toFixed(3),
      tAcc: +this.tAcc.toFixed(1),
      calmUntil: +this.calmUntil.toFixed(1),
    };
  }

  /** 调试：累计位移（卡死检测用） */
  movedAcc = 0;

  update(dt: number, now: number, playerPos: Vector3, flashlightOn: boolean): EntityTick {
    this.tAcc = now;
    const dx = playerPos.x - this.pos.x;
    const dz = playerPos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    const hasLOS = this.checkLOS(playerPos);

    // 追击条件：视线 + 距离（手电 ×2 侦测范围）
    const sight = this.cfg.sightRange * (flashlightOn ? this.cfg.flashlightRangeMul : 1);
    if (now >= this.calmUntil) {
      if (hasLOS && dist < sight && this.state !== 'chase') {
        this.state = 'chase';
        this.noLosT = 0;
      }
    }

    let speed = 0;
    let caught = false;

    switch (this.state) {
      case 'wander': {
        speed = this.cfg.wanderSpeed;
        if (this.moveTo(this.target.x, this.target.z, dt, speed)) this.pickWanderTarget();
        break;
      }
      case 'investigate': {
        speed = this.cfg.investigateSpeed;
        if (this.moveTo(this.target.x, this.target.z, dt, speed)) {
          this.state = 'linger';
          this.lingerT = 2.5;
        }
        break;
      }
      case 'linger': {
        this.lingerT -= dt;
        this.root.rotation.y += dt * 2.4; // 原地扫视
        if (this.lingerT <= 0) {
          this.state = 'wander';
          this.pickWanderTarget();
        }
        break;
      }
      case 'chase': {
        speed = this.cfg.chaseSpeed;
        this.moveTo(playerPos.x, playerPos.z, dt, speed);
        if (hasLOS) {
          this.noLosT = 0;
          this.lastSeen = { x: playerPos.x, z: playerPos.z };
        } else {
          this.noLosT += dt;
          if (this.noLosT > this.cfg.loseSightSeconds && dist > 10) {
            this.state = 'investigate';
            this.target = this.lastSeen ?? { x: this.pos.x, z: this.pos.z };
          }
        }
        if (dist < this.cfg.catchRadius) {
          caught = true;
          this.state = 'wander';
          this.pickWanderTarget();
          this.calmUntil = now + 7; // 抓住后回深处消化 7s
        }
        break;
      }
    }

    // 贴地 + 视觉脉动（追击时更亮更快）
    this.pos.y = this.nav.floorAt(this.pos.x, this.pos.z) + ENTITY_HEIGHT * 0.5;
    const chasing = this.state === 'chase';
    const pulse = chasing ? 0.12 : 0.05;
    const s = 1 + Math.sin(now * (chasing ? 9 : 3)) * pulse;
    this.body.scale.set(0.68 * s, (ENTITY_HEIGHT / 1.0) * (chasing ? 1.05 : s), 0.68 * s);
    this.light.intensity = chasing ? 1.8 : 0.9;
    const eyeScale = chasing ? 1.5 : 1;
    this.eyeL.scale.setScalar(eyeScale);
    this.eyeR.scale.setScalar(eyeScale);

    this.root.position.copy(this.pos);
    this.root.updateMatrixWorld(true);

    return { caught, dist, hasLOS, state: this.state };
  }

  // ---- 内部 ----

  private checkLOS(playerPos: Vector3): boolean {
    if (!this.collision) return true; // 无体素数据的兜底世界：视为开阔
    const ox = this.pos.x;
    const oy = this.pos.y + 0.5;
    const oz = this.pos.z;
    const dx = playerPos.x - ox;
    const dy = playerPos.y - oy;
    const dz = playerPos.z - oz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return true;
    const hit = this.collision.queryRay(ox, oy, oz, dx / len, dy / len, dz / len, len);
    // 命中点比玩家近 → 被墙挡住
    return !(hit && Math.hypot(hit.x - ox, hit.y - oy, hit.z - oz) < len - 0.25);
  }

  /**
   * 朝目标移动；返回是否到达。
   * 注意（2026-10-26 实测坑）：不用体素胶囊推离——实体胶囊半径 0.34 比玩家 0.12 粗，
   * 会被走廊收窄段的几何卡死（推力逐帧抵消移动，追击速度剩 ~10%）。实体是「乱流缝坏的
   * 东西」，半穿行反而符合皮设；用走廊包围盒钳制 + 地面高度场兜底。视线检测仍走体素
   * queryRay（那才是玩家可用的躲藏手段）。
   */
  private moveTo(tx: number, tz: number, dt: number, speed: number): boolean {
    const px = this.pos.x;
    const pz = this.pos.z;
    const dx = tx - this.pos.x;
    const dz = tz - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.35) return true;
    const step = Math.min(speed * dt, d);
    this.pos.x += (dx / d) * step;
    this.pos.z += (dz / d) * step;
    // 朝移动方向（+Z 前向约定，与伙计一致）
    this.root.rotation.y = Math.atan2(dx, dz);
    // 走廊包围盒钳制
    const M = 0.5;
    this.pos.x = Math.min(Math.max(this.pos.x, this.nav.bboxMin[0] + M), this.nav.bboxMax[0] - M);
    this.pos.z = Math.min(Math.max(this.pos.z, this.nav.bboxMin[2] + M), this.nav.bboxMax[2] - M);
    this.movedAcc += Math.hypot(this.pos.x - px, this.pos.z - pz);
    return false;
  }

  private pickWanderTarget() {
    const { wanderMin, wanderMax } = this.cfg;
    this.target = {
      x: wanderMin.x + Math.random() * (wanderMax.x - wanderMin.x),
      z: wanderMin.z + Math.random() * (wanderMax.z - wanderMin.z),
    };
  }
}
