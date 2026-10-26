/**
 * main.ts — 《长夜驿站》装配：aholo-viewer 渲染 SPZ 世界 + GLB 伙计 + 第一人称行走，
 * 委托给 src/game/ 的玩法状态机（阶段三起：多夜配置化，按 NightDef 懒加载世界）。
 *
 * - viewer 初始化复用脚手架已跑通的 wiring（Scene3D + setScene、禁用 gizmo/culling）。
 * - up 约定：N1/N2 世界（Aholo World API 输出）渲染空间为 +Y up（?up=1/?up=-1 亮度梯度
 *   A/B 判定，2026-10-26）；?up=-1 仅作世界侧对照调试。
 * - 换夜：loadNightWorld(def) 拉取该夜 spz/体素/nav，换 splat 并原地更新 world 句柄
 *   （controls/companion/game 同步换导航与碰撞）。
 * - 调试：?debug=1 显示左上角技术 HUD；window.__game 见文件尾部。
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
import { Game, type WorldHandle } from './game/game';
import { NIGHTS, type NightDef } from './game/config';

const { parseSplatData, detectSplatFileType, SplatFileType } = SplatLoader;
const { createSplat } = SplatUtils;

const DEFAULT_UP_SIGN = 1;
const PAGE_T0 = performance.now(); // FTUE 冷加载计时锚点
const params = new URLSearchParams(location.search);
const upSign = params.get('up') === '-1' ? -1 : DEFAULT_UP_SIGN;
const debugHud = params.get('debug') === '1';

const errors: string[] = [];
addEventListener('error', (e) => errors.push('error: ' + e.message));
addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + e.reason));

const container = document.getElementById('app')!;
const uiRoot = document.getElementById('game-ui')!;
const hud = document.getElementById('hud')!;
const hint = document.getElementById('hint')!;
if (!debugHud) hud.style.display = 'none';

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
let game: Game | null = null;
let worldSplat: unknown = null;

/** 世界运行时句柄（Game 只读；换夜时本模块原地更新字段） */
const world: WorldHandle = { nav: null as never, collision: null, night: 0 };

/** 按夜懒加载世界资产：换 splat + 换导航/碰撞（同夜并发请求合并） */
let loadingNight: { night: number; promise: Promise<void> } | null = null;
function loadNightWorld(def: NightDef): Promise<void> {
  if (world.night === def.night) return Promise.resolve();
  if (loadingNight && loadingNight.night === def.night) return loadingNight.promise;
  const promise = (async () => {
    state.phase = 'load-night' + def.night;
    const navResp = await fetch(def.world.nav);
    if (!navResp.ok) throw new Error('fetch nav HTTP ' + navResp.status);
    const navData = (await navResp.json()) as NavData;

    const resp = await fetch(def.world.spz);
    if (!resp.ok) throw new Error('fetch spz HTTP ' + navResp.status);
    const bytes = new Uint8Array(await resp.arrayBuffer());

    state.phase = 'parse-world';
    const type = detectSplatFileType('world.spz', bytes) ?? SplatFileType.SPZ;
    const data = await parseSplatData(type, bytes);
    const splat = await createSplat(data);

    // 换世界：旧 splat 摘除、新 splat 上场（世界对象由 GC/引擎处置）
    if (worldSplat) gameScene.remove(worldSplat as never);
    gameScene.add(splat as never);
    gameScene.notifySceneChange?.();
    worldSplat = splat;

    const nav = buildNavField(navData, upSign);
    const collision = await loadVoxelCollision(def.world.voxelMeta, def.world.voxelBin);
    state.collision = collision ? 'voxel' : 'nav-fallback';
    controls?.setWorld(nav, collision);
    controls?.setBarriers(def.barriers ?? []); // 物理封路（N6 落差口隐形墙；缺省空=无）
    companion?.setNav(nav);
    world.nav = nav;
    world.collision = collision;
    world.night = def.night;
    state.phase = 'ready';
  })();
  loadingNight = { night: def.night, promise };
  promise.finally(() => {
    if (loadingNight && loadingNight.promise === promise) loadingNight = null;
  });
  return promise;
}

