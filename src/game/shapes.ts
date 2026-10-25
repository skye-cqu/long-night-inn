/**
 * shapes.ts — 占位几何工厂（viewer 的 Sphere/Box 等几何类未在模块层导出，
 * 这里用导出的 BufferGeometry + BufferAttribute 手搓 UV 椭球）。
 * TODO(Lux3D 信物/实体)：正式资产 GLB 接入后本文件可整体退役。
 */
import { BufferAttribute, BufferGeometry } from '@manycore/aholo-viewer';

/** UV 球（单位半径，法线=归一化位置；用 mesh.scale 变形成椭球/胶囊/扁盒） */
export function sphereGeometry(widthSegments = 16, heightSegments = 12): BufferGeometry {
  const w = Math.max(3, widthSegments);
  const h = Math.max(2, heightSegments);
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (let iy = 0; iy <= h; iy++) {
    const v = iy / h;
    const theta = v * Math.PI; // 0..PI
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    for (let ix = 0; ix <= w; ix++) {
      const u = ix / w;
      const phi = u * Math.PI * 2;
      const sinP = Math.sin(phi);
      const cosP = Math.cos(phi);
      const x = -sinT * cosP;
      const y = cosT;
      const z = sinT * sinP;
      positions.push(x, y, z);
      normals.push(x, y, z);
    }
  }
  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      const a = iy * (w + 1) + ix;
      const b = a + 1;
      const c = a + w + 1;
      const d = c + 1;
      if (iy !== 0) indices.push(a, c, b);
      if (iy !== h - 1) indices.push(b, c, d);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geo.setIndex(indices);
  return geo;
}
