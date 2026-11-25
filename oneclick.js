#!/usr/bin/env node
/**
 * 一键全解（本地闭环）：读牌 -> 求解 -> 独立复算 -> 挂载 -> 执行 -> 下一关
 *
 *   node oneclick.js [选项]
 *
 *   --seeds N        并行求解的随机种子路数（默认 4）
 *   --stages N       最多连续处理几关（默认 12）
 *   --solve-sec N    每路求解的秒数预算（默认 45）
 *   --exec-sec N     单关执行超时秒数（默认 900）
 *   --tick MS        点击间隔毫秒（默认 150）
 *   --seed-base N    起始种子（默认 910000）
 *   --dry            只求解不执行（安全预览）
 *   --allow-props    允许使用道具（默认禁止，方案里出现 park/tray 即中止）
 *
 * 设计原则（全部来自前两局的实测教训）：
 *   1. 牌面只从游戏对象读（dump_board_raw），不依赖 __mapInfo 钩子——页面重载会丢。
 *   2. 每次执行前必须 verify_plan3 判 WIN，否则不点。
 *   3. 只接受"手牌与托盘都为空"的干净局面，绝不从残局硬接。
 *   4. 只接受纯点击方案；一旦方案里出现道具步，直接中止。
 *   5. 多路不同种子并行，取节点最少的那条——实测差距可达 80 倍。
 *   6. bot 每步自校验状态签名，失配即 drift 停止，所以不会盲点。
 *
 * 退出码：0=至少清完一关且全部成功；1=通道/前置不满足；2=某一关无解；3=执行异常中止
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const NODE = process.execPath;

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
function num(name, def) {
  const v = opt(name, def);
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const SEEDS = num('seeds', 4);
const STAGES = num('stages', 12);
const SOLVE_SEC = num('solve-sec', 45);
const EXEC_SEC = num('exec-sec', 900);
const TICK = num('tick', 150);
const SEED_BASE = num('seed-base', 910000);
const DRY = !!opt('dry', false);
const ALLOW_PROPS = !!opt('allow-props', false);

const HAND_MAX = 7;
const WAIT_NEXT_SEC = 20;      // 清关后等下一关出现的时间
const POLL_MS = 1200;

// ---------------------------------------------------------------- 日志
const TS = new Date();
const pad = (n) => String(n).padStart(2, '0');
const STAMP = `${TS.getFullYear()}${pad(TS.getMonth() + 1)}${pad(TS.getDate())}-` +
  `${pad(TS.getHours())}${pad(TS.getMinutes())}${pad(TS.getSeconds())}`;
const LOG_DIR = path.join(DIR, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
const LOG_FILE = path.join(LOG_DIR, `oneclick-${STAMP}.log`);

function log(line, zh) {
  // 控制台只输出 ASCII，避免代码页造成的乱码；完整信息（含中文）落盘为 UTF-8
  console.log(line);
  const t = new Date().toTimeString().slice(0, 8);
  fs.appendFileSync(LOG_FILE, `[${t}] ${line}${zh ? '\n        ' + zh : ''}\n`, 'utf8');
}

function die(code, line, zh) {
  log('ABORT: ' + line, zh);
  log('LOG: ' + LOG_FILE, '完整日志已保存到上面这个文件');
  process.exit(code);
}

// ---------------------------------------------------------------- 子进程
function runN(args, opts = {}) {
  const r = spawnSync(NODE, args, {
    cwd: DIR,
    encoding: 'utf8',
    timeout: opts.timeout || 120000,
    env: Object.assign({}, process.env, opts.env || {}),
    maxBuffer: 32 * 1024 * 1024
  });
  if (r.error) return { code: -1, out: String(r.error.message || r.error) };
  return { code: r.status === null ? -1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const CDP = Object.assign({}, process.env, { CDP_WS: process.env.CDP_WS || 'ws://127.0.0.1:62000' });

// ---------------------------------------------------------------- 调试代理
const net = require('net');
const PROXY_PORT = 62000;
const PROXY_DIR = path.resolve(DIR, '..', 'WMPFDebugger');
const PROXY_PID = path.join(DIR, 'logs', 'proxy.pid');

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1200, () => { s.destroy(); resolve(false); });
  });
}

/** 谁在监听这个端口（Windows netstat 解析），拿不到返回 0 */
function portOwner(port) {
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
  for (const ln of (r.stdout || '').split(/\r?\n/)) {
    if (!ln.includes(':' + port)) continue;
    if (!/LISTENING/i.test(ln)) continue;
    const parts = ln.trim().split(/\s+/);
    const pid = parseInt(parts[parts.length - 1], 10);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return 0;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

/**
 * 从我们自己的代理日志里读出"frida 到底注入到了哪个 pid"。
 * 这是判断"代理还在跑、但挂的是已经死掉的旧 WMPF 进程"的唯一可靠依据
 * ——换微信账号、重启微信之后，WMPF 浏览器进程会换 pid，旧注入就失效了。
 */
function proxyAttachInfo() {
  let files = [];
  try { files = fs.readdirSync(LOG_DIR).filter((f) => /^proxy-.*\.log$/.test(f)); } catch (e) { return null; }
  files.sort().reverse();
  const owner = portOwner(PROXY_PORT);
  for (const f of files) {
    let txt = '';
    try { txt = fs.readFileSync(path.join(LOG_DIR, f), 'utf8'); } catch (e) { continue; }
    // 一个日志文件可能被追加了多次启动记录（proxy.cmd 固定文件名），只看最后一段
    const opens = [...txt.matchAll(/\[logger\] proxy log opened pid=(\d+) at (\S+)/g)];
    const lastOpen = opens.length ? opens[opens.length - 1] : null;
    const since = lastOpen ? txt.slice(lastOpen.index) : txt;
    const loaded = [...since.matchAll(/script loaded[^\n]*pid:\s*(\d+)/g)];
    if (!loaded.length) continue;
    const hdr = lastOpen;
    const proxyPid = hdr ? parseInt(hdr[1], 10) : 0;
    // 端口占用者已经换了 → 这份日志属于被替换掉的上一个代理，不能拿来判断当前状态
    if (owner && proxyPid && proxyPid !== owner) continue;
    const pid = parseInt(loaded[loaded.length - 1][1], 10);
    // hook 真正就绪的时刻（"script loaded" 那行的 HH:MM:SS，日期取日志头的 ISO 日期）
    // 端口 3 秒就监听，但 frida --auto-detect 要 20 秒以上才挂上 hook；两者必须分开看，
    // 否则会把"开窗口时 hook 还没挂上"误判成"代理挂错了进程"。
    let readyAt = 0;
    const rm = since.match(/(\d\d):(\d\d):(\d\d) \[frida\] script loaded/);
    if (rm && hdr) {
      const d = new Date(hdr[2]);
      d.setHours(+rm[1], +rm[2], +rm[3], 0);
      if (d.getTime() < Date.parse(hdr[2]) - 3600000) d.setTime(d.getTime() + 86400000);
      readyAt = d.getTime();
    }
    return {
      pid,
      file: f,
      proxyPid,
      startedAt: hdr ? Date.parse(hdr[2]) : 0,
      readyAt,
      miniapp: /\[miniapp\] miniapp client connected/.test(since),
      alive: !/\[logger\] proxy exit code=/.test(since) && pidAlive(pid)
    };
  }
  return null;
}

/** 当前 62000 端口占用者对应的日志文件（用来盯着 hook 什么时候挂上） */
function proxyLogForOwner() {
  const owner = portOwner(PROXY_PORT);
  let files = [];
  try { files = fs.readdirSync(LOG_DIR).filter((f) => /^proxy-.*\.log$/.test(f)); } catch (e) { return null; }
  files.sort().reverse();
  for (const f of files) {
    let txt = '';
    try { txt = fs.readFileSync(path.join(LOG_DIR, f), 'utf8'); } catch (e) { continue; }
    const opens = [...txt.matchAll(/\[logger\] proxy log opened pid=(\d+) at/g)];
    if (!opens.length) continue;
    const proxyPid = parseInt(opens[opens.length - 1][1], 10);
    if (owner && proxyPid !== owner) continue;
    return path.join(LOG_DIR, f);
  }
  return null;
}

/** 最新一个 WeChatAppEx 进程的创建时间（毫秒），判断"小程序窗口是不是代理启动后才开的" */
function newestAppexStart() {
  if (process.platform !== 'win32') return 0;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    "$p=Get-Process -Name WeChatAppEx -ErrorAction SilentlyContinue | Sort-Object StartTime -Descending | Select-Object -First 1;" +
    "if($p){$p.StartTime.ToUniversalTime().ToString('o')}"], { encoding: 'utf8', timeout: 20000 });
  const t = Date.parse(String(r.stdout || '').trim());
  return Number.isFinite(t) ? t : 0;
}

