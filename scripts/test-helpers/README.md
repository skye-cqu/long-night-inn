# test-helpers — 验收探针沉淀（E10，N4 验收输入③）

来源：N3/N4 验收轮实证的四个模式，沉淀为零依赖页面侧脚本（红线：不加运行时依赖、零 API）。
后续夜（N7/回响模式）与回归验收直接复用，避免重复踩「无头 rAF 停摆 + 共享浏览器劫持」两个时间黑洞。

## 文件

- `probe-installer.js` — 探针本体。**全文粘贴进游戏页执行一次**（mcp `browser_evaluate` 的
  `function` 参数即贴文件内容），安装幂等的 `window.__probe`。

## 用法（browser_evaluate 通道，N4 验收同款）

```js
// 1) 安装（每个新页面/每次被劫持重导航后重装一次）
() => { /* probe-installer.js 全文 */ }

// 2) 泵帧推进游戏时（无头 rAF 停摆兜底），返回实际推进的游戏秒数
() => __probe.pump(3)

// 3) 游戏时钟采样（速度/扣减一律以 timeLeft 差为分母，不用墙钟）
() => __probe.sample(['entity.state', 'entity.pos.x', 'entity.pos.z', 'sanity'], 4000, 400)

// 4) hop-walk 实走到世界坐标（自动朝向、逐跳核对、记录坠落软复位次数）
() => __probe.hopTo(-6.05, 3.05, { hop: 0.8, timeout: 60 })

// 5) 劫持检测 + 恢复后核对（共享浏览器被导航走后）
() => __probe.watch()      // 事前挂上
() => __probe.verifyState() // 恢复后：账本/解锁链完整性 + 当前 stage/night

// 6) 清日志
() => __probe.reset()
```

## 口径约定（沿 N4 验收报告）

1. **游戏时钟分母**：一切速度/扣减 = `Δ(状态量) / Δ(__game.night.timeLeft)`；墙钟受无头 dt 钳制失真。
2. **截图泵帧节奏** ≈0.5s 游戏时/张（`pump(0.5)` + 截图交替）。
3. **劫持恢复**：重新导航 `http://localhost:5199/?debug=1` 即可；账本在 localStorage，进度无损；
   恢复后先 `verifyState()` 再继续测。
4. 探针只读游戏状态 + 驱动既有调试 API（`__game.setInput/setYaw/api.*`），不改动游戏代码。

## 与游戏调试接口的关系

`window.__game`（见 `游戏工程/README.md`）负责「操作」；`window.__probe` 负责「测量与兜底」。
两者配合即可完成：N 夜完整流、实体招式采样（state/pos）、理智/扣减、封路口不可穿越验证
（hopTo 顶到 barrier 坐标看 finalDist 不再减小）等验收项。
