#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 FM-1 音色台的随附入门音色库（starter bank）。

为什么要有这个东西
------------------
出厂音色的参数集权利链在 Yamaha 那一层就断了（见 LICENSE-AUDIT.md），
所以仓库不能分发它 —— 但"clone 下来点开是空的"不是一个能接受的结果。
解法是：仓库自带一份**本项目原创设计**的音色库，权利完全干净，可以随
仓库自由分发。出厂音色则由页面在运行时从上游取，两件事互不干扰。

这 32 个音色不是凑数的占位符，是一份按 FM 合成原理排布的对照实验：
从"只有一个载波"开始，逐个引入调制器比率、包络、失谐、反馈、加法堆叠，
每个音色都标注它演示什么。

设计依据（都是从 engine/fm.js 里读出来的实数，不是凭感觉）
-----------------------------------------------------------
  电平 → 振幅     level 99 = 1.0，每级 0.75 dB。
                  调制深度 ≈ 振幅 × 1 圈相位，所以 level 60 的调制器
                  只有 β≈0.22（几乎听不出），有效的 FM 调制要 70 以上。
  速率 → 时长     走完 99 级跨度需要 0.005 × 2^((99-r)/8) 秒：
                  r=72→50ms  r=64→100ms  r=56→200ms  r=46→0.5s
                  r=38→1s    r=30→2s     r=25→3s     r=20→4.7s
                  实际时长还要乘「本段电平跨度 / 99」。
  失谐            字节 = 面板值 + 7，每级 ±4 音分。

产出
----
  starter/FM-1_starter_bank.syx   标准 DX7 32-voice bulk dump，可导入 Dexed
  data/starter.js                 同一份数据的 base64 + 每槽设计说明，供页面内置
