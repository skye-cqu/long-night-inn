/**
 * entity.ts — 实体「闻声而动」（一招：循声而来，见影则追）。行为 AI 四态
 * （wander/investigate/linger/chase）跨夜共用，数值按 NightDef.entity 配置。
 *
 * 行为（全部可学习——好玩五律第 2 条）：
 * - 平时在深处游荡；
 * - 噪音事件（奔跑>说话>走路>蹲行，拾取中噪）把它吸引到噪音点（investigate）；
 * - 对玩家有视线（体素 queryRay）且距离 <sightRange（手电开 ×2），或近距离听到高噪
 *   （跑/喊）→ 追击；
 * - 追到 = 玩家丢当日战利品被拖回门口（「笑看死亡」，不判死）；抓住后回深处饱食冷却。
 *
 * 视觉源：Lux3D 实体 GLB（entity-n1.glb / entity-n2.glb，按夜懒加载，归一化 ~2.2m，
 * 包围盒中心对齐原点），叠两个小发光球当红眼 + 跟随点光；加载失败 console.warn
 * 并保留深黑半透明拉长椭球占位。
 */
import { Box3, GLTFLoader, Mesh, MeshPhongMaterial, Object3D, PointLight, Vector3, downloadTexture } from '@manycore/aholo-viewer';
import type { Scene3D } from '@manycore/aholo-viewer';
import type { VoxelCollision } from '../collision';
import type { NavField } from '../nav';
import type { EntityDef } from './config';
import { sphereGeometry } from './shapes';

const { loadGLTF } = GLTFLoader;

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

/** 实体视觉高（米），GLB 与占位椭球都按此归一化 */
const ENTITY_HEIGHT = 2.2;

/** 拉取实体 GLB：归一化到 ENTITY_HEIGHT、包围盒中心对齐原点（root 锚在高度中点） */
async function loadEntityGlb(url: string): Promise<Object3D> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch ${url} HTTP ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const result = await loadGLTF(buffer, { textureLoader: downloadTexture });
  const model = result.scene as unknown as Object3D;
  model.updateMatrixWorld(true);
  const box = new Box3().setFromObject(model as never);
  const h = Math.max(1e-6, box.max.y - box.min.y);
  model.scale.setScalar(ENTITY_HEIGHT / h);
  model.updateMatrixWorld(true);
  const b2 = new Box3().setFromObject(model as never);
  model.position.x -= (b2.min.x + b2.max.x) * 0.5;
  model.position.y -= (b2.min.y + b2.max.y) * 0.5;
  model.position.z -= (b2.min.z + b2.max.z) * 0.5;
  return model;
}

export class Entity {
  readonly root = new Object3D();
  readonly pos = new Vector3();
  state: EntityState = 'wander';
  /** 抓捕冷却（抓住后回深处消化，教学夜的宽限） */
  calmUntil = 0;
  /** 盲追截止时刻（N4 黑暗理智归零惩罚：无视视线/距离直扑玩家） */
  enrageUntil = 0;

  private nav: NavField;
  private collision: VoxelCollision | null;
  private cfg: EntityDef;
  private target = { x: 0, z: 0 };
  private lingerT = 0;
  private noLosT = 0;
  private lastSeen: { x: number; z: number } | null = null;
  /** 视觉容器（脉动缩放作用于此；内含占位椭球或 GLB 模型） */
  private visual = new Object3D();
  private placeholder: Object3D;
  private eyeL: Mesh;
  private eyeR: Mesh;
  private light: PointLight;
  private tAcc = 0;

  constructor(scene: Scene3D, nav: NavField, collision: VoxelCollision | null, cfg: EntityDef) {
    this.nav = nav;
    this.collision = collision;
    this.cfg = cfg;

    // 占位形体：深黑半透明拉长椭球（GLB 就绪前/失败时的视觉兜底）
    const body = new Mesh(
      sphereGeometry(18, 14),
      new MeshPhongMaterial({ color: 0x05070a, transparent: true, opacity: 0.72, shininess: 30 }),
    );
    body.scale.set(0.68, ENTITY_HEIGHT / 1.0, 0.68);
    this.placeholder = new Object3D();
    this.placeholder.add(body as never);
    this.visual.add(this.placeholder as never);
    this.root.add(this.visual as never);

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

    this.pos.set(cfg.start.x, nav.floorAt(cfg.start.x, cfg.start.z) + ENTITY_HEIGHT * 0.5, cfg.start.z);
    this.pickWanderTarget();
  }

