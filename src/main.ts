/**
 * main.ts — 《长夜驿站》脚手架装配：aholo-viewer 渲染 SPZ 世界 + GLB 伙计 +
 * 第一人称行走 + 调试 HUD / window.__game 自动化接口。
 *
 * - viewer 初始化复用 2026-10-26 go/no-go 验收测试页已跑通的探针代码，
 *   渲染循环骨架参考官方 walk-demo 与官网 render-runtime（自建 Scene3D + setScene、
 *   pixelRatio、禁用坐标系 gizmo 与各级 culling）。
 * - up 约定：N1 世界（Aholo World API 输出）渲染空间为 +Y up（?up=1/?up=-1
 *   渲染对比 + studio 官方查看器截图亮度梯度同号判定，2026-10-26）；官方
 *   quickstart 的「splat 为 OpenCV -Y up」仅适用于 bear.sog 等原始资产。
 *   ?up=-1 仅作世界侧对照调试。
 */
import {
  BackgroundMode,
  Color,
  PerspectiveCamera,
  Scene3D,
  SplatLoader,
  SplatUtils,
  Vector3,
  createViewer,
  setViewerConfig,
} from '@manycore/aholo-viewer';
import { buildNavField, type NavData } from './nav';
import { WalkControls } from './walk-controls';
import { loadVoxelCollision } from './collision';
import { Companion } from './companion';

const { parseSplatData, detectSplatFileType, SplatFileType } = SplatLoader;
const { createSplat } = SplatUtils;

const DEFAULT_UP_SIGN = 1;
const params = new URLSearchParams(location.search);
const upSign = params.get('up') === '-1' ? -1 : DEFAULT_UP_SIGN;

const errors: string[] = [];
addEventListener('error', (e) => errors.push('error: ' + e.message));
addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + e.reason));

const container = document.getElementById('app')!;
const hud = document.getElementById('hud')!;
const hint = document.getElementById('hint')!;

interface GameDebugState {
  phase: string;
  fps: number;
  upSign: number;
  collision: string;
  parseMs: number | null;
  loadMs: number | null;
  camPos: { x: number; y: number; z: number } | null;
  yaw: number;
  companionAnim: string;
  companionPos: { x: number; y: number; z: number } | null;
  companionSpeed: number;
  errors: string[];
}

const state: GameDebugState = {
  phase: 'boot',
  fps: 0,
  upSign,
  collision: 'loading',
  parseMs: null,
  loadMs: null,
  camPos: null,
  yaw: 0,
  companionAnim: 'loading',
  companionPos: null,
  companionSpeed: 0,
  errors,
};

// ---- aholo-viewer：世界 + 伙计（同一场景） ----
const viewer = createViewer('long-night-inn', container, { antialiasing: false });
const gameScene = new Scene3D();
viewer.setScene(gameScene);
const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 300);
camera.enableFrustumCulling = false;
camera.enableDetailCulling = false;
viewer.setCamera(camera);
try {
  (viewer.config as never as { coordinateSystem: { enabled: { set(v: boolean): void } } })
    .coordinateSystem.enabled.set(false);
  const cul = (viewer as never as { defaultViewport: { drivenCullingConfig: Record<string, boolean> } })
    .defaultViewport.drivenCullingConfig;
  cul.frustumCullingEnabled = false;
  cul.occlusionCullingEnabled = false;
  cul.detailCullingEnabled = false;
  cul.layersCullingEnabled = false;
  cul.triCullingEnabled = false;
} catch {
  /* 配置项缺失不致命 */
}
setViewerConfig(viewer, {
  pixelRatio: 1 / window.devicePixelRatio,
  pipeline: {
    Background: {
      background: { active: BackgroundMode.BasicBackground, basic: { color: new Color(0, 0, 0) } },
      ground: { enabled: false },
    },
    Splatting: { enabled: true },
    TAA: { enabled: false },
  },
} as Parameters<typeof setViewerConfig>[1]);
viewer.resume();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  viewer.resize?.();
});

let controls: WalkControls | null = null;
let companion: Companion | null = null;
let navData: NavData | null = null;
let worldSplat: unknown = null;

// ---- 世界与伙计加载 ----
const T0 = performance.now();
(async () => {
  try {
    state.phase = 'load-nav';
    const navResp = await fetch('./assets/world-n1.nav.json');
    if (!navResp.ok) throw new Error('fetch nav HTTP ' + navResp.status);
    navData = (await navResp.json()) as NavData;

    state.phase = 'fetch-world';
    const resp = await fetch('./assets/world-n1.spz');
    if (!resp.ok) throw new Error('fetch spz HTTP ' + resp.status);
    const bytes = new Uint8Array(await resp.arrayBuffer());

    state.phase = 'parse-world';
    const t1 = performance.now();
    const type = detectSplatFileType('world.spz', bytes) ?? SplatFileType.SPZ;
    const data = await parseSplatData(type, bytes);
    state.parseMs = Math.round(performance.now() - t1);
    const splat = await createSplat(data);
    worldSplat = splat;

    state.phase = 'add-world';
    gameScene.add(splat);
    state.loadMs = Math.round(performance.now() - T0);

    const nav = buildNavField(navData, upSign);
    state.phase = 'load-collision';
    const collision = await loadVoxelCollision('./assets/collision.voxel-meta.json', './assets/collision.voxel.bin');
    state.collision = collision ? 'voxel' : 'nav-fallback';
    controls = new WalkControls(container, nav, collision);
    const spawn = spawnFromBBox(nav);
    controls.startAt(spawn.x, spawn.z, spawn.yaw);
    hint.style.opacity = '1';

    companion = new Companion(nav);
    companion.position.set(spawn.x - Math.cos(spawn.yaw) * 1.4, nav.floorAt(spawn.x, spawn.z), spawn.z);
    state.phase = 'load-companion';
    await companion.load('./assets/huoji.glb', viewer, gameScene);
    state.phase = 'rendering';

    requestAnimationFrame(loop);
  } catch (err) {
    state.phase = 'error';
    const e = err as { stack?: string; message?: string };
    errors.push('load: ' + (e?.stack ?? e?.message ?? String(err)));
    hud.textContent = 'ERROR: ' + err;
  }
})();

