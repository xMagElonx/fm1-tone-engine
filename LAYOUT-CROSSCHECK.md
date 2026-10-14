# Which DX7 byte-layout table is right?

Several tables for the packed DX7 voice are in circulation, they disagree, and the
disagreement is not cosmetic: a table that puts the global block 14 bytes early makes the
decoder read the same bytes twice, so the fields *look* fine individually while the voice as a
whole comes back wrong. This document settles it **with measurements**, not with authority.

Everything below is reproducible. The verdicts come from the bytes, and the ruler used to reach
them is itself checked against a known-good table and two known-bad ones.

---

## 1. Four rulers that do not need an authority

Authority is exactly what is contested here, so the rulers are all things the data says about
itself.

### ① The name field finds itself

A voice name has to be printable ASCII. In a corpus of real voices, scan every window of
length *N* and keep the ones that are printable in **every** voice. On the 128 factory voices
(`ref/packed128.bin`), for *N* = 10 there is exactly **one** such window: offset **118**.

```
all-printable 10-byte windows: 118        (unique)
all-printable 12-byte windows: none
```

That one number settles the end of the voice: the name is bytes 118–127. Anything claiming the
name starts at 108 has to survive the fact that no 12-byte window anywhere fits.

### ② The operator block size measures itself

The curve byte of each operator occupies 2 + 2 bits, so it can never exceed 15. Look at every
byte in the voice and take its maximum across the corpus; the bytes with max ≤ 15 are:

```
11, 28, 45, 62, 79, 96      ← step 17
```

That progression *is* the operator block size: 17 bytes, six blocks, 0–101. It also answers a
question no table can talk its way out of — **byte 96 belongs to an operator block.** It is the
sixth block's curve byte (`85 + 11`).

### ③ A bit that is never set is not a parameter

Byte 111 holds feedback in bits 0–2 and oscillator key sync in bit 3; bits 4–6 are unused.
Measured on the 128 factory voices:

```
byte 111 max value across all 128 voices : 15      → a 4-bit container
bit 3 set in                             : 87 / 128
bit 4 set in                             :  0 / 128
```

A reader that takes oscillator sync from **bit 4** therefore reports the same value — "off" —
for every voice, and no amount of testing on real voices would ever reveal it, because the
reader is not wrong about the data, it is wrong about which bit is the data.

### ④ Two claims on the same bit

If a table assigns one bit to two different fields, that is the signature of a whole block
having been shifted. Unlike the other three rulers this one is self-contained: it needs
nothing but the table.

### ⑤ Range — and why it is the weakest of the five

A field has a legal range, so a value outside it is evidence the table is wrong. But only
*distribution* is evidence: the factory ROM genuinely contains out-of-range values. Ours has
nine of them:

```
TIMPANI      OP2 Level 3    = 127
SYN BASS1    OP4 Rate 3     = 127
SAW EM UP    OP2 Freq Fine  = 127      (also UP2 and UP3)
BRASS 4      LFO speed      = 127
CONGA        LFO speed      = 127
BI   BEN     LFO speed      = 127
BASS 4       LFO pitch mod depth = 127
```

The same phenomenon is documented independently: `phosphor-dsp`'s `dx7.rs` notes that "four
values in the factory set are genuinely out of that range" and clamps them, on the grounds that
this is what the hardware does and it is the only way the file stays the bytes the cartridges
shipped with. **Their four voices are not our nine** — which is the point: out-of-range is a
property of the data, so a handful of violations proves nothing. A table is falsified by range
only when violations are widespread, or when the maximum lands nowhere near the legal range.

---

## 2. The verdict

Every ruler above is implemented in [`tools/tablecheck.mjs`](tools/tablecheck.mjs), which runs
the same tests on a known-good table and two known-bad ones, so that a green result means "the
ruler can distinguish", not merely "nothing complained".

| | name window | byte 96 | byte 97 | byte 98 | byte 111 | bits double-claimed |
|---|---|---|---|---|---|---|
| **packed-128** (this project; also `phosphor-dsp`, `midiwire`, DX7 Service Manual) | 118–127 ✓ | 4-bit container in the operator series | — | — | max 15, bit 3 live | **0** |
| `pydxseven` 2024 | claims 108–119 ✗ (no printable window) | claims **algorithm** ✗ (belongs to operator 6) | claims **feedback 0–7**, measured 0–**115**, 115/128 violate ✗ | claims **osc sync 0–1**, measured 0–**28**, 52/128 violate ✗ | — | **70** |
| bit-4 variant (our own historical bug) | — | — | — | — | bits 4 is never set ✗ | 0 |

Seven independent claims in the 2024 table are violated across more than 20 % of the corpus in
one shot — `feedback` reaching 115 when it is declared 0–7, `LFO sync` reaching 99 when it is
declared 0–1, `amp mod sensitivity` declared 0–3 and measured 28–99 in **every** voice.

