# FM-1 音色台 · 授权与来源审计

> 一次把这些仓库的许可证与音色数据的权利来源查到底。
> 结论不乐观，但它决定了这个项目**能发什么、不能发什么**。

---

## 结论先行

**出厂音色的 128 个参数集，权利链在第 1 层就断了，后面每一层签发的许可都无法治愈它。**

最要紧的一条，也是整份文档里唯一需要记住的一句：

> 上游那个仓库对音色数据声明了 CC0 —— 但 CC0 在这里是**弃权声明（quitclaim），不是权利转让**。
> 一个作者只能放弃他自己拥有的权利。他在 `LICENCE.md` 里明确写了
> 「我对音色参数本身不主张任何权利」，也就是说，这部分他**从未拥有过**，
> 自然也无从放弃。你从上游拿到的，是一个**没有权利来源的许可**。

所以：引擎代码可以发，音色字节不能发。下面逐条给出依据。

---

## 一、每条线索查到了哪里

### 1. 上游：`KingParamount/fm1-factory-presets`

`LICENCE.md` 原文（逐字摘录）：

```
## banks/
The four .syx bank files and FM-1_factory_128voices_packed.bin are released
under CC0 1.0 Universal.

This covers only my own contribution: the SysEx capture, the decode of
M-VAVE's transport format, and the reassembly of the voice data into standard
DX7 bank dumps. I claim no rights in the voice parameters themselves. Those
originate from Yamaha ROM and VRC cartridge material and from the community
Dexed_cart 1.0 compilation, as selected and renamed by M-VAVE.
See docs/protocol-and-provenance.md for the per-voice trace.

## tools/
MIT.

## docs/
Prose and the provenance PDF: CC BY-SA 4.0.
```

**一个仓库，三份许可证，而且每一份覆盖的范围都不同。** 这解释了为什么 GitHub 的
许可证识别 API 对这个仓库返回 `NOASSERTION`（无法识别）而不是某个具体协议。

关键在于那段自我限定：CC0 只覆盖**他自己加的那层**——
抓包、解码 M-VAVE 传输格式、把数据重组回标准 DX7 bank。
音色参数本身，他不主张，也就不可能授权。

### 2. 参数的上游之一：Yamaha 的 ROM / VRC 卡带

溯源的 128 个音色里，**40 个可以追回 Yamaha 官方卡带**（ROM1A–4B 与 VRC101A–112B）。
其中 23 个字节级完全相同，9 个差 1–5 字节且名称对应，8 个差距在 15 字节内且名称对应。

Yamaha 对 DX7 音色数据的立场，最硬的一条证据来自它自己的 EULA
（DX7 Pack for Genos2，`my.yamaha.com/en/support/updates/dx7_pack.html`）：

> The SOFTWARE is owned by Yamaha and/or Yamaha's licensor(s), and is protected
> by relevant copyright laws and all applicable treaty provisions.
> … You may not reproduce, modify, change, rent, lease, or distribute the
> SOFTWARE in whole or in part, or create derivative works of the SOFTWARE.

这不是同一份文件，但是**同一权利人、同一类标的**。它足以说明：
Yamaha 从未把这些音色参数放进公有领域。

### 3. 参数的上游之二：`Dexed_cart 1.0`（BlackWinny）

溯源的结论是：**126 / 128 个出厂音色与这个合集逐字节相同**
（比对池是 3837 个 SysEx 文件解析出的 3525 个 bank，去重后 29615 个唯一参数集，
所以 112 字节的完全匹配不可能是合集内部冗余造成的巧合）。

这个合集的性质：KVR Audio 用户 BlackWinny 汇编的 DX7 音色合集，
由 Dexed 官方站推荐（"BlackWinny from kvraudio did a great DX7 compilation
named Dexed_cart_1.0.zip"）。

**它没有任何许可证声明。** 我核对的是公开能找到的唯一正式来源（Dexed 官网、
各镜像的 README、KVR 原帖），三处都没有许可条款。

这一点必须说清楚：**「自由流通」不是「已授权」。**
一份文件在网上传了三十年，唯一能证明的是没人管，不是没人有权管。

### 4. 资源中心：`aroum/fm1-custom-fw`

GitHub API 查询结果：`"license": null` —— **仓库根目录没有任何 LICENSE 文件。**