/** 初始机位：走廊长轴中点附近，朝长轴正方向（包围盒推导，go/no-go 探针结论） */
function spawnFromBBox(nav: ReturnType<typeof buildNavField>) {
  const [minX, , minZ] = nav.bboxMin;
  const [maxX, , maxZ] = nav.bboxMax;
  const x = minX + (maxX - minX) * 0.3;
  const z = (minZ + maxZ) * 0.5;
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  const yaw = spanX >= spanZ ? 0 : Math.PI / 2; // 长轴为 x 时朝 +x
  return { x, z, yaw };
}

// ---- 渲染循环 + HUD ----
let lastT = performance.now();
let frames = 0;
let fpsWindowStart = performance.now();

function loop(t: number) {
  const dt = Math.min((t - lastT) / 1000, 0.5);
  lastT = t;

  if (controls) {
    controls.update(dt, camera);
    (viewer as never as { forceNextFrameRender?: boolean }).forceNextFrameRender = true;
    if (companion) {
      const ps = controls.playerState;
      companion.update(ps.position, ps.yaw, dt);
    }
  }
  viewer.render();

  // HUD（每 ~500ms 刷新一次文本，避免布局抖动）
  frames++;
  if (t - fpsWindowStart > 500) {
    state.fps = Math.round((frames * 1000) / (t - fpsWindowStart));
    frames = 0;
    fpsWindowStart = t;
    const p = controls?.position;
    const cp = companion?.position;
    state.camPos = p ? { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) } : null;
    state.yaw = +(controls ? (controls.yaw * 180) / Math.PI : 0).toFixed(1);
    state.companionAnim = companion?.animName ?? 'loading';
    state.companionPos = cp ? { x: +cp.x.toFixed(2), y: +cp.y.toFixed(2), z: +cp.z.toFixed(2) } : null;
    state.companionSpeed = +(companion?.speed ?? 0).toFixed(2);
    hud.textContent =
      `phase=${state.phase} fps=${state.fps} up=${upSign}\n` +
      `cam=${state.camPos ? JSON.stringify(state.camPos) : '-'} yaw=${state.yaw}°\n` +
      `伙计: ${state.companionAnim} v=${state.companionSpeed} ${state.companionPos ? JSON.stringify(state.companionPos) : '-'}\n` +
      (state.errors.length ? `errors[${state.errors.length}]` : '');
    if (state.phase === 'rendering') hint.textContent = '点击画面进入行走模式 · WASD 移动 / 鼠标转向 / ESC 释放鼠标';
  }
  requestAnimationFrame(loop);
}

// ---- 自动化 / 调试接口 ----
(window as never as Record<string, unknown>).__game = {
  get state() {
    return { ...state, errors: [...errors] };
  },
  setInput(forward: number, strafe = 0) {
    return controls?.setInput(forward, strafe);
  },
  getPos: () =>
    controls ? { x: +controls.position.x.toFixed(3), y: +controls.position.y.toFixed(3), z: +controls.position.z.toFixed(3) } : null,
  setYaw: (yaw: number) => controls?.setYaw(yaw),
  turn: (rad: number) => controls && controls.setYaw(controls.yaw + rad),
  setCam: (x: number, y: number, z: number, yawRad: number) => {
    if (!controls) return null;
    controls.position.set(x, y, z);
    controls.setYaw(yawRad);
    return { x, y, z, yaw: yawRad };
  },
  /** 视觉调参：伙计朝向偏移微调（弧度），返回当前偏移 */
  tuneCompanion: (delta = 0) => companion?.adjustYawOffset(delta) ?? null,
  /** 取证用：冻结/恢复伙计跟随（冻结后转身可见伙计） */
  setFollow: (v: boolean) => companion?.setFollowEnabled(v) ?? null,
  /** 验证用：临时隐藏/显示伙计（像素差取证） */
  showCompanion: (v: boolean) => {
    if (companion) companion.root.visible = v;
    return v;
  },
  debugCompanion: () => companion?.debugInfo() ?? null,
  viewer: () => viewer,
  /** 验证用：隐藏/显示世界点云（排查遮挡） */
  showWorld: (v: boolean) => {
    const s = worldSplat as { visible?: boolean } | null;
    if (s && 'visible' in s) s.visible = v;
    return v;
  },
  /** 验证用：改世界纯色背景 */
  setBg: (hex: number) => {
    setViewerConfig(viewer, {
      pipeline: {
        Background: {
          background: { active: BackgroundMode.BasicBackground, basic: { color: new Color(hex) } },
          ground: { enabled: false },
        },
        Splatting: { enabled: true },
        TAA: { enabled: false },
      },
    });
    return hex;
  },
  V3: Vector3,
};
export type { GameDebugState };
