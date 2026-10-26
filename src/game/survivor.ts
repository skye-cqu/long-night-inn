/**
 * survivor.ts — 幸存者遭遇槽（设计 §3 槽位 4，N2 起启用）。
 *
 * 途中遇到的人：等待（原地 idle，玩家靠近时转身面向）→ 跟随（E 选「救」后，
 * 复用伙计跟随思路：走 Walk 停 Idle，落后玩家 ~3m，距离 >8m 传送补位）→
 * 结局（saved/lost/robbed/ignored，由玩法层 game.ts 写入账本并结算）。
 *
 * 视觉源：Lux3D 幸存者 GLB（survivor.glb，Walk_Loop + Idle_Loop 双动画），
 * 加载 wiring 与伙计同源（官方 walk-demo 的 AnimationPlugin + Skeleton + bindSkinned）；
 * 失败 console.warn 并保留深灰人形椭球占位。
 */
import {
  Animation,
  Box3,
  GLTFLoader,
  Mesh,
  MeshPhongMaterial,
  Object3D,
  PointLight,
  Vector3,
  downloadTexture,
} from '@manycore/aholo-viewer';
import type { Scene3D, Viewer } from '@manycore/aholo-viewer';
import type { NavField } from '../nav';
import { sphereGeometry } from './shapes';

const AnimationPlugin = Animation.AnimationPlugin;
const AnimationMixer = Animation.AnimationMixer;
const Skeleton = Animation.Skeleton;
const { loadGLTF } = GLTFLoader;
type AnimationClip = Animation.AnimationClip;
type AnimationAction = Animation.AnimationAction;

/** 旅人身高（米）——普通人身形（伙计 1.15 / 实体 2.2） */
const SURVIVOR_HEIGHT = 1.7;
const FOLLOW_BACK = 3.0; // 落后玩家距离
const TELEPORT_DIST = 8; // 超过此距离传送补位
const YAW_SMOOTH = 8;
const ANIM_CROSSFADE = 5;
const WALK_ENTER_SPEED = 0.18;
const IDLE_ENTER_SPEED = 0.06;
const WALK_ANIM_REF_SPEED = 1.4;

export type SurvivorState = 'waiting' | 'following' | 'saved' | 'lost' | 'robbed' | 'ignored';

export class Survivor {
  readonly root = new Object3D();
  readonly pos = new Vector3();
  state: SurvivorState = 'waiting';
  /** 本局是否已触发过「靠近低语」（只低语一次） */
  announced = false;

  private mixer: InstanceType<typeof AnimationMixer> | null = null;
  private actions: { Idle?: AnimationAction; Walk?: AnimationAction } = {};
  private current = 'Idle';
  private loaded = false;
  private placeholder: Object3D;
  private nav: NavField;
  private yaw = 0;
  private smoothedSpeed = 0;
  private lastPos = new Vector3();
  animName = 'loading';

  constructor(scene: Scene3D, nav: NavField, x: number, z: number) {
    this.nav = nav;
    this.root.visible = false;

    // 占位人形：深灰瘦长椭球（GLB 就绪前/失败时的视觉兜底）
    const body = new Mesh(
      sphereGeometry(16, 12),
      new MeshPhongMaterial({ color: 0x2a2d33, shininess: 18 }),
    );
    body.scale.set(0.34, SURVIVOR_HEIGHT / 1.0, 0.34);
    this.placeholder = new Object3D();
    this.placeholder.add(body as never);
    this.root.add(this.placeholder as never);

    // 随身灯笼（雾夜里的「一点暖光」——玩家靠它认出活人，也是低语雷达的可视锚）
    const lamp = new PointLight(0xffd9a0, 1.5, 5.5, 1.4);
    lamp.position.y = 1.0;
    this.root.add(lamp as never);

    this.pos.set(x, nav.floorAt(x, z), z);
    this.lastPos.copy(this.pos);
    scene.add(this.root as never);
    scene.notifySceneChange?.();
  }

