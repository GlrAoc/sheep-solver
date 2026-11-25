#!/usr/bin/env node
/**
 * 环境自检：一条命令看清"这套东西现在能不能用"，以及不能用时该修哪里。
 *
 *   node doctor.js
 *
 * 只读检查，不改任何文件、不动代理。输出 PASS/FAIL/WARN 表格 + 修复建议。
 * 退出码：0 全部关键项通过；1 有 FAIL。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const PROXY_DIR = path.resolve(DIR, '..', 'WMPFDebugger');
const LOG_DIR = path.join(DIR, 'logs');
const NODE = process.execPath;

const rows = [];
function rec(level, name, detail, fix) {
  rows.push({ level, name, detail, fix: level === 'PASS' ? '' : fix || '' });
}
const pass = (n, d) => rec('PASS', n, d);
const warn = (n, d, f) => rec('WARN', n, d, f);
const fail = (n, d, f) => rec('FAIL', n, d, f);

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000 });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1200, () => { s.destroy(); resolve(false); });
  });
}

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

/** 与 oneclick.js 同一套解析：取最后一次 proxy log opened 分段 */
function proxyAttachInfo() {
  let files = [];
  try { files = fs.readdirSync(LOG_DIR).filter((f) => /^proxy-.*\.log$/.test(f)); } catch (e) { return null; }
  files.sort().reverse();
  const owner = portOwner(62000);
  for (const f of files) {
    let txt = '';
    try { txt = fs.readFileSync(path.join(LOG_DIR, f), 'utf8'); } catch (e) { continue; }
    const opens = [...txt.matchAll(/\[logger\] proxy log opened pid=(\d+) at (\S+)/g)];
    const last = opens.length ? opens[opens.length - 1] : null;
    const since = last ? txt.slice(last.index) : txt;
    const loaded = [...since.matchAll(/script loaded[^\n]*pid:\s*(\d+)/g)];
    if (!loaded.length) continue;
    const pPid = last ? parseInt(last[1], 10) : 0;
    if (owner && pPid && pPid !== owner) continue;
    const pid = parseInt(loaded[loaded.length - 1][1], 10);
    let readyAt = 0;
    const rm = since.match(/(\d\d):(\d\d):(\d\d) \[frida\] script loaded/);
    if (rm && last) {
      const d = new Date(last[2]);
      d.setHours(+rm[1], +rm[2], +rm[3], 0);
      if (d.getTime() < Date.parse(last[2]) - 3600000) d.setTime(d.getTime() + 86400000);
      readyAt = d.getTime();
    }
    return {
      pid, file: f,
      miniapp: /\[miniapp\] miniapp client connected/.test(since),
      alive: !/\[logger\] proxy exit code=/.test(since) && pidAlive(pid),
      readyAt
    };
  }
  return null;
}

