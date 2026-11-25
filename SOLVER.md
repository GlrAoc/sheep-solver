# 主关卡求解：从「打不通」到 910 步完整通关方案

这份文档记录本次的关键修正、可复现命令，以及每个结论对应的反编译证据。
所有脚本都不依赖 CDP，可离线跑；最后一个环节（回灌执行）才需要连微信。

---

## 1. 之前为什么打不通：规则建模错了三处

| # | 之前的模型 | 客户端真实行为 | 证据 |
|---|---|---|---|
| 1 | 手牌必须先 `< 6` 才能再点 | `removeCardNode` 只在 `getCrushBlockNum() >= 7` 时拒绝。手牌里不会残留三连（够三张立刻消），所以该值就是手牌张数 ⇒ **手牌 6 张时仍可再点一张变 7**，只要这一下凑成三连就回落，否则 7 张才真正卡死 | `removeCardNode` @1183352；`getCrushBlockNum` @1325319 |
| 2 | tray 是一个「自由池」，任意一张都能点回手牌 | `addThreeOutBlock` 把第 k 张 push 进 `moveOutObj[k+1]`；`updateBlockPosStatus` 对 `n < len-1` 的牌调 `setStatus(false)` ⇒ **tray 是 3 个 LIFO 栈，每个栈只有最上面那张可点** | `addThreeOutBlock` @3647310；`updateBlockPosStatus` @3649377 |
| 3 | 每关只能移出 1 次（`prop_remove`） | `moveOutBlock()` **没有道具计数校验**，计数校验在分享/看广告回调里；只要手牌非空就能移出 | `moveOutBlock` @1329704 |

第 2 条影响最大：它把「tray 随便取」变成「必须按后进先出还债」，也直接决定了 910 步里那 498 次取回的顺序。
第 1 条把可达空间放大了一档 —— 之前所有求解器都在一个**过窄**的模型里搜索，才会集体停在 100~170 张。

---

## 2. 求解器

| 文件 | 作用 |
|---|---|
| `beam3.js` | 忠实模型的 beam search（逐层保优 + 状态去重）。状态 = (已消集合, 有序手牌, 3 个 tray 栈, 已移出次数) |
| `verify_plan3.js` | **独立复算器**：不复用求解器代码，按客户端规则逐步重放方案，任一步非法立即报错 |
| `sim_bot.js` | **端到端**：把 `bot.js` 真实代码 eval 进 `fake_game.js` 的假场景，喂方案跑到底 |
| `fake_game.js` | 假 Cocos 场景（3 槽栈、手牌按同花色插入、`>=7` 拒点、`moveOutBlock` 无限制） |
| `bot.js` | 注入端。`setPlan()` 按方案执行，每一步用状态签名核对，漂移即中止而不是乱点 |

### 用法

```bash
# 1) 求解（离线，约 95 秒 / 246 张）
node beam3.js <board>.board.json 1200 200 300

# 2) 独立复算：每一步是否合法、是否真的清空
node verify_plan3.js <board>.board.json <board>.beam3.plan.json

# 3) 端到端：bot.js 真实代码在假场景里跑完
node sim_bot.js <board>.board.json <board>.beam3.plan.json
```

---

## 3. 实测结果

| 盘面 | 结果 | 步数 | 移出 | 取回 | 时间 |
|---|---|---|---|---|---|
| 18 张子关 `046ef1ba…` | SOLVED → 复算 WIN → 仿真 WIN | 53 | 9 | 26 | 0.7s |
| 246 张主关 `1106f9ee…`（seed `2638707585_3380513274_2442643249_3015994336`） | SOLVED → 复算 WIN → 仿真 WIN | **910** | 166 | 498 | 95.3s |
| 主关第 500 步的中途盘面（board=5, hand=5, tray=5） | 续解 10 步 → 复算 WIN → 仿真 WIN | 10 | 0 | 5 | 0.4s |

复算器输出（246 张）：

```
steps        : 910
board left   : 0
hand         : []
tray slots   : [] [] []
RESULT       : WIN - every step legal, all 3 containers empty
```

仿真器输出（`bot.js` 真实代码驱动假游戏）：

```
phase        : win  clicks=910  mode=external
board left   : 0/246
tray cards   : 0
hand         : 0
stats        : {"rejected":0,"cancelled":0,"parked":166}
RESULT       : WIN
```