  /** 加载 Lux3D 旅人 GLB（与伙计同源的动画 wiring；成功后替换占位） */
  async load(url: string, viewer: Viewer, scene: Scene3D) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${url} HTTP ${resp.status}`);
    const buffer = await resp.arrayBuffer();
    const result = await loadGLTF(buffer, { textureLoader: downloadTexture });

    const animationPlugin = new AnimationPlugin();
    animationPlugin.registerToViewer({ viewer } as never);
    const model = result.scene as unknown as Object3D;
    this.mixer = new AnimationMixer(model as never);
    animationPlugin.add(this.mixer as never);

    const bound = new WeakSet<object>();
    (result.skeletons as Map<unknown, unknown[]>).forEach((skinnedMeshes: unknown[], iSkeleton: unknown) => {
      const sk = iSkeleton as { bones: unknown; inverseBindMatrices: unknown };
      const skeleton = new Skeleton(sk.bones as never, sk.inverseBindMatrices as never);
      for (const sm of skinnedMeshes as object[]) {
        if (bound.has(sm)) continue;
        bound.add(sm);
        animationPlugin.bindSkinned(sm as never, skeleton as never, this.mixer as never);
      }
    });

    this.normalize(model);
    this.root.remove(this.placeholder as never);
    this.root.add(model);
    this.setupActions((result.animations || []) as AnimationClip[]);
    scene.notifySceneChange?.();
    this.loaded = true;
    this.animName = 'Idle';
  }

  /** 展示在槽位（下潜开始时调用；GLB 若未就绪，占位人形先顶上） */
  place(x: number, z: number) {
    this.pos.set(x, this.nav.floorAt(x, z), z);
    this.lastPos.copy(this.pos);
    this.yaw = 0;
    this.smoothedSpeed = 0;
    this.root.visible = true;
    this.root.position.copy(this.pos);
    this.root.updateMatrixWorld(true);
  }

  get isPresent() {
    return this.state === 'waiting' || this.state === 'following';
  }

  /** 每帧：等待=面向玩家（近处）；跟随=落后 3m 行走，>8m 传送；动画按速度切换 */
  update(dt: number, playerPos: Vector3, playerYaw: number) {
    if (!this.loaded || !this.root.visible) return;
    if (this.state === 'waiting') {
      const dx = playerPos.x - this.pos.x;
      const dz = playerPos.z - this.pos.z;
      if (Math.hypot(dx, dz) < 6) {
        // 面向玩家（转身的「人」——区别于实体的扫视）
        this.yaw += Math.atan2(Math.sin(Math.atan2(dx, dz) - this.yaw), Math.cos(Math.atan2(dx, dz) - this.yaw)) * Math.min(1, YAW_SMOOTH * dt);
      }
    } else if (this.state === 'following') {
      const fwd = { x: Math.cos(playerYaw), z: Math.sin(playerYaw) };
      const tx = playerPos.x - fwd.x * FOLLOW_BACK;
      const tz = playerPos.z - fwd.z * FOLLOW_BACK;
      const d = Math.hypot(tx - this.pos.x, tz - this.pos.z);
      if (d > TELEPORT_DIST) {
        // 掉队太远：雾里追上来（传送补位）
        this.pos.set(tx, this.nav.floorAt(tx, tz), tz);
        this.smoothedSpeed = 0;
      } else if (d > 0.4) {
        const step = Math.min(2.7 * dt, d);
        this.pos.x += ((tx - this.pos.x) / d) * step;
        this.pos.z += ((tz - this.pos.z) / d) * step;
      }
      // 走廊包围盒钳制（与伙计同法）
      const M = 0.3;
      this.pos.x = Math.min(Math.max(this.pos.x, this.nav.bboxMin[0] + M), this.nav.bboxMax[0] - M);
      this.pos.z = Math.min(Math.max(this.pos.z, this.nav.bboxMin[2] + M), this.nav.bboxMax[2] - M);
      this.pos.y = this.nav.floorAt(this.pos.x, this.pos.z);
    }

    // 速度估算 → 动画切换（Walk/Idle）与朝向
    const mdx = this.pos.x - this.lastPos.x;
    const mdz = this.pos.z - this.lastPos.z;
    const instSpeed = dt > 1e-5 ? Math.hypot(mdx, mdz) / dt : 0;
    this.smoothedSpeed += (instSpeed - this.smoothedSpeed) * Math.min(1, 8 * dt);
    if (this.state === 'following') {
      const moved = Math.hypot(mdx, mdz);
      if (this.smoothedSpeed > WALK_ENTER_SPEED * 0.8 && moved > 1e-4) {
        const target = Math.atan2(mdx, mdz);
        this.yaw += Math.atan2(Math.sin(target - this.yaw), Math.cos(target - this.yaw)) * Math.min(1, YAW_SMOOTH * dt);
      }
    }
    this.lastPos.copy(this.pos);

    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
    this.root.updateMatrixWorld(true);
    this.updateAnimation(dt);
  }

  get debug() {
    return {
      state: this.state,
      pos: { x: +this.pos.x.toFixed(2), z: +this.pos.z.toFixed(2) },
      anim: this.animName,
      loaded: this.loaded,
      announced: this.announced,
    };
  }

  private updateAnimation(dt: number) {
    if (this.smoothedSpeed > WALK_ENTER_SPEED) this.current = 'Walk';
    else if (this.smoothedSpeed < IDLE_ENTER_SPEED) this.current = 'Idle';
    this.animName = this.current;
    const walk = this.actions.Walk;
    const idle = this.actions.Idle;
    if (!walk || !idle) return;
    const wantWalk = this.current === 'Walk' ? 1 : 0;
    const k = Math.min(1, ANIM_CROSSFADE * dt);
    walk.weight += (wantWalk - walk.weight) * k;
    idle.weight += (1 - wantWalk - idle.weight) * k;
    walk.active = walk.weight > 0.001;
    idle.active = idle.weight > 0.001;
    if (walk.active) {
      walk.speed = Math.min(1.4, Math.max(0.5, this.smoothedSpeed / WALK_ANIM_REF_SPEED));
    }
  }

  /** 按包围盒归一化身高并把脚底对到原点（伙计同法） */
  private normalize(model: Object3D) {
    model.updateMatrixWorld(true);
    model.traverse((n) => {
      const sm = n as unknown as { isSkinnedMesh?: boolean; update?: () => void };
      if (sm.isSkinnedMesh && typeof sm.update === 'function') sm.update();
    });
    const box = new Box3().setFromObject(model as never);
    const h = Math.max(1e-6, box.max.y - box.min.y);
    model.scale.setScalar(SURVIVOR_HEIGHT / h);
    model.updateMatrixWorld(true);
    const scaled = new Box3().setFromObject(model as never);
    model.position.x -= (scaled.min.x + scaled.max.x) * 0.5;
    model.position.y -= scaled.min.y;
    model.position.z -= (scaled.min.z + scaled.max.z) * 0.5;
  }

  private setupActions(clips: AnimationClip[]) {
    const find = (re: RegExp) => clips.find((c) => re.test(c.name)) || null;
    const idleClip = find(/idle/i);
    const walkClip = find(/walk/i);
    if (!this.mixer) return;
    if (idleClip) {
      const a = this.mixer.clipAction(idleClip as never);
      a.active = true;
      a.weight = 1;
      this.actions.Idle = a as AnimationAction;
    }
    if (walkClip) {
      const a = this.mixer.clipAction(walkClip as never);
      a.active = false;
      a.weight = 0;
      this.actions.Walk = a as AnimationAction;
    }
  }
}
