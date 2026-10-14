# FM-1 / DX7 voice data: the packed voice, byte by byte

An M-VAVE FM-1 stores its voices in the standard Yamaha **DX7 packed** format.
That single fact is why a browser can talk to the thing at all — and it is why
this document is useful to anyone building an FM-1 or a DX7 tool, not only to
people using this project.

What is here that you will not find elsewhere: a layout that **executes**. The
table below is not prose, it is data — it lives in `engine/dx7.js` as
`DX7.LAYOUT`, and `tools/layout.mjs` checks it against real bytes. Every bit the
table *claims* must actually reach the decoder; every bit it *does not claim*
must reach nothing at all. You can point that tool at your own file; it needs
neither a device nor this project's data.

---

## 1. The three sizes you will meet

| What | Size | Notes |
|---|---|---|
| Full SysEx bank dump | 4104 bytes | `F0 43 00 09 20 00 … F7` — the only message this project will send |
| Bank payload | 4096 bytes | the 4104 minus the 6 header bytes, the checksum, and the trailing `F7` |
| One voice | 128 bytes | 32 voices to a bank; 16384 bytes is the FM-1's full 128-voice set |

Checksum, over the 4096-byte payload:

```
checksum = (128 - (sum(payload) & 0x7F)) & 0x7F
```

`0x43` is Yamaha's manufacturer ID, not M-VAVE's. This matters — see §6.

Every one of the 4104 bytes is a 7-bit MIDI data byte. Any value above 127 in
voice data is a decode error, not an exotic voice.

---

## 2. The packed voice

A 128-byte voice is **six 17-byte operator blocks** (block 0 = OP6 … block 5 =
OP1), then **26 bytes of global data**, then a **ten-character name**.

### 2.1 One operator block — 17 bytes, repeated six times

Absolute offset = `17 × block number + block offset`. Block 0 is OP6, block 5
is OP1 — the operators are stored in **reverse** order, which is the first thing
to get wrong.

| Block offset | Field | Bits | Range |
|---|---|---|---|
| +0 … +3 | envelope rates R1 R2 R3 R4 | whole byte | storage 0–127, panel 0–99 |
| +4 … +7 | envelope levels L1 L2 L3 L4 | whole byte | storage 0–127, panel 0–99 |
| +8 | keyboard level scaling break point | whole byte | storage 0–127, panel 0–99 |
| +9 | scaling left depth | whole byte | storage 0–127, panel 0–99 |
| +10 | scaling right depth | whole byte | storage 0–127, panel 0–99 |
| +11 | left curve (bits 0–1), right curve (bits 2–3) | 2 + 2 | 0–3 each — `-LIN -EXP +EXP +LIN` |
| +12 | rate scaling (bits 0–2), detune (bits 3–6) | 3 + 4 | 0–7; detune 0–14 on the panel, 7 = centre |
| +13 | amp mod sensitivity (bits 0–1), key velocity sensitivity (bits 2–4) | 2 + 3 | 0–3; 0–7 |
| +14 | output level | whole byte | storage 0–127, panel 0–99 |
| +15 | oscillator mode (bit 0), frequency coarse (bits 1–5) | 1 + 5 | 0–1; 0–31 |
| +16 | frequency fine | whole byte | storage 0–127, panel 0–99 |

Note that **four** of these bytes carry two fields each, and they are packed in
opposite directions: curves go low-to-high (`left` in the low bits), while
`rate scaling` takes the low bits and `detune` the high ones. Reading a two-
field byte with the wrong half is a silent error — the value stays legal, it is
just somebody else's parameter.

### 2.2 The global region — 26 bytes, offsets 102–127

