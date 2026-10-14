# FM-1 Tone Bench

An M-VAVE FM-1 voice engine that lives in the browser. **Search, audition, edit by plain
language, export, write to the device.**

**▶ Live: https://fm1-tone-engine.app.workbuddy.host/** — no install, no build, no account.

It is a single `index.html`. Double-click it and it runs. No bundler, no npm dependencies,
no server. Only the device-write feature needs hardware; everything else works with no
hardware and no network.

The plain-language editing layer runs on a **local dictionary** by default (offline, free).
To make it understand *descriptions* rather than literal keywords — "like an old electric
piano, but brighter" — you can swap the middle layer for an LLM. **No server required: it
talks to the provider straight from the page.** See [`LLM.md`](LLM.md).

---

## What it does

- **32 voices the moment you open it** — an original voice library shipped with the repo,
  each one annotated with the FM principle it demonstrates
- **Load** the 128 factory voices (4 banks), or drag in any number of standard DX7 `.syx` banks
- **Search** by voice name, source file, original name, Yamaha cartridge ID, algorithm number;
  sort by brightness
- **Audition** with one click. A 6-operator FM engine synthesises in the browser — no plugin
- **See the structure** — every voice draws its own **algorithm diagram**: how the 6 operators
  are wired, which are carriers, where the feedback lands
- **Export** a single audition as WAV; glue the first 32 search results into a new `.syx` bank
- **Trace provenance** — a per-slot ledger for factory voices: which DX7 bank file it came from,
  its original name, whether it can be traced back to an official Yamaha cartridge
- **Edit by plain language** — pick a voice as an anchor, type "brighter, longer tail", and it
  tells you what it understood, which parameters it intends to move, and what the result is.
  **A/B it before you keep it.** Parsing happens locally by default: offline, free, and the edit
  lands on a copy — not one byte of the original voice is touched.
  Numbers and method: `NATURAL-LANGUAGE.md`
- **LLM-backed editing (optional)** — swap the middle layer for a model and it understands
  descriptions instead of literal keywords. Talks to any OpenAI-compatible endpoint, **no
  server in between** (verified: DeepSeek and Zhipu answer on the `null` origin a `file://`
  page sends). Or point it at a local Ollama and pay nothing.
  Three hard design boundaries: **the model cannot touch bytes** — it can only say
  "brightness +0.45", and which parameter that moves is still computed by a deterministic
  mapping that carries byte-level round-trip assertions, so it *cannot* break a voice;
  when the model answers off-topic it **falls back to the local dictionary** and says why;
  the API key never leaves your browser. See [`LLM.md`](LLM.md)
- **Write to the device** over Web MIDI (needs an FM-1 plus Chrome/Edge). Three gates:
  standard bank dump only, an explicit confirmation checkbox, and fewer than 32 voices does
  not pass. **Not verified on real hardware** — what to check first once you have the device
  is in `MIDI-WRITE.md`
- **Self-audit** — the page runs a decoder audit on open; every PASS/FAIL line is visible

---

## Why it is not just another editor

The FM-1 scene already has an excellent librarian (fm1-editor.com) and 40+ alternative
firmwares. This project deliberately does **not** compete on either. It occupies one narrow
slot nothing else covers:

**Editing a DX7-compatible voice by talking to it, with no hardware and no install.**

Two consequences that matter:

- **You can use it before you own the device.** The FM engine renders in the browser, so you
  can hear a voice — and hear what the AI did to it — with nothing but a browser tab.
- **The AI cannot corrupt anything.** It never emits bytes. It only emits five axes
  (`bright` / `sustain` / `attack` / `width` / `feedback`) with intensities between −1 and +1.
  A deterministic mapping — the part that *is* covered by measured assertions — turns those
  into operator parameters. The worst case for a hallucinating model is "nothing changed",
  never "the voice is broken".

---

## The three-layer voice source: works out of the box, ships nothing it shouldn't

Those two goals look mutually exclusive — if you don't ship the bytes, doesn't a fresh clone
get an empty shell? A three-layer structure resolves it:

| Layer | Source | Requires | Contents |
|---|---|---|---|
| ① | `data/starter.js` | nothing — shipped in the repo | 32 original voices (CC0), each with design notes |
| ② | upstream raw link | network | the 128 factory voices, **fetched and parsed by the page at runtime** |
| ③ | `data/factory.js` | running a build script locally | same, plus a 128-row provenance ledger |

