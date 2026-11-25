(function () {
  var G = (typeof document !== "undefined" && document.gameContext) ? document.gameContext : globalThis;
  var cc = G.cc;
  if (!cc) return "no cc";
  var scene = cc.director.getScene();
  if (!scene) return "no scene";

  var cb = null, crush = null, moveOut = null;
  var stack = [scene];
  while (stack.length) {
    var n = stack.pop();
    var comps = n._components || [];
    for (var i = 0; i < comps.length; i++) {
      var c = comps[i];
      if (!c) continue;
      if (!cb && ("nowLevelBlockObj" in c) && typeof c.checkIsShow === "function") cb = c;
      else if (!crush && ("crushArray" in c) && typeof c.moveOutBlock === "function") crush = c;
      else if (!moveOut && ("moveOutObj" in c)) moveOut = c;
    }
    var ch = n.children || [];
    for (var k = 0; k < ch.length; k++) stack.push(ch[k]);
  }
  if (!cb) return "no board comp";

  function blockCompOf(node) {
    var cs = (node && node._components) || [];
    for (var i = 0; i < cs.length; i++) {
      if (cs[i] && cs[i].cardDataObj && typeof cs[i].touchEnd === "function") return cs[i];
    }
    return null;
  }

  var obj = cb.nowLevelBlockObj || {};
  var blocks = [];
  for (var L in obj) for (var R in obj[L]) for (var C2 in obj[L][R]) {
    var comp = blockCompOf(obj[L][R][C2]);
    if (!comp) continue;
    blocks.push({ id: L + "-" + C2 + "-" + R, layerNum: +L, rowNum: +R, rolNum: +C2, type: comp.cardDataObj.type });
  }

  var hand = [];
  var a = (crush && crush.crushArray) || [];
  for (var i2 = 0; i2 < a.length; i2++) if (a[i2] && a[i2].cardDataObj) hand.push(a[i2].cardDataObj.type);

  var tray = [[], [], []];
  if (moveOut && moveOut.moveOutObj) {
    for (var k2 in moveOut.moveOutObj) {
      var idx = (+k2) - 1;
      if (idx < 0 || idx > 2) continue;
      var arr = moveOut.moveOutObj[k2] || [];
      for (var j = 0; j < arr.length; j++) if (arr[j] && arr[j].cardDataObj) tray[idx].push(arr[j].cardDataObj.type);
    }
  }

  var lv = cb.nowLevelData || {};
  return JSON.stringify({
    levelKey: lv.levelKey, total: blocks.length,
    blocks: blocks, hand: hand, traySlots: tray
  });
})()