| Offset | Field | Bits | Range |
|---|---|---|---|
| 102 … 105 | pitch envelope rates R1 R2 R3 R4 | whole byte | storage 0–127, panel 0–99 |
| 106 … 109 | pitch envelope levels L1 L2 L3 L4 | whole byte | storage 0–127, panel 0–99 |
| 110 | **algorithm** | bits 0–4 | 0–31 (displayed as 1–32) |
| 111 | feedback (bits 0–2), **oscillator key sync** (bit 3) | 3 + 1 | 0–7; 0–1 |
| 112 | LFO speed | whole byte | storage 0–127, panel 0–99 |
| 113 | LFO delay | whole byte | storage 0–127, panel 0–99 |
| 114 | LFO pitch mod depth | whole byte | storage 0–127, panel 0–99 |
| 115 | LFO amp mod depth | whole byte | storage 0–127, panel 0–99 |
| 116 | LFO sync (bit 0), LFO wave (bits 1–3), LFO pitch mod sensitivity (bits 4–6) | 1 + 3 + 3 | 0–1; 0–5 on the panel (7 fits the field); 0–7 |
| 117 | transpose | whole byte | 0–48 on the panel, 0–127 fits the field |
| 118 … 127 | voice name | 10 whole bytes | ASCII, space padded |

---

## 3. Bits the format does not use

Worth knowing, so that you do not go looking for a meaning that is not there.
These are absent from `DX7.LAYOUT` on purpose, and the tool asserts that each
one is genuinely dead — flipping it must not change a decoded voice.

| Where | Bits |
|---|---|
| every operator block | byte +11 bits 4–6, byte +13 bits 5–6, byte +15 bit 6 |
| global | byte 110 bits 5–6, byte 111 bits 4–6 |

And in a valid MIDI data byte, **bit 7 is always zero** — it does not exist as
an addressable bit in this format at all.

---

## 4. Two traps — both of which we fell into ourselves

We did not find these by reading a table. We found them because a round-trip
check disagreed with us, and the disagreement turned out to be right.

### Trap 1: oscillator key sync is bit 3 of byte 111, not bit 4

It was written as bit 4. Every real value of byte 111 is ≤ 15, so bit 4 is
always zero — which means the parameter read as "off" for every voice, and the
UI showed "off" for every voice, and **87 of the 128 factory voices have it
on** — bit 4 is set in none of the 128, bit 3 in 87 of them. Format valid.
Checksum correct. Rendering silent about it.

What caught it was a **pack → unpack round-trip assertion**: 127 of the 128
bytes came back identical and only byte 111 disagreed. One disagreeing byte,
out of 128, is easy to dismiss as noise. It was not noise.

### Trap 2: the envelope is four rates *then* four levels

Not `(R1 L1 R2 L2 R3 L3 R4 L4)` interleaved. Writing the interleaved form keeps
the format legal and the checksum correct, and it makes **every voice's envelope
something other than what it was designed to be** — a slow attack becomes a
short burst and a drop.

The stereo test for it here was arithmetic rather than structural: the rendered
peak came out at 0.387, and 0.387 is exactly the amplitude of sustain level 88.
When a measurement lands precisely on a parameter value, you are not looking at
the sound, you are looking at the parameter.

### And: the algorithm is at byte 110

Some circulated DX7 parameter tables put the algorithm number at byte 96. In the
packed format used by bulk dumps, measured on 128 captured voices, it is **byte
110**. If your table disagrees, §5 settles it in about a second — which is a
better use of your time than trusting either table.

Two other layouts are real, and they are where the *other* numbers come from: the
unpacked format (169 bytes, 23 per operator) puts the algorithm at 146, and the
MIDI parameter-change address puts it at 134. Neither is 96.

Which circulated table is right is settled by measurement rather than authority;
the measurements are written up in [`LAYOUT-CROSSCHECK.md`](LAYOUT-CROSSCHECK.md).

---

## 5. Check your own bytes

```bash
node tools/layout.mjs <your-bank.syx>      # or a raw .bin of packed voices
node tools/layout.mjs                       # no argument: self-check on the bundled library
node tools/layout.mjs --map                 # print the whole layout table
```

It accepts a standard SysEx bank (4104 bytes, or any multiple), or raw packed
voices (any multiple of 128 bytes). It then checks four things:

1. **The layout table against itself** — 128 bytes × 7 bits, no bit claimed
   twice, no byte left entirely unclaimed.
2. **Bit-level attribution** — each claimed bit is flipped on its own; the
   decoded voice must change. Each unclaimed bit is flipped; the decoded voice
   must *not* change. This is the check that fails loudly on Trap 1 above: it
   reports `111.3` (claimed but dead) and `111.4` (live but unclaimed) by name.
3. **Round-trip** — `decodeVoice → encodeVoice` must reproduce the original
   bytes exactly, for every voice.