在著作权法下，没有许可证 = 默认保留所有权利。这不是"随便用"的信号，
恰恰相反。如果你要引用它的 README 内容（那份社区固件清单），
严格讲你需要单独取得许可。

### 5. 本项目实际引用到的其他代码

| 组件 | 仓库 | 许可证 | 本项目是否使用其代码 |
|---|---|---|---|
| 固件脚手架 | `zvenson/dinghy` | GPL-3.0 | 否 |
| DX7 引擎参考实现 | `asb2m10/dexed` | GPL-3.0（msfa 组件 Apache-2.0） | 否 |
| 32 算法连接表的文本化表示 | `smbolton/hexter`（经 LAU 邮件列表公开） | **GPL-2.0** | 否（只用事实描述） |

第三行需要单独说明：本项目的 32 算法连接表，用的是对**硬件行为的事实性描述**，
这种描述同时也公开在 Yamaha 官方的 DX7 操作手册里（手册明确写出了算法 1 的载波是
OP1 与 OP3、算法 5 是 3 载波 3 调制器、算法 16 是 1 载波 5 调制器、算法 32 是 6 载波）。
事实本身不受著作权保护。**但如果将来要直接搬运 hexter 的代码实现，那份代码是
GPL-2.0，会传染。**

---

## 二、权利链逐层拆解

```
Yamaha（ROM / VRC 卡带，1983–1987）
   │  ← 从未授权进公有领域（见其 EULA）
   ▼
匿名 DX7 SysEx 合集（Aminet 等，互联网自由流通数十年）
   │  ← 来源不可考 = 无法取得许可，也无法证明已获许可
   ▼
Dexed_cart 1.0（BlackWinny 汇编）
   │  ← 汇编者可能对"汇编"享有权利，但对其中每个音色参数没有权利
   ▼
M-VAVE 的挑选与改名（把目录名当音色名，如 GUITAR 3 其实是 ROM1B 的 BANJO）
   │  ← 挑选编排可能构成新的汇编作品；下层权利仍不在他手上
   ▼
KingParamount 的抓包与重建（本次上游）
   │  ← 只对"抓包 / 解码 / 重组"这一层声明 CC0
   ▼
本站（fm1-tone-engine）
```

**断点在第 1 层。** 从第 2 层往下的每一次"授权"，都是没有 title 的人在转让 title。

一个法学院式的说法：这是典型的**权利瑕疵沿链条继承**。善意取得在这里帮不上忙，
因为标的不是有体物，而且下游每一个人都在文件里承认了自己没有底层权利
（上游那份 `LICENCE.md` 甚至主动写出来了）。

---

## 三、这个项目能发什么、不能发什么

### ✅ 可以发

- `engine/dx7.js`、`engine/fm.js`、`index.html`、`tools/*` —— 全部是本站自己写的
- **`starter/` 与 `data/starter.js`** —— 32 个**从零设计**的音色，不派生自任何 Yamaha
  出厂音色或第三方 DX7 音色库，以 **CC0 1.0** 发布。这是本项目唯一可以随仓库分发的
  音色数据；理由见下面「为什么需要一份自己的音色库」
- **32 个算法的算子连接表** —— 对硬件行为的事实性描述，Yamaha 官方手册已公开
- **DX7 packed voice 格式说明**（128 字节布局、偏移量、校验和算法）—— 同上，
  来源于 Yamaha 的 MIDI Data Format Sheet，属事实
- **这份 `LICENSE-AUDIT.md` 本身** —— 而且说实话，这是整个仓库里最有价值的东西：
  上游做了逐槽溯源，但没有人把"这批数据到底能不能用"写清楚

### ❌ 不要发

- `ref/` —— 从上游下载的地面真值（`packed128.bin`、`bank1.syx`）
- `data/factory.js` —— 内含 128 个出厂音色的**完整字节**
- `demo/*.wav` —— 用这些音色渲染出来的音频，问题完全相同
- 上游的逐槽台账表（`docs/` 是 CC BY-SA 4.0，整表搬运需署名 + 相同方式共享）

**已经处理**：上述三项都写进了 `.gitignore`。它们留在本地不影响使用，
但不会被提交。使用者用 `tools/fetch_ref.sh` + `tools/build_assets.py`
在自己的机器上重建——**由使用者自己去取那些字节，而不是由本仓库分发**。