  /** 换夜：更新参数/导航/碰撞并异步换 GLB 视觉（行为四态逻辑不动）。
   *  强化夜（N3 起）：cfg.darken 材质叠加压暗、cfg.eyeBoost 红眼增亮（视觉演出，行为只看数值配置） */
  applyNight(nav: NavField, collision: VoxelCollision | null, cfg: EntityDef, scene: Scene3D) {
    this.nav = nav;
    this.collision = collision;
    this.cfg = cfg;
    this.state = 'wander';
    this.teleport(cfg.start.x, cfg.start.z);
    this.pickWanderTarget();
    loadEntityGlb(cfg.glb)
      .then((model) => {
        const darken = Math.min(0.8, Math.max(0, cfg.darken ?? 0));
        if (darken > 0) {
          const k = 1 - darken; // 材质叠加：颜色乘暗（不改几何/灯光；GLB 失败回退占位不压）
          model.traverse((n) => {
            const m = n as { isMesh?: boolean; material?: { color?: { multiplyScalar(v: number): void } } | Array<{ color?: { multiplyScalar(v: number): void } }> };
            if (!m.isMesh || !m.material) return;
            const mats = Array.isArray(m.material) ? m.material : [m.material];
            for (const mat of mats) mat.color?.multiplyScalar(k);
          });
        }
        this.visual.remove(this.placeholder as never);
        this.visual.add(model as never);
        scene.notifySceneChange?.();
      })
      .catch((e: unknown) => console.warn(`[实体] ${cfg.name} GLB 加载失败，保留占位:`, e));
  }

  /** 世界就绪后重挂导航/碰撞：setNight 时 world.nav 可能还是上一夜的（按夜懒加载未完成），
   *  实体会被旧 bbox 钳制、y 用旧地面场；beginDive 守卫（world=本夜）通过后调用本方法再 teleport。 */
  retarget(nav: NavField, collision: VoxelCollision | null) {
    this.nav = nav;
    this.collision = collision;
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

  /** 盲追（N4 黑暗理智归零惩罚）：seconds 秒内无视视线/距离/饱食冷却直扑玩家。
   *  「永久侦测」的实现=强制 chase 且不丢目标；追到/超时后回归常态行为。 */
  enrage(seconds: number, now: number) {
    this.enrageUntil = now + seconds;
    this.calmUntil = 0;
    this.noLosT = 0;
    if (this.state !== 'chase') this.state = 'chase';
  }

  /** 第二招「见光追」（N5 匮乏夜，cfg.sightTrick）：手电开启瞬间实体直接获得玩家位置，
   *  无视视线/距离盲追 sightTrickSeconds 秒（复用 enrage 通道——红眼点光同步抬档，
   *  演出=「它顺着你的光柱摸过来了」）。手电关闭不影响已开启的窗口。
   *  返回是否触发（调试/伙计台词用；非 sightTrick 夜恒 false，N1–N4 零变化）。 */
  flashlightPing(now: number): boolean {
    if (!this.cfg.sightTrick) return false;
    if (now < this.enrageUntil) return false; // 窗口已在追：不重置计时
    this.enrage(this.cfg.sightTrickSeconds ?? 6, now);
    return true;
  }

  teleport(x: number, z: number) {
    this.pos.set(x, this.nav.floorAt(x, z) + ENTITY_HEIGHT * 0.5, z);
  }

  get debug() {
    return {
      name: this.cfg.name,
      state: this.state,
      pos: { x: +this.pos.x.toFixed(2), y: +this.pos.y.toFixed(2), z: +this.pos.z.toFixed(2) },
      target: { x: +this.target.x.toFixed(2), z: +this.target.z.toFixed(2) },
      moved: +this.movedAcc.toFixed(3),
      tAcc: +this.tAcc.toFixed(1),
      calmUntil: +this.calmUntil.toFixed(1),
      enrageLeft: +Math.max(0, this.enrageUntil - this.tAcc).toFixed(1),
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
    const enraged = now < this.enrageUntil; // N4 黑暗理智归零：永久侦测窗口

    // 追击条件：视线 + 距离（手电 ×侦测倍率）；盲追窗口无视视线/距离
    const sight = this.cfg.sightRange * (flashlightOn ? this.cfg.flashlightRangeMul : 1);
    if (now >= this.calmUntil) {
      if (enraged && this.state !== 'chase') {
        this.state = 'chase';
        this.noLosT = 0;
      } else if (hasLOS && dist < sight && this.state !== 'chase') {
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
          this.state = enraged ? 'chase' : 'wander';
          if (!enraged) this.pickWanderTarget();
        }
        break;
      }
      case 'chase': {
        speed = this.cfg.chaseSpeed;
        this.moveTo(playerPos.x, playerPos.z, dt, speed);
        if (hasLOS || enraged) {
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
          this.calmUntil = now + 7; // 抓住后回深处消化 7s（盲追窗口被抓则惩罚已兑现，不续）
          this.enrageUntil = 0;
        }
        break;
      }
    }

    // 贴地 + 视觉脉动（追击时更亮更快；强化夜红眼更亮更大+点光更凶）
    this.pos.y = this.nav.floorAt(this.pos.x, this.pos.z) + ENTITY_HEIGHT * 0.5;
    const chasing = this.state === 'chase';
    const eyeBoost = this.cfg.eyeBoost ?? 1;
    const pulse = chasing ? 0.12 : 0.05;
    const s = 1 + Math.sin(now * (chasing ? 9 : 3)) * pulse;
    this.visual.scale.set(s, chasing ? 1.05 : s, s);
    // 盲追窗口（N4 理智归零）：红眼与点光再抬一档（演出，行为数值在 cfg）
    this.light.intensity = (chasing ? 1.8 : 0.9) * (1 + (eyeBoost - 1) * 0.6) * (now < this.enrageUntil ? 1.35 : 1);
    const eyeScale = (chasing ? 1.5 : 1) * eyeBoost;
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