/** 打印一份现场诊断，换账号/换机器时先跑这个 */
async function diagnose() {
  log('=== diagnose ===', '现场诊断');
  for (const p of [62000, 9421]) {
    const up = await portOpen(p);
    const owner = portOwner(p);
    log(`port ${p}: ${up ? 'LISTENING' : 'closed'}${owner ? ' pid ' + owner : ''}`,
      `端口 ${p}：${up ? '监听中' : '未监听'}${owner ? '，进程 ' + owner : ''}`);
  }
  const at = proxyAttachInfo();
  if (!at) {
    log('frida attach: unknown (no proxy log matched the current port owner)',
      '看不到注入记录：代理不是本脚本启动的，或日志缺失');
  } else {
    log(`frida attach: pid ${at.pid} alive=${at.alive} miniappConnected=${at.miniapp} ` +
      `hookReadyAt=${at.readyAt ? new Date(at.readyAt).toISOString() : 'NOT YET'} ` +
      `proxyStartedAt=${at.startedAt ? new Date(at.startedAt).toISOString() : '?'} (${at.file})`,
      `注入目标：pid ${at.pid}，${at.alive ? '存活' : '已死亡'}，小程序连接=${at.miniapp ? '是' : '否'}，` +
      `hook 就绪=${at.readyAt ? new Date(at.readyAt).toLocaleTimeString() : '还没挂上'}`);
  }
  const appex = newestAppexStart();
  log('newest WeChatAppEx start: ' + (appex ? new Date(appex).toISOString() : 'unknown'),
    '最新游戏窗口进程启动时间：' + (appex ? new Date(appex).toLocaleString() : '未知'));
  const p = probe(6000);
  log('game object readable: ' + (p ? 'yes' : 'no'), '游戏对象可读：' + (p ? '是' : '否'));
  if (p && p.board) log(`level=${p.board.levelKey} blocks=${p.board.blocks} init=${p.board.init}`, '关卡信息见上');
}