The layers don't conflict; whichever is present wins. **Layer ② is the interesting one:**

> You click a button, and your browser fetches the raw bytes from upstream and parses them
> in memory. The bytes never enter this repository, and were never distributed by the author.

That is the same legal act as `tools/fetch_ref.sh` — providing a tool, not the content — but
the experience goes from "run three commands" to "click once". Upstream returns
`Access-Control-Allow-Origin: *`, so a `file://` page can fetch it too.

If the fetch fails (offline, blocked, browser restriction) it falls back to layer ①: the 32
original voices are unaffected, and a message explains how to get the data locally.
**It never fails silently.**

---

## Licensing: the "can I ship this?" question, actually answered

See **`LICENSE-AUDIT.md`**. In one line:

> The rights chain for the 128 factory parameter sets **breaks at layer 1 (Yamaha)**.
> The upstream repo declares CC0 over that data, but that declaration only covers its own
> capture and decoding work, and explicitly states it claims no rights over the voice
> parameters themselves.

So this repository **does not ship those bytes**:

| | |
|---|---|
| ✅ Ships | engine code, the 32-algorithm connection table, format documentation, 32 original voices, the audit |
| ❌ Does not ship | `ref/`, `data/factory.js`, `demo/*.wav` — all in `.gitignore` |

**The distinction is not formalism**: distribution is a separate act that can be held
accountable. Providing a tool is not.

The 32 voices under `starter/` are designed **from scratch** by this project and released as
CC0 — they are not subject to that restriction, which is exactly why layer ① can exist.

**This project's own licence is MIT** (see `LICENSE`): use it, modify it, sell it, redistribute
it — the only requirement is keeping the copyright notice. Same logic as above: a repo that
ships only tools and no third-party bytes should state its own position plainly.

---

## Using and verifying it

**Just want to use it:** open <https://fm1-tone-engine.app.workbuddy.host/>. Or clone and
double-click `index.html`. There is no other step.

**Want the 128 factory voices offline:** click "fetch FM-1 factory voices" in the page. For a
fully offline copy, run once locally:

```bash
bash   tools/fetch_ref.sh        # fetch reference bytes from upstream (ref/)
python tools/build_assets.py     # rebuild data/factory.js
```

**Want to verify the whole project:**

```bash
node   tools/verify.mjs          # 1. decoder audit (against real bytes)
node   tools/engine_test.mjs     # 2. audition engine audit (algorithm table + synthesis)
node   tools/verify_starter.mjs  # 3. bundled voice library: does it sound / are params legal
node   tools/midi_test.mjs       # 4. MIDI layer: byte alignment, send gates, device round-trip
node   tools/intent_test.mjs     # 5. plain-language layer: is the direction right, measured by rendering
node   tools/llm_test.mjs        # 6. LLM layer: malformed replies, failure fallback, no key leakage
node   tools/smoke.mjs           # 7. page end-to-end, five scenarios
```

All seven exit 0, **440 assertions total** (26 + 28 + 30 + 57 + 33 + 109 + 157), reproducible.

**They also all exit 0 on a fresh clone.** The parts that need factory data print `SKIP` and
say how to supply it — they neither crash nor quietly pass. That is deliberate: a public
repo's test suite has to finish on a machine where nothing has been configured.

The four assertions that matter most:

- **#4** takes the bytes rebuilt from real device captures in `data/factory.js`, pushes them
  through the send path and re-packs them, then requires the output to be **byte-identical**
  to the original — proving what the page sends is the same bank the real world has.
- **#5** says "brighter" and then actually renders **192 voices** and measures spectral
  content, requiring **zero** of them to move the wrong way; says "longer tail" and actually
  measures the envelope. **This layer's correctness is never judged by reading the code.**
- **#6** throws every kind of misbehaving model at it — garbage output, wrong axis names,
  0–100 scoring, out-of-range values, 401, network down, timeout, and a model that honestly
  says it can't — **none may throw**, and each must land on a result that can explain itself.
  Separate assertions specifically watch for "no API key in the return value".
- **#7** installs a **network gate** in every scenario: a scenario that should not touch the
  network gets caught by an assertion if it does, rather than quietly falling back to the
  local dictionary and hiding the problem.

**Want to change the 32 bundled voices:**

```bash
python tools/make_starter.py     # pack the bank, starter.js, starter/README.md
node   tools/render_starter.mjs  # render starter/preview/_starter_medley.wav
```

---

