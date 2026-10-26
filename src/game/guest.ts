/**
 * guest.ts — 住客回归（设计 §6 #26 常客系统首秀，§7 N4 机制槽「关联」）。
 *
 * N2 幸存者结局读账本分岔（readGuestSaved）：
 * - saved   → N4 晨间驿站出现旅人（DOM 卡：他就是那晚被救的人，住下了），口头情报
 *             「主街最深处有件好东西」；夜谈多一段旅人评语（≥2 条池，评论 N4 经历）。
 * - 非 saved → 无住客；情报由伙计给出（「我闻到深处有铃铛味」）。
 * 两种集都刷「古镇银铃」（值 12 文，图鉴系列第 5 格——N2 油纸包第 4 格之后），
 * 落点=主街最深处死胡同凹室（NightDef.guest.bell，plan-n4-points.mjs 硬规则验证）。
 *
 * 视觉零新资产：银铃复用 Lux3D 怀表 GLB（token-watch.glb，圆金属件铃形最近），
 * 加载失败回退银白占位椭球 + 银白点光（灯笼暖光里的冷光点=「好东西」的视觉钩）。
 * 生命周期同 echo.ts：beginDive 重建，setNight dispose。
 */
import { Box3, GLTFLoader, Mesh, MeshPhongMaterial, Object3D, PointLight, Vector3, downloadTexture } from '@manycore/aholo-viewer';
import type { Scene3D } from '@manycore/aholo-viewer';
import type { NavField } from '../nav';
import type { GuestDef } from './config';
import type { Ledger } from './ledger';
import { sphereGeometry } from './shapes';

const { loadGLTF } = GLTFLoader;

/** N2 结局 → 是否有住客（最后一条 N2 幸存者记录 = survivor_saved 才算住下） */
export function readGuestSaved(ledger: Ledger): boolean {
  const records = ledger
    .nightRecords(2)
    .filter((r) => r.type === 'survivor_saved' || r.type === 'survivor_robbed' || r.type === 'survivor_ignored' || r.type === 'survivor_lost')
    .sort((a, b) => a.ts - b.ts);
  const last = records[records.length - 1];
  return last?.type === 'survivor_saved';
}

/** 晨间住客卡（saved 集）：intro=他是谁 / line=他的话 / intel=口头情报（指向银铃） */
export const GUEST_CARD = {
  name: '住客 · 旅人',
  intro: '他就是那晚你从雾里带回来的人。伤养好了，人住下了——晨光里帮你把柴劈好了。',
  line: '「掌柜，这条沉在水底的街，我年轻时赶集走过。镇上的铃铛响一声，浪就退一尺。」',
  intel: '「主街最深处有件好东西——去了，别空手回来。」',
};

/** 无住客（非 saved 集）：情报由伙计给出（银铃照刷） */
export const GUEST_INNKEEPER_INTEL = '「我闻到深处有铃铛味。」';

/** 夜谈旅人评语池（有住客时，评论 N4 经历；≥2 条） */
export const GUEST_TALK: string[] = [
  '柜台那头，住下的旅人放下了汤碗：「你回来的时辰真好——刚才浪头都爬到街口了。铃铛找着了吗？听见它响，这条街就还认你。」',
  '住下的旅人往灯边凑了凑：「今夜你身上的水汽是咸的。那东西追你的时候，灯笼全都背过身去——它们只照走路的人，不照跑的人。」',
  '住下的旅人擦着手里的碗：「深海里还能捡着没锈的东西，是镇子在还人情。掌柜，账要一笔笔还，路要一步步走。」',
];

/** 夜谈抽一条旅人评语 */
export function pickGuestTalk(): string {
  return GUEST_TALK[Math.floor(Math.random() * GUEST_TALK.length)] ?? GUEST_TALK[0]!;
}