4. **Ranges** — no negative or fractional parameters, no byte above 127, no
   voice with every operator at output level 0.

It exits non-zero if anything fails. Pointing it at a bank you built yourself is
the fastest way to find out whether your encoder agrees with the format.

---

## 6. Writing to an FM-1

The FM-1 accepts **standard DX7 bank imports**. It does not need M-VAVE's own
transport, and that is a good thing, because M-VAVE's transport cannot be
reimplemented: it uses manufacturer ID `00 32` rather than Yamaha's `43`, 1190
bytes per message carrying a 7-bit bitstream, and **the checksum algorithm is
not published and has not been worked out** — summing and XORing the header,
the payload, and the decoded data, in plain and two's-complement form, matches
nothing across the sixteen blocks of a real capture.

So the write path is one message, the one from §1:

```
F0 43 00 09 20 00 <4096 bytes> <checksum> F7
```

Two things about that header, stated plainly: `20 00` is what the real capture
contains, and we copied it rather than deriving it. We did not establish whether
the FM-1 parses that field the DX7 way or by its own rule. It works in the sense
that this is the bytes the ground truth has.

### Send one kind of message, and nothing else

A device that accepts bulk voice data will usually accept other things too. In
the FM-1's case:

```
F0 22 24 35 7D F7      puts the unit into chip download mode
F0 22 24 35 7F F7      the normal upgrade command
```

**They differ in one nibble of one data byte.** Given that, a blacklist is the
wrong shape of defence. This project allows exactly one message to leave: the
4104-byte standard bank dump, checked for length, header, terminator and
self-consistent checksum before it goes anywhere. Anything else is refused
locally.

### Three things to know before you write

- **There is no standard path to reading the device back.** The FM-1 answers no
  standard DX7 read request, so with standard tooling there is no "back up the
  device" — only "back up what you already have".
  *(Corrected 2026-10-15: one undocumented private command does return the
  current voice, one voice at a time, in a format that still needs parsing. This
  project neither implements nor has verified it — `MIDI-WRITE.md` §5.5.)*
- **The onboard factory reset does not restore the factory set.** It restores
  whatever was last imported. It is not a safety net for a bad write.
- **A standard bank dump carries no target address and gets no acknowledgement.**
  There is nothing in the message that says which bank it lands in, and the
  device does not reply. So a sender can honestly say "bytes were sent" and
  cannot honestly say "the write succeeded".

---

## 7. What is *not* known

Stated here so that nobody mistakes a plausible sentence for a measured one.

- **Which bank a received dump lands in.** The private protocol addresses the
  target slot explicitly; the standard bank dump has no such field. This project
  assumes "the device's currently selected bank" — an assumption, isolated in
  one place (`FakeFm1.selectedBank` in `engine/midi.js`) precisely so that a
  single correction fixes it.
- **Whether the write path works on real hardware at all.** The code is written,
  the tests pass, and the bytes it produces are byte-identical to a real capture
  — but no physical FM-1 has ever been used with it. This is the largest open
  question in the project.
- **Whether a 4104-byte SysEx survives an OS MIDI stack intact.** If a real
  device ignores a write, chunked sending is the first thing to try.

---

## 8. Where these facts come from, and what that means for reuse

Two independent sources, and it is worth keeping them separate:

- **The byte layout** is from Yamaha's DX7 MIDI Data Format Sheet ("Bulk Dump
  Packed Format"), cross-checked here against 128 voices captured from a real
  device. **A format description is a fact and is not copyrightable**; this
  document and the table in `engine/dx7.js` are original work released under
  this project's MIT licence. Use them.
- **The voices themselves are a different question entirely.** The FM-1's 128
  factory voices trace back to Yamaha ROM and VRC cartridge material and to a
  community DX7 compilation, and the upstream capture repository declares CC0
  over *its own* capture and decoding work while explicitly claiming no rights
  in the voice parameters. **None of that cures the chain, and this repository
  therefore ships no voice bytes.** The full reasoning, including what may and
  may not be redistributed, is in [`LICENSE-AUDIT.md`](LICENSE-AUDIT.md).

Format knowledge here; data there. The distinction is the whole point.

---

<sub>[中文说明](README.zh-CN.md) · [main README](README.md)</sub>
