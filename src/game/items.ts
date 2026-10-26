/**
 * items.ts — 世界内兴趣物：战利品（按夜配置）+ 归航之门。
 *
 * 视觉源：Lux3D 信物 GLB（token-*.glb，按 LootDef.glb 懒加载，归一化到 ~0.35m
 * 悬浮于 floorAt+1.0）；加载失败 console.warn 并保留椭球占位。旋转浮动 + 跟随
 * 点光 + E 拾取 + 图鉴逻辑不变。
 * // TODO(Lux3D 门)：归航门的实体形态（当前为暖光柱占位）。
 */
import { Box3, GLTFLoader, Mesh, MeshPhongMaterial, Object3D, PointLight, Vector3, downloadTexture } from '@manycore/aholo-viewer';
import type { Scene3D } from '@manycore/aholo-viewer';
import type { LootDef } from './config';
import type { NavField } from '../nav';
import { sphereGeometry } from './shapes';

const { loadGLTF } = GLTFLoader;

/** 信物视觉尺寸（包围盒最大边归一化目标，米） */
const TOKEN_SIZE = 0.35;

export interface LootItem {
  def: LootDef;
  root: Object3D;
  pos: Vector3; // 悬浮中心（世界坐标）
  baseY: number;
  taken: boolean;
  value: number; // 回响模式会微调
}

/** 拉取 GLB 并按包围盒归一化到目标尺寸、居中到原点（悬浮+旋转的锚点） */
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

/** 拾取后可重置（回响重玩用） */
export class WorldItems {
  readonly loot: LootItem[] = [];
  readonly doorRoot = new Object3D();
  readonly doorPos: Vector3;
  private doorBaseY = 0;
  private scene: Scene3D;
  /** 暖光点（N3 雪夜灯笼暖光，零新资产：发光小球+点光） */
  private lampsRoot: Object3D | null = null;

