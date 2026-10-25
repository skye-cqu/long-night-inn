/**
 * items.ts — N1 世界内兴趣物：3 件战利品 + 归航之门。
 *
 * 视觉=viewer(three 系)基元占位（发光小物件：基元 + 跟随点光 + 旋转浮动）。
 * // TODO(Lux3D 信物)：img/text-to-3D 产出 GLB 后按 LootDef.id 替换占位几何
 *   （灯油瓶/铜灯笼/旧怀表各一件，跨幕信物直接复用 id）。
 * // TODO(Lux3D 门)：归航门的实体形态（当前为暖光柱占位）。
 */
import { Mesh, MeshPhongMaterial, Object3D, PointLight, Vector3 } from '@manycore/aholo-viewer';
import type { Scene3D } from '@manycore/aholo-viewer';
import type { LootDef } from './config';
import type { NavField } from '../nav';
import { sphereGeometry } from './shapes';

export interface LootItem {
  def: LootDef;
  root: Object3D;
  pos: Vector3; // 悬浮中心（世界坐标）
  baseY: number;
  taken: boolean;
  value: number; // 回响模式会微调
}

/** 拾取后可重置（回响重玩用） */
export class WorldItems {
  readonly loot: LootItem[] = [];
  readonly doorRoot = new Object3D();
  readonly doorPos: Vector3;
  private doorBaseY = 0;

  constructor(scene: Scene3D, nav: NavField, defs: LootDef[], door: { x: number; z: number }) {
    for (const def of defs) {
      const root = new Object3D();
      const floorY = nav.floorAt(def.x, def.z);
      const baseY = floorY + 1.0;
      root.position.set(def.x, baseY, def.z);

      // TODO(Lux3D 信物)：占位几何按 shape 分型（瓶=竖长椭球/灯笼=球+顶环/怀表=扁盒）
      const geo = sphereGeometry(18, 14);
      const mat = new MeshPhongMaterial({ color: def.color, shininess: 80 });
      const mesh = new Mesh(geo, mat);
      if (def.shape === 'bottle') mesh.scale.set(0.72, 1.55, 0.72);
      else if (def.shape === 'watch') mesh.scale.set(1.05, 0.3, 1.05);
      else mesh.scale.set(1, 1, 1);
      root.add(mesh as never);

      if (def.shape === 'lantern') {
        // 灯笼顶环（扁球）
        const halo = new Mesh(sphereGeometry(12, 8), new MeshPhongMaterial({ color: def.glowColor, shininess: 60 }));
        halo.scale.set(1, 0.28, 1);
        halo.position.y = 0.26;
        root.add(halo as never);
      }

      // 跟随点光（照亮伙计/实体等 mesh；splat 自身亮度由 CSS 侧处理）
      const light = new PointLight(def.glowColor, 1.1, 4.5, 1.5);
      root.add(light as never);

      scene.add(root as never);
      this.loot.push({ def, root, pos: new Vector3(def.x, baseY, def.z), baseY, taken: false, value: def.value });
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