## Repository layout

```
index.html                the entire UI. double-click and it runs
engine/dx7.js             DX7/FM-1 format layer: decode, serialize, checksum, parameter ranges
engine/fm.js              6-operator FM audition engine (same file shared by browser and Node)
engine/midi.js            MIDI transport: Web MIDI wrapper, send gates, device-side simulation
engine/intent.js          intent layer: phrasing -> five axes. hot-swappable for an LLM
engine/llm.js             LLM layer: prompt building, tolerant parsing, failure fallback, key storage
LICENSE                   MIT — use, modify, sell; just keep the notice
LICENSE-AUDIT.md          licensing and provenance audit — what this repo may and may not ship
MIDI-WRITE.md             writing to the device: why standard bank dump, and what is unverified
NATURAL-LANGUAGE.md       the plain-language layer: structure, measured numbers, three measurement lessons
LLM.md                    LLM integration: why no server, why the model can't break a voice, error handling

starter/README.md         bundled library notes + design table for all 32 voices (script-generated)
starter/FM-1_starter_bank.syx  the 32 original voices as a standard DX7 bank, importable into Dexed
starter/preview/          29-second audition medley of that library

data/starter.js           shipped in the repo: 32 original voices (CC0)
data/README.md            which data goes in the repo, which does not, and why
data/factory.js           (generated, gitignored) 4 factory banks + a 128-row ledger

tools/fetch_ref.sh        fetch reference bytes from upstream
tools/build_assets.py     rebuild data/factory.js from the reference bytes
tools/make_starter.py     generate the bundled library (the 32 voice definitions live here)
tools/verify.mjs          1. decoder audit
tools/engine_test.mjs     2. engine audit
tools/verify_starter.mjs  3. bundled-library audit
tools/midi_test.mjs       4. MIDI audit (includes byte-for-byte comparison against ground truth)
tools/intent_test.mjs     5. intent audit (direction correctness measured, never read off the code)
tools/llm_test.mjs        6. LLM audit (fake fetch throughout; no key, no network)
tools/smoke.mjs           7. page end-to-end (five scenarios)
tools/serve.mjs           local static server (the way out when file:// can't get MIDI permission)
tools/serve.cmd           Windows double-click version — no typing commands
tools/render_demo.mjs     render audition audio for the factory voices
tools/render_starter.mjs  render audition audio for the bundled library
tools/fft.mjs             spectral analysis (the "ruler" the engine audit measures with)
tools/diag_spectrum.mjs   inspect one voice's spectral peaks
tools/diag_ranges.mjs     list every out-of-range value with its raw bytes
tools/diag_amp.mjs        amplitude/envelope diagnostics (used to locate a byte-order bug)
tools/analyze_ref.py      early script used to reverse-engineer the byte layout

ref/                      (gitignored) ground truth: packed128.bin / bank1.syx / protocol.md
demo/                     (gitignored) audition WAVs of the factory voices
```

---

## The audition engine's boundaries (please read this part)

**It is not a DX7 clone. It is an approximation good enough to tell voices apart.** For an
accurate recreation use Dexed — it is free and it does a better job. The goal here is to let
you **distinguish** voices in a browser, not to **reproduce** them.

### Implemented

