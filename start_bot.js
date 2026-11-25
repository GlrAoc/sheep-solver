(function () {
  var G = (typeof document !== "undefined" && document.gameContext) ? document.gameContext : globalThis;
  var b = G.__sheepBot;
  if (!b) return "no bot";
  try { if (b.cfg) b.cfg.tickMs = 150; } catch (e) { }
  try { b.start(); } catch (e) { return "start err:" + e; }
  var s = b.status();
  return JSON.stringify({ started: true, phase: s.phase, plan: s.plan, mode: s.mode, tickMs: b.cfg && b.cfg.tickMs });
})()