  constructor(scene: Scene3D, nav: NavField, defs: LootDef[], door: { x: number; z: number }, lamps?: Array<{ x: number; z: number }>) {
    this.scene = scene;
    for (const def of defs) {
      const root = new Object3D();
      const floorY = nav.floorAt(def.x, def.z);
      const baseY = floorY + 1.0;
      root.position.set(def.x, baseY, def.z);

      // 占位几何（GLB 就绪前/失败时的视觉兜底）：瓶=竖长椭球/灯笼=球+顶环/怀表=扁盒
      const placeholder = new Object3D();
      const geo = sphereGeometry(18, 14);
      const mat = new MeshPhongMaterial({ color: def.color, shininess: 80 });
      const mesh = new Mesh(geo, mat);
      if (def.shape === 'bottle') mesh.scale.set(0.72, 1.55, 0.72);
      else if (def.shape === 'watch') mesh.scale.set(1.05, 0.3, 1.05);
      else mesh.scale.set(1, 1, 1);
      placeholder.add(mesh as never);

      if (def.shape === 'lantern') {
        // 灯笼顶环（扁球）
        const halo = new Mesh(sphereGeometry(12, 8), new MeshPhongMaterial({ color: def.glowColor, shininess: 60 }));
        halo.scale.set(1, 0.28, 1);
        halo.position.y = 0.26;
        placeholder.add(halo as never);
      }
      root.add(placeholder as never);

      // Lux3D 信物 GLB：异步替换占位（失败保留占位 + console.warn）
      if (def.glb) {
        loadGlbNormalized(def.glb, TOKEN_SIZE)
          .then((model) => {
            if (item.taken) return;
            root.remove(placeholder as never);
            root.add(model as never);
            this.scene.notifySceneChange?.();
          })
          .catch((e: unknown) => console.warn(`[信物] ${def.id} GLB 加载失败，保留占位:`, e));
      }

      // 跟随点光（照亮伙计/实体等 mesh；splat 自身亮度由 CSS 侧处理）
      const light = new PointLight(def.glowColor, 1.1, 4.5, 1.5);
      root.add(light as never);

      scene.add(root as never);
      const item: LootItem = { def, root, pos: new Vector3(def.x, baseY, def.z), baseY, taken: false, value: def.value };
      this.loot.push(item);
    }

    // 归航之门：暖光柱占位
    this.doorPos = new Vector3(door.x, 0, door.z);
    const floorY = nav.floorAt(door.x, door.z);
    this.doorBaseY = floorY + 1.35;
    const gate = new Mesh(
      sphereGeometry(16, 12),
      new MeshPhongMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.85, shininess: 100 }),
    );
    gate.scale.set(0.22, 1.35, 0.75);
    this.doorRoot.add(gate as never);
    const doorLight = new PointLight(0xffc884, 1.6, 7, 1.4);
    this.doorRoot.add(doorLight as never);
    this.doorRoot.position.set(door.x, this.doorBaseY, door.z);
    scene.add(this.doorRoot as never);
    this.scene.notifySceneChange?.();

    // 暖光点（挂在一个 root 上，dispose 一并摘除）
    if (lamps && lamps.length) {
      this.lampsRoot = new Object3D();
      for (const lamp of lamps) {
        const y = nav.floorAt(lamp.x, lamp.z);
        const bulb = new Mesh(
          sphereGeometry(10, 8),
          new MeshPhongMaterial({ color: 0xffb35c, shininess: 100 }),
        );
        bulb.scale.set(0.14, 0.18, 0.14);
        bulb.position.set(lamp.x, y + 0.55, lamp.z);
        const glow = new PointLight(0xffa050, 1.0, 5, 1.5);
        glow.position.copy(bulb.position);
        this.lampsRoot.add(bulb as never);
        this.lampsRoot.add(glow as never);
      }
      scene.add(this.lampsRoot as never);
      this.scene.notifySceneChange?.();
    }
  }

  /** 换夜重建前：把本夜世界物从场景摘除 */
  dispose(scene: Scene3D) {
    for (const item of this.loot) scene.remove(item.root as never);
    scene.remove(this.doorRoot as never);
    if (this.lampsRoot) {
      scene.remove(this.lampsRoot as never);
      this.lampsRoot = null;
    }
    scene.notifySceneChange?.();
  }

  /** 回响重玩：复活全部战利品（价值可微调），门复位 */
  reset(valueJitter = 0) {
    for (const item of this.loot) {
      item.taken = false;
      item.root.visible = true;
      if (valueJitter > 0) {
        const j = Math.floor(Math.random() * (valueJitter * 2 + 1)) - valueJitter;
        item.value = Math.max(1, item.def.value + j);
      } else {
        item.value = item.def.value;
      }
    }
    this.doorRoot.visible = true;
  }

  update(t: number, dt: number) {
    // 旋转 + 浮动 + 微光脉动
    for (const item of this.loot) {
      if (item.taken) continue;
      item.root.rotation.y += dt * 1.2;
      item.root.position.y = item.baseY + Math.sin(t * 1.6 + item.pos.x) * 0.08;
    }
    this.doorRoot.rotation.y += dt * 0.15;
    this.doorRoot.position.y = this.doorBaseY + Math.sin(t * 0.9) * 0.05;
  }

  /** 最近未拾取战利品 */
  nearest(pos: Vector3): { item: LootItem; dist: number } | null {
    let best: { item: LootItem; dist: number } | null = null;
    for (const item of this.loot) {
      if (item.taken) continue;
      const d = Math.hypot(item.pos.x - pos.x, item.pos.z - pos.z);
      if (!best || d < best.dist) best = { item, dist: d };
    }
    return best;
  }

  take(item: LootItem) {
    item.taken = true;
    item.root.visible = false;
    return item;
  }

  lootedValue() {
    return this.loot.reduce((s, i) => (i.taken ? s + i.value : s), 0);
  }

  lootedCount() {
    return this.loot.filter((i) => i.taken).length;
  }
}
