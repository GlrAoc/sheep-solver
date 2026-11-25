# 羊了个羊 离线求解

> 出处说明：求解器骨架源自社区开源项目（原作者 `juice`），本仓库在其基础上重写了读牌通道、执行链路与一键编排，并补充了运维文档与自检工具。

把当天的牌面在本地还原出来，先算出通关顺序，确认没问题再让脚本按顺序点。

牌面数据取自小程序自己收到的响应（`map_md5` 和 `map_seed`），不是猜的，也不是服务端重放。算出来的方案会用一个独立的复算脚本整份重放一遍，牌全清、三个容器都空才动手；任何一步对不上就停。

## 需要什么

- Windows 10 / 11
- Node.js 22 以上（用的是内置 `WebSocket`，项目本身没有 npm 依赖，不用 `npm install`）
- Python 3.8 以上（只用标准库）
- 微信 PC 版 4.x
- [WMPFDebugger](https://github.com/evi0s/WMPFDebugger)，第三方工具，得单独装

WMPFDebugger 负责把微信小程序的私有调试协议转成标准 CDP，没有它连不上游戏进程。

```powershell
git clone https://github.com/evi0s/WMPFDebugger
cd WMPFDebugger
yarn
npx ts-node src/index.ts
```

它需要 Node 22+ 和 yarn，默认在 `62000` 端口开代理。支持哪些微信版本、怎么查版本号，看它自己的 README。**这个窗口跑起来就别关了**，关掉等于断线。

## 跑起来

代理在窗口 A 跑着，窗口 B 进本目录：

```powershell
$env:CDP_WS='ws://[::1]:62000'
node eval_cdp.js --file read_mapinfo.js
```

能打印出对象就是通了。连不上就换成 `ws://127.0.0.1:62000`，有的构建只监听 IPv6。

微信里打开游戏，停在「开始游戏」那一屏，先别点。然后体检：

```powershell
powershell -File preflight.ps1
```

出现 `READY` 再往下。`NOT READY` 说明代理断了，或者游戏正停在结算、暂停这些不跑 JS 的界面。

```powershell
powershell -File watch.ps1
```

现在回微信点「开始游戏」。之后每过一关点一次「下一关」，剩下的它自己跑。

只打一关、不想挂着：

```powershell
powershell -File run_offline.ps1
```

## 它做了什么

1. 装一个钩子，从客户端的响应里取种子；
2. 用种子离线重建整张牌面；
3. 和实机上每张牌的位置、花色逐块比对，不一致就停；
4. 搜索通关顺序；
5. 独立复算整份方案，必须全清；
6. 回灌给执行器，每步点之前再核对一次花色。

第 3 步开始，任何一步不过都是一行都不点。

手牌上限按客户端的真实规则算（未成组的牌最多 7 张），不是估的。

## 命令

| 命令 | 干什么 |
|---|---|
| `preflight.ps1` | 检查端口、JS 是否在跑、钩子是否装上 |
| `run_offline.ps1` | 跑一轮完整流程，直接点 |
| `watch.ps1` | 挂着等新牌面，自动跑上一行 |
| `diagnose.ps1` | 算不出来时判定原因 |
| `verify_plan3.js` | 复算器，唯一可信的判据 |
| `plan_stats.js` | 看方案要几张手牌、是否合法 |

```powershell
powershell -File run_offline.ps1 -MaxSec 900 -Workers 3   # 每进程 900 秒，3 路并行
powershell -File run_offline.ps1 -AnalyzeOnly            # 只算不打
powershell -File diagnose.ps1 -Sec7 300                  # 先给 7 格搜索 300 秒
```

`-Workers` 是并行进程数，各自用不同随机序，谁先解出用谁。8 GB 内存建议不超过 3。

## 算不出来的时候

求解器有三种结果，区别很大：

| 输出 | 意思 |
|---|---|
| `SOLVED` | 找到方案了，文件也写出来了 |
| `EXHAUSTED` | 整个搜索空间被反驳完，确实无解 |
| `budget hit` | 预算内没找到，**不代表过不了** |

看到 `budget hit` 先跑一次判定：

```powershell
powershell -File diagnose.ps1
```

它会把上限放宽到 8 格、9 格再搜。放宽后允许的走法更多，所以解出来的方案一定是合法方案，只是要拿 7 格规则再验一遍：手牌峰值不超过 6 就能直接用。

如果 7 格怎么都算不出、8 格却几秒就出来，而且那份方案确实要第 8 张牌，那这局牌面本身就要求多一张手牌，客户端会直接拒点，换算法也过不去。`diagnose.ps1` 会把这种情况标成 `NEEDS PROPS`，省得白耗。

## 常见问题

**连不上 62000**：先确认代理窗口还活着，再试 `ws://[::1]:62000`。

**`[eval] timeout after 15s`**：游戏此刻不跑 JS，切回游戏让画面动一下再跑。

**算得慢**：正常。两百多张的关卡单进程要几十秒到几分钟，牌面越乱越久。

**会不会点错**：每一步点之前都会核对那个位置现在应该是哪张牌，不一致就整局停手。

## 文件

| 文件 | 作用 |
|---|---|
| `watch.ps1` `preflight.ps1` `run_offline.ps1` `diagnose.ps1` | 入口脚本 |
| `gen_from_seed.ps1` `generate_board.py` | 取种子、用种子重建牌面 |
| `dfs_nopark.js` | 求解器 |
| `verify_plan3.js` `plan_stats.js` | 复算、方案统计 |
| `eval_cdp.js` `inject.js` | 在游戏进程里执行 / 注入 JS |
| `hook_map.js` | 取种子的钩子 |
| `bot.js` `hold_on.js` `start_bot.js` `apply_plan.js` | 执行器 |
| `diff_board.js` | 离线牌面和实机牌面逐块比对 |
| `SOLVER.md` | 算法、证据链、验证记录 |
| `evidence/` | 两张已验证方案的样本和对应牌面 |

运行时会生成 `mapinfo.json`、`leveldata.json`、`live_gen.json`、`last_board.txt`、`leveldata.seed_*.board.json`、`watch_state.json`、`.plan_expr.js`、`nopark_*.plan.json`、`diag_h*.plan.json`，都是中间文件，删了下次会重新生成。

## 免责

本项目只用于个人学习和技术研究，比如逆向工程、搜索算法、自动化测试，不要用于商业用途。

它不修改游戏客户端，不修改存档和服务端数据，不碰道具、复活、广告这些接口。但自动化操作本身可能违反游戏用户协议，账号风险自己承担。本项目和腾讯、微信、《羊了个羊》及其开发者没有任何关系，也没有得到他们的授权或认可。

代码按现状提供，不附带任何担保，使用造成的直接或间接损失作者不负责。如果相关权利方认为不妥，联系删除。

第三方工具 [WMPFDebugger](https://github.com/evi0s/WMPFDebugger) 以 GPL-2.0 发布，本项目不包含它的代码，只是调用它开的端口。
