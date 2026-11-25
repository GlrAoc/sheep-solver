(function () {
  var G = (typeof document !== "undefined" && document.gameContext) ? document.gameContext : globalThis;
  var cc = G.cc;
  if (!cc) return "no cc";
  var found = null;
  function walk(node, d) {
    if (!node || d > 12 || found) return;
    var cs = node._components || [];
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      if (c && c.nowLevelData && c.nowLevelData.levelData) { found = c; break; }
    }
    var ch = node.children || [];
    for (var j = 0; j < ch.length; j++) walk(ch[j], d + 1);
  }
  walk(cc.director.getScene(), 0);
  if (!found) return "no level data";
  var d = found.nowLevelData;
  return JSON.stringify({
    levelKey: d.levelKey, widthNum: d.widthNum, heightNum: d.heightNum,
    levelData: d.levelData, blockTypeData: d.blockTypeData
  });
})()