(async function main() {
  console.log('=== doctor: 环境自检 ===\n');

  // 1 node
  const nv = process.versions.node;
  const major = parseInt(nv.split('.')[0], 10);
  if (major >= 18) pass('node', `v${nv} (${NODE})`);
  else fail('node', `v${nv} 太旧`, '装 Node 18+；本项目在 v22.22.2 上验证');

  // 2 代理目录
  const entry = path.join(PROXY_DIR, 'src', 'index.ts');
  if (fs.existsSync(entry)) pass('WMPFDebugger', PROXY_DIR);
  else fail('WMPFDebugger', '缺 src/index.ts: ' + PROXY_DIR, '按 docs/ENVIRONMENT.md 第 3.1 节 clone');

  // 3 tsx
  const tsx = path.join(PROXY_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (fs.existsSync(tsx)) pass('tsx', 'node_modules/tsx 已安装');
  else fail('tsx', '缺 node_modules/tsx', 'cd WMPFDebugger && yarn install（先换成 npmmirror 源）');

  // 4 frida binding（最关键的一条）
  const binding = path.join(PROXY_DIR, 'node_modules', 'frida', 'build', 'frida_binding.node');
  if (fs.existsSync(binding)) {
    const sz = fs.statSync(binding).size;
    const sha = require('crypto').createHash('sha256').update(fs.readFileSync(binding)).digest('hex');
    const good = sz === 132846592;
    const expect = '7f94e98aee0f6527e8f1fdcf1ee0c7d296a591d7c8dd0ee16bbb07b8bfeeb443';
    if (good && sha === expect) pass('frida binding', `${(sz / 1048576).toFixed(0)}MB, sha256 ${sha.slice(0, 12)}…`);
    else warn('frida binding', `${(sz / 1048576).toFixed(0)}MB, sha256 ${sha.slice(0, 12)}… 与已验证值不符`,
      '若能用可忽略；不能用就重新解压 frida-v17.18.0-napi-v8-win32-x64.tar.gz');
  } else {
    fail('frida binding', '缺 node_modules/frida/build/frida_binding.node',
      '解压 frida-v17.18.0-napi-v8-win32-x64.tar.gz 到 node_modules/frida/（见 ENVIRONMENT 3.4）');
  }

  // 5 日志目录可写
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
    const probe = path.join(LOG_DIR, '.doctor_probe');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    pass('logs 目录', '可写');
  } catch (e) {
    fail('logs 目录', '不可写: ' + e.message, '检查磁盘权限/杀软');
  }

  // 6 端口与代理状态
  const up62000 = await portOpen(62000);
  const up9421 = await portOpen(9421);
  if (up62000 && up9421) {
    const owner = portOwner(62000);
    const at = proxyAttachInfo();
    if (!at) {
      warn('代理 62000/9421', `LISTENING pid ${owner}，但日志里没有 script loaded`,
        '可能仍在 auto-detect（等 20-25s）；或是别的方式启动的代理。等一下再看，或用 oneclick.cmd --start-proxy 重启');
    } else if (!at.alive) {
      fail('代理注入目标', `pid ${at.pid} 已退出`, 'oneclick.cmd --stop-proxy 后重开，或直接 oneclick.cmd');
    } else if (at.readyAt) {
      pass('代理就绪', `pid ${at.pid}，hook 就绪 ${new Date(at.readyAt).toLocaleTimeString()}，小程序已连=${at.miniapp ? '是' : '否'}`);
    } else {
      warn('代理就绪', `pid ${at.pid}，但未解析到 hook 就绪时刻`, '看日志里有没有 "[frida] script loaded"');
    }
  } else {
    warn('代理 62000/9421', `未监听（62000=${up62000} 9421=${up9421}）`, 'oneclick.cmd --start-proxy');
  }

  // 7 脚本编码（chcp 936 下 .cmd 必须纯 ASCII）
  for (const f of fs.readdirSync(DIR).filter((x) => /\.cmd$/i.test(x))) {
    const b = fs.readFileSync(path.join(DIR, f));
    const non = [...b].filter((x) => x > 127).length;
    const bare = (b.toString('binary').match(/(?<!\r)\n/g) || []).length;
    if (non === 0 && bare === 0) pass('编码 ' + f, 'ASCII + CRLF');
    else fail('编码 ' + f, `non-ascii=${non} bareLF=${bare}`,
      'chcp 936 的 .cmd 混入中文/LF 会让 cmd.exe 按字节错位解析（见 RUNBOOK 第 4 节）。重写为纯 ASCII + CRLF');
  }

  // 8 微信进程
  const wx = sh('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-Process -Name WeChatAppEx -ErrorAction SilentlyContinue | Measure-Object).Count"]);
  const cnt = parseInt(wx.out, 10);
  if (Number.isFinite(cnt) && cnt > 0) pass('WeChatAppEx', `${cnt} 个进程`);
  else warn('WeChatAppEx', '没找到微信小程序进程', '先打开微信');

  // 输出
  const w1 = Math.max(...rows.map((r) => r.name.length), 12);
  console.log('状态   检查项'.padEnd(w1 + 8) + ' 说明');
  console.log('-'.repeat(w1 + 60));
  for (const r of rows) {
    console.log((r.level + '   ').padEnd(8) + r.name.padEnd(w1 + 2) + ' ' + r.detail);
    if (r.fix) console.log(' '.repeat(10 + w1 + 2) + '→ ' + r.fix);
  }

  const fails = rows.filter((r) => r.level === 'FAIL').length;
  const warns = rows.filter((r) => r.level === 'WARN').length;
  console.log('\n合计：PASS ' + rows.filter((r) => r.level === 'PASS').length +
    '，WARN ' + warns + '，FAIL ' + fails);
  if (fails) {
    console.log('\n有 FAIL：按上面的箭头逐条修，修完再跑一次 doctor。');
    process.exit(1);
  }
  console.log('\n关键项全部通过。用法：oneclick.cmd --start-proxy → 等 hook ready → 开游戏窗口 → oneclick.cmd');
})();