/** 启动一个代理进程，输出写到 logs/proxy-*.log，返回日志路径 */
async function startProxy(tag) {
  if (!fs.existsSync(path.join(PROXY_DIR, 'src', 'index.ts'))) {
    log('[proxy] WMPFDebugger not found at ' + PROXY_DIR, '找不到 WMPFDebugger 目录：' + PROXY_DIR);
    return null;
  }
  const proxyLog = path.join(LOG_DIR, `proxy-${STAMP}${tag ? '-' + tag : ''}.log`);
  try { fs.writeFileSync(proxyLog, '', 'utf8'); } catch (e) { }
  const { spawn } = require('child_process');
  // 把当前 node 所在目录前置进 PATH：npx 依赖它，避免"双击启动时 PATH 里没有 node"
  const nodeDir = path.dirname(NODE);
  // 日志不能靠 stdout 重定向：detached 子进程 + 文件句柄在 Windows 上会丢内容（实测恒 0 字节），
  // 所以让代理自己按 MINIAPP_PROXY_LOG 打开文件写一份（见 WMPFDebugger/src/logger.ts）
  const childEnv = Object.assign({}, process.env, {
    PATH: nodeDir + path.delimiter + (process.env.PATH || ''),
    MINIAPP_PROXY_LOG: proxyLog
  });
  const p = spawn(process.env.ComSpec || 'cmd.exe',
    ['/c', 'npx', 'tsx', 'src/index.ts', '--auto-detect', '--debug-main'], {
      cwd: PROXY_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: childEnv
    });
  p.unref();
  try { fs.writeFileSync(PROXY_PID, String(p.pid), 'utf8'); } catch (e) { }

  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await portOpen(PROXY_PORT)) {
      log(`[proxy] up after ${i + 1}s (pid ${p.pid})`, `代理已就绪（${i + 1} 秒，pid ${p.pid}）`);
      log('[proxy] log: ' + proxyLog, '代理日志：' + proxyLog);
      await waitHookReady(proxyLog, 90);
      return proxyLog;
    }
  }
  log('[proxy] failed to come up in 120s, see ' + proxyLog, '代理 120 秒仍未就绪，看日志：' + proxyLog);
  return null;
}

/**
 * 等 hook 真正挂上（日志里出现 "script loaded ... pid: N"）。
 * 关键：端口监听 2-3 秒就有了，但 frida --auto-detect 要扫模块、算偏移，
 * 实测 20-25 秒才 inject 完成。这中间的窗口期里开的游戏窗口一律连不上，
 * 所以"代理就绪"必须等到这一行，而不是等到端口监听。
 */
async function waitHookReady(proxyLog, sec) {
  const t0 = Date.now();
  for (let i = 0; i < sec; i++) {
    let txt = '';
    try { txt = fs.readFileSync(proxyLog || '', 'utf8'); } catch (e) { }
    const m = txt.match(/script loaded[^\n]*pid:\s*(\d+)/);
    if (m) {
      log(`[proxy] hook ready after ${i + 1}s, frida target pid=${m[1]}`,
        `hook 已挂上（再等 ${i + 1} 秒，注入进程 pid ${m[1]}）—— 现在可以打开游戏窗口了`);
      return parseInt(m[1], 10);
    }
    const at = proxyAttachInfo();
    if (at && at.readyAt) return at.pid;
    await sleep(1000);
  }
  log('[proxy] hook still not ready after ' + sec + 's',
    `hook ${sec} 秒还没挂上，先别开游戏窗口（开了也连不上）；看日志：${proxyLog}`);
  return 0;
}

/** 在代理日志里等 "[miniapp] miniapp client connected"，最多等 sec 秒 */
async function waitMiniapp(proxyLog, sec) {
  for (let i = 0; i < sec; i++) {
    await sleep(1000);
    let txt = '';
    try { txt = fs.readFileSync(proxyLog, 'utf8'); } catch (e) { }
    if (/\[miniapp\] miniapp client connected/.test(txt)) return true;
  }
  return false;
}

/**
 * 杀掉占用端口的老代理，重新起一个。
 * 换微信账号 / 重启微信之后，WMPF 浏览器进程会换 pid，旧注入随之失效，
 * 但代理进程还活着、端口还占着 —— 只看"端口在监听"会误判成"代理可用"。
 */
