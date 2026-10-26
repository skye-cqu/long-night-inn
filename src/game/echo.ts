/**
 * echo.ts — N2 选择回响首秀（设计 §6 #25「回响 ≥2/幕：次日世界显形」，设计 §7 N3
 * 机制槽「世界记得你」）。读 N2 账本 survivor 结局 → N3 世界内显形 ≥2 处回响
 * （世界物件 + 晨间文案成对）：
 * - saved   → 主街入口「谢礼灯笼」（发光小灯笼，复用铜灯笼 GLB；E 拾取 +5 文，仅此夜）
 *             + 晨间字「有人托乱流给你捎了句话：谢谢」
 * - robbed  → 主街游荡「寻仇残影」（黑色半透明人形，不攻击；靠近=伙计紧张+红晕，绕开即消失）
 *             + 晨间字「你抢来的东西在发烫」
 * - ignored → doorway「被丢弃的行李」（不可拾取叙事物件，E 察看一句描述）
 *             + 晨间字「有些人没等到天亮」
 * - lost    → 门口「一半油纸包」（叙事物件，E 察看）
 *             + 晨间字「他没能跟你走出来」
 * 账本无 N2 记录（跨局清档）→ 默认 ignored 集。
 * 实现从简：全部复用 GLB/基元 + DOM 文案，不建新系统；每局 beginDive 重置，setNight dispose。
 */
import { Box3, GLTFLoader, Mesh, MeshPhongMaterial, Object3D, PointLight, Vector3, downloadTexture } from '@manycore/aholo-viewer';
import type { Scene3D } from '@manycore/aholo-viewer';
import type { NavField } from '../nav';
import { sphereGeometry } from './shapes';
import type { Ledger } from './ledger';

const { loadGLTF } = GLTFLoader;

export type EchoKind = 'saved' | 'robbed' | 'ignored' | 'lost';

/** 晨间驿站的一行回响字（世界内物件之外的第二处回响） */
export const ECHO_MORNING: Record<EchoKind, string> = {
  saved: '有人托乱流给你捎了句话：谢谢。',
  robbed: '你抢来的东西在发烫。',
  ignored: '有些人没等到天亮。',
  lost: '他没能跟你走出来。',
};

/** 夜谈按回响类型的评语池（每型 ≥2 条） */
export const ECHO_TALK: Record<EchoKind, string[]> = {
  saved: [
    '门口那只灯笼是谢礼。账本记了：你夜里递出去的手，天亮有人接住了。',
    '灯笼还会亮几夜。乱流缝世界时，把你缝进了「善」那一页——别撕。',
    '五文不多。但雪原上有人惦记你，这笔利息比文钱值钱。',
  ],
  robbed: [
    '街上那道影子是来寻仇的。账本记了：抢来的十文，昨夜连本带利开始讨了。',
    '它没有脸，也没有手——拿不走东西，只往你心里按。绕开它，账挂着。',
    '油纸包还烫着。乱流不管对错，只管记账：欠了的，会自己长脚找上门。',
  ],
  ignored: [
    '门口那件行李，主人昨夜没能等到天亮。账本记了：你听见了，但没有回头。',
    '行李不能收——不是你的东西，也永远不可能是了。它就摆在那儿，替人等你一眼。',
  ],
  lost: [
    '门口半个油纸包。他没能跟你走出来——账本记了：带到一半的手，松在了雾里。',
    '另半个纸包还在雾里某处。别找了。账本记了：尽力了，也是没够到。',
  ],
};

/** 夜谈抽一条回响评语（池内随机） */
export function pickEchoTalk(kind: EchoKind): string {
  const pool = ECHO_TALK[kind];
  return pool[Math.floor(Math.random() * pool.length)] ?? pool[0]!;
}

/** 「E 察看」叙事物件的描述（每物件一句） */
export const ECHO_RELIC_TEXT: Record<'ignored' | 'lost', string> = {
  ignored: '被丢弃的行李：锁扣大开，衣物冻得硬邦邦。雪快把它埋了——主人没再回来拿。',
  lost: '一半油纸包：纸角被撕去，里面的东西已经凉透。另一半留在了雾里。',
};

/** 读 N2 账本 survivor 结局 → 回响集（无 N2 记录/跨局清档 → 默认 ignored） */
export function readEchoKind(ledger: Ledger): EchoKind {
  const records = ledger
    .nightRecords(2)
    .filter((r) => r.type === 'survivor_saved' || r.type === 'survivor_robbed' || r.type === 'survivor_ignored' || r.type === 'survivor_lost')
    .sort((a, b) => a.ts - b.ts);
  const last = records[records.length - 1];
  if (!last) return 'ignored';
  return last.type.slice('survivor_'.length) as EchoKind;
}

/** 拉取 GLB 按包围盒归一化并居中（与 items.ts 同法；灯笼回响用） */
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

export interface EchoTick {
  /** 寻仇残影：本帧首次进入逼近（edge 触发，用后即清） */
  wraithNear: boolean;
  /** 寻仇残影：本帧散去（edge 触发） */
  wraithGone: boolean;
}

