# FM-1 Tone Bench — the one-screen version

**An M-VAVE FM-1 voice engine that runs entirely in a browser tab.** Search, audition, edit by
plain language, export, write to the device. No install, no build, no server, no account.

**▶ https://fm1-tone-engine.app.workbuddy.host/**

This page answers three questions and nothing else: **what it does**, **how it is proven**, and
**what it caught**. The depth is in the other documents; this is the front page.

---

## 1. What it does — and where the hardware actually enters

The interesting question about a project like this is "how much of it is real, and how much is
a DX7 tool wearing an FM-1 costume". Measured against the code, the answer is below.

| Layer | What it speaks | Needs an FM-1? |
|---|---|---|
| Interface, search, library | its own state | **no** |
| Audition (`engine/fm.js`) | its own 6-operator FM engine | **no** |
| Plain-language edit (`engine/intent.js`, `engine/llm.js`) | five axes + a model | **no** |
| Voice bytes (`engine/dx7.js`) | standard Yamaha DX7 | **no** |
| The 128 factory voices (fetched at runtime) | FM-1's own data | **no** |
| Write to the device (`engine/midi.js`) | a standard DX7 bank dump | **yes — the only one** |

The header the tool sends is `F0 43 00 09 20 00` — `0x43` is **Yamaha's** manufacturer ID. This
project speaks standard DX7, deliberately: M-VAVE's own recovery protocol
(vendor ID `00 32`, 1190 bytes per packet, 7-bit bit-stream) was documented by upstream but its
checksum was not, so that road was closed from the start.

**Consequence worth stating plainly: five of the six layers need no device.** You can hear a
voice, and hear what the language model did to it, with nothing but a browser tab.

---

## 2. How it is proven

```
node tools/verify.mjs          # 1. decoder, against real captured bytes          (26)
node tools/engine_test.mjs     # 2. FM engine: 32-algorithm table + synthesis     (28)
node tools/verify_starter.mjs  # 3. the 32 bundled voices: legal params, audible  (30)
node tools/midi_test.mjs       # 4. MIDI: byte alignment, send gates, round-trip  (57)
node tools/intent_test.mjs     # 5. plain language: is the direction right?       (33)
node tools/llm_test.mjs        # 6. model layer: bad replies, fallback, no key leak (109)
node tools/smoke.mjs           # 7. the page end to end, five scenarios          (157)
node tools/layout.mjs          # 8. the byte layout, bit by bit                   (23)
node tools/tablecheck.mjs      # 9. are the circulated layout tables right?       (19)
```

**Nine commands, 482 assertions, all exit 0** — and all exit 0 on a fresh `git clone` too,
where the parts that need factory data print `SKIP` and say how to supply it rather than
crashing or quietly passing.

Four kinds of proof, in descending order of how much they are worth:

1. **The bytes are the real bytes.** Assertion set #4 takes voices rebuilt from real device
   captures, pushes them through the send path, re-packs them, and requires the output to be
   **byte-identical** to the original. What the page sends is what the real world has.
2. **Direction is measured, never read.** #5 says "brighter" and then actually **renders 192
   voices** and measures spectral content, requiring zero of them to move the wrong way. This
   layer's correctness is never judged by looking at the code.
3. **"Nothing happened" is asserted too.** #7 installs a network gate in every scenario: a
   scenario that should not touch the network fails an assertion if it does, instead of quietly
   falling back to the local dictionary and hiding the problem. Five scenarios, zero requests.
4. **The layout is checked bit by bit.** #8 flips every bit the layout table claims (the decoded
   voice must change) and every bit it does not claim (the decoded voice must not). A declared
   parameter that nothing reads is a *fake* parameter, and this is the check that finds them.

### And the checker was proved able to fail

A green suite means nothing unless the ruler can go red. So the historical oscillator-sync bug
was put back into a throwaway copy and the audit re-run:

```
FAIL  every declared bit really affects the decoded voice
      bits that decoded identically after flipping: 111.3   ← declared, but dead
FAIL  every undeclared bit really is dead
      bits that changed the decoded voice: 111.4            ← not declared, but live
```

It named the byte and the bit of a bug that had hidden for a whole round.

---

## 3. What it caught

This is the part that cannot be reproduced by reading someone else's code, because each entry is
a measurement that disagreed with a plausible-looking implementation.

