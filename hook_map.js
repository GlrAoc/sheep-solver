(function () {
  var G = (typeof document !== "undefined" && document.gameContext) ? document.gameContext : globalThis;
  var cc = G.cc;
  if (!cc) return "no cc";

  var rec = {
    at: 0, mapSeed: null, mapMd5: null, mapSeed2: null, levelKey: null, src: null,
    wx: false, errs: [], seq: 0, caps: [], url: null, method: null, errCode: null
  };
  G.__mapInfo = rec;
  var MAXCAP = 6;

  // never keep the account token from the request URL
  function mask(u) {
    try { return String(u).replace(/([?&]t=)[^&]*/g, "$1***"); } catch (e) { return ""; }
  }

  // The game context exposes wx as G.wx, and it only exists after the miniapp bundle
  // finishes loading. A one-shot install at injection time can therefore miss it, so this
  // is retried from every scan tick until it sticks.
  function installTransport() {
    var w = null;
    try { w = (typeof wx !== "undefined" && wx) ? wx : (G.wx || null); } catch (e) { }
    if (!w || typeof w.request !== "function" || w.__sheepHook) return;
    try {
      var orig = w.request;
      w.request = function (opt) {
        try {
          if (opt && opt.url && String(opt.url).indexOf("map_info_ex") >= 0) {
            var o2 = {};
            for (var k in opt) o2[k] = opt[k];
            var ok = opt.success;
            o2.success = function (res) {
              try {
                var d = res && res.data;
                if (typeof d === "string") d = JSON.parse(d);
                var p = d && (d.data || d);
                if (p) {
                  rec.seq++;
                  rec.at = Date.now();
                  rec.src = "wx.request";
                  rec.url = mask(opt.url);
                  rec.method = opt.method || "GET";
                  rec.errCode = (d && d.err_code !== undefined) ? d.err_code : null;
                  if (p.map_md5) rec.mapMd5 = p.map_md5;
                  if (p.map_seed) rec.mapSeed = p.map_seed;
                  if (p.map_seed_2) rec.mapSeed2 = p.map_seed_2;
                  rec.matchDataLen = (p.match_data || "").length;
                  rec.rawKeys = [];
                  for (var kk in p) rec.rawKeys.push(kk);
                  rec.caps.push({
                    at: rec.at,
                    err: rec.errCode,
                    seed: p.map_seed ? p.map_seed.join(",") : "",
                    md5: p.map_md5 ? p.map_md5.join(",") : "",
                    seed2: p.map_seed_2
                  });
                  if (rec.caps.length > MAXCAP) rec.caps.shift();
                }
              } catch (e) { rec.errs.push("resp:" + e); }
              if (ok) return ok(res);
            };
            o2.fail = function (e) { rec.errs.push("reqfail"); if (opt.fail) return opt.fail(e); };
            return orig.call(w, o2);
          }
        } catch (e) { rec.errs.push("wrap:" + e); }
        return orig.call(w, opt);
      };
      w.__sheepHook = true;
      rec.wx = true;
    } catch (e) { rec.errs.push("wx:" + e); }
  }

  // Authoritative fallback: exactly what resetMapSeed() consumed, already parsed by the client.
  function scan() {
    installTransport();
    var lv = null, cb = null;
    function walk(node, depth) {
      if (!node || depth > 12) return;
      var cs = node._components || [];
      for (var i = 0; i < cs.length; i++) {
        var c = cs[i];
        if (!c) continue;
        // NOTE: do not touch c.mapSeed - it is a getter that throws until serverMapPlayInfo exists
        try { if (!lv && c.serverMapPlayInfo && typeof c.rebornGameFunc === "function") lv = c; } catch (e) { }
        try { if (!cb && c.nowLevelBlockObj) cb = c; } catch (e) { }
      }
      var ch = node.children || [];
      for (var j = 0; j < ch.length; j++) walk(ch[j], depth + 1);
    }
    walk(cc.director.getScene(), 0);
    if (!lv) return;
    var smp = lv.serverMapPlayInfo;
    if (smp) {
      if (smp.map_seed && smp.map_seed.length === 4) {
        rec.mapSeed = [smp.map_seed[0], smp.map_seed[1], smp.map_seed[2], smp.map_seed[3]];
        if (rec.src !== "wx.request") rec.src = "serverMapPlayInfo.map_seed";
      }
      if (smp.map_md5) rec.mapMd5 = smp.map_md5;
      if (smp.map_seed_2) rec.mapSeed2 = smp.map_seed_2;
      if (smp.match_data !== undefined) rec.matchDataLen = (smp.match_data || "").length;
      rec.hasServerInfo = true;
    }
    if (cb && cb.nowLevelData && cb.nowLevelData.levelKey) rec.levelKey = cb.nowLevelData.levelKey;
    if (cb) rec.blocks = cb._totalBlock || 0;
  }

  var setT = G.setInterval || setInterval;
  var timer = setT(scan, 200);
  G.__mapInfoStop = function () {
    try { (G.clearInterval || clearInterval)(timer); } catch (e) { }
    return "stopped";
  };
  scan();
  return "map hook installed; wx=" + rec.wx;
})()