"""

import base64
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent

HEADER = bytes([0xF0, 0x43, 0x00, 0x09, 0x20, 0x00])
TERMINATOR = 0xF7
BANK_DATA = 4096
VOICE_BYTES = 128


# --------------------------------------------------------------------------
# 包络预设。元组顺序 = (R1, L1, R2, L2, R3, L3, R4, L4)
# 括号里是按上面的换算估出的实际时长，供设计时对齐听感。
# --------------------------------------------------------------------------
EG_HIT      = (99, 99, 62,  0,  0,  0, 60,  0)   # 瞬时起音，~0.13s 落到底（打击类）
EG_WOOD     = (99, 99, 46,  0,  0,  0, 58,  0)   # 瞬时起音，~0.5s 落到底（木质共鸣）
EG_BELL     = (99, 99, 38,  0,  0,  0, 45,  0)   # 瞬时起音，~1s 衰减
EG_TUBBELL  = (99, 99, 25,  0,  0,  0, 38,  0)   # 瞬时起音，~3s 衰减
EG_KEY      = (99, 99, 48, 62, 30,  0, 46,  0)   # 快起音 → 0.44s 到 62 → 1.2s 淡出
EG_KEY_LONG = (99, 99, 42, 70, 26,  0, 44,  0)   # 键盘类，衰减更慢更持久
EG_MOD_PLUCK= (99, 99, 58, 20, 20,  0, 50,  0)   # 调制器专用：音头亮、迅速变暗
EG_SUST     = (72, 99, 60, 92, 35, 88, 42,  0)   # 35ms 起音，长 sustain（管风琴/持续音）
EG_SUST_FM  = (62, 96, 55, 92, 34, 86, 42,  0)   # 同上，起音稍软
EG_SLOW     = (46, 92, 40, 96, 30, 90, 46,  0)   # 0.5s 慢起音（弦乐/pad）
EG_PAD      = (38, 88, 36, 96, 28, 90, 25,  0)   # 0.9s 慢起音，释放约 2.6s
EG_MOD_SWELL= (52, 62, 44, 96, 32, 92, 44,  0)   # 调制器专用：音头暗、随后变亮（铜管）


def op(coarse=1, level=0, eg=EG_SUST, fine=0, detune=0):
    """一个算子的参数。未在音色里列出的算子一律 level=0，即不发声。

    断点/左右深度/速率缩放/力度灵敏度一律留中性值：这些在 engine/fm.js 里
    尚未实现，设成非中性值只会让同一份参数在不同实现下表现不一致。
    """
    assert 0 <= coarse <= 31, f"频率粗调必须在 0–31：{coarse}"
    assert 0 <= level <= 99, f"输出电平必须在 0–99：{level}"
    assert -7 <= detune <= 7, f"失谐是面板值（−7…+7），越界会被 & 15 静默截断：{detune}"
    assert 0 <= fine <= 99, f"频率微调必须在 0–99：{fine}"
    assert len(eg) == 8, f"包络必须是 8 个值（R1 L1 R2 L2 R3 L3 R4 L4）：{eg}"
    assert all(0 <= x <= 99 for x in eg), f"包络值必须在 0–99：{eg}"
    return dict(coarse=coarse, level=level, eg=eg, fine=fine, detune=detune)


def pack_op(o):
    """把一个算子打成 17 字节（DX7 packed voice 的算子块）。

    字节布局：前 4 字节是 EG rate 1–4，紧接着 4 字节是 EG level 1–4。
    而本文件的 eg 元组是**交错**的 (R1 L1 R2 L2 R3 L3 R4 L4)，所以这里必须重排。

    这一处曾经写错：把 eg 的前 4 个直接当 rate、后 4 个当 level。结果是格式完全
    合法、校验和也对、渲染不报错，但每个音色的包络都不是设计的样子 —— L1 被当成了
    rate2，于是"慢起音长持续"变成了"先冲一小下再掉下去"。下面 unpack_op 与 voice()
    里的往返断言存在的意义，就是让这类错在打包期就炸掉。
    """
    eg = o["eg"]
    b = bytearray(17)
    b[0], b[1], b[2], b[3] = eg[0], eg[2], eg[4], eg[6]   # EG rate 1–4
    b[4], b[5], b[6], b[7] = eg[1], eg[3], eg[5], eg[7]   # EG level 1–4
    b[8] = 39                                         # break point（C3，中性）
    b[9] = 0                                          # left depth（中性）
    b[10] = 0                                         # right depth（中性）
    b[11] = 0                                         # left/right curve（中性）
    b[12] = (((o["detune"] + 7) & 15) << 3) | 0       # detune | rate scaling=0
    b[13] = 0                                         # key vel sens=0 | amp mod sens=0
    b[14] = o["level"] & 0x7F
    b[15] = ((o["coarse"] & 31) << 1) | 0             # freq coarse | osc mode=ratio
    b[16] = o["fine"] & 0x7F
    return bytes(b)


def unpack_op(b):
    """pack_op 的逆运算。只用于打包后自检，把交错顺序还原回来。"""
    return dict(
        coarse=(b[15] >> 1) & 31,
        level=b[14],
        fine=b[16],
        detune=((b[12] >> 3) & 15) - 7,
        eg=(b[0], b[4], b[1], b[5], b[2], b[6], b[3], b[7]),
    )


def pack_voice(name, algo, ops, feedback=0, osc_sync=0, transpose=24,
               pitch_eg=(99, 99, 99, 99, 50, 50, 50, 50)):
    """把高层描述打成 128 字节的 packed voice。

    ops 的键是算子号 1-6；packed 顺序是 block 0 = OP6 … block 5 = OP1。
    pitch_eg 的 level 以 50 为「无变化」，>50 升高、<50 降低。
    """
    v = bytearray(VOICE_BYTES)
    for block in range(6):
        num = 6 - block
        spec = ops.get(num, op(1, 0))
        v[block * 17:(block + 1) * 17] = pack_op(spec)

    v[102:106] = bytes(pitch_eg[0:4])
    v[106:110] = bytes(pitch_eg[4:8])
    v[110] = algo & 31
    v[111] = ((osc_sync & 1) << 4) | (feedback & 7)
    v[112] = 35      # LFO speed（engine 尚未实现 LFO，留常用值保持数据完整）
    v[113] = 0       # LFO delay
    v[114] = 0       # LFO pitch mod depth
    v[115] = 0       # LFO amp mod depth
    v[116] = 0       # pitch mod sens | wave | sync
    v[117] = transpose & 0x7F

    nm = name.encode("ascii")[:10].ljust(10, b" ")
    v[118:128] = nm
    return bytes(v)


def voice(name, algo, ops, idea, **kw):
    raw = pack_voice(name, algo, ops, **kw)
    # 打包后立刻解回来逐项核对。字节顺序一旦写错，音色依然"合法"、依然能出声，
    # 只是包络完全不是设计的样子 —— 那种错只能靠往返回去比对才能发现。
    for block in range(6):
        num = 6 - block
        want = ops.get(num, op(1, 0))
        got = unpack_op(raw[block * 17:(block + 1) * 17])
        for k in ("coarse", "level", "fine", "detune", "eg"):
            assert got[k] == want[k], (
                f"{name} 的 OP{num}·{k} 打包往返不一致：写入 {want[k]}，取出 {got[k]}")
    return dict(name=name, algo=algo, ops=ops, idea=idea, kw=kw, raw=raw)


# ==========================================================================
# 32 个音色。分组说明：
#   0-5    最简 FM：调制器比率的作用
#   6-12   键盘与打击：经典 FM 音色的构成
#   13-19  持续音：加法堆叠与慢包络
#   20-26  低频与旋律：实用的 lead / bass / 木管
#   27-31  打击与效果：包络与反馈的极端用法
# ==========================================================================
BANK = [
    # ---------------------------------------------------------------- 0-5
    voice("INIT SINE", 0,
          {1: op(1, 99, EG_SUST)},
          "最简 FM：只有一个载波、没有调制器，听到的是纯正弦。"
          "这是所有 FM 音色的起点，也是判断引擎是否正常的基准。"),

    voice("SINE 1:1", 0,
          {1: op(1, 99, EG_KEY), 2: op(1, 78, EG_KEY)},
          "载波与调制器同为 1:1。调制器把边带按基频的整数倍铺开，"
          "频谱接近锯齿波，音色明亮而有点毛刺 —— 这就是 FM 最基础的一步。"),

    voice("SINE 1:2", 0,
          {1: op(1, 99, EG_KEY), 2: op(2, 74, EG_KEY)},
          "调制器取两个八度（比率 2）。边带落在偶次谐波上，"
          "音色比 1:1 更干净、更\"啵\"，是铜管与木管类音色的常用配置。"),

    voice("SINE 1:3", 0,
          {1: op(1, 99, EG_KEY), 2: op(3, 72, EG_KEY)},
          "调制器取十二度（比率 3）。边带间隔变大、中间出现空档，"
          "听感偏木质感，接近单簧管的方向。"),

    voice("SINE 1:7", 0,
          {1: op(1, 99, EG_BELL), 2: op(7, 88, EG_MOD_PLUCK)},
          "调制器取比率 7 且电平很高 → 边带被推到很远处，"
          "非谐波成分明显，听感接近金属敲击。这是\"FM 能造出金属声\"的原理演示。"),

    voice("SINE 3:2", 0,
          {1: op(1, 96, EG_KEY), 2: op(1, 76, EG_KEY, fine=50)},
          "调制器取 1.5 倍（coarse 1 配 fine 50），也就是 3:2 的纯五度比。"
          "载波仍是 1 倍，所以音高一点没变 —— 变的只有音色。"
          "这正是 FM 最反直觉的地方：音高永远由载波决定，调制器只决定音色。"),

    # ---------------------------------------------------------------- 6-12
    voice("EP TINE", 4,
          {1: op(1, 99, EG_KEY), 2: op(14, 86, EG_MOD_PLUCK),
           3: op(1, 94, EG_KEY), 4: op(1, 80, EG_KEY),
           5: op(1, 78, EG_KEY, detune=2), 6: op(1, 72, EG_KEY)},
          "经典电钢的构成：三对载波/调制器并联。比率 14 的调制器负责音头那声"
          "\"叮\"（调制器包络衰减极快，所以亮只出现在最初几十毫秒）。"
          "第五对加了 +2 级失谐，制造轻微的琴弦合唱感。"),

    voice("EP BRIGHT", 4,
          {1: op(1, 99, EG_KEY), 2: op(11, 92, EG_MOD_PLUCK),
           3: op(1, 90, EG_KEY), 4: op(2, 88, EG_KEY),
           5: op(2, 84, EG_KEY_LONG, detune=1), 6: op(1, 78, EG_KEY_LONG)},
          "把电钢的调制器电平推到 92、比率换成 11，音头更亮更硬。"
          "对比 EP TINE 就能听出：改调制器电平远比改载波电平更能改变\"性格\"。"),

    voice("BELL FM", 4,
          {1: op(1, 99, EG_BELL), 2: op(3, 90, EG_BELL, fine=17),
           3: op(2, 82, EG_BELL), 4: op(7, 78, EG_BELL)},
          "关键在于比率不是整数：coarse=3 配 fine=17 → 3 × 1.17 = 3.51。"
          "边带与基频不成整数倍，于是产生钟声特有的\"拍频\"。"
          "整数比永远做不出真正的钟。"),

    voice("BELL LONG", 4,
          {1: op(1, 99, EG_TUBBELL), 2: op(3, 86, EG_TUBBELL, fine=17),
           3: op(2, 76, EG_TUBBELL, detune=6), 4: op(9, 74, EG_TUBBELL),
           5: op(1, 70, EG_TUBBELL), 6: op(5, 66, EG_TUBBELL, fine=20)},
          "在 BELL FM 的基础上补满六算子、并把衰减拉到约 3 秒。"
          "多出来的两对算子负责那几个不明显的泛音 —— 它们让长尾不致单调。"),

    voice("MARIMBA", 4,
          {1: op(1, 99, EG_WOOD), 2: op(4, 84, EG_WOOD),
           3: op(4, 70, EG_WOOD)},
          "木琴：短促的木质衰减（约 0.5 秒）+ 比率 4 的调制器；"
          "第二个载波也取比率 4，把敲击的高频木头味抬到前面。"
          "对比 KICK：同样的包络速率，只是拉长了衰减，就从打击变成了乐器。"),

    voice("VIBES", 4,
          {1: op(1, 99, EG_BELL), 2: op(6, 80, EG_BELL),
           3: op(4, 74, EG_BELL), 4: op(2, 70, EG_BELL)},
          "颤音琴：一个载波走纯比率 1、一个走比率 4，调制器用比率 6 与 2，"
          "衰减约 1 秒。金属感来自高比率的调制器，圆润感来自那个纯比率载波。"),

    voice("TUB BELL", 4,
          {1: op(1, 99, EG_TUBBELL), 2: op(2, 94, EG_TUBBELL, fine=76),
           3: op(1, 88, EG_TUBBELL), 4: op(1, 76, EG_TUBBELL, detune=3)},
          "管钟：调制器比率 2.76 制造强烈的非谐波，载波本身是纯音，"
          "所以听得清音高、却完全没有乐音的通透感。"),

    # ---------------------------------------------------------------- 13-19
    voice("ORGAN ADD", 31,
          {1: op(1, 99, EG_SUST), 2: op(2, 88, EG_SUST), 3: op(3, 76, EG_SUST),
           4: op(4, 66, EG_SUST), 5: op(6, 58, EG_SUST), 6: op(8, 50, EG_SUST)},
          "算法 32 是纯加法：六个算子都是载波，没有任何调制。"
          "它们按 1/2/3/4/6/8 倍叠出管风琴的谐波栓，电平递减。"
          "把这条和 SINE 1:1 对比，就是\"加法合成 vs 调制合成\"的对照。"),

    voice("ORGAN FM", 3,
          {1: op(1, 99, EG_SUST), 2: op(1, 62, EG_SUST), 3: op(1, 46, EG_SUST),
           4: op(2, 90, EG_SUST), 5: op(1, 68, EG_SUST), 6: op(1, 52, EG_SUST)},
          "同样的管风琴方向，改用两条串联调制链来做。"
          "和 ORGAN ADD 听感相近，但频谱更\"整\" —— 调制合成天然产生密集边带。"),

    voice("BRASS 1", 2,
          {1: op(1, 99, EG_SUST_FM), 2: op(1, 84, EG_MOD_SWELL), 3: op(1, 62, EG_MOD_SWELL),
           4: op(1, 92, EG_SUST_FM), 5: op(1, 80, EG_MOD_SWELL), 6: op(1, 58, EG_MOD_SWELL)},
          "铜管的核心不是音色本身，而是**亮度随时间上升**。看调制器的包络："
          "L1=62 起音时很暗，L2=96 随后变亮 —— 听感就是吹奏时气流逐渐加满。"),

    voice("STRINGS 1", 2,
          {1: op(1, 99, EG_SLOW, detune=2), 2: op(1, 72, EG_SLOW), 3: op(1, 56, EG_SLOW),
           4: op(1, 94, EG_SLOW, detune=-2), 5: op(1, 68, EG_SLOW), 6: op(2, 50, EG_SLOW)},
          "弦乐：慢起音 + 中等调制。两个载波之间拉开 4 级失谐（约 16 音分），"
          "让它们互相轻微跑调 —— 这是\"一群人拉琴\"和\"一个人拉琴\"的区别。"),

    voice("PAD WARM", 4,
          {1: op(1, 99, EG_PAD, detune=-2), 2: op(1, 70, EG_PAD),
           3: op(1, 92, EG_PAD, detune=0), 4: op(1, 66, EG_PAD),
           5: op(1, 84, EG_PAD, detune=2), 6: op(2, 60, EG_PAD)},
          "暖 pad：约 0.9 秒起音、释放约 2.6 秒。"
          "注意三个调制器电平都压在 60–70 —— 刻意只加一点点边带，"
          "让它像背景而不抢占位置。"),

    voice("PAD GLASS", 6,
          {1: op(1, 99, EG_PAD), 2: op(3, 74, EG_PAD),
           3: op(2, 90, EG_PAD), 4: op(2, 68, EG_PAD),
           5: op(1, 88, EG_PAD, detune=4), 6: op(1, 72, EG_PAD)},
          "算法 7 与算法 5 的唯一区别是：第一对里那个载波自己带反馈。"
          "把反馈给载波（而不是调制器）会产生略带噪声的金属光泽，"
          "这是\"玻璃感\"的来源。"),

    voice("PAD MOTION", 6,
          {1: op(1, 94, EG_PAD), 2: op(2, 76, EG_PAD),
           3: op(1, 99, EG_PAD, fine=6), 4: op(3, 70, EG_PAD, detune=5),
           5: op(2, 90, EG_PAD, detune=-5), 6: op(1, 78, EG_PAD)},
          "让各对的起音时长与整数比都不一致，互相之间就会持续产生缓慢的相位差，"
          "听感上像声音在慢慢游动。这种\"不整齐\"是刻意的。"),

    # ---------------------------------------------------------------- 20-26
    voice("BASS FM", 0,
          {1: op(1, 99, EG_KEY_LONG), 2: op(1, 80, EG_MOD_PLUCK)},
          "低音：载波比率 1 保证基频扎实，调制器用快速衰减的包络 —— "
          "只在音头给一点\"咬\"，之后迅速干净下来。低音最忌一直保持高调制。"),

    voice("BASS DEEP", 1,
          {1: op(1, 99, EG_KEY_LONG), 2: op(1, 74, EG_KEY_LONG),
           3: op(1, 96, EG_KEY_LONG), 4: op(2, 70, EG_MOD_PLUCK),
           5: op(1, 60, EG_KEY_LONG), 6: op(1, 66, EG_KEY_LONG)},
          "算法 2 有两条链：一条以比率 1 的调制器做主体，"
          "另一条以比率 2、衰减极快的调制器做音头。"
          "这比单链低音更有层次，是 FM 低音常用的结构。"),

    voice("SQR LEAD", 0,
          {1: op(1, 99, EG_SUST_FM), 2: op(1, 92, EG_SUST_FM)},
          "把调制器电平推到 92（调制指数约 2.4）→ 频谱重心被推到基频的两倍以上，"
          "谐波铺成近似方波的一串。"
          "这是\"用调制量去逼近另一种波形\"的直接演示。"),

    voice("SAW LEAD", 0,
          {1: op(1, 99, EG_SUST_FM), 2: op(1, 88, EG_SUST_FM)},
          "与 SQR LEAD 几乎相同，但载波自带反馈（反馈 5）："
          "反馈给频谱加了连续的噪声底，听感更粗、更像锯齿。"
          "把这两个交替弹一遍，就能听出反馈到底是干什么的。", feedback=5),

    voice("FLUTE", 31,
          {1: op(1, 99, EG_SUST_FM), 2: op(2, 46, EG_SUST_FM)},
          "长笛用加法做：基频 + 一个很弱的八度。真正让长笛像长笛的其实是气声，"
          "而那需要噪声源 —— 这台引擎没有，所以它只到\"纯净的木管\"为止。"),

    voice("CLARINET", 0,
          {1: op(1, 99, EG_SUST_FM), 2: op(2, 84, EG_SUST_FM)},
          "单簧管的标志是\"只有奇次谐波\"。比率 2 的调制器按说给的是偶次谐波，"
          "但调制指数偏大时会同时生成两组边带，听感反而接近奇次为主的簧片音。"),

    voice("WOOD BASS", 1,
          {1: op(1, 99, EG_KEY), 2: op(1, 72, EG_MOD_PLUCK),
           3: op(2, 74, EG_HIT), 4: op(3, 66, EG_HIT)},
          "木管低音：主体是比率 1 的载波；另加一条链以比率 2 作载波、比率 3 作调制器，"
          "包络短得多 —— 两条链长度不同，就能在同一音色里同时给出\"音高\"和\"打击\"。"),

    # ---------------------------------------------------------------- 27-31
    voice("KICK", 0,
          {1: op(1, 99, EG_HIT), 2: op(1, 76, EG_HIT)},
          "底鼓：靠音高包络做出下扫 —— L1=78 → L2=50，"
          "起音瞬间音高被抬高、很快落回基频，这就是\"砰\"的来源。"
          "注：engine/fm.js 尚未实现音高包络，所以浏览器里这一项暂时听不出来。",
          pitch_eg=(99, 78, 60, 50, 0, 50, 40, 50)),

    voice("SNARE", 4,
          {1: op(1, 88, EG_HIT), 2: op(9, 92, EG_HIT),
           3: op(3, 90, EG_HIT), 4: op(12, 88, EG_HIT),
           5: op(1, 60, EG_HIT), 6: op(7, 86, EG_HIT)},
          "军鼓：三个载波分别取比率 1、3、1，而调制器用比率 9 / 12 / 7 配接近满电平 —— "
          "频谱被轰成一片噪声，音高感基本消失。这里\"不和谐\"正是目的。"),

    voice("METAL HIT", 4,
          {1: op(1, 99, EG_HIT), 2: op(13, 95, EG_HIT),
           3: op(2, 88, EG_HIT), 4: op(11, 90, EG_HIT)},
          "高比率 + 极短衰减 = 金属撞击。对比 SINE 1:7："
          "同一个原理（高比率调制），只是把时长从 1 秒压到 0.13 秒，"
          "就从\"钟\"变成了\"敲铁\"。"),

    voice("SPACE FX", 6,
          {1: op(1, 88, EG_PAD), 2: op(7, 84, EG_PAD),
           3: op(1, 96, EG_PAD, fine=30), 4: op(5, 82, EG_TUBBELL),
           5: op(2, 90, EG_TUBBELL, detune=6), 6: op(3, 76, EG_TUBBELL)},
          "效果音：把非整数比、长衰减、大失谐全部堆在一起，"
          "再加上载波反馈。它没有明确的音高感，"
          "适合做场景转换的过渡层。", feedback=6),

    voice("GROWL", 0,
          {1: op(1, 99, EG_SUST_FM), 2: op(1, 86, EG_SUST_FM),
           3: op(1, 40, EG_SUST_FM)},
          "低沉的咆哮：调制器电平推到 86（调制指数约 1.4），"
          "另加一个纯正弦载波（电平 40）垫底。"
          "调制量顶到接近临界时，音色会在\"有音高\"和\"快破音\"之间摇摆。"),
]


# --------------------------------------------------------------------------
# 打包成 bank
# --------------------------------------------------------------------------
def main():
    assert len(BANK) == 32, f"必须正好 32 个音色，现在是 {len(BANK)}"

    for i, v in enumerate(BANK):
        name = v["name"]
        assert len(name) <= 10, f"槽 {i}: 音色名超过 10 字符 → {name!r}"
        assert name.isascii(), f"槽 {i}: 音色名必须可打印 ASCII → {name!r}"
        assert any(o["level"] > 0 for o in v["ops"].values()), \
            f"槽 {i} {name}: 所有算子电平都是 0，这个音色会静音"

    names = [v["name"] for v in BANK]
    assert len(set(names)) == 32, "音色名有重复"

    packed = b"".join(v["raw"] for v in BANK)
    assert len(packed) == BANK_DATA, len(packed)

    checksum = (128 - (sum(packed) & 0x7F)) & 0x7F
    syx = HEADER + packed + bytes([checksum, TERMINATOR])
    assert len(syx) == 4104, len(syx)

    # ---- 1. 标准 .syx，可以直接导入 Dexed 或写进真机 ----
    outdir = ROOT / "starter"
    outdir.mkdir(exist_ok=True)
    (outdir / "FM-1_starter_bank.syx").write_bytes(syx)

    # ---- 2. 页面内置用的版本 ----
    datadir = ROOT / "data"
    datadir.mkdir(exist_ok=True)
    js = {
        "schema": 1,
        "label": "随附入门音色",
        "origin": "original",
        "licence": "CC0-1.0",
        "note": ("本项目原创设计的 32 个音色，不派生自任何 Yamaha 出厂音色或第三方 "
                 "DX7 音色库。以 CC0 1.0 发布，可自由分发。设计说明见 starter/README.md。"),
        # 存完整的 SysEx（4104 字节），与 data/factory.js 的格式保持一致 ——
        # 这样页面上两个数据源走同一条解析路径，不需要分支判断。
        # 解出来就是 starter/FM-1_starter_bank.syx，用户也能直接拿去导入 Dexed。
        "banks": [base64.b64encode(syx).decode("ascii")],
        "names": names,
        "design": [{"slot": i, "name": v["name"], "algo": v["algo"] + 1,
                    "idea": v["idea"]} for i, v in enumerate(BANK)],
    }
    body = json.dumps(js, ensure_ascii=False, indent=1)
    # newline="\n" 是必须的：Windows 上 write_text 默认把 \n 翻成 \r\n，
    # 会让文件在 git 里整篇显示为改动。
    (datadir / "starter.js").write_text(
        "// generated by tools/make_starter.py — do not edit by hand\n"
        "// 本项目原创音色库，CC0 1.0，可随仓库自由分发。\n"
        f"window.FM1_STARTER = {body};\n",
        encoding="utf-8", newline="\n")

    # ---- 3. starter/README.md —— 音色表由代码生成，永远不会和音色本身漂移 ----
    md = [
        "# 随附音色库",
        "",
        "`FM-1_starter_bank.syx` 与 `../data/starter.js` 是同一份数据的两种形态：前者是标准",
        "DX7 32-voice bulk dump（可直接导入 Dexed 或写进真机），后者是页面内置用的 base64。",
        "",
        "## 授权",
        "",
        "**CC0 1.0 Universal（公共领域贡献）**。这 32 个音色是本项目原创设计的，不派生自任何",
        "Yamaha 出厂音色或第三方 DX7 音色库，可以自由复制、修改、再分发。",
        "",
        "对照：FM-1 的 128 个出厂音色参数集**不是**这个授权状态 —— 它的权利链在 Yamaha 那一层",
        "就断了（见 `../LICENSE-AUDIT.md`）。那批数据不随仓库分发，由页面在运行时从上游取。",
        "",
        "## 设计",
        "",
        "这不是凑数的占位音色，而是一份按 FM 合成原理排布的对照实验：从「只有一个载波」开始，",
        "逐个引入调制器比率、包络、失谐、反馈、加法堆叠。每个音色都标注它在演示什么，",
        "在页面里选中任一随附音色即可读到。",
        "",
        "| 槽 | 音色名 | 算法 | 演示什么 |",
        "|---:|---|---:|---|",
    ]
    for i, v in enumerate(BANK):
        md.append(f"| {i} | `{v['name']}` | {v['algo'] + 1} | {v['idea'].replace(chr(10), ' ')} |")
    md += [
        "",
        "## 重新生成与验证",
        "",
        "```",
        "python tools/make_starter.py      # 打包 bank 与 starter.js",
        "node   tools/verify_starter.mjs   # 能否发声 / 参数是否合法 / 两个产物是否同源",
        "node   tools/render_starter.mjs   # 渲染 preview/_starter_medley.wav",
        "```",
        "",
        "打包脚本会在打包后立刻把每个算子解回来逐项比对（`unpack_op` 往返断言）。这一步是有必要的：",
        "字节顺序一旦写错，音色**依然合法、依然能出声**，只是包络完全不是设计的样子 —— 那种错",
        "只能靠往返回去比对来发现，正常的格式检查抓不到。",
        "",
        "## 已知边界",
        "",
        "试听引擎（`engine/fm.js`）**不是** DX7 的逐周期复刻，是一台能听出音色特征的近似引擎。",
        "尚未实现：按键电平缩放、速率缩放、力度灵敏度、LFO、音高包络。受影响的音色已在表里注明",
        "（例如 `KICK` 依赖音高包络做下扫，浏览器里暂时听不出来）。要准确的 DX7 音色请用 Dexed。",
        "",
    ]
    (outdir / "README.md").write_text("\n".join(md), encoding="utf-8", newline="\n")

    # ---- 4. 打包期自证 ----
    print(f"✓ 32 个音色 → starter/FM-1_starter_bank.syx "
          f"({len(syx)} 字节，校验和 0x{checksum:02x})")
    print(f"✓ data/starter.js（内嵌完整 SysEx {len(syx)} 字节，与 data/factory.js 格式一致）")
    print(f"✓ starter/README.md（音色表随代码生成）")
    print("")
    print("  槽  音色名      算法  设计意图")
    print("  ─────────────────────────────────────────────────────────────────────")
    for i, v in enumerate(BANK):
        idea = v["idea"].replace("\n", "")
        print(f"  {i:>2}  {v['name']:<10}  {v['algo'] + 1:>3}   {idea[:64]}")
    print("")
    print("注意：以上自检只覆盖打包层（长度、校验和、名字、是否全静音）。")
    print("音色能不能真的发声、参数是否落在合法区间，由 tools/verify_starter.mjs 验证。")


if __name__ == "__main__":
    main()