const WRAITH_TRIGGER_DIST = 3.2; // 逼近触发：伙计紧张+红晕
const WRAITH_VANISH_DIST = 6.5; // 触发后玩家绕开至此距离 → 残影散去
const WRAITH_PATROL_R = 2.5; // 游荡半径

export class Echo {
  readonly root = new Object3D();
  kind: EchoKind = 'ignored';
  /** 谢礼灯笼是否已拾取（仅此夜有效；重进本夜重置） */
  giftTaken = false;
  /** 叙事物件是否已察看过（每局一次提示） */
  relicSeen = false;

  private scene: Scene3D;
  private nav: NavField;
  private anchors: { gift: { x: number; z: number }; wraith: { x: number; z: number }; relic: { x: number; z: number } };
  /** 残影（robbed 集）运行时 */
  private wraith: Object3D | null = null;
  private wraithPos = new Vector3();
  private wraithTarget = { x: 0, z: 0 };
  private wraithTriggered = false;
  private wraithGoneDone = false;
  private relic: Object3D | null = null;
  private gift: Object3D | null = null;

  constructor(scene: Scene3D, nav: NavField, anchors: { gift: { x: number; z: number }; wraith: { x: number; z: number }; relic: { x: number; z: number } }) {
    this.scene = scene;
    this.nav = nav;
    this.anchors = anchors;
    this.root.visible = false;
    scene.add(this.root as never);
    scene.notifySceneChange?.();
  }

  /** 下潜开始：按结局集显形（先清上一局的世界物） */
  spawn(kind: EchoKind, giftGlbUrl: string) {
    this.clearWorld();
    this.kind = kind;
    this.giftTaken = false;
    this.relicSeen = false;
    this.wraithTriggered = false;
    this.wraithGoneDone = false;
    this.root.visible = true;

    if (kind === 'saved') this.spawnGift(giftGlbUrl);
    else if (kind === 'robbed') this.spawnWraith();
    else this.spawnRelic(kind);
    this.scene.notifySceneChange?.();
  }

  /** 谢礼灯笼：复用铜灯笼 GLB + 暖光（加载失败回退发光小球占位） */
  private spawnGift(glbUrl: string) {
    const { x, z } = this.anchors.gift;
    const y = this.nav.floorAt(x, z);
    const holder = new Object3D();
    holder.position.set(x, y + 0.9, z);

    const placeholder = new Mesh(
      sphereGeometry(14, 10),
      new MeshPhongMaterial({ color: 0xffb35c, shininess: 90 }),
    );
    placeholder.scale.setScalar(0.16);
    holder.add(placeholder as never);
    this.gift = holder;
    this.root.add(holder as never);

    loadGlbNormalized(glbUrl, 0.34)
      .then((model) => {
        if (this.giftTaken) return;
        holder.remove(placeholder as never);
        holder.add(model as never);
        this.scene.notifySceneChange?.();
      })
      .catch((e: unknown) => console.warn('[回响] 谢礼灯笼 GLB 加载失败，保留占位:', e));

    const glow = new PointLight(0xffb35c, 1.5, 5, 1.4);
    holder.add(glow as never);
  }

  /** 寻仇残影：黑色半透明人形（拉长椭球 + 头球），不攻击、无碰撞 */
  private spawnWraith() {
    const { x, z } = this.anchors.wraith;
    const y = this.nav.floorAt(x, z);
    const body = new Object3D();
    const torso = new Mesh(
      sphereGeometry(16, 12),
      new MeshPhongMaterial({ color: 0x05070a, transparent: true, opacity: 0.58, shininess: 8 }),
    );
    torso.scale.set(0.42, 1.05, 0.34);
    torso.position.y = 0.82;
    const head = new Mesh(
      sphereGeometry(12, 10),
      new MeshPhongMaterial({ color: 0x05070a, transparent: true, opacity: 0.5, shininess: 8 }),
    );
    head.scale.setScalar(0.21);
    head.position.y = 1.66;
    body.add(torso as never);
    body.add(head as never);
    this.wraith = body;
    this.wraithPos.set(x, y, z);
    this.wraithTarget = { x, z };
    body.position.copy(this.wraithPos);
    this.root.add(body as never);
  }

  /** 叙事物件：ignored=被丢弃的行李 / lost=半个油纸包（不可拾取，E 察看） */
  private spawnRelic(kind: 'ignored' | 'lost') {
    const { x, z } = this.anchors.relic;
    const y = this.nav.floorAt(x, z);
    const isLuggage = kind === 'ignored';
    const mesh = new Mesh(
      sphereGeometry(14, 10),
      new MeshPhongMaterial({ color: isLuggage ? 0x4a4038 : 0xc9a86b, shininess: isLuggage ? 6 : 30 }),
    );
    // 行李=横放方包状；油纸包=半只扁包
    mesh.scale.set(isLuggage ? 1.15 : 0.62, isLuggage ? 0.5 : 0.3, isLuggage ? 0.7 : 0.45);
    mesh.position.set(x, y + (isLuggage ? 0.3 : 0.14), z);
    mesh.rotation.y = 0.6;
    this.relic = new Object3D();
    this.relic.add(mesh as never);
    this.root.add(this.relic as never);
  }