---

## 3. The specific case, and what it actually demonstrates

The table above is the [ftrain/pydxseven](https://github.com/ftrain/pydxseven) README, and its
`dx7_voice_codec.py`. Its README opens with:

> *"This code was generated by ChatGPT 4o using the following prompts: … Completely define each
> byte in a voice. Write a Python module that decodes and encodes the byte data in a voice."*

The documentation was generated alongside the code, by the same process, and the two agree with
each other. Neither was checked against a byte.

Its operator block is 17 bytes — correct. But its global block starts at 88 instead of 102, so
it assigns bytes 88–97 twice: to operator 6's envelope/breakpoint/curves/detune, and again to
the pitch envelope, the algorithm and the feedback. Encoding writes the global block last, so
operator 6 loses.

Running **its own code** on the 128 factory voices (upstream commit `f966e4a`, file
`dx7_voice_codec.py`, sha256 `2f83f5c0…`, 5563 bytes, no imports — it cannot touch the disk or
the network) gives:

```
voices that survive decode → encode byte-identically :  0 / 128
union of corrupted byte positions                     : 20 bytes
which are exactly                                     : offset +13..+16 of five of the six operator blocks
original values in those positions that are non-zero   : 1663 / 2560
```

Those twenty bytes are neither read nor written by the codec. They hold, per operator, the
velocity sensitivity and amp mod sensitivity, **the output level**, the oscillator mode and
coarse frequency, and the fine frequency. In other words: round-tripping a voice through it
discards every operator's output level and frequency ratio, and it does so silently — the
format stays legal and the checksum, if you recompute it, stays correct.

Its "name" is read from bytes 108–119, which measured against 128 real voices is not printable
ASCII in a single one of them.

**What this is not.** This is not a claim that the author is careless, and not a claim that the
library is useless — it loads and saves cartridges with a correct header and checksum, which is
what it advertises. It is a claim about one artifact, checked against bytes, with the whole
reproduction above. It is also not a claim that this project is immune: **this project is
vibe-coded too**, and it shipped the very bug that the second bad table stands for — oscillator
sync read from bit 4, wrong, for an entire round. The difference is not who wrote it; it is that
a round-trip assertion over real captured bytes was there to disagree.

If anything, the useful lesson is the one this project keeps re-learning: **generated
documentation and generated code agree with each other and with nobody else.** The README and
the implementation being mutually consistent is worth nothing at all. What is worth something
is `decode → encode → compare`, on bytes that came from a real device.

### Reproducing it

```bash
curl -sL "https://raw.githubusercontent.com/ftrain/pydxseven/f966e4ae6038a45112eac92309965e286cb75abd/dx7_voice_codec.py" -o /tmp/dx7_voice_codec.py
sha256sum /tmp/dx7_voice_codec.py     # 2f83f5c0659b54988b516d540a1192f0a25ba8f20ae600857d548dadbf14835c
```

Then decode and re-encode each voice from any standard `.syx` or raw packed dump and compare.
`tools/tablecheck.mjs` runs the same corpus through the four table-level rulers above, and prints
its verdict for each candidate table.

---

## 4. Where "134" comes from, and where "96" comes from

Three different layouts are all real, which is how a table can be wrong while looking
authoritative:

| Layout | Size | Operator block | Algorithm at |
|---|---|---|---|
| packed voice (bulk dump / what an FM-1 accepts) | 128 B | 17 B | **110** |
| "unpacked" voice (what editors work in) | 169 B | 23 B | 146 |
| VCED / single-voice SysEx, and the MIDI parameter-change address | 155 B | 21 B | **134** |

So "the algorithm is 134" is correct — for the parameter-change address space, where the DX7
takes `F0 43 1n gg pp dd F7` with gg = 01 and pp = 06, i.e. parameter 1 × 128 + 6 = 134. And
"the algorithm is 146" is correct for the unpacked format. **Neither is 96.** 96 is not a
third convention; measured, it is the sixth operator's curve byte.

If you are writing an importer, the layout that matters for a bulk dump is the first row, and
the way to be sure of your own table is to point `tools/tablecheck.mjs` at your bytes rather
than to trust any of these three rows — including this one.

---

## 5. Check your own bytes

```bash
node tools/tablecheck.mjs                  # the bundled library + ref/packed128.bin if present
node tools/tablecheck.mjs your-bank.syx    # your bytes
node tools/tablecheck.mjs --tables         # print the three candidate tables it knows
```

It needs neither this project's data nor an FM-1, and it says so loudly when the corpus is
missing rather than passing quietly. To test a table of your own, declare its fields the way the
`fields` blocks in the tool do — a byte, a bit window, and the legal range — and it will tell you
which of your claims the bytes contradict.
