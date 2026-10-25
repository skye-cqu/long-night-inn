/**
 * companion.ts — 随行伙伴「伙计」：合并版 huoji.glb（Walk_Loop + Idle_Loop，见
 * scripts/merge-glb-animations.mjs），lerp 跟随在玩家身后偏右，移动播行走、静止播待机。
 *
 * GLTF 加载 / 蒙皮绑定 / 动画混合的 wiring 移植自官方 walk-demo 的
 * WalkThirdPersonCharacter（MIT，衍生自 SuperSplat Viewer）：
 * loadGLTF(buffer, { textureLoader: downloadTexture }) + AnimationPlugin +
 * Skeleton + bindSkinned；mixer 由 AnimationPlugin 随 viewer.render() 自动推进。
 * 世界 up 为 +Y（见 main.ts 头注），与 GLB 的 glTF 惯例一致，无需翻转。
 *
 * 注意（2026-10-26 验证教训）：跟随逻辑让伙伴始终位于玩家朝向的背后，
 * 「转身找他」会让他绕到新的背后——调试/取证时用 __game.setFollowEnabled(false)
 * 冻结跟随再转身。
 */
import {
  AmbientLight,
  Animation,
  Box3,
  DirectionalLight,
  GLTFLoader,
  Object3D,
  Vector3,
  downloadTexture,
} from '@manycore/aholo-viewer';
import type { Scene3D, Viewer } from '@manycore/aholo-viewer';
import type { NavField } from './nav';

const AnimationPlugin = Animation.AnimationPlugin;
const AnimationMixer = Animation.AnimationMixer;
const Skeleton = Animation.Skeleton;
const { loadGLTF } = GLTFLoader;
type AnimationClip = Animation.AnimationClip;
type AnimationAction = Animation.AnimationAction;

/** 伙计目标身高（米），按包围盒归一化 */
const COMPANION_HEIGHT = 1.15;
/** 跟随锚点：玩家身后 / 偏右（米） */
const FOLLOW_BACK = 1.15;
const FOLLOW_RIGHT = 0.85;
const FOLLOW_LERP = 4.2; // 位置平滑（1/s）
const YAW_SMOOTH = 9; // 朝向平滑（1/s）
const ANIM_CROSSFADE = 5; // 动画权重平滑（1/s）
const WALK_ENTER_SPEED = 0.18;
const IDLE_ENTER_SPEED = 0.06;
/** 行走动画 1x 速度对应的移动速度参考值（m/s） */
const WALK_ANIM_REF_SPEED = 1.4;

/** 模型朝向微调（弧度）：模型局部前向按 glTF/Mixamo 惯例取 +Z；若倒着走用
 * __game.tuneCompanion(Math.PI) 翻转并回填 */
let modelYawAdjust = 0;

export class Companion {
  readonly root = new Object3D();
  private readonly lights = new Object3D();
  private mixer: InstanceType<typeof AnimationMixer> | null = null;
  private actions: { Idle?: AnimationAction; Walk?: AnimationAction } = {};
  private current = 'Idle';
  private loaded = false;
  followEnabled = true;

  readonly position = new Vector3();
  private yaw = 0;
  private smoothedSpeed = 0;
  private lastPos = new Vector3();
  animName = 'loading';

  private nav: NavField;
  modelHeight = 0;

  constructor(nav: NavField) {
    this.nav = nav;
    this.root.visible = false;
    const ambient = new AmbientLight(0xffffff, 0.85);
    const key = new DirectionalLight(0xffffff, 1.2);
    key.position.set(0.4, 1.0, 0.35);
    const fill = new DirectionalLight(0xbfd4ff, 0.5);
    fill.position.set(-0.7, 0.6, -0.4);
    this.lights.add(ambient as never);
    this.lights.add(key as never);
    this.lights.add(fill as never);
  }