`rejected=0` / `cancelled=0` 说明方案里**没有一次点击被客户端拒绝**，也没有一次点到被压住的牌。

---

## 4. 实机执行链路

```bash
# 0) MCP connect_cdp 拉起代理后，62000 只监听 IPv6，127.0.0.1 连不上
#    所有子进程都要 CDP_WS=ws://[::1]:62000
# 1) 先放 hold 标记再注入（否则注入即开跑，离线求解那 1~2 分钟会乱点）
node inject.js hold_on.js 'ws://[::1]:62000' 25000
node inject.js bot.js     'ws://[::1]:62000' 25000     # 返回 "...; HELD"

# 2) 进关、等 _boardInit=true，然后导出真实盘面（含 traySlots，可中途接管）
node eval_cdp.js --file dump_live_full.js --out live.json

# 3) 求解 + 独立复算
node beam3.js live_board.json 1200 200 300
node verify_plan3.js live_board.json live_board.beam3.plan.json

# 4) 回灌并启动（tickMs=150，内部按 tray 深度自适应降速）
node apply_plan.js live_board.beam3.plan.json
node eval_cdp.js --file start_bot.js
```

`dumpBoard()` 现在会输出 `traySlots: [[..],[..],[..]]`，因此即使中途接管（tray 里已经有牌）
也能从当前状态继续求解，不必从开局重来。

### 执行期安全阀

- 每一步执行前比对「预期状态签名」（`hand|slot1/slot2/slot3`），对不上就中止，不会连点。
- 移出后校验 tray 张数确实增加，没增加就 `stuck` 停机。
- `maxClicks: 5000`（910 步的方案留足余量）。

---

## 5. 已知限制

1. **910 步里 166 次移出**：真实客户端里这会把 3 个槽各堆到 160+ 张，`updateBlockPosStatus`
   的补间对象数量也随之暴涨。逻辑上合法（只有栈顶可点，方案也只点栈顶），但**视觉上会堆成一列**，
   帧率可能下降。若实机卡顿，把 `beam3.js` 的处罚权重从 `-150/次` 调高即可换取「移出更少」的解
   （代价：可能又回到不可解，因为 tray 债务下降会牺牲可解性）。
2. 方案是**针对具体 seed 的**。实机用 `dump_board.js` 拿到的真实盘面重新解，不要直接套用
   本仓库里那份 246 张方案（除非盘面完全一致）。
3. `beam3.js` 是启发式搜索：**出解即证明可解**，但「搜不到」不等于「不可解」。
4. 服务端本局 `sync_match_step_to_server:false`，不会逐步校验点击序列。

---

## 6. 实机结果（2026-11-12，levelKey 80001 → 90012）

| 关卡 | 盘面 | 方案 | 实机结果 |
|---|---|---|---|
| 80001 | 18 张（手牌/tray 空） | 53 步 / 9 park | **通关**，53 次动作后手牌、tray 全空，关卡切到 90012 |
| 80001（重开后再来一次） | 18 张 | 53 步 / 9 park | **通关**，53 次动作，切到 90012 |
| 90012 | 246 张 | 910 步 / 166 park | 执行到 `clicks=334`、盘面剩 5 张、tray 23 张时客户端 **48 秒无响应**，随后关卡被重置为 80001（`gameIsWin=false`、`playLevelNum=0`） |

### 6.1 实机新踩到的两个坑（都已修）

1. **补间中途采样导致「假漂移」**：点击后客户端是「先删牌、下一帧再消三连」，手牌会短暂出现
   `1,1,1,3,3` 这种 5 张未消状态。旧逻辑只等一帧就比对签名，于是每步都判漂移并回落到页内 DFS
   （那个模型的 tray 是错的），把牌打乱。现在改为：**优先等预期签名出现，或连续 8 帧不变 / 4 秒**
   才判定失败（`bot.js` 的 `pending` 分支）。
2. **`isChoosed` 残留导致 tray 卡点不动**：`updateBlockNodeData()` 把 `isChoosed` 初始化成 `true`，
   `updateBlockPosStatus()` 在补间回调里才置回 `false`。移出后立刻去点 tray 顶牌，`touchStart`
   会因为 `!isShowLight || isChoosed` 直接 return，点击被吞掉。现在 `clickComp()` 会在点击前把
   `isChoosed` 清成 `false`，并拒绝 `isShowLight===false` 的埋牌。

