#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
羊了个羊 棋盘还原器 (由 .map + map_seed 复现客户端牌面)

对齐客户端逻辑:
  resetMapSeed()            xorshift.setSeed(mapSeed); random() 丢一次
  createBlockTypeObj()      for type in sorted(blockTypeData): push type * (3*cardNum)
                            mapShuffle()  -> Fisher-Yates(xorshift)
  initBlockNodeLayer()      遍历 Object.keys(levelData)（数字键 -> 升序）与 list 顺序
  SetBlockCardType()        type==0 -> blockTypeArr.pop()   (从尾部取)
  checkIsShow()             layer 更大 且 |rowDiff|<8 且 |rolDiff|<8 -> 被压住不可点
"""
import sys, json, collections

MASK = 0xFFFFFFFF


class XorShift:
    """Cocos Creator xorshift128 (npm 'xorshift') 逐位对齐实现"""

    def __init__(self, seed):
        self.set_seed(seed)

    def set_seed(self, seed):
        assert len(seed) == 4, "seed must be array with 4 numbers"
        u = [x & MASK for x in seed]
        self.s0u, self.s0l, self.s1u, self.s1l = u
        self.times = 0

    def randomint(self):
        e, t, n, i = self.s0u, self.s0l, self.s1u, self.s1l
        o = t + i                       # 64-bit add of (n,e) + (i,t)
        a = (n + e + (1 if o > MASK else 0)) & MASK
        r = o & MASK
        self.s0u, self.s0l = n, i
        e1 = (((e << 23) & MASK) | ((t & 0xFFFFFE00) >> 9)) & MASK   # s
        t1 = (t << 23) & MASK                                        # c
        e ^= e1                                                      # e ^= s
        t ^= t1                                                      # t ^= c
        s = (e ^ n) & MASK
        c = (t ^ i) & MASK
        s ^= (e >> 18)
        c ^= ((t >> 18) | ((e & 0x3FFFF) << 14)) & MASK
        s ^= (n >> 5)
        c ^= ((i >> 5) | ((n & 0x1F) << 27)) & MASK
        self.s1u, self.s1l = s & MASK, c & MASK
        return a, r

    def random(self):
        self.times += 1
        a, b = self.randomint()
        return 2.3283064365386963e-10 * a + 2220446049250313e-31 * (b >> 12)


def shuffle(arr, xs):
    for i in range(len(arr) - 1, -1, -1):
        j = int(xs.random() * (i + 1))
        arr[i], arr[j] = arr[j], arr[i]
    return arr


def build_board(m, seed):
    xs = XorShift(seed)
    xs.random()                                   # resetMapSeed(): 丢一次

    pool = []
    for t in sorted(m["blockTypeData"], key=lambda k: int(k)):
        pool += [int(t)] * (3 * int(m["blockTypeData"][t]))
    shuffle(pool, xs)                             # mapShuffle

    keys = sorted(m["levelData"], key=lambda k: int(k))   # JS 整数键升序
    blocks = []
    for k in keys:
        for n in m["levelData"][k]:               # 保持 list 原序
            # 客户端序列化地图时会把值为 0 的字段省掉，所以贴在第 0 行（rowNum=0）
            # 的块在 json 里根本没有 rowNum 这个键。id 是 "<layer>-<rol>-<row>"，
            # 三个坐标都在，缺什么就从 id 里补回来。
            n = dict(n)
            if "rowNum" not in n or "rolNum" not in n or "layerNum" not in n:
                parts = str(n.get("id", "")).split("-")
                if len(parts) == 3:
                    n.setdefault("layerNum", int(parts[0]))
                    n.setdefault("rolNum", int(parts[1]))
                    n.setdefault("rowNum", int(parts[2]))
            for c in ("layerNum", "rolNum", "rowNum"):
                if c not in n:
                    raise SystemExit("block %r has no %s and no parsable id" % (n.get("id"), c))
            if n["type"] == 0:
                n["type"] = pool.pop()            # SetBlockCardType
            blocks.append(n)

    # 遮挡: 是否被更高层 ±1 格内的块压住
    by_layer = collections.defaultdict(list)
    for b in blocks:
        by_layer[b["layerNum"]].append(b)
    for b in blocks:
        b["covered"] = False
        for L, arr in by_layer.items():
            if L <= b["layerNum"]:
                continue
            for o in arr:
                if abs(o["rowNum"] - b["rowNum"]) < 8 and abs(o["rolNum"] - b["rolNum"]) < 8:
                    b["covered"] = True
                    break
            if b["covered"]:
                break
    return blocks


def render(blocks, width, height, sub=8, layer=None):
    grid = [["." for _ in range(width)] for _ in range(height)]
    for b in blocks:
        if layer is not None and b["layerNum"] != layer:
            continue
        r, c = b["rowNum"] // sub, b["rolNum"] // sub
        if 0 <= r < height and 0 <= c < width:
            ch = str(b["layerNum"] % 10)
            grid[r][c] = ch if grid[r][c] in "." else "#"
    return "\n".join("".join(row) for row in grid)


def main(json_path, seed):
    m = json.load(open(json_path, encoding="utf-8"))
    blocks = build_board(m, seed)
    layers = collections.Counter(b["layerNum"] for b in blocks)
    types = collections.Counter(b["type"] for b in blocks)
    cov = sum(1 for b in blocks if b["covered"])

    print(f"map levelKey={m['levelKey']} widthNum={m['widthNum']} heightNum={m['heightNum']}")
    print(f"seed={seed}")
    print(f"blocks={len(blocks)} layers={sorted(layers)}")
    print(f"types={dict(sorted(types.items()))}")
    print(f"每花色张数 %3 == 0 : {all(v % 3 == 0 for v in types.values())}")
    print(f"开局被压住={cov}  可点={len(blocks)-cov}")
    print("\n[顶层覆盖图  0-9a-o=层号, #=同格多块]")
    print(render(blocks, m["widthNum"], m["heightNum"]))
    for L in sorted(layers):
        print(f"\n[layer {L}] {layers[L]} blocks")
        print(render(blocks, m["widthNum"], m["heightNum"], layer=L))

    # the live client keys every block as "<layer>-<rol>-<row>" (bot.js uses the same key),
    # so plans can be matched back onto the running board by id alone
    for b in blocks:
        b["id"] = f"{b['layerNum']}-{b['rolNum']}-{b['rowNum']}"

    out = json_path.replace(".json", f".seed_{'_'.join(map(str, seed))}.board.json")
    json.dump({"seed": seed, "blocks": blocks}, open(out, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"\n[out] {out}")


if __name__ == "__main__":
    jp = sys.argv[1]
    sd = [int(x) for x in sys.argv[2:6]] or [589667220, 4047304004, 62666966, 3333988324]
    main(jp, sd if len(sd) == 4 else [589667220, 4047304004, 62666966, 3333988324])