| It looked fine | What was actually wrong | What caught it |
|---|---|---|
| Format valid, checksum correct, rendering silent | The envelope was written interleaved (`R1 L1 R2 L2 …`); the format is **4 rates, then 4 levels**. Every voice's envelope was not what it was designed to be — a slow attack became a short burst and a drop | A measured render peak of **0.387** — exactly the amplitude of sustain level 88. When a measurement lands precisely on a parameter value, you are looking at the parameter, not the sound |
| The UI showed "oscillator sync: off" for every voice, forever | Sync was read from **bit 4** of byte 111. Every real value of byte 111 is ≤ 15 (`0b1111`), so bit 4 is **structurally** always zero — the parameter had never been readable | The pack → unpack round-trip added for voice editing: 127 of 128 bytes came back identical, **only byte 111 disagreed**. One byte out of 128 is easy to dismiss as noise; it was not noise |
| The cards looked normal, the exported bank "looked right" | "Sort by slot" was a string comparison of `bankLabel + slot` → **lexicographic** order (0, 1, 10, 11, …, 2, 20, …), scrambling all 32 voices | Wiring up device write: the 32 voices the page was about to send did not match the source bank |
| The spectral centroid said "no brighter" | The FFT had been copied into three scripts and **two copies were missing the bit-reversal permutation** | Every voice's centroid landed at 8–12 kHz, which would mean the engine was rendering white noise. The engine was fine. **The ruler was wrong** |
| "It also runs on a fresh clone" — checked six times, always green | The check was made by copying the directory with `tar`, which **preserves line endings**. It was only ever agreeing with one machine | The first real `git clone` crashed the test suite **before assertion #1 ran**: Git for Windows sets `core.autocrlf=true` in the system config, a repo-local setting does not travel with a clone, so `index.html` checked out with CRLF and `/<script>\n/` never matched |
| The new layout tool ran and reported "I cannot tell what this file is" | `DX7.SYX_BYTES` where the export is `DX7.SYSEX_BYTES`. A missing property is `undefined`; `4104 % undefined` is `NaN`; `NaN === 0` is `false` — so the branch went the wrong way **without a sound** | A constant guard, added after the fact. The failure surfaced one call away from the typo. **In JavaScript a wrong name is not an error, it is a value** |

The through-line: **four of these six were the ruler, not the thing being measured.** The audit
tools are themselves code, and they can be silently wrong in exactly the same way the code under
test can.

### The strongest single piece of evidence in this repository

The distribution of byte 111 across the 128 captured factory voices:

```
value :  0  2  3  4  5  6  7  8 10 12 13 14 15
count :  5  1  1  5  4  6 19 10  2  3  8 13 51
```

Every value ≤ 15. Bit 4 is set in **0** of the 128 voices; bit 3 is set in **87**. So an
implementation reading oscillator sync from bit 4 reports "off" for the whole factory set, and
no amount of testing on real voices would ever reveal it — the reader is not wrong about the
data, it is wrong about which bit *is* the data. That is not an anecdote; it is a measurement.

By-product, same shape: a widely circulated DX7 table puts the algorithm number at **byte 96**.
Measured on these 128 voices it is **byte 110**, and byte 96 turns out to be the sixth
operator's curve byte — it sits in the same step-17 series as the other five. Which table is
right, decided by measurement rather than authority, is
[`LAYOUT-CROSSCHECK.md`](LAYOUT-CROSSCHECK.md).

---

## 4. What this honestly is not

- **Not the first at anything.** The FM-1 scene already has an excellent librarian
  (fm1-editor.com), 40+ alternative firmwares, and — since October 2026 — at least one other
  project putting a language model in the loop (`hunterxiong2026/fm1-felucca-editor-2026`, MIT,
  but aimed at **Felucca** firmware, over Felucca's parameter protocol, requiring Windows,
  Python and a real device). AI-generated work is not a novelty in this scene; it is the norm,
  and one ModWiggler poster describes the whole batch as *"released by vibe-coders"*.
  The narrow thing this project is: a **stock, unmodified FM-1**, standard DX7, a browser tab,
  no hardware, no install, no firmware flashing.
- **Not a DX7 clone.** The audition engine is an approximation good enough to tell voices apart.
  No key-level scaling, no rate scaling, no velocity, no LFO, no pitch EG, no DAC character.
  Use Dexed for accuracy; use this to *distinguish* voices without a device.
- **Not a distributor of anyone else's bytes.** The 128 factory voices are fetched from upstream
  **at runtime** and never enter the repository; `ref/`, `demo/` and `data/factory.js` are
  gitignored. The rights chain for those bytes breaks at Yamaha — reasoning in
  `LICENSE-AUDIT.md`.
- **Not verified on real hardware.** The device-write path has never been run against a physical
  FM-1. The code is written, the tests pass, and the bytes it emits are byte-identical to the
  real world's — but where the device stores them, and in what order, needs a unit. What to check
  first is in `MIDI-WRITE.md` §6.
- **And the model's judgement is unmeasured.** What is verified is the *mapping* (axis →
  parameter → measured sound, zero wrong-direction results over 192 voices). What is **not**
  verified is whether a real model picks the right axes, because no real key was available.
  Stated as such in `LLM.md` §7.

---

## 5. Where to read more

| Document | What is in it |
|---|---|
| [`README.md`](README.md) | the full tour, including the thirteen real problems with their traces |
| [`VOICE-DATA.md`](VOICE-DATA.md) | the packed voice byte by byte: the layout, the unused bits, the write path |
| [`LAYOUT-CROSSCHECK.md`](LAYOUT-CROSSCHECK.md) | which circulated DX7 layout table is right — four rulers that need no authority |
| [`LICENSE-AUDIT.md`](LICENSE-AUDIT.md) | what this repository may and may not ship, and why |
| [`MIDI-WRITE.md`](MIDI-WRITE.md) | why a standard bank dump, what the device does, and what is unverified |
| [`NATURAL-LANGUAGE.md`](NATURAL-LANGUAGE.md) | the plain-language layer: structure, measured numbers, three measurement lessons |
| [`LLM.md`](LLM.md) | why no server, why the model cannot break a voice, how failures fall back |

**Licence:** MIT for the code; the 32 bundled voices are separately **CC0**.
