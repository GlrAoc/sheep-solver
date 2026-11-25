(function () {
  var G = (typeof document !== "undefined" && document.gameContext) ? document.gameContext : globalThis;
  var cc = G.cc;
  var out = { logs: [], level: null, board: null };
  try { out.logs = (G.__sheepBot && G.__sheepBot.logs || []).slice(-40); } catch (e) { }
  if (!cc) return JSON.stringify(out);
  var lv = null, cb = null;
  function walk(node, depth) {
    if (!node || depth > 12) return;
    var cs = node._components || [];
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      if (!c) continue;
      if (typeof c.rebornGameFunc === "function" && !lv) lv = c;
      if (c.nowLevelBlockObj && !cb) cb = c;
    }
    var ch = node.children || [];
    for (var j = 0; j < ch.length; j++) walk(ch[j], depth + 1);
  }
  walk(cc.director.getScene(), 0);
  if (lv) out.level = {
    gameOverStatus: lv.gameOverStatus, gameIsWin: lv.gameIsWin, gameIsStop: lv.gameIsStop,
    playLevelNum: lv.playLevelNum, playCount: lv.playCount, countdown: lv.countdown
  };
  if (cb) {
    var n = 0, obj = cb.nowLevelBlockObj || {};
    for (var L in obj) for (var R in obj[L]) for (var C in obj[L][R]) n++;
    out.board = { init: cb._boardInit, blocks: n, total: cb._totalBlock, levelKey: cb.nowLevelData && cb.nowLevelData.levelKey };
  }
  return JSON.stringify(out);
})()
