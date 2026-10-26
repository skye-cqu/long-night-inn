/**
 * atmosphere.ts — N4「深海 × 灯笼古镇」氛围粒子：悬浮微尘/气泡（设计 §7 N4 氛围槽）。
 *
 * three Points ≤200 点，零贴图零新资产（红色线：不加运行时依赖——Points/PointsMaterial/
 * BufferGeometry/BufferAttribute/Blending 全部用 @manycore/aholo-viewer 同源导出，
 * 与渲染器同一 three 实例，避免跨实例对象）。粒子散布在本夜 nav 可站柱上方 0.3~2.2m，
 * 缓慢上浮+水平摆动（深海悬浮感），只在下潜阶段可见。
 *
 * 实测坑（预防）：aholo-viewer 未在模块层导出 Sphere/Box 几何（README 关键事实 2），
 * 但 Points/BufferGeometry 在导出面里（index.d.ts L5902/L13148/L13196）；若运行时缺失
 * 则 console.warn 并整层跳过——氛围层不允许卡死玩法。
 */
import { BufferAttribute, BufferGeometry, Blending, Points, PointsMaterial } from '@manycore/aholo-viewer';
import type { Object3D, Scene3D } from '@manycore/aholo-viewer';
import type { NavField } from '../nav';

const MAX_POINTS = 200;

export class DustField {
  readonly root: Object3D | null = null;
  private points: Points | null = null;
  private base: Float32Array | null = null;
  private scene: Scene3D;

  constructor(scene: Scene3D, nav: NavField) {
    this.scene = scene;
    if (typeof Points !== 'function' || typeof BufferGeometry !== 'function' || typeof BufferAttribute !== 'function') {
      console.warn('[氛围] viewer 未导出 Points/BufferGeometry，微尘层跳过（不影响玩法）');
      return;
    }
    // 散布点=可站柱随机采样（柱顶上方悬浮；没 nav 柱就没有微尘——退化安全）
    const cols = nav.columns;
    if (!cols.length) return;
    const n = Math.min(MAX_POINTS, cols.length);
    const pos = new Float32Array(n * 3);
    const base = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const c = cols[Math.floor(Math.random() * cols.length)]!;
      base[i * 3] = c.x + (Math.random() - 0.5) * 0.8;
      base[i * 3 + 1] = c.y + 0.3 + Math.random() * 1.9;
      base[i * 3 + 2] = c.z + (Math.random() - 0.5) * 0.8;
    }
    pos.set(base);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    const mat = new PointsMaterial({
      color: 0x9fd8d0, // 深海青尘
      size: 0.045,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: Blending.AdditiveBlending, // 发光微粒（零贴图：小尺寸+加色叠加读作悬浮微光）
    });
    // BufferGeometry 默认泛型是 TriangleList，Points 要求 PointList 拓扑标记——运行时同一
    // 数据结构（viewer 的 Drawable 只按 position attribute 画点），类型侧 never 断言
    this.points = new Points(geo as never, mat);
    this.base = base;
    this.root = this.points as unknown as Object3D;
    this.root.visible = false;
    scene.add(this.root as never);
    scene.notifySceneChange?.();
  }

  /** 下潜阶段显隐 */
  setVisible(v: boolean) {
    if (!this.root) return;
    this.root.visible = v;
    this.scene.notifySceneChange?.();
  }

  /** 每帧：缓慢上浮 + 水平微摆（循环；无位移=静态亦可接受，氛围层不做碰撞） */
  update(t: number) {
    if (!this.points || !this.base) return;
    const attr = (this.points.geometry as unknown as { getAttribute(name: string): { array: Float32Array; needsUpdate: boolean } }).getAttribute('position');
    const arr = attr.array;
    const n = arr.length / 3;
    for (let i = 0; i < n; i++) {
      const ph = i * 1.7;
      // 上浮 0.12m/s 循环 1.9m；水平 0.05m 正弦摆（相位按粒子错开）
      arr[i * 3 + 1] = this.base[i * 3 + 1] + ((t * 0.12 + ph * 0.37) % 1.9);
      arr[i * 3] = this.base[i * 3] + Math.sin(t * 0.5 + ph) * 0.05;
      arr[i * 3 + 2] = this.base[i * 3 + 2] + Math.cos(t * 0.4 + ph) * 0.05;
    }
    attr.needsUpdate = true;
  }

  dispose() {
    if (!this.root) return;
    this.scene.remove(this.root as never);
    this.scene.notifySceneChange?.();
    this.points = null;
    this.base = null;
  }
}