  /** 每帧：谢礼灯笼浮动旋转 / 残影游荡+逼近判定。edge 事件一次性返回 */
  update(dt: number, t: number, playerPos: Vector3): EchoTick {
    const tick: EchoTick = { wraithNear: false, wraithGone: false };
    if (!this.root.visible) return tick;

    if (this.kind === 'saved' && this.gift && !this.giftTaken) {
      this.gift.rotation.y += dt * 1.1;
      this.gift.position.y += Math.sin(t * 1.5) * dt * 0.05;
    }

    if (this.kind === 'robbed' && this.wraith && !this.wraithGoneDone) {
      // 缓慢游荡（0.6 m/s，锚点邻域）+ 面向玩家
      const d = Math.hypot(this.wraithTarget.x - this.wraithPos.x, this.wraithTarget.z - this.wraithPos.z);
      if (d < 0.3) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * WRAITH_PATROL_R;
        this.wraithTarget = { x: this.anchors.wraith.x + Math.cos(a) * r, z: this.anchors.wraith.z + Math.sin(a) * r };
      } else {
        const step = Math.min(0.6 * dt, d);
        this.wraithPos.x += ((this.wraithTarget.x - this.wraithPos.x) / d) * step;
        this.wraithPos.z += ((this.wraithTarget.z - this.wraithPos.z) / d) * step;
        this.wraithPos.y = this.nav.floorAt(this.wraithPos.x, this.wraithPos.z);
      }
      this.wraith.position.copy(this.wraithPos);
      const pd = Math.hypot(playerPos.x - this.wraithPos.x, playerPos.z - this.wraithPos.z);
      this.wraith.rotation.y = Math.atan2(playerPos.x - this.wraithPos.x, playerPos.z - this.wraithPos.z);

      if (!this.wraithTriggered && pd < WRAITH_TRIGGER_DIST) {
        // 逼近只触发一次红晕（账只讨一次）；玩家绕开到 VANISH 距离即散去
        this.wraithTriggered = true;
        tick.wraithNear = true;
      } else if (this.wraithTriggered && pd > WRAITH_VANISH_DIST) {
        this.wraithGoneDone = true;
        this.wraith.visible = false;
        tick.wraithGone = true;
      }
    }
    return tick;
  }

  /** 可交互物距离（E 提示/交互用）：gift=拾取 / relic=察看 */
  nearInteractable(playerPos: Vector3): { kind: 'gift' | 'relic'; dist: number } | null {
    if (!this.root.visible) return null;
    if (this.kind === 'saved' && !this.giftTaken && this.gift) {
      const dist = Math.hypot(this.gift.position.x - playerPos.x, this.gift.position.z - playerPos.z);
      return { kind: 'gift', dist };
    }
    if ((this.kind === 'ignored' || this.kind === 'lost') && this.relic) {
      const p = this.relic.children[0]?.position ?? null;
      if (!p) return null;
      const dist = Math.hypot(p.x - playerPos.x, p.z - playerPos.z);
      return { kind: 'relic', dist };
    }
    return null;
  }

  /** E 拾取谢礼灯笼（成功后 takeGift() 由 game 层记账） */
  isGiftInRange(playerPos: Vector3, radius: number): boolean {
    const near = this.nearInteractable(playerPos);
    return near?.kind === 'gift' && near.dist < radius;
  }

  isRelicInRange(playerPos: Vector3, radius: number): boolean {
    const near = this.nearInteractable(playerPos);
    return near?.kind === 'relic' && near.dist < radius;
  }

  takeGift() {
    this.giftTaken = true;
    if (this.gift) this.gift.visible = false;
  }

  markRelicSeen() {
    this.relicSeen = true;
  }

  /** 换夜/销毁：世界物摘除 */
  dispose() {
    this.clearWorld();
    this.root.visible = false;
    this.scene.remove(this.root as never);
    this.scene.notifySceneChange?.();
  }

  private clearWorld() {
    if (this.gift) {
      this.root.remove(this.gift as never);
      this.gift = null;
    }
    if (this.wraith) {
      this.root.remove(this.wraith as never);
      this.wraith = null;
    }
    if (this.relic) {
      this.root.remove(this.relic as never);
      this.relic = null;
    }
  }

  get debug() {
    return {
      kind: this.kind,
      giftTaken: this.giftTaken,
      relicSeen: this.relicSeen,
      wraith: this.wraith
        ? { triggered: this.wraithTriggered, gone: this.wraithGoneDone, pos: { x: +this.wraithPos.x.toFixed(2), z: +this.wraithPos.z.toFixed(2) } }
        : null,
    };
  }
}