### 6.2 卡死与执行节奏

`clicks=334` 时 tray 峰值 33 张，日志在 `park ok #26` 后完全静默 48 秒。**不是关卡倒计时**
（`levelComp.countdown` 是每秒 +1 的用时计数器：174 → 复活重开归零 → 9 → 53 → 89）。

已加入自适应节奏（`bot.js` 的 `pace()`）：

| tray 深度 | tick |
|---|---|
| < 6 | 150ms |
| ≥ 6 | ≥ 300ms |
| ≥ 12 | ≥ 450ms |
| ≥ 20 | ≥ 700ms |
| 刚移出后 700ms 内 | 强制 ≥ 700ms |

### 6.3 可解性边界（都在 `live_main_board.json` 上实测）

| 约束 | 结果 |
|---|---|
| 无 tray 上限 | 旧盘面 910 步 / 166 park 解出（75.8s） |
| `TRAY_CAP=9 / 12 / 15 / 18 / 21` | 全部失败（剩 71 / 53 / 42 / 39 / 36 张），浅 tray 不可解 |
| 新盘面、beam 1200 | 死在第 961 层（`left=0` 但 tray 32 张、手牌 4 张，牌型被搁死） |
| 新盘面、beam 4000+ | 300s 只跑到 ~300/910 层（每层 ~1s），时间不够 |

结论：**深度 tray 是必要解**，所以执行端必须控节奏，而不是把 tray 压浅。新盘面需要更宽的搜索
（`scoreState` 里的 frontier 已改为抽样 1/6 加速，大 beam 才有希望在 15 分钟内跑完 910 层）。

---

## 7. md5 + seed → 离线生成 → 离线求解 → 按路线执行（2026-11-13 重做）

这一节是现在的主链路，替换掉「先 dump 实机盘面再解」的旧链路。

### 7.1 证据链（全部来自 `script-bundle-game.js`）

| 事实 | 位置 |
|---|---|
| `map_info_ex` 是本关地图接口（`GAMEDAILY`） | `D.mapUrls` @1373801 |
| 服务端返回 `map_md5`（数组）+ `map_seed`（4 元）+ `map_seed_2` | `serverMapPlayInfo` / `SS2C_GetSeedAck` @4417191 |
| `resetMapSeed(){ mapXorShift.setSeed(parentComp.mapSeed); random(); }` | @1170402 |
| `parentComp.mapSeed` 是 getter，读 `serverMapPlayInfo.map_seed` | getter @1170458 |
| `init()` → `resetMapSeed()` → `buildBlockTypes()` → `mapShuffle()` | @1170887 |
| `moveOutBlock()` 就是「移出」道具 | @2949936：`checkPropUseLimit(PropType.remove)` + `userData.prop_remove>=1` → `moveOutBlock()` → `prop_remove--` |

因此：

- **seed 每次点击都不同、md5 固定** → 必须在点「开始游戏/再次挑战」的瞬间抓；
- **`moveOutBlock()` 属于道具** → 「不得使用任何道具」= 不能 park = 只有 7 格手牌这一条资源。

### 7.2 新工具

| 文件 | 作用 |
|---|---|
| `hook_map.js` | 注入后每 200ms 扫场景，把 `serverMapPlayInfo.map_seed / map_md5 / map_seed_2` 写进 `G.__mapInfo`（`mapSeed` 是 getter，未就绪会抛，只读 `serverMapPlayInfo`） |
| `dump_leveldata.js` | 直接取 `cb.nowLevelData`（`levelData` + `blockTypeData` + `widthNum/heightNum/levelKey`），即客户端真正解码出来的地图，不需要下载 `.map` |
| `dump_board_raw.js` | 不依赖 bot，直接遍历场景读实机盘面 `{id, layerNum, rowNum, rolNum, type}` + 手牌 + 三个 slot |
| `generate_board.py` | 离线生成器：`XorShift.setSeed(seed)` + 丢一次 `random()` → `blockTypeData` 展开 → `mapShuffle` → 按层/行列取尾 → 遮挡判定；输出带 `id = layer-rol-row` |
| `gen_from_seed.ps1` | `__mapInfo` + `nowLevelData` → 生成 `<leveldata>.seed_....board.json`，路径写进 `last_board.txt` |
| `diff_board.js` | 逐块比对「离线生成」与「实机 dump」，身份是 `layer-rol-row:type`；不一致退出 2 |
| `dfs_nopark.js` | 禁道具精确搜索：只允许点牌面（手牌 ≤ 6 才可点），状态 =（已消集合, 手牌多重集），失败态用 53 位直映表记忆 |
| `run_offline.ps1` | 上面全部 + `verify_plan3` 复算 + 回灌执行，任一门槛不过就停，绝不点游戏 |
| `scan_seeds.ps1` | 批量随机 seed 生成 + 求解，估算「换种子能不能等到可解盘」 |

