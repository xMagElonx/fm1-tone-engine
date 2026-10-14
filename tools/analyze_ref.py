"""Empirically derive the DX7 packed-voice byte layout from FM-1 factory data.

Ground truth: ref/packed128.bin = 128 voices x 128 bytes, recovered from the
FM-1's own restore tool by KingParamount. We do NOT trust secondary blog tables;
we measure the byte ranges across all 128 voices and match them against each
DX7 parameter's legal range.
"""
import sys, pathlib, collections

REF = pathlib.Path(__file__).resolve().parent.parent / "ref"

# ---------------------------------------------------------------- .syx check
bank = (REF / "bank1.syx").read_bytes()
print("bank1.syx size:", len(bank), "(expected 4104)")
print("header:", bank[:6].hex(" "))
data = bank[6:6 + 4096]
chk = bank[4102]
end = bank[4103]
calc = (128 - (sum(data) & 0x7F)) & 0x7F
print(f"checksum in file: 0x{chk:02x}   calculated: 0x{calc:02x}   match: {chk == calc}")
print(f"terminator: 0x{end:02x} (expected 0xf7)")
print()

# ------------------------------------------------------- packed voices
blob = (REF / "packed128.bin").read_bytes()
N = len(blob) // 128
voices = [blob[i * 128:(i + 1) * 128] for i in range(N)]
print(f"packed voices: {N}")
print()

names = []
for i, v in enumerate(voices):
    raw = v[118:128]
    names.append("".join(chr(c) if 32 <= c < 127 else "." for c in raw).rstrip())
print("names 0-47:")
for i in range(0, 48, 4):
    print("   " + "  |  ".join(f"{i+j:3d} {names[i+j]:<10}" for j in range(4)))
print()

# ------------------------------- ranges per byte position across all voices
print("byte  min  max  distinct  (voice0 value)")
rows = []
for b in range(128):
    col = [v[b] for v in voices]
    rows.append((b, min(col), max(col), len(set(col)), voices[0][b]))

# candidate matches against legal DX7 ranges
cands = {
    "algorithm (0-31)": lambda lo, hi: lo >= 0 and hi <= 31 and hi >= 20,
    "feedback (0-7)": lambda lo, hi: hi <= 7 and hi >= 5,
    "osc sync / lfo sync (0-1)": lambda lo, hi: hi == 1,
    "lfo waveform (0-5)": lambda lo, hi: hi <= 5 and hi >= 4,
    "amp mod sens (0-3)": lambda lo, hi: hi <= 3 and hi >= 2,
    "transpose (0-48)": lambda lo, hi: 24 <= lo and hi <= 48,
    "detune (0-14)": lambda lo, hi: 10 <= hi <= 14 and lo <= 4,
    "coarse freq (0-31)": lambda lo, hi: hi <= 31 and lo <= 2,
}
for label, test in cands.items():
    hits = [r for r in rows if test(r[1], r[2])]
    print(f"\n{label}:")
    if not hits:
        print("    (none)")
    for b, lo, hi, d, v0 in hits[:14]:
        print(f"    byte {b:3d}   min {lo:3d}  max {hi:3d}  distinct {d:3d}   voice0 = {v0}")
