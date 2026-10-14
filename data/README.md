# data/ 里哪些进仓库、哪些不进

这个目录同时装着两种性质完全不同的数据，别混在一起看：

| 文件 | 进仓库？ | 为什么 |
|---|---|---|
| `starter.js` | **进** | 32 个原创音色，CC0 1.0，本项目自己设计的 |
| `factory.js` | 不进 | 128 个出厂音色的完整字节，权利链在第 1 层就断了 |

---

## `starter.js`（进仓库）

随仓库分发的 32 个原创音色，页面双击打开就靠它。生成方式：

```bash
python tools/make_starter.py
```

音色参数写在 `tools/make_starter.py` 里，设计说明见 `starter/README.md`（也由脚本生成）。
它以 **CC0 1.0** 发布，可以随仓库自由分发 —— 这是它与 `factory.js` 的根本区别。

---

## `factory.js`（不进仓库）

`data/factory.js` 里含有 **M-VAVE FM-1 出厂 128 音色的完整字节**，以及逐槽来源台账。
它**不应该被提交到公开仓库**——理由见根目录 `LICENSE-AUDIT.md`。

`ref/` 同理：那是从上游仓库下载的地面真值参考（`packed128.bin`、`bank1.syx`），
同样含有音色数据。

所以这两个目录都在 `.gitignore` 里。它们留在本地，页面照常工作。

## 怎么在本地重建

```bash
# 1. 从上游仓库取地面真值（参考 bank + 128 个 packed 音色）
bash tools/fetch_ref.sh

# 2. 用它们重建 data/factory.js
python tools/build_assets.py

# 3. 验证
node tools/verify.mjs
```

跑完之后刷新 `index.html`，出厂音色按钮就会出现。

## 上游是谁

`github.com/KingParamount/fm1-factory-presets` —— 2026-09 从 M-VAVE 官方还原工具的
SysEx 抓包中重建出厂音色，并逐槽做了来源溯源。

**注意**：上游对 `banks/` 声明的是 CC0，但那份声明**只覆盖他自己的贡献**
（抓包、解码、重组），并明确表示他不对音色参数本身主张权利。
换句话说，即使你从上游拿到了这些字节，你拿到的也只是一个**没有权利来源的许可**。
详见 `LICENSE-AUDIT.md`。