生成器 `generate_board.py` 现在给每块补 `id = "<layer>-<rol>-<row>"`，与实机 `bot.js` 的 key 完全一致，
方案可以直接按 id 回灌。

### 7.3 已验证

**① 生成器与实机逐块一致（2026-11-13，真实 seed）。** 实机 `80001`（18 张）抓到
`map_seed = 3558456125, 3673289329, 2876221802, 961763022`，`map_md5 = 046ef1ba…/b2a01d95…`：

```
generated blocks : 18
live      blocks : 18 levelKey=80001
identical        : 18
RESULT: MATCH - the seed reproduces the live board exactly
```

**② 同一块盘面禁道具解出并复算 WIN。** 只用点牌面，18 步、0 次移出：

```
SOLVED steps=18 nodes=19 time=0.0s
RESULT: WIN - every step legal, all 3 containers empty
```

说明「抓 seed → 生成 → 逐块比对 → 求解 → 复算 → 回灌」整条链路可用，且没有使用任何道具。

**③ 246 主关在禁道具下**是**可解的**——前提是搜索预算给够（几分钟，不是几十秒）。

盘面 `1106f9ee….seed_2654436761_43514_19442_21696.board.json`（246 张，24 层）：

```
SOLVED steps=246 nodes=232948721 time=209.0s  -> deep_1.plan.json
SOLVED steps=246 nodes= 99931445 time=102.7s  -> deep_2.plan.json
verify_plan3: steps 246, board left 0, hand [], tray [] [] [] , RESULT: WIN
```

两份方案**互不相同**（不同随机序搜索得到），都只点牌面、**0 次移出**，独立复算器逐条复算通过。

反例边界（同一张图、不同洗牌）：`seed_1013905231_…` 跑 300s / 3.3 亿节点仍是
`bestLeft = 43`，判 `budget hit (unknown)` —— 这只是「预算内没找到」，**不是**不可解证明。

历史误判来源：早期 35s 的 `scan_seeds` 扫了 8 个 seed 全部 `budget hit`，我把它读成了
「0/8 不可解」。把预算提到 100~210s 后立刻解出，说明那只是预算问题。`dfs_nopark.js` 的
三种判决必须区分开：

| 退出码 | 含义 |
|---|---|
| 0 | `SOLVED` —— 找到并写出可复算的通关方案（可解证明） |
| 2 | `EXHAUSTED` —— 整个状态空间被反驳完（不可解证明，至今未出现） |
| 3 | `budget hit (unknown)` —— 没找到，**什么都证明不了** |

### 7.4 结论与操作

「离线计算一定通关」在**禁道具**前提下是可实现的：246 张主关能解，但单次搜索要 100~210 秒，
所以 `run_offline.ps1` 默认 `-Workers 3`（3 个不同随机序并行，各自独立的失败表）、`-MaxSec 600`，
取第一个通过复算的方案。解得出才执行；解不出就停在第 4 步，一行都不点。

禁道具方案还有个实机好处：全程 **tray 恒空**，不会出现之前 tray 峰值 33 张导致客户端卡死的问题，
246 步也比带移出的 632 步短得多。

```powershell
# 1) 注入 seed 钩子（一次即可，重开小程序后要重注入）
node inject.js hook_map.js "ws://[::1]:62000" 40000

# 2) 点「开始游戏 / 再次挑战」后，一条命令走完：抓 seed → 生成 → 比对 → 求解 → 复算 → 执行
powershell -File run_offline.ps1                     # 默认 3 路并行 / 600s

# 只看可解性、不动游戏
powershell -File run_offline.ps1 -AnalyzeOnly
```

---

## 8. 求解器重写与「道具局」判定（2026-11-13）

### 8.1 引擎改了什么