| Part | Approach |
|---|---|
| Operator routing | all 32 algorithms, including the cross-operator feedback in algorithms 4 / 6 (OP4→OP6, OP5→OP6) |
| Frequency | ratio mode (coarse 0 → 0.5, fine +1%/step), fixed mode (1/10/100/1000 Hz) |
| Detune | ±4 cents/step (approximate; the DX7 curve is not linear) |
| Envelope | 4 segments: R1–R3 advance while held, R4 releases on key-up; **timed by level span** (a zero-span segment is near-instant) |
| Level mapping | 0.75 dB/step; level 0 maps to exactly zero |
| Feedback | one-sample delayed feedback; amount = (n/7)² |
| Output | peak-normalised to 0.85 (gain capped at 20× so an extremely quiet envelope doesn't get lifted into noise) + 3 ms fade in/out |

### Not implemented (changes detail, not a bug)

- **Key level scaling** (breakpoint / left-right depth / curve) — it makes one voice brighter
  up high and darker down low
- **Rate scaling** — it makes envelopes run faster in the upper register
- **Velocity sensitivity** — preview always uses full velocity
- **LFO** — so no vibrato or tremolo
- **Pitch EG** — so no pitch glide at the attack
- **DX7 bit depth and DAC character** — Dexed emulates this with three engines
  (Modern / Mark I / OPL); this uses an ideal sine

The parameter table in the UI shows these fields as they are. You can see them, you just
can't hear them.

---

## Where the algorithm table came from

The operator connections for all 32 algorithms come from a public text description (LAU
mailing list, provided by Sean Bolton, excerpted from the hexter sources), transcribed
without flattening the original nesting.

**Cross-checked against four independent facts from Yamaha's official DX7 manual — all agree:**

| Manual | Matches |
|---|---|
| Algorithm 1 has two carriers: OP1 and OP3 | ✓ |
| Algorithm 5 is 3 carriers + 3 modulators | ✓ |
| Algorithm 16 is 1 carrier + 5 modulators | ✓ |
| Algorithm 32 is 6 carriers, no modulators | ✓ |

Plus two global invariants (asserted in `tools/engine_test.mjs`): **OP1 is a carrier in all 32
algorithms**; each algorithm uses all 6 operators exactly once with exactly one feedback path.

Note: hexter itself is GPL-2.0. **This project uses none of its code** — only factual
descriptions of hardware behaviour (the same content is public in Yamaha's manual). Pulling in
its implementation later would be a licensing question.

---

## Twelve real problems along the way (all fixed, all left a trace)

1. **The algorithm table was missing a layer of sharing.** Algorithms 19–25 use a temporary
   variable in the original notation so one modulator feeds several carriers; I transcribed
   the expression twice. Numerically equivalent, structurally wrong. The "every operator
   appears exactly once" assertion caught it.

2. **The ruler itself was broken.** That FFT had been copied into three scripts, and two copies
   were missing the bit-reversal permutation — so every voice's "spectral centroid" landed at
   8–12 kHz and it looked like the engine was rendering white noise. **The engine was fine; the
   ruler was wrong.** Fixed by collapsing the FFT into one `tools/fft.mjs` and **adding
   assertions to the FFT itself**.

3. **The smoke test caught the page crashing.** In an environment without Web Audio, `playVoice`
   threw. Now it renders first and plays after — audition and WAV export still work, just
   silently.

4. **Wrong byte order, and the voice still looks legal.** Generating the bundled library, I
   interleaved the 8 envelope values `(R1 L1 R2 L2 R3 L3 R4 L4)` and took the first 4 as rates.
   The DX7 packed format is **4 rates, then 4 levels**. The consequences were subtle: format
   valid, checksum correct, rendering silent about it — but **every voice's envelope was not
   what it was designed to be**; a slow attack became "a short burst then a drop". What caught
   it was measured data: the render peak was 0.387, and 0.387 is exactly the amplitude of
   sustain level 88. Fixed by adding an `unpack_op` round-trip assertion so this class of error
   explodes at packing time.

5. **A tool changed the file's line endings.** Python's `write_text()` converts `\n` to `\r\n`
   by default on Windows, so a patch script rewrote every line ending in `index.html` and the
   smoke test's `/<script>\n/` immediately stopped matching. Fixed by explicitly passing
   `newline="\n"` at every Python write. **Tools bite too, and they bite quietly.**

6. **"Sort by slot" was actually a shuffle.** It was written as a string comparison of
   `(bankLabel + slot)` — which is **lexicographic** — so the order became 0, 1, 10, 11, …,
   19, 2, 20, … and all 32 voices in a bank were scrambled. The bug had been there since the
   day it was written and nobody could see it: the cards looked normal, the exported bank
   "looked right" too. It surfaced when the device-write feature was wired up — the 32 voices
   the page sent didn't match the source bank. **A new feature illuminates old code you were
   sure was fine.**

7. **"Oscillator sync" had been wrong since the day it was written.** It was read from bit 4 of
   byte 111; the standard format puts it at **bit 3**. Every real value is ≤ 15, so bit 4 is
   always 0 — the platform therefore read "off" forever, the UI displayed "off", and in fact
   **16 voices have it on**. It stayed silent for a whole round: format valid, round-trip
   passing, rendering normal. What caught it was the **pack→unpack round-trip assertion** added
   for voice editing — 127 bytes round-tripped identically and only 111 disagreed, which sent
   me back to the standard. **First "one bit too many", then "this parameter has always been
   fake": two bugs in one place.**

8. **The ruler was wrong three times, and each time it looked like a broken feature.** Building
   the plain-language layer: measuring attack with the sample-peak position (meaningless for a
   sustained tone); measuring brightness with spectral centroid (FM spreads energy
   symmetrically and *dilutes* the centroid, while the high-frequency energy share had actually
   risen 208%); measuring from a fixed instant (`BRASS 1`'s attack lasts 0.45 s, so it was
   measuring the moment *before* it gets bright). All three times the ruler was wrong, not the
   thing being measured. The fix went into the assertions: **spectral things get spectral
   rulers, envelope things get envelope rulers, and envelopes are always energy-weighted over
   the whole segment, never sampled at a fixed instant.** Full story in `NATURAL-LANGUAGE.md`.

9. **The JSON extractor found the model's own example.** Looking for "the first balanced brace"
   in a model's reply naturally picks up the example it gave first — "for instance
   `{"foo":"bar"}`, my suggestion is `{…}`" — instead of the actual answer. Format valid,
   parsing effortless, result wrong. Fixed by trying every balanced fragment and **preferring
   the one that is recognisable** (has `axes`, or a known axis name). This one came from
   writing test cases rather than from being burned — but it earns its entry.

10. **Rescaling by the batch maximum drags the correct value down with it.** Models sometimes
    score 0–100. I first rescaled by the batch maximum, so in `{"bright":0.5,"sustain":80}`
    the maximum was 80, everything got divided by 100, and **the perfectly correct 0.5 became
    0.005 and was dropped**. Fixed by deciding per value: ≤ 1 as-is, ≤ 10 on a 1–10 scale,
    larger as a percentage — and telling the user when a rescale happened. **Two scales mixed
    in one reply is something that actually happens.**

11. **A test that simulated an external dependency by mutating a global silently stopped
    working** once the dependency became injected. To test the LLM layer end-to-end I changed
    `fetch` to be passed in as an argument; the `globalThis.fetch = …simulate offline` line in
    scenario B stopped having any effect overnight — it was simulating something the page no
    longer used. What caught it was a newly added **network-gate assertion**: "a scenario that
    should not use the network must send zero requests." It named two unexpected requests
    outright. **An assertion's value is sometimes not the feature it verifies but the old
    ground it happens to illuminate.**

One by-product: a widely circulated DX7 byte-layout table puts the algorithm number at byte
96. **Measured, it is byte 110.** Which is why this project works backwards from real bytes
instead of coding against second-hand tables.

---

## Known limitations

- The audition engine's boundaries are above — **do not treat it as a sound design tool**
- A few points in the bundled library (e.g. `KICK`'s downward sweep) rely on the pitch
  envelope, which the engine does not implement — **the data is correct, it just cannot be
  heard in the browser yet**; `starter/README.md` marks each case
- The factory-voice provenance ledger comes from upstream `docs/` (**CC BY-SA 4.0**);
  redistributing the whole table requires attribution + share-alike
- The licensing status of `Dexed_cart 1.0` cannot be determined, so it may only be recorded as
  a *source*, never relied on as a *licence*
- The local dictionary layer matches **literal keywords** on five axes. It does not understand
  compound constraints (the second half of "warm but not muddy" is lost) or descriptions like
  "like an old electric piano" — only the LLM layer does.
  **And the model's axis-selection accuracy is not measured** (no real key was available, and
  no real model has been run over those 192 voices). What *is* verified is the **mapping**:
  axis → parameter → sound, measured with zero wrong-direction results. Boundaries in
  `LLM.md` section 7
- This project is **MIT**; the 32 voices under `starter/` are separately **CC0**.
  Third-party data boundaries are in `LICENSE-AUDIT.md`
- **The device-write feature has never been verified on real hardware.** The code is written,
  the tests pass, and the bytes it emits are byte-identical to the real world's — but "where
  the device stores them and in what order" needs a physical unit. What to check first is in
  `MIDI-WRITE.md` section 6
- Writing is irreversible: the FM-1 only receives, it never sends, so voices already on the
  device cannot be read back

---

## Documentation language

**The English README is the front door; the in-depth documents are currently in Chinese**
(`LICENSE-AUDIT.md`, `MIDI-WRITE.md`, `NATURAL-LANGUAGE.md`, `LLM.md`). Translating the
licensing audit first is the plan — it is the one this community asks about most. Until then,
the source comments and the tests are readable, and `LLM.md` is the shortest of the four.

The UI itself is in Chinese.

---

<sub>[中文版 README](README.zh-CN.md)</sub>