async function restartProxy(reason) {
  log('[heal] ' + reason, '代理需要重启：' + reason);
  const owner = portOwner(PROXY_PORT);
  if (owner) {
    spawnSync('taskkill', ['/PID', String(owner), '/T', '/F'], { stdio: 'ignore' });
    log('[heal] killed stale proxy pid ' + owner, '已结束挂错目标的旧代理 ' + owner);
  }
  for (let i = 0; i < 20; i++) {
    if (!(await portOpen(PROXY_PORT))) break;
    await sleep(500);
  }
  return startProxy('restart');
}

/**
 * 确保 62000 上的 CDP 代理在跑。没跑就自己拉起来（脱离父进程，跑完不退出，
 * 下次直接复用；要关就用 --stop-proxy）。
 */
async function ensureProxy() {
  if (await portOpen(PROXY_PORT)) {
    log('[proxy] 62000 already listening', '代理已在运行，直接复用');
    let at = proxyAttachInfo();
    if (!at) {
      // 端口在监听但看不到 "script loaded"：多半是 auto-detect 还在跑（20 秒级）
      const lg = proxyLogForOwner();
      if (lg) {
        log('[proxy] port open but frida hook not loaded yet, waiting...',
          '代理在跑但 hook 还没挂上（正在 auto-detect），等它挂好再继续');
        const pid = await waitHookReady(lg, 60);
        if (pid) at = proxyAttachInfo();
      }
    }
    if (at && !at.alive) {
      log(`[proxy] attached pid ${at.pid} is dead -> restart`,
        `代理挂载的进程 ${at.pid} 已经不在了（微信换账号/重启都会这样），自动重启代理`);
      return !!(await restartProxy('stale frida target'));
    }
    if (at) {
      log(`[proxy] attached pid ${at.pid} alive=${at.alive} miniapp=${at.miniapp} hookReady=${!!at.readyAt}`,
        `代理挂在进程 ${at.pid} 上，小程序已连接=${at.miniapp ? '是' : '否'}`);
    }
    return true;
  }
  if (opt('no-proxy', false)) {
    log('[proxy] not running and --no-proxy set', '代理未运行，且指定了 --no-proxy');
    return false;
  }
  log('[proxy] starting WMPFDebugger --auto-detect ...', '代理未运行，正在自动启动 WMPFDebugger…');
  return !!(await startProxy(''));
}

function stopProxy() {
  let fromFile = 0;
  try {
    fromFile = parseInt(fs.readFileSync(PROXY_PID, 'utf8').trim(), 10);
    if (Number.isFinite(fromFile) && pidAlive(fromFile)) {
      process.kill(fromFile);
      log('[proxy] killed pid ' + fromFile, '已关闭代理进程 ' + fromFile);
    }
  } catch (e) {
    log('[proxy] no pid file or kill failed: ' + e.message, '没找到代理 pid，可能本来就没在跑');
  }
  // pid 文件可能是过期的（代理被别的方式重启过），以端口占用者为准再兜一次
  const owner = portOwner(PROXY_PORT);
  if (owner && owner !== fromFile) {
    spawnSync('taskkill', ['/PID', String(owner), '/T', '/F'], { stdio: 'ignore' });
    log('[proxy] killed port owner pid ' + owner, '按端口占用者关闭了代理 ' + owner);
  }
  if (!owner && !fromFile) log('[proxy] nothing to stop', '没有在跑的代理');
}

/** 在游戏 VM 里求值某个脚本文件，结果写到 out（大对象走 --out，避免 stdout 截断） */
function evalScript(file, out, waitMs) {
  const args = ['eval_cdp.js', '--file', file];
  const tmp = path.join(DIR, `.oneclick_${path.basename(file, '.js')}.json`);
  args.push('--out', tmp);
  const env = Object.assign({}, CDP);
  if (waitMs) env.EVAL_WAIT_MS = String(waitMs);
  const r = runN(args, { timeout: Math.max(40000, (waitMs || 45000) + 25000), env });
  if (r.code !== 0) return { ok: false, text: r.out, data: null };
  try {
    const data = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    if (out) fs.copyFileSync(tmp, out);
    return { ok: true, text: r.out, data };
  } catch (e) {
    return { ok: false, text: r.out + ' parse:' + e.message, data: null };
  }
}

function inject(file) {
  const r = runN(['inject.js', file], { timeout: 120000, env: CDP });
  return /\[inject\] done/.test(r.out) && !/EXCEPTION/.test(r.out);
}

// ---------------------------------------------------------------- 步骤
function probe(waitMs) {
  const r = evalScript('probe_state.js', null, waitMs);
  return r.ok ? r.data : null;
}

/**
 * 等到"有一个真实关卡在盘上"为止。这一步是必须的：
 * WMPFDebugger 的 hook 只在**小程序加载时**生效，代理启动前就已经打开的游戏
 * 不会连上 9421（代理会一直打印 "waiting for miniapp to connect"）。
 * 所以这里要提示用户把游戏窗口关掉重开，并等他进入关卡。
 */
