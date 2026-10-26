/**
 * nav.ts — 世界导航数据（离线从点云预计算，见 scripts/gen-nav-data.mjs）。
 * 体素碰撞（下一任务）落地前，行走碰撞 = 地面高度场钳制 + 走廊包围盒约束。
 */

export interface NavData {
  /** 点云包围盒 */
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  cellSize: number;
  nx: number;
  nz: number;
  /** 两种 up 约定各自的地面高度场（行主序：iz*nx+ix） */
  floorGridNeg: (number | null)[]; // up = -Y（OpenCV）
  floorGridPos: (number | null)[]; // up = +Y
  globalFloorNeg: number;
  globalFloorPos: number;
}

/** 一根可站柱：nav 非空格的格心水平坐标 + 该格地面高度 */
export interface NavColumn {
  x: number;
  z: number;
  y: number;
}

export interface NavField {
  /** 世界 up 方向的 y 符号：-1 = OpenCV（-Y up），+1 = glTF 惯例（+Y up） */
  upSign: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  /** 地面高度（世界坐标 y）。 */
  floorAt(x: number, z: number): number;
  /** 全部可站柱（非空格，量级≤网格数；坠落软复位「最近可站柱」用） */
  columns: NavColumn[];
}

export function buildNavField(data: NavData, upSign: number): NavField {
  const grid = upSign < 0 ? data.floorGridNeg : data.floorGridPos;
  const globalFloor = upSign < 0 ? data.globalFloorNeg : data.globalFloorPos;
  const { bboxMin, bboxMax, cellSize, nx, nz } = data;
  const floorAt = (x: number, z: number): number => {
    const ix = Math.floor((x - bboxMin[0]) / cellSize);
    const iz = Math.floor((z - bboxMin[2]) / cellSize);
    if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) return globalFloor;
    const v = grid[iz * nx + ix];
    return v === null ? globalFloor : v;
  };
  const columns: NavColumn[] = [];
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const v = grid[iz * nx + ix];
      if (v === null) continue;
      columns.push({ x: bboxMin[0] + (ix + 0.5) * cellSize, z: bboxMin[2] + (iz + 0.5) * cellSize, y: v });
    }
  }
  return { upSign, bboxMin, bboxMax, floorAt, columns };
}