这个区别不是形式主义：分发是一个独立的、可被追责的行为，而提供工具不是。

### 为什么需要一份自己的音色库

只发工具会带来一个副作用：别人 clone 下来，双击 `index.html` 是个空壳 ——
必须先跑两条命令才看得见东西。这个体验很差，而且它把"权利干净"变成了
一个由用户承担的成本。

解法不是"那就把字节发了吧"，而是补上第三层：

| 层 | 谁提供 | 权利状态 |
|---|---|---|
| ① `data/starter.js` | 本仓库 | CC0 —— 本项目原创，可自由分发 |
| ② 上游 raw 链接 | 页面在运行时去取 | 从本仓库走出去的字节数为 0 |
| ③ `data/factory.js` | 用户本地重建 | 同上 |

于是"点开就能用"和"不发不该发的"同时成立 —— ①负责前者，②负责后者。

有个细节值得单独说：**给出链接让页面去取，和把字节打进仓库，是两件事。**
前者是本仓库在说"那份数据在那里"，后者是本仓库在复制发行它。
前者不构成发行，后者构成。这也是为什么第 ② 层要写成运行时拉取，而不是
在构建时下载、再打进一个 JS 文件。

---

## 四、项目自己的许可证：选了 MIT

**当前状态：不含任何 GPL 代码，可以自由选择。** 已经落地为 **MIT**，文件在仓库根目录 `LICENSE`。

选它的理由很直白：这个仓库只发工具、不发第三方的字节（第二节那一堆限制已经把该挡的
都挡住了），那它自己就该把态度写清楚。MIT 是「随便用、改、商用、二次分发，
只要保留版权声明」——一句话能说完，别人 clone 下来不用去查条文。

**但有一个会改变结论的开关**：如果将来引入 `dinghy`（GPL-3.0）或
`dexed`（GPL-3.0）的代码——哪怕只是一小段——整个项目必须转为 GPL-3.0。
这不是风格选择，是传染性条款。**所以只要想保住 MIT，就别 copy 它们的代码，
只借鉴思路、自己重写。**（现在每一行都是自己写的，这条是给将来的自己留的。）

顺带记一个有意思的观察，它正好是 FM-1 这个生态独有的：
**GPL-3.0 的反 Tivoization 条款（§6，要求提供"安装信息"）在 FM-1 这种
官方本来就允许刷机的设备上是被天然满足的。** 别的硬件厂商靠锁 bootloader
来规避这一条，M-VAVE 恰好没锁。这在这个生态里是个挺漂亮的分析题。

---

## 五、还没解决的两件事

1. **`Dexed_cart 1.0` 的授权状态无法查清。** 查不到不是坏消息也不是好消息，
   是"不能依赖"。它只能被当作*来源*记录，不能被当作*许可*使用。
2. **上游仓库自己也没厘清。** 三个目录三份许可证，GitHub 识别为 NOASSERTION。
   如果你想用它的东西，最干净的动作是给它提一个 issue，请作者把许可证统一、
   并把边界写清楚。**这个动作本身就是一次真实的开源合规实践**——而且是能写进
   简历、能在面试里讲五分钟的那种。
3. ~~本站自己的许可证还没定。~~ **已定：MIT**（见上一节与根目录 `LICENSE`）。

---

## 附：怎么自己复核（可复用的方法）

这次用到的三招，换任何一个开源项目都能用：

1. **看仓库根目录**：`LICENSE` / `LICENCE` / `LICENSE.md` / `COPYING`，
   或者 `GET https://api.github.com/repos/<owner>/<repo>/license`。
2. **但要明白：根目录有 LICENSE ≠ 权利清楚。** 真正要问的是
   「这份许可证覆盖的是不是**我想用的那一部分**」。上游那个仓库就是最好的反面教材：
   它有三个许可证，而你想用的那部分恰好是它**没有**授权的那部分。
3. **去找权利人自己的说法。** 三个仓库的 LICENCE 加起来，都不如 Yamaha 自己那份
   EULA 的一句话有分量。**下游的许可永远不能超越上游的权利。**

---

> 免责：这不是法律意见。我不是执业律师，本文档是事实核查与风险梳理，
> 不构成对任何具体使用方式的合法性结论。涉及实际发布决策时请咨询执业律师。
> 文中引用的法条概念（汇编作品、合理使用）请以现行有效文本为准。
