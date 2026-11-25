(function () {
  var G = (typeof document !== "undefined" && document.gameContext) ? document.gameContext : globalThis;
  G.__sheepHold = true;
  return "hold=true";
})()