// ---- 世界与伙计加载（标题页期间后台进行；N1 启动即载） ----
const T0 = performance.now();
(async () => {
  try {
    const def1 = NIGHTS[0]!;
    state.phase = 'load-nav';
    const navResp = await fetch(def1.world.nav);
    if (!navResp.ok) throw new Error('fetch nav HTTP ' + navResp.status);
    const navData = (await navResp.json()) as NavData;

    state.phase = 'fetch-world';
    const resp = await fetch(def1.world.spz);
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
    const collision = await loadVoxelCollision(def1.world.voxelMeta, def1.world.voxelBin);
    state.collision = collision ? 'voxel' : 'nav-fallback';
    world.nav = nav;
    world.collision = collision;
    world.night = def1.night;
    controls = new WalkControls(container, nav, collision);
    controls.setRuntimeEnabled(false); // 标题页阶段禁输入

    companion = new Companion(nav);
    state.phase = 'load-companion';
    await companion.load('./assets/huoji.glb', viewer, gameScene);
    state.phase = 'ready';

    // 玩法状态机（标题页在资产就绪后弹出；标题遮挡期间世界已在后台加载完毕）
    game = new Game({
      scene: gameScene,
      viewer,
      world,
      loadNightWorld,
      controls,
      companion,
      appContainer: container,
      uiRoot,
      hint,
    });
    game.begin();
    game.markBoot(PAGE_T0);
    requestAnimationFrame(loop);
  } catch (err) {
    state.phase = 'error';
    const e = err as { stack?: string; message?: string };
    errors.push('load: ' + (e?.stack ?? e?.message ?? String(err)));
    hud.style.display = debugHud ? '' : 'block';
    hud.textContent = 'ERROR: ' + err;
  }
})();

// ---- 渲染循环 + 技术调试 HUD ----
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
  if (game) game.update(dt, t / 1000);
  viewer.render();

  frames++;
  if (t - fpsWindowStart > 500) {
    state.fps = Math.round((frames * 1000) / (t - fpsWindowStart));
    frames = 0;
    fpsWindowStart = t;
    if (debugHud) {
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
        (game ? `stage=${(game as { stage?: string }).stage}\n` : '') +
        (state.errors.length ? `errors[${state.errors.length}]` : '');
    }
  }
  requestAnimationFrame(loop);
}

// ---- 自动化 / 调试接口 ----
(window as never as Record<string, unknown>).__game = {
  get state() {
    return { ...state, stage: game?.stage ?? null, night: world.night, errors: [...errors] };
  },
  get night() {
    return game?.debug ?? null;
  },
  setInput(forward: number, strafe = 0) {
    return controls?.setInput(forward, strafe);
  },
  setSprint: (v: boolean) => controls?.setSprint(v) ?? null,
  setCrouch: (v: boolean) => controls?.setCrouch(v) ?? null,
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
  /** 阶段直达：title/morning/dive/settle/talk/progress */
  goto: (stage: string) => (game as unknown as { goto(s: string): void })?.goto(stage as never),
  /** 夜直达（1 起算）：换配置回晨间，世界后台加载；配合 goto('dive') 冒烟 */
  enterNight: (n: number) => game?.enterNight(n) ?? null,
  /** 验收快捷：完整 API 集（pickup/speak/setTimer/entityChase/returnHome/ledger…） */
  get api() {
    return game?.api ?? null;
  },
  /** 视觉调参：伙计朝向偏移微调（弧度），返回当前偏移 */
  tuneCompanion: (delta = 0) => companion?.adjustYawOffset(delta) ?? null,
  setFollow: (v: boolean) => companion?.setFollowEnabled(v) ?? null,
  showCompanion: (v: boolean) => {
    if (companion) companion.root.visible = v;
    return v;
  },
  debugCompanion: () => companion?.debugInfo() ?? null,
  viewer: () => viewer,
  showWorld: (v: boolean) => {
    const s = worldSplat as { visible?: boolean } | null;
    if (s && 'visible' in s) s.visible = v;
    return v;
  },
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
