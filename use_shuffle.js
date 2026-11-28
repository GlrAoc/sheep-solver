// use_shuffle.js - 页面内执行「洗牌」道具（真实实现）
//
// 2026-11-26 实测修正：
//   之前用反射找名字含 shuffle 的方法，命中的全是渲染层 _resetAssembler / _resetFrame，
//   调用后牌面纹丝不动。真正的洗牌在 chessboard 组件的 updateBlockArea()：
//
//     updateBlockArea() {
//       if (this.randomPropRequest) return;
//       ... 收集所有 isShuffleBlock 的牌的 type ...
//       types = this.mapShuffle(types);          // 本地打乱
//       ... 对每张牌 beginRotate(pos, types.pop())  // 带动画换 type
//     }
//
//   语义确认：洗牌 = 位置不变、花色重排，每类数量守恒。
//   isServerRandomRequired=false 时纯本地，不需要服务端、不消耗道具次数。
//
// 返回 JSON：
//   { ok, called, before, async, err, waitMs }

(function () {
  var G = (typeof document !== "undefined" && document.gameContext) ? document.gameContext : globalThis;
  var cc = G.cc;
  if (!cc || !cc.director) return JSON.stringify({ ok: false, err: 'cc_not_found' });
  var scene = cc.director.getScene();
  if (!scene) return JSON.stringify({ ok: false, err: 'no_scene' });

  var cb = null, stack = [scene];
  while (stack.length) {
    var n = stack.pop(), cs = n._components || [];
    for (var ci = 0; ci < cs.length; ci++) {
      var x = cs[ci];
      if (x && ("nowLevelBlockObj" in x) && typeof x.checkIsShow === 'function') { cb = x; break; }
    }
    if (cb) break;
    var ch = n.children || [];
    for (var ck = 0; ck < ch.length; ck++) stack.push(ch[ck]);
  }
  if (!cb) return JSON.stringify({ ok: false, err: 'chessboard_not_found' });
  if (typeof cb.updateBlockArea !== 'function') {
    return JSON.stringify({ ok: false, err: 'no_updateBlockArea' });
  }

  // 前置：正在洗牌中则不要重入
  if (cb.randomPropRequest) {
    return JSON.stringify({ ok: false, err: 'shuffle_in_progress' });
  }

  // 记录洗牌前的 type 分布指纹，供调用方比对
  var fp = 0, cnt = 0, parts = [];
  try {
    var obj = cb.nowLevelBlockObj || {};
    for (var L in obj) for (var R in obj[L]) for (var C2 in obj[L][R]) {
      var nd = obj[L][R][C2];
      var comps = (nd && nd._components) || [];
      for (var q = 0; q < comps.length; q++) {
        var cd = comps[q] && comps[q].cardDataObj;
        if (!cd) continue;
        parts.push(String(cd.type));
        cnt++;
        break;
      }
    }
    parts.sort();
    var s = parts.join(',');
    for (var i2 = 0; i2 < s.length; i2++) { fp = ((fp << 5) - fp + s.charCodeAt(i2)) | 0; }
  } catch (e0) { }

  var err = null, ret = null, isAsync = false;
  try {
    ret = cb.updateBlockArea();
    isAsync = !!(ret && typeof ret.then === 'function');
    if (isAsync) {
      ret.then(function (v) { G.__wxsheepShuffle = { ok: true, ret: String(v) }; },
        function (e2) { G.__wxsheepShuffle = { ok: false, err: String((e2 && e2.message) || e2) }; });
    }
  } catch (e) {
    err = String((e && e.message) || e);
  }

  return JSON.stringify({
    ok: err === null,
    called: err === null,
    before: { cards: cnt, fp: fp },
    async: isAsync,
    err: err
  });
})()