async function waitForLevel(maxSec) {
  const t0 = Date.now();
  let lastMsg = -999;
  let fails = 0;
  let healed = false;
  let lastHealCheck = 0;
  for (;;) {
    if (maxSec > 0 && (Date.now() - t0) / 1000 > maxSec) {
      die(1, `no active level within ${maxSec}s`, `等待 ${maxSec} 秒仍未进入关卡，已退出。`);
    }
    const p = probe(8000);
    if (p && p.board && p.board.init && p.board.blocks > 0) {
      log(`[ready] level=${p.board.levelKey} blocks=${p.board.blocks}`, 
        `已接入关卡：${p.board.levelKey}，${p.board.blocks} 张`);
      return p;
    }

    if (!p) {
      fails++;
      // 读不到 → 三种可能，只有第一种该重启代理：
      //   A 注入目标进程已死（换账号/重启微信）        → 必须重启，重启 hook 才能挂上新进程
      //   B 小程序窗口是代理启动之后才开的，却没连上    → 代理挂的是旧微信进程，重启
      //   C 小程序窗口是代理启动之前就开着的（或压根没开）→ 重启没用，让用户关掉重开
      // 以前"找不到注入记录(unknown)"也会重启，等于把可能正常的 hook 白杀一遍，
      // 逼用户多关一次游戏窗口 —— 现在未知情况一律不重启。
      if (!healed && fails >= 2 && Date.now() - lastHealCheck > 20000) {
        lastHealCheck = Date.now();
        const at = proxyAttachInfo();
        const appex = newestAppexStart();
        const t = (x) => new Date(x).toTimeString().slice(0, 8);
        let why = null;
        if (at && !at.alive) {
          why = `注入目标 pid ${at.pid} 已经不在了`;
        } else if (at && at.readyAt && appex && appex > at.readyAt + 5000) {
          // 窗口是 hook 挂好之后才开的，却还没连上 → 这才是真的挂错进程
          why = `游戏窗口(${t(appex)})在 hook 就绪(${t(at.readyAt)})之后才开，却没连上 62000`;
        }
        if (why) {
          healed = true;
          await restartProxy(why);
          log('[heal] 等 hook 挂好后再开游戏窗口（下面会提示 hook ready）',
            '重启代理后 frida 还要 20 秒左右才挂上 hook，必须等它挂好再开窗口，否则还是连不上');
        } else if (at && at.miniapp) {
          log('[heal] miniapp connected, no restart needed',
            '小程序已连上调试通道，但页面里没有关卡对象 —— 请在游戏里进关卡，不用重启代理');
        } else if (at && at.readyAt && appex && appex <= at.readyAt + 5000) {
          log('[heal] window opened before hook was ready -> no restart',
            `游戏窗口(${t(appex)})开的时候 hook 还没挂好(${t(at.readyAt)})，重启也没用：` +
            '把游戏窗口关掉，从微信重新打开一次「羊了个羊：星球」就行');
        } else {
          log('[heal] attach unknown -> keep waiting (no restart)',
            '看不到 hook 记录，但不动代理（重启反而要多关一次游戏窗口）：请把游戏窗口关掉重开一次');
        }
      }
    } else {
      fails = 0;
    }

    const el = (Date.now() - t0) / 1000;
    if (el - lastMsg >= 20) {
      lastMsg = el;
      if (!p) {
        const at = proxyAttachInfo();
        const appex = newestAppexStart();
        const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);
        const bits = [];
        if (at) {
          bits.push(`注入目标pid=${at.pid} 存活=${at.alive} 小程序已连=${at.miniapp}`);
          if (at.startedAt) bits.push(`代理启动=${hhmmss(at.startedAt)}`);
          if (at.readyAt) bits.push(`hook就绪=${hhmmss(at.readyAt)}`);
        } else {
          bits.push('注入目标=未知(无hook记录)');
        }
        if (appex) bits.push(`游戏窗口起于=${hhmmss(appex)}`);
        const st = bits.join(' ');
        let hint;
        if (at && at.readyAt && appex && appex <= at.readyAt + 5000) {
          hint = '游戏窗口比 hook 早开：关掉游戏窗口，从微信重开一次即可（不用重启代理）。';
        } else if (!at || !at.readyAt) {
          hint = 'hook 还没挂上（frida auto-detect 要 20 秒），先别开游戏窗口。';
        } else {
          hint = '把游戏窗口关掉，从微信重新打开「羊了个羊：星球」，进关卡即可自动接管。';
        }
        log('[wait] cannot read the game yet (' + st + ')',
          '读不到游戏对象。诊断：' + st + '\n' +
          '        ' + hint + '\n' +
          '        （hook 只在页面加载时注入；换账号/重启微信后必须重开一次小程序。）\n' +
          '        想先看现场情况可运行：oneclick.cmd --diagnose');
      } else {
        const info = p.board ? `init=${p.board.init} blocks=${p.board.blocks} level=${p.board.levelKey}` : 'no board';
        log(`[wait] no active level (${info})`, 
          `还没进入关卡（${info}）。请在游戏里点「开始/再次挑战」，进关卡后自动接管。`);
      }
    }
    await sleep(4000);
  }
}

