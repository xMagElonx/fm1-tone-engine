#!/usr/bin/env bash
# ============================================================================
# 取地面真值参考 —— 从上游仓库下载 FM-1 出厂音色的原始字节
# ----------------------------------------------------------------------------
# 为什么要有这一步，而不是直接把这些文件放进仓库：
# 见根目录 LICENSE-AUDIT.md。简单说，这批音色参数的权利链在 Yamaha 那一层
# 就断了，上游声明的 CC0 只覆盖它自己的抓包与解码，不覆盖音色参数本身。
# 所以本仓库不分发字节，只提供取字节的工具。
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p ref

BASE="https://raw.githubusercontent.com/KingParamount/fm1-factory-presets/main"

# raw.githubusercontent.com 偶尔会中断 TLS 握手（curl 报 56，
# "schannel: server closed abruptly"）。重试能盖住这类瞬时故障。
CURL="curl -fsSL --retry 4 --retry-delay 2 --retry-all-errors --max-time 120"

echo "→ 下载参考数据（ref/）"
$CURL -o ref/packed128.bin "$BASE/banks/FM-1_factory_128voices_packed.bin"
$CURL -o ref/bank1.syx     "$BASE/banks/FM-1_factory_bank1.syx"
$CURL -o ref/protocol.md   "$BASE/docs/protocol-and-provenance.md"

echo "→ 校验尺寸"
check() {  # 文件 期望字节
  local got; got=$(wc -c < "$1" | tr -d ' ')
  if [ "$got" != "$2" ]; then echo "  ✗ $1 期望 $2 字节，实际 $got"; exit 1; fi
  echo "  ✓ $1 $got 字节"
}
check ref/packed128.bin 16384
check ref/bank1.syx     4104

echo
echo "完成。接着跑："
echo "  python tools/build_assets.py     # 重建 data/factory.js"
echo "  node   tools/verify.mjs          # 审计解码器"
echo "  node   tools/engine_test.mjs     # 审计试听引擎"
echo "  node   tools/smoke.mjs           # 端到端跑一遍页面"