/** 拉取 GLB 按包围盒归一化并居中（与 items.ts/echo.ts 同法） */
async function loadGlbNormalized(url: string, size: number): Promise<Object3D> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch ${url} HTTP ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const result = await loadGLTF(buffer, { textureLoader: downloadTexture });
  const model = result.scene as unknown as Object3D;
  model.updateMatrixWorld(true);
  const box = new Box3().setFromObject(model as never);
  const dim = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
  model.scale.setScalar(size / Math.max(1e-6, dim));
  model.updateMatrixWorld(true);
  const b2 = new Box3().setFromObject(model as never);
  model.position.x -= (b2.min.x + b2.max.x) * 0.5;
  model.position.y -= (b2.min.y + b2.max.y) * 0.5;
  model.position.z -= (b2.min.z + b2.max.z) * 0.5;
  return model;
}

export class Guest {
  readonly root = new Object3D();
  /** 住客是否在场（N2 结局=saved）；银铃两种集都刷 */
  present = false;
  /** 银铃是否已拾取（每局重置） */
  bellTaken = false;

  private scene: Scene3D;
  private nav: NavField;
  private def: GuestDef;
  private bell: Object3D | null = null;
  private bellBaseY = 0;

  constructor(scene: Scene3D, nav: NavField, def: GuestDef) {
    this.scene = scene;
    this.nav = nav;
    this.def = def;
    this.root.visible = false;
    scene.add(this.root as never);
    scene.notifySceneChange?.();
  }

  /** 下潜开始：显形银铃（present 只驱动晨间卡/夜谈，不驱动世界物） */
  spawn(present: boolean, bellGlbUrl: string) {
    this.clearWorld();
    this.present = present;
    this.bellTaken = false;
    this.root.visible = true;

    const { x, z } = this.def.bell;
    const y = this.nav.floorAt(x, z);
    this.bellBaseY = y + 0.9;
    const holder = new Object3D();
    holder.position.set(x, this.bellBaseY, z);

    // 占位：银白小椭球（GLB 就绪前/失败的视觉兜底）
    const placeholder = new Mesh(
      sphereGeometry(14, 10),
      new MeshPhongMaterial({ color: 0xd8dee8, shininess: 110 }),
    );
    placeholder.scale.setScalar(0.15);
    holder.add(placeholder as never);
    this.bell = holder;
    this.root.add(holder as never);

    // 银铃 GLB：复用怀表（圆金属件零新资产）；银白点光=灯笼暖光里的冷光钩
    loadGlbNormalized(bellGlbUrl, 0.3)
      .then((model) => {
        if (this.bellTaken) return;
        holder.remove(placeholder as never);
        holder.add(model as never);
        this.scene.notifySceneChange?.();
      })
      .catch((e: unknown) => console.warn('[住客] 银铃 GLB 加载失败，保留占位:', e));

    const glow = new PointLight(0xcfe0ea, 1.5, 5, 1.4);
    holder.add(glow as never);
    this.scene.notifySceneChange?.();
  }

  /** 每帧：银铃浮动旋转 */
  update(dt: number, t: number) {
    if (!this.root.visible || !this.bell || this.bellTaken) return;
    this.bell.rotation.y += dt * 1.4;
    this.bell.position.y = this.bellBaseY + Math.sin(t * 1.7) * 0.07;
  }

  /** 银铃拾取距离（E 提示用） */
  isBellInRange(playerPos: Vector3, radius: number): boolean {
    if (!this.root.visible || !this.bell || this.bellTaken) return false;
    const dist = Math.hypot(this.bell.position.x - playerPos.x, this.bell.position.z - playerPos.z);
    return dist < radius;
  }

  takeBell() {
    this.bellTaken = true;
    if (this.bell) this.bell.visible = false;
  }

  /** 换夜/销毁：世界物摘除 */
  dispose() {
    this.clearWorld();
    this.root.visible = false;
    this.scene.remove(this.root as never);
    this.scene.notifySceneChange?.();
  }

  private clearWorld() {
    if (this.bell) {
      this.root.remove(this.bell as never);
      this.bell = null;
    }
  }

  get debug() {
    return {
      present: this.present,
      bellTaken: this.bellTaken,
      bell: this.bell ? { x: +this.bell.position.x.toFixed(2), y: +this.bell.position.y.toFixed(2), z: +this.bell.position.z.toFixed(2) } : null,
    };
  }
}