function dumpBoard(saveAs) {
  const r = evalScript('dump_board_raw.js', saveAs);
  return r.ok ? r.data : null;
}

function botStatus() {
  const r = evalScript('chk_bot.js');
  return r.ok ? r.data : null;
}

/** 并行多路求解，返回 {solved, best, results} */
function solveAll(boardFile, round) {
  const seeds = [];
  for (let i = 0; i < SEEDS; i++) seeds.push(SEED_BASE + round * 1000 + i * 11);

  const jobs = seeds.map((seed) => {
    const outFile = path.join(DIR, `auto_${STAMP}_s${seed}.plan.json`);
    return { seed, outFile };
  });

  // 并行：同时起 N 个进程（每个都是单线程 DFS）
  const { spawn } = require('child_process');
  return Promise.all(jobs.map((j) => new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(NODE, ['dfs_nopark.js', boardFile, String(SOLVE_SEC), '9000000000', String(j.seed)], {
      cwd: DIR,
      env: Object.assign({}, process.env, {
        HAND_MAX: String(HAND_MAX),
        PLAN_OUT: j.outFile,
        SLICE_MS: '30000'
      })
    });
    let buf = '';
    p.stdout.on('data', (d) => { buf += d.toString(); });
    p.stderr.on('data', (d) => { buf += d.toString(); });
    const killer = setTimeout(() => { try { p.kill(); } catch (e) { } }, (SOLVE_SEC + 25) * 1000);
    p.on('close', (code) => {
      clearTimeout(killer);
      const m = /SOLVED steps=(\d+) nodes=(\d+)/.exec(buf);
      const mm = /bestLeft=(\d+)\/(\d+)/.exec(buf);
      resolve({
        seed: j.seed,
        file: j.outFile,
        code,
        solved: !!m && fs.existsSync(j.outFile),
        steps: m ? +m[1] : 0,
        nodes: m ? +m[2] : 0,
        bestLeft: mm ? +mm[1] : null,
        total: mm ? +mm[2] : null,
        sec: ((Date.now() - t0) / 1000).toFixed(1)
      });
    });
  })));
}

function verify(boardFile, planFile) {
  const r = runN(['verify_plan3.js', boardFile, planFile], { timeout: 300000 });
  return { win: /RESULT\s*:\s*WIN/.test(r.out), text: r.out };
}

function applyPlan(planFile) {
  const r = runN(['apply_plan.js', planFile], { timeout: 180000, env: CDP });
  const m = /ok steps=(\d+) missing=(\d+)/.exec(r.out);
  return { ok: !!m && +m[2] === 0, steps: m ? +m[1] : 0, missing: m ? +m[2] : -1, text: r.out };
}