- **不再每节点全表扫描**：哪些牌能点，原先每个节点都要把 n 张牌重算一遍；现在用增量维护的可点前沿（`clist` + `cpos` + 按花色计数 `clickable`），点击/回退时只更新真正变化的邻居。
- **遮挡图改 CSR**：`invStart/invList` 两条扁平数组，热路径里没有 `for-of`、没有临时数组/对象分配。
- **候选缓冲按深度分片**：见 8.2，这是正确性问题，不是性能问题。
- **重启抖动权重**：每个时间片给 `open/same/unlock/wide` 加随机扰动，让不同重启走**不同策略**，而不是同一条路上的不同随机数。

实测（246 张主关，4 路并行、每路 90 秒上限）：**4/4 全部解出**，27.5s / 40.0s / 46.8s / 84.5s，节点速率 1.5~2.7 M nodes/s（旧版约 0.9 M nodes/s）；单进程跑同一张图 161s 解出。

### 8.2 一个会「点出非法步」的 bug

重写时把候选列表放在全局共享缓冲区，父层在递归返回后读到的是子层覆盖过的内容，于是点了一张**仍被压住**的牌：

```
FAIL step 98: block 17-24-40 is covered by 1
```

`verify_plan3.js` 是唯一可信判据，正是它抓到的。改成 `candBuf = new Int32Array(n*(n+2))`、按 `pathLen` 分片后，同一张图复算 `RESULT: WIN`。

**纪律：任何求解器改动，先过 `node --check`，再过 `verify_plan3.js`；解出但复算不过的方案等同于没解出。**

### 8.3 7 格上限的准确定义

```js
removeCardNode(e){ ... this.crushAreaNode.getComponent(f.default).getCrushBlockNum()>=7
   ? e.reductionBlock() : (this.parentComp.addOp(...), this.deleteNode(e), ...) }

getCrushBlockNum(){ let e=this.crushArray.length;
   for(let o=0;o<this.crushArray.length-2;o++){ /* 连续三张同色 */ e-=3 }
   return e }
```

判定发生在**加点之前**，所以：点击前手牌 ≤ 6 才允许点，点完最多 7 张未成组的牌。正在播放消除动画的三张会被 `e-=3` 先扣掉，画面瞬时可能看到 8 张，但**未成组**的永远 ≤ 7 —— 求解器模型（`handSize < 7` 才可点）与客户端完全等价。

### 8.4 「道具局」的证据：378 张那局

| 手牌上限 | 结果 |
|---|---|
| 7（真实客户端） | 3 进程 × 600s、19 次重启/进程，全部 `bestLeft=16`；新版单进程 180s 到 `bestLeft=15` |
| 8 | **34.7~36.9s 解出 378 步**，但方案在第 145 步时手牌 7 张，需要第 8 张 |
| 9 | **2.1s 解出**，峰值「点击前 8 张」 |

也就是说：这张盘面存在通关顺序，但它要求手上同时压 8 张未成组的牌，而客户端在第 7 张时就拒点。**再加算力也过不去**，属于牌面本身要求道具，不是算法缺陷。

顺带做了前缀修复实验（把 8 格方案里 7 格合法的前缀喂回 7 格搜索）：前缀 138 步 → `bestLeft=27`；132 步 → `bestLeft=18`；60~90s 内都没解出。说明不是「在越界点附近改一步」那么简单。

### 8.5 新增判定工具

`diagnose.ps1`：7 格（默认 120s）→ 8 格 → 9 格逐级放宽。任何一层解出，先用 `plan_stats.js` 查该方案的**点击前手牌峰值**：

- 峰值 ≤ 6 → 交给 `verify_plan3.js` 复算，通过就判 `SOLVABLE at 7 slots`（退出码 0）；
- 峰值 > 6 → `NEEDS PROPS`（退出码 2），并打印是哪一步、要几张；
- 三层都无解 → `UNKNOWN`（退出码 3）。

`plan_stats.js` 只看方案文件本身，不碰盘面：步数、三消数、点击前峰值（及当时的牌型分布）、最终手牌、是否 7 格合法。

判定原理：8/9 格允许的走法是 7 格的**超集**，所以放宽后解出的方案一定是合法方案，只是要拿 7 格规则再验一遍。反过来「放宽能解、收紧不能解」是**强证据**而非证明——所以 `diagnose.ps1` 的措辞是「先加一次 `-Sec7` 再下结论」。