  async load(url: string, viewer: Viewer, scene: Scene3D) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch huoji.glb HTTP ${resp.status}`);
    const buffer = await resp.arrayBuffer();
    const result = await loadGLTF(buffer, { textureLoader: downloadTexture });

    const animationPlugin = new AnimationPlugin();
    animationPlugin.registerToViewer({ viewer } as never);
    const model = result.scene as unknown as Object3D;
    this.mixer = new AnimationMixer(model as never);
    animationPlugin.add(this.mixer as never);

    // 蒙皮绑定（与官方 demo 相同的 wiring）
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
    this.root.removeAllChildren();
    this.root.add(model);
    this.setupActions((result.animations || []) as AnimationClip[]);

    scene.add(this.lights as never);
    scene.add(this.root as never);
    scene.notifySceneChange?.();
    this.loaded = true;
    this.root.visible = true;
    this.animName = 'Idle';
  }

  /** 每帧：跟随目标点、朝向、地面钳制、动画切换 */
  update(playerPos: Vector3, playerYaw: number, dt: number) {
    if (!this.loaded) return;
    if (this.followEnabled) {
      const fwd = { x: Math.cos(playerYaw), z: Math.sin(playerYaw) };
      const right = { x: -fwd.z, z: fwd.x };
      const tx = playerPos.x - fwd.x * FOLLOW_BACK + right.x * FOLLOW_RIGHT;
      const tz = playerPos.z - fwd.z * FOLLOW_BACK + right.z * FOLLOW_RIGHT;
      const a = 1 - Math.exp(-FOLLOW_LERP * dt);
      this.position.x += (tx - this.position.x) * a;
      this.position.z += (tz - this.position.z) * a;
      // 与玩家相同的走廊包围盒钳制，避免跟随目标点穿出走廊
      const M = 0.3;
      this.position.x = Math.min(Math.max(this.position.x, this.nav.bboxMin[0] + M), this.nav.bboxMax[0] - M);
      this.position.z = Math.min(Math.max(this.position.z, this.nav.bboxMin[2] + M), this.nav.bboxMax[2] - M);
      this.position.y = this.nav.floorAt(this.position.x, this.position.z); // 脚底贴地
    }

    // 朝向：移动时朝移动方向，静止时面向玩家（世界 yaw：atan2(dx, dz)，+Z 前向）
    const mdx = this.position.x - this.lastPos.x;
    const mdz = this.position.z - this.lastPos.z;
    const moved = Math.hypot(mdx, mdz);
    const instSpeed = dt > 1e-5 ? moved / dt : 0;
    this.smoothedSpeed += (instSpeed - this.smoothedSpeed) * Math.min(1, 8 * dt);
    let targetYaw: number;
    if (this.smoothedSpeed > WALK_ENTER_SPEED * 0.8 && moved > 1e-4) {
      targetYaw = Math.atan2(mdx, mdz);
    } else {
      const dx = playerPos.x - this.position.x;
      const dz = playerPos.z - this.position.z;
      targetYaw = Math.hypot(dx, dz) > 0.3 ? Math.atan2(dx, dz) : this.yaw;
    }
    this.lastPos.copy(this.position);
    const wrapped = Math.atan2(Math.sin(targetYaw - this.yaw), Math.cos(targetYaw - this.yaw));
    this.yaw += wrapped * Math.min(1, YAW_SMOOTH * dt);

    this.root.position.set(this.position.x, this.position.y, this.position.z);
    this.root.rotation.y = this.yaw + modelYawAdjust;
    this.root.updateMatrixWorld(true);

    this.updateAnimation(dt);
  }

  get speed() {
    return this.smoothedSpeed;
  }

  // ---- 内部 ----

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

  /** 按包围盒归一化身高并把脚底对到原点（与官方 demo normalizeModel 同法） */
  private normalize(model: Object3D) {
    model.updateMatrixWorld(true);
    // 蒙皮网格先 update() 让包围盒用骨骼姿态（官方 demo 同法）
    model.traverse((n) => {
      const sm = n as unknown as { isSkinnedMesh?: boolean; update?: () => void };
      if (sm.isSkinnedMesh && typeof sm.update === 'function') sm.update();
    });
    const box = new Box3().setFromObject(model as never);
    const h = Math.max(1e-6, box.max.y - box.min.y);
    this.modelHeight = COMPANION_HEIGHT;
    const s = COMPANION_HEIGHT / h;
    model.scale.setScalar(s);
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

  /** 调试：冻结/恢复跟随（取证时冻结再转身看伙计） */
  setFollowEnabled(v: boolean) {
    this.followEnabled = v;
    return v;
  }

  /** 调试：实时微调朝向偏移（弧度），返回当前值 */
  adjustYawOffset(delta: number) {
    modelYawAdjust += delta;
    return +modelYawAdjust.toFixed(3);
  }

  /** 调试：模型渲染状态快照 */
  debugInfo() {
    const box = new Box3().setFromObject(this.root as never);
    let meshCount = 0;
    this.root.traverse((n) => {
      const o = n as unknown as { isMesh?: boolean; isSkinnedMesh?: boolean };
      if (o.isMesh || o.isSkinnedMesh) meshCount++;
    });
    return {
      loaded: this.loaded,
      rootVisible: this.root.visible,
      pos: this.root.position.toArray?.() ?? null,
      boxMin: box.min.toArray?.(),
      boxMax: box.max.toArray?.(),
      anims: Object.keys(this.actions),
      meshCount,
    };
  }
}