/** 启动 bot，并把点击间隔设成 --tick 指定的值（start_bot.js 里写死 150，这里覆盖） */
function startBot() {
  const f = path.join(DIR, '.oneclick_start.js');
  fs.writeFileSync(f,
    '(function(){var G=(typeof document!=="undefined"&&document.gameContext)?document.gameContext:globalThis;' +
    'var b=G.__sheepBot;if(!b)return "no bot";' +
    'try{if(b.cfg)b.cfg.tickMs=' + TICK + ';}catch(e){}' +
    'try{b.start();}catch(e){return "start err:"+e;}' +
    'var s=b.status();return JSON.stringify({started:true,phase:s.phase,plan:s.plan,mode:s.mode,tickMs:b.cfg&&b.cfg.tickMs});})()',
    'utf8');
  const r = runN(['inject.js', f], { timeout: 120000, env: CDP });
  const bad = /no bot|start err|EXCEPTION/.test(r.out);
  return { ok: !bad && /started/.test(r.out), text: r.out };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 单关
async function playStage(stageNo, st) {
  // 1) 局面必须干净
  if (!st) st = probe(15000);
  if (!st || !st.board) die(1, 'CDP not reachable or no board component', '调试通道不通：确认 WMPFDebugger 还在跑（62000 端口）');
  if (!st.board.init || !st.board.blocks) die(1, 'no active level (init=false or blocks=0)', '当前不在关卡内：请手动点进关卡（或点“再来一次”）后重跑');

  const levelKey = st.board.levelKey;
  const blocksN = st.board.blocks;
  log(`[stage ${stageNo}] level=${levelKey} blocks=${blocksN}`, `第 ${stageNo} 关：关卡号 ${levelKey}，场上 ${blocksN} 张`);

  // 2) 转储真实牌面
  const dumpFile = path.join(DIR, `auto_${STAMP}_stage${stageNo}.board.json`);
  const d = dumpBoard(dumpFile);
  if (!d || !Array.isArray(d.blocks)) die(1, 'dump failed', '读取牌面失败');
  if (d.hand.length || d.traySlots.some((s) => s.length)) {
    die(1, `dirty state hand=${d.hand.length} tray=${JSON.stringify(d.traySlots.map((s) => s.length))}`,
      '手牌或托盘不为空，无法使用"整盘解"；请先清空或换一局');
  }
  if (d.levelKey !== levelKey) log(`[warn] levelKey changed during dump ${levelKey} -> ${d.levelKey}`);

  // 3) 转成求解器输入
  const boardFile = path.join(DIR, `auto_${STAMP}_stage${stageNo}.solve.json`);
  const blocks = d.blocks.map((b, i) => ({
    id: b.id, rolNum: b.rolNum, rowNum: b.rowNum, layerNum: b.layerNum,
    moldType: 1, cardId: i, type: b.type, covered: false
  }));
  fs.writeFileSync(boardFile, JSON.stringify({ seed: null, blocks }), 'utf8');

  // 4) 多路求解
  const results = await solveAll(boardFile, stageNo);
  const solved = results.filter((r) => r.solved).sort((a, b) => a.nodes - b.nodes);
  const summary = results.map((r) => `s${r.seed}:${r.solved ? 'OK/' + r.nodes : 'FAIL/' + (r.bestLeft ?? '-')}`).join(' ');
  log(`[solve] ${summary}`, `求解：${summary}（OK 后为节点数，FAIL 后为最佳剩余张数）`);

  if (!solved.length) {
    const exhausted = results.some((r) => r.code === 2);
    die(2, exhausted ? 'UNSOLVABLE without props' : 'search budget exhausted',
      exhausted
        ? '该局面在 7 格手牌、不用道具的前提下已被证明无解。建议用一次「洗牌」后重跑——实测洗牌能把死局变成秒解局。'
        : '没搜到解，但也没证明无解（预算耗尽）。可以加 --solve-sec 或 --seeds 再试；或者直接洗牌。');
  }

  const best = solved[0];
  log(`[solve] best seed=${best.seed} steps=${best.steps} nodes=${best.nodes} ${best.sec}s`,
    `采用种子 ${best.seed} 的方案：${best.steps} 步，${best.nodes} 节点，耗时 ${best.sec}s`);

  // 5) 必须独立复算判 WIN
  const v = verify(boardFile, best.file);
  if (!v.win) die(3, 'verify_plan3 did not return WIN', '复算未通过，拒绝执行。\n' + v.text.slice(-600));
  log('[verify] WIN - every step legal, containers empty', '复算通过：每一步合法，三个容器最终清空');

  // 6) 只允许纯点击
  const plan = JSON.parse(fs.readFileSync(best.file, 'utf8'));
  const kinds = {};
  plan.forEach((s) => { kinds[s.kind] = (kinds[s.kind] || 0) + 1; });
  if (!ALLOW_PROPS && ((kinds.park || 0) + (kinds.tray || 0)) > 0) {
    die(3, 'plan uses props but --allow-props not set', '方案用到了道具，默认不允许，已中止');
  }
  if (plan.length !== blocksN) log(`[warn] plan steps=${plan.length} != blocks=${blocksN}`);

  if (DRY) {
    log('[dry] plan ready, not executing', '演练模式：只算不打，方案已就绪');
    return { levelKey, steps: plan.length, dry: true };
  }

  // 7) 注入 bot（页面重载后会丢）+ 挂载方案 + 启动
  if (!inject('hold_on.js')) die(3, 'inject hold failed', '注入 hold 失败');
  if (!inject('bot.js')) die(3, 'inject bot failed', '注入 bot 失败');
  const ap = applyPlan(best.file);
  if (!ap.ok) die(3, `apply_plan failed missing=${ap.missing}`, '方案与实机不匹配，拒绝执行：\n' + ap.text.slice(-400));
  log(`[exec] plan loaded steps=${ap.steps} missing=0`, `方案已挂载：${ap.steps} 步，与实机逐项吻合`);

  const base = botStatus();
  const wins0 = base ? base.wins : 0;

  const sb = startBot();
  if (!sb.ok) die(3, 'start bot failed', '启动 bot 失败');
  log('[exec] bot started tick=' + TICK + 'ms', `开始执行，点击间隔 ${TICK}ms`);

  // 8) 轮询直到过关
  const t0 = Date.now();
  let lastClicks = 0;
  let lastPrint = 0;
  let finalClicks = 0;
  for (;;) {
    await sleep(POLL_MS);
    const s = botStatus();
    if (!s) continue;
    if (typeof s.clicks === 'number') { lastClicks = s.clicks; finalClicks = s.clicks; }

    if (s.wins > wins0 || s.phase === 'win') {
      log(`[exec] DONE clicks=${s.clicks} elapsed=${Math.round((Date.now() - t0) / 1000)}s`,
        `本关完成：共点击 ${s.clicks} 次，用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
      break;
    }
    if (['drift', 'stuck', 'no-park', 'maxClicks'].includes(s.phase)) {
      // 方案已跑完（点击次数达到步数）时出现 drift，几乎都是"清空后自动进下一关"
      // 引起的状态跳变，不是失败。这种情况按完成处理，交给后面的关卡切换检查。
      if (finalClicks >= plan.length) {
        log(`[exec] DONE clicks=${s.clicks} (plan finished, level switched)`,
          `本关完成：方案 ${plan.length} 步已全部执行，游戏已切换到下一关`);
        break;
      }
      die(3, `bot aborted phase=${s.phase} clicks=${s.clicks} err=${s.lastError || '-'}`,
        `执行中止（阶段=${s.phase}）。这通常意味着实机状态和方案不一致，已停止，不会盲点。\n最近日志：\n` +
        (s.logs || []).slice(-6).join('\n'));
    }
    if ((Date.now() - t0) / 1000 > EXEC_SEC) {
      die(3, `timeout after ${EXEC_SEC}s clicks=${lastClicks}`, '执行超时，已停止');
    }
    const el = (Date.now() - t0) / 1000;
    if (el - lastPrint >= 15) {
      lastPrint = el;
      log(`[exec] ${lastClicks}/${blocksN} clicks (${Math.round(el)}s)`, `进度：${lastClicks}/${blocksN}，已用 ${Math.round(el)} 秒`);
    }
  }

  // 9) 结束校验：牌必须真正清空；或者游戏已经自己推进到下一张图
  const after = probe(15000);
  const left = after && after.board ? after.board.blocks : -1;
  const won = after && after.level ? !!after.level.gameIsWin : false;
  const lvNew = after && after.board ? after.board.levelKey : null;
  const advanced = lvNew !== null && lvNew !== levelKey;
  log(`[check] left=${left} gameIsWin=${won} level=${lvNew}${advanced ? ' advanced' : ''}`,
    `结束校验：场上剩余 ${left} 张，游戏判定通关=${won}` +
    (advanced ? `，已推进到新关卡 ${lvNew}` : ''));
  if (left > 0 && !advanced) {
    die(3, `board not empty (left=${left})`, '场上还有牌，判定为未清空，已停止');
  }

  return { levelKey, steps: plan.length, clicks: finalClicks, won, left, advanced, nextLevel: advanced ? lvNew : null };
}

// ---------------------------------------------------------------- 主流程
(async function main() {
  if (opt('stop-proxy', false)) { stopProxy(); process.exit(0); }
  if (opt('start-proxy', false)) {
    const lg = await startProxy('manual');
    process.exit(lg ? 0 : 1);
  }
  if (opt('diagnose', false)) { await diagnose(); process.exit(0); }

  log('=== oneclick start ===', '一键全解启动');
  log(`args seeds=${SEEDS} stages=${STAGES} solveSec=${SOLVE_SEC} tick=${TICK} dry=${DRY}`,
    `参数：并行 ${SEEDS} 路，最多 ${STAGES} 关，每路 ${SOLVE_SEC} 秒，点击间隔 ${TICK}ms，演练模式=${DRY}`);

  const proxyOk = await ensureProxy();
  if (!proxyOk) {
    die(1, 'CDP proxy (62000) not available', '调试代理没起来。手动启动方法：\n' +
      '  cd dbg/WMPFDebugger\n' +
      '  npx tsx src/index.ts --auto-detect\n' +
      '看到 62000 端口监听后再运行本脚本。');
  }

  let first = await waitForLevel(num('wait-sec', 0));
  log('CDP ok', '调试通道正常，已在关卡内');

  let done = 0;
  for (let i = 1; i <= STAGES; i++) {
    const r = await playStage(i, first);
    first = null;
    done++;
    if (r.dry) { log('=== dry run end ===', '演练结束，未执行任何点击'); process.exit(0); }

    // 等下一关出现；没有就认为整轮挑战结束
    log('[wait] looking for next level...', '等待下一关出现…');
    let next = null;
    for (let t = 0; t < WAIT_NEXT_SEC * 2; t++) {
      await sleep(1000);
      const p = probe(6000);
      if (p && p.board && p.board.init && p.board.blocks > 0 && p.board.levelKey !== r.levelKey) {
        next = p; break;
      }
    }
    if (!next) {
      log('=== challenge finished ===', '没有下一关了：整轮挑战已结束（结算页）。');
      log(`stages cleared=${done}`, `本次共清完 ${done} 关`);
      log('LOG: ' + LOG_FILE, '日志：' + LOG_FILE);
      process.exit(0);
    }
    log(`[next] level=${next.board.levelKey} blocks=${next.board.blocks}`,
      `下一关：关卡号 ${next.board.levelKey}，${next.board.blocks} 张`);
    first = next;
  }

  log(`=== stage limit reached (${STAGES}) ===`, `已达到关卡上限 ${STAGES}，停止`);
  log('LOG: ' + LOG_FILE, '日志：' + LOG_FILE);
  process.exit(0);
})().catch((e) => {
  log('ABORT: exception ' + (e && e.stack || e), '脚本异常终止');
  process.exit(3);
});
