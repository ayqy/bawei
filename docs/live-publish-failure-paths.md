# live-publish 已尝试失败路径（简表）

更新时间：2026-03-28（Asia/Shanghai）

## 目标

记录在真实站点 10 渠道发布过程中，已经反复验证为失败或低收益的路径，避免继续消耗在无效重试上。

## 已验证的失败/低收益路径

1. **常驻循环 + 自动继续/重试**
   - 现象：同一渠道在阻塞状态下被重复推进，`attempts` 持续增长（600+），成功率未提升。
   - 结论：该路径不可取，已改为单次运行。

2. **`not_logged_in` 状态继续尝试**
   - 现象：登录页/未登录态下反复触发发布，不会自行恢复成功。
   - 结论：`not_logged_in` 属于阻塞错误，需立即失败并停止本轮。

3. **微信原图直链被平台拒绝**
   - 现象：CSDN 提示“非正常图片地址”，疑似防盗链导致。
   - 结论：直接使用微信图片原始 URL 不可取，应先代理化（`/api/image-proxy`）再进入发布链路。

4. **通用插图流程在部分编辑器不稳定**
   - 现象：`cnblogs` 富文本场景出现“正文仅前两行进入编辑器，后续图片未插入”。
   - 结论：单一插入路径不可靠，需保留多级兜底（通用粘贴/拖拽失败后走本地文件上传）。

5. **`sspai` 卡在 `fillContent` 阶段**
   - 现象：长时间停留“正在填充正文”，触发无进度超时。
   - 结论：该类卡死应判定失败退出，不应自动无限重试。

6. **`baijiahao` 发布后验收不通过**
   - 现象：`waiting_user | 验收未通过：详情页未检测到原文链接`。
   - 结论：属于人工确认/平台规则阻塞，单轮失败后应结束并等待人工处理。

7. **`sspai` 登录审计误判为已登录**
   - 现象：登录审计阶段返回 `logged_in (entry-page-accessible)`，但发布阶段 `detectLogin` 直接返回 `not_logged_in`。
   - 结论：`/write` 场景可能先渲染编辑器壳再弹登录/重定向，单靠 URL/DOM 快速探测不可靠；后续需增强审计策略（例如检查 token/cookie 或等待鉴权完成）。

8. **`maybeImportStorageState` 可能覆盖 `sspai` 已登录态**
   - 现象：`tmp/mcp-storageState.json` 中 `https://sspai.com` 的 `localStorage.ssToken` 为空时，导入会覆写当前 profile 的 `ssToken`，导致发布阶段变成 `not_logged_in`。
   - 结论：聚焦 `sspai` 时优先禁用该导入（`STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json`）或先更新 storageState 文件。

9. **`sspai` 发布需要处理“选择发布通道”弹窗**
   - 现象：点击顶部“发布”后会弹出“选择发布通道（立即发布/投稿编辑部）”弹窗，若未点击弹窗底部“发布”，`released_at` 不会更新，验收会判定“尚未发布”。
   - 结论：需要在自动化里显式选择通道并点击弹窗底部“发布”，否则会进入 `waiting_user` 阻塞。

10. **`sspai` “本文编辑窗口已打开”提示弹窗阻塞**
   - 现象：页面弹出“提示：本文编辑窗口已打开...”，仅有“返回”按钮（见 `tmp/sspai-write-107882.png`），会遮挡编辑器/发布弹窗，导致自动化无法继续点击。
   - 结论：需要在自动化里识别该弹窗并点击“返回”关闭，再继续发布流程；若频繁出现，需避免同时打开多个 `sspai /write` 标签页。

## 观测依据

- `artifacts/live-publish/mcp-publish-progress.json`
- `artifacts/live-publish/mcp-login-audit.json`
- `artifacts/live-publish/network-*.ndjson`（关键请求/响应抓包）
- `artifacts/mowen-weixin-publish/*`（墨问发布脚本基线日志/截图）

## 已验证的成功经验（mowen）

1. **标题规则：第一行即标题**
   - 做法：在正文最前插入 `<p>${title}</p><p><br/></p>`，确保标题与正文分离（避免标题与正文粘连）。

2. **排版与图片拆分：先写正文富文本，图片逐张插入**
   - 现象：直接复制整篇公众号文章粘贴到墨问，段落/加粗/换行正常，但图片会丢失。
   - 结论：正文富文本用 HTML 粘贴写入；图片必须走“逐张上传插入”的链路。

3. **图片插入稳定性：节流 + 落点 + 防替换**
   - 做法：
     - 每次插图前把 selection 折叠到编辑器末尾（否则可能只触发上传但不落稿）。
     - 每次插图后在末尾插入空段落 `<p><br/></p>`，保证下一张图的插入点稳定。
     - 通过 `POST /api/note/wxa/v1/note/draft` 解析 ProseMirror doc：本次插图应导致 image 节点数量 **+1**；若数量不增长则高概率是“替换已有图片”，应回滚并重试。
     - 插图节奏：每张图片上传后至少等待 `8s~10s` 再进行下一张（过快容易闪现“上传失败”）。

4. **验收策略：优先用 `note/show` 接口而不是 DOM**
   - 现象：墨问详情页为 SPA 异步渲染，刚跳转时 DOM 可能短暂不包含“原文链接”，导致 `pageContainsSourceUrl()` 假阴性。
   - 做法：在详情页用 `POST /api/note/wxa/v1/note/show` 获取 `detail.noteBase.content`（HTML），在返回内容里检索原文链接，并用 `<img uuid="...">` 数量估算图片是否齐全。

5. **脚本基线（最稳）：系统剪贴板 PNGf + 真 `Cmd+V`**
   - `scripts/mowen-weixin-publish-mowen.mjs`：macOS 下用系统剪贴板 `PNGf` + Playwright 真 `Meta+V`，并在每张图后等待 `8s`，已多次跑通完整图文发布。

## 当前阻塞结果定义（脚本策略）

- 登录审计阶段：`not_logged_in`、`unknown + captcha-or-risk-page`
- 发布阶段：`not_logged_in`、`waiting_user`、`failed`、`timeout`、`stalled`
- 处理方式：仅对该渠道立即标记 `failed`，本轮不再重试该渠道

## 尝试记录（聚焦单渠道）

### 2026-03-28（Asia/Shanghai）｜mowen｜第 13 次尝试｜失败（插图未触发 + 误判为 failed）

- 命令：
  - `LIVE_PUBLISH_CHANNELS=mowen npm run live:open`
  - `LIVE_PUBLISH_CHANNELS=mowen npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 结果摘要：脚本很快结束为 `failed | 执行失败`，并提示 `可点击该渠道状态重新打开页面`。
- 关键证据：
  - 网络日志 `artifacts/live-publish/network-mowen-1774681085871.ndjson`：出现大量轮询 `POST /api/note/wxa/v1/note/draft`，但未观察到 `upload/prepare` / `priv-sdn` 等图片上传链路请求，疑似“粘贴/拖拽事件未触发编辑器插图逻辑”。
- 经验教训：
  - **不能在 paste 方式上傻等 120s**：如果 `draft` 与 DOM 均无变化，应快速失败并切换到 drop / file-input 兜底路径（否则会卡死在第一张图）。
  - **ProseMirror 不要用 `innerHTML=''` 清空**：可能破坏编辑器内部 state，导致后续图片落稿不稳定（已改为仅用 `execCommand selectAll/delete` 清空）。
  - **插图失败不要无条件 `undo`**：可能误撤销上一张已成功图片（已改为“仅当检测到本次插入的 DOM 图片增量时才 undo”）。

### 2026-03-28（Asia/Shanghai）｜mowen｜第 14 次尝试｜失败（上传成功但 draft 不增，无法落稿）

- 命令：
  - `LIVE_PUBLISH_CHANNELS=mowen npm run live:open`
  - `LIVE_PUBLISH_CHANNELS=mowen npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 结果摘要：进入 `waiting_user | 图片自动上传失败：请手动上传后继续`，第一张图即失败。
- 失败详情（devDetails）：
  - `paste: 图片插入超时（120s） | drop: 未触发图片插入（draft/DOM 无变化） | file-input: 未找到图片上传 input/button`
- 关键证据：
  - 网络日志 `artifacts/live-publish/network-mowen-1774683028021.ndjson`：
    - 出现 `POST https://misc.mowen.cn/api/file/v1/upload/prepare 200` 与 `POST https://prod-priv-sdn.oss-accelerate.aliyuncs.com/ 200`（返回 `fileId`），说明**上传链路已跑通**；
    - 但大量 `POST https://note.mowen.cn/api/note/wxa/v1/note/draft 200` 响应里，`image` 节点数量始终不超过 1（仍为旧 uuid），说明**上传成功 ≠ ProseMirror 文档落稿成功**。
- 经验教训：
  - 仅派发 `ClipboardEvent(paste)` 且只带 `File`，可能会触发上传但**不会触发编辑器插入/落稿**；
  - 下一轮需要让 `clipboardData` 更接近真实粘贴：除 `File` 外同时携带 `text/html`（`<img src=\"blob:...\">` 或类似），促使编辑器在文档中插入图片节点后再替换为 uuid。

### 2026-03-28（Asia/Shanghai）｜mowen｜第 15 次尝试｜失败（编辑器渲染慢导致找不到 ProseMirror）

- 命令：
  - `LIVE_PUBLISH_CHANNELS=mowen npm run live:open`
  - `LIVE_PUBLISH_CHANNELS=mowen npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 结果摘要：`failed | 执行失败`，devDetails 为 `未找到内容编辑器（可能是编辑器尚未渲染完成）`。
- 经验教训：
  - 墨问首次打开/冷启动时编辑器渲染可能超过 15s；需要把 `ensureEditorSurfaceReady` 与 `waitForVisibleElement` 的等待时长提升到 60s 以上，避免误判失败。

### 2026-03-28（Asia/Shanghai）｜mowen｜第 25 次尝试｜失败（详情页验收假阴性：DOM 未渲染完成）

- 现象：发布后已跳到 `https://note.mowen.cn/detail/<uuid>`，但验收报 `详情页未检测到原文链接`。
- 关键证据：网络日志 `artifacts/live-publish/network-mowen-1774690122646.ndjson` 中，`POST /api/note/wxa/v1/note/show 200` 的 `detail.noteBase.content` 已包含标题、正文、多张 `<img uuid="...">`，且（通常）已包含原文链接。
- 结论：墨问详情页是 SPA 异步渲染，**DOM 可能短暂缺内容**，仅靠 `pageContainsSourceUrl()` 有假阴性。
- 修复方向：详情页验收改为优先调用 `note/show` 接口（必要时 `retryUntil` 等待内容达到阈值），并从返回 HTML 里解析图片数量。

### 2026-03-28（Asia/Shanghai）｜mowen｜第 26 次尝试｜失败（验收逻辑 bug：图片数量解析恒为 0）

- 现象：发布流程已跑完，但验收报 `详情页图片数量不足（0/9）`。
- 根因：从 `note/show` 返回 HTML 解析 `<img>` 时，误把正则写成了 `/<img\\\\b.../`，导致 `<img uuid=...>` 永远匹配不到，从而图片数恒为 0。
- 修复：改为 `/<img\\b.../`（单反斜杠），并优先按 `<img uuid="...">` 的 uuid 去重计数。

### 2026-03-28（Asia/Shanghai）｜mowen｜第 27 次尝试｜成功（插件全自动完整图文发布 + API 验收通过）

- 命令：
  - `LIVE_PUBLISH_CHANNELS=mowen npm run live:open`
  - `LIVE_PUBLISH_CHANNELS=mowen npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 结果摘要：`mowen.status=success`，`notes=发布成功 | 验收通过：详情页包含原文链接`，并通过 `note/show` 返回 HTML 解析到图片数量满足预期（9 图）。
- 关键证据：网络日志 `artifacts/live-publish/network-mowen-1774699725932.ndjson`。

### 2026-03-26（Asia/Shanghai）｜sspai｜第 619 次尝试｜失败（not_logged_in）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 登录审计：stdout 显示 `sspai: logged_in (entry-page-accessible) https://sspai.com/write`
- 发布阶段：运行时返回 `not_logged_in | 未登录：请先登录该渠道`
- `tmp/mcp-publish-progress.json` 摘要：`sspai.status=failed`，`sspai.notes=发布中检测到未登录（阻塞）...`，`sspai.attempts=619`
- 经验教训：
  - `inspectLoginStateOnPage` 对 `sspai /write` 的快速判断存在误判风险（可能先渲染壳页面，随后才出现登录弹窗/跳转）。
  - 下一轮优先解决“测试版 Chrome profile 的登录态同步/刷新”与“更可靠的 sspai 登录态判定”，否则会在发布阶段反复被 `not_logged_in` 阻塞。

### 2026-03-26（Asia/Shanghai）｜sspai｜第 620 次尝试｜失败（图片上传失败 -> waiting_user）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 结果摘要：`waiting_user | 图片自动上传失败：请手动上传后继续`
- 经验教训：
  - `fillEditorByTokens -> insertImageAtCursor` 在 `sspai` 场景存在不稳定/失败概率，需要提供更可靠的兜底（例如远程图片插入或走站点上传 API），否则会落入手工上传。

### 2026-03-26（Asia/Shanghai）｜sspai｜第 621 次尝试｜失败（发布通道弹窗未处理 -> 未发布）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 过程进展：图片上传进度可见（`正在上传图片（10/10）`）后进入 `正文已写入`
- 最终阻塞：`waiting_user | 验收阻塞：文章尚未发布（可能需要实名认证/补充必填项）`
- 现场证据：`/write#id` 页面弹出“选择发布通道（立即发布/投稿编辑部）”弹窗，底部需要点击一次“发布”才会真正发布（见 `tmp/sspai-write.png`）
- 经验教训：
  - `sspai` 的“发布”是两步：先打开发布弹窗，再选择通道并点击弹窗底部“发布”；当前脚本仅点了顶部“发布”，导致 `released_at=0`。
  - `maybeImportStorageState` 会覆写 `localStorage`，若 `tmp/mcp-storageState.json` 中 `ssToken` 为空，会把已登录态覆盖成未登录；本轮通过 `STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json` 规避该风险。

### 2026-03-26（Asia/Shanghai）｜sspai｜第 622 次尝试｜失败（发布通道弹窗仍未被自动点击）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 现场证据：仍停留在“选择发布通道”弹窗（见 `tmp/sspai-write-107876.png`）
- 经验教训：
  - 仅点击“立即发布”文字节点可能无效，需要点击其可交互容器（`.contribute-option`）并点击按钮（`.btn__submit`）。

### 2026-03-26（Asia/Shanghai）｜sspai｜第 623 次尝试｜失败（发布通道弹窗仍未被自动点击）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run publish:live`
- 结果摘要：仍进入 `waiting_user | 验收阻塞：文章尚未发布...`
- 经验教训：
  - 即使使用 `publish:live` 清理页面，若发布弹窗未被正确处理，仍会卡在 `released_at=0`。

### 2026-03-26（Asia/Shanghai）｜sspai｜第 624 次尝试｜失败（已进入“正在发布”，但仍未真正发布）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 过程进展：状态进入 `正在发布`
- 现场证据：最终仍停留在“选择发布通道”弹窗（见 `tmp/sspai-write-107878.png`）
- 经验教训：
  - 需要更强约束的弹窗定位策略（例如直接定位 `.el-dialog.ss-dialog[role=dialog]` 并校验包含“选择发布通道”文本）。

### 2026-03-26（Asia/Shanghai）｜sspai｜第 625 次尝试｜失败（弹窗仍未被自动点击，疑似出现晚于 8s）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 现场证据：最终仍停留在“选择发布通道”弹窗（见 `tmp/sspai-write-107879.png`）
- 经验教训：
  - 弹窗可能在“点击顶部发布”后较晚才出现（>8s），需要延长等待窗口并在弹窗出现后再执行二次点击（选择通道 + 底部发布）。

### 2026-03-26（Asia/Shanghai）｜sspai｜第 626 次尝试｜失败（弹窗存在多个 dialog，querySelector 命中错误节点）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 现场证据：最终仍停留在“选择发布通道”弹窗（见 `tmp/sspai-write-107880.png`）
- 经验教训：
  - 页面同时存在多个 `div.el-dialog.ss-dialog`（题图/登录/提示/发布通道等），使用 `querySelector` 会命中错误 dialog，导致找不到发布通道弹窗。
  - 需要改为 `querySelectorAll` 并筛选“可见且 innerText 包含 选择发布通道”的 dialog，再点击 `.contribute-option` + `button.btn__submit`。

### 2026-03-26（Asia/Shanghai）｜sspai｜第 627 次尝试｜失败（“本文编辑窗口已打开”提示弹窗阻塞）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 现场证据：出现“提示：本文编辑窗口已打开... 返回”弹窗（见 `tmp/sspai-write-107882.png`），遮挡操作面板。
- 结果摘要：最终仍 `released_at=0`，进入 `waiting_user | 验收阻塞：文章尚未发布...`
- 经验教训：
  - 发布前/发布后均可能出现该提示弹窗，需要在自动化里先行关闭（点击“返回”）。
  - 除了发布通道弹窗外，还要把“提示类弹窗”纳入统一的阻塞弹窗处理逻辑。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 628 次尝试｜失败（已自动处理弹窗，但仍未发布）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 过程进展：状态推进到 `验收：确认文章已发布并在详情页可见`，并持续轮询 `released_at`。
- 最终阻塞：`waiting_user | 验收阻塞：文章尚未发布（可能需要实名认证/补充必填项）`（`released_at` 仍为 0）。
- 经验教训：
  - 即使自动化已尝试关闭“本文编辑窗口已打开”弹窗、并点击“选择发布通道”弹窗的“立即发布+发布”，仍可能因**必填项未满足**导致发布请求未生效（常见：至少一个标签、封面/题图等）。
  - 下一轮需要在点击发布前自动补齐元信息（至少 1 个标签；如存在 cover/banner file input 则填充占位封面），并在失败时采集阻塞快照（弹窗文本、toast、发布按钮 disabled、已选标签）。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 629 次尝试｜失败（补齐标签/封面后仍未发布；页面跳转到草稿列表）

- 命令：
  - `LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:open`
  - `LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 新增自动化（本轮已上线）：
  - 发布前自动尝试设置至少 1 个标签（`v2MsgSettingTags`）。
  - 验收失败时采集 `blockers` 快照（dialogs/toast/selectedTags/url 等）。
- 最终阻塞：仍为 `released_at=0`，进入 `waiting_user | 验收阻塞：文章尚未发布...`
- 关键证据（来自 `blockers` 快照，落盘于扩展 storage 的日志字符串中）：
  - `blockers.url = https://sspai.com/my/post/draft`（流程中发生页面跳转，落到“草稿列表”而非 `/write#id` 或 `/post/id`）
  - `blockers.selectedTags = []`、`blockers.tagInputPlaceholder = ""`（快照采集时已不在写作页，因此无法确认标签是否真正写入成功）
  - `blockers.publishChannelDialog = ""`（采集时发布通道弹窗已消失）
- 经验教训：
  - 少数派点击发布后可能发生**重定向到草稿列表**：可能意味着发布被拦截/回落为草稿，或实际上走了“投稿编辑部”路径（非立即发布），因此 `released_at` 不会更新。
  - 下一轮需要：
    - 强化“选择发布通道”弹窗的**立即发布选中确认**（用 `simulateClick` 并校验 active/aria/radio 状态，避免误走投稿编辑部）。
    - 在写作页内更早采集“已选标签/发布按钮是否 disabled”的快照（避免跳转后信息丢失）。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 630 次尝试｜失败（命中“本文编辑窗口已打开”提示；疑似多标签页导致）

- 命令：
  - `LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:open`
  - `LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（`000003.log` 中的 `blockers` 快照解析）：
  - `blockers.url = https://sspai.com/write#107885`
  - `blockers.editorAlreadyOpenDialog` 含完整文案：`提示 本文编辑窗口已打开... 返回`（即页面再次出现阻塞弹窗）
  - `blockers.selectedTags = []`、`blockers.tagInputPlaceholder = ""`（弹窗遮挡/右侧面板未展开时，标签输入无法稳定定位）
- 经验教训：
  - 该弹窗通常由**同一篇草稿在多个标签页/窗口同时打开**触发；本项目 `live:open` 会先打开 `sspai /write`，而 `live:publish`（此前 `preserveExistingPages=true`）不会关闭旧页，容易叠加成多标签页。
  - 下一轮将 `live:publish` 调整为启动时关闭所有既有页面（`preserveExistingPages=false`），避免触发“编辑窗口已打开”弹窗，再验证是否能发布成功。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 631 次尝试｜失败（关闭既有页面后仍命中“编辑窗口已打开”；怀疑登录审计打开写作页触发锁）

- 命令：
  - `LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:open`
  - `LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（`blockers` 快照解析）：
  - `blockers.url = https://sspai.com/write#107886`
  - `blockers.editorAlreadyOpenDialog` 仍出现“本文编辑窗口已打开... 返回”
  - `blockers.selectedTags = []`、`blockers.tagInputPlaceholder = ""`（被弹窗遮挡/面板未展开时，标签仍难以稳定写入）
- 经验教训：
  - 即使 `live:publish` 已在开始阶段关闭所有页面，仍可能触发该锁；推测原因之一是 **login audit 阶段会打开 `sspai /write`**（用于审计登录态），这可能在短时间内创建编辑会话锁，随后真正的发布 tab 打开时就命中“编辑窗口已打开”提示。
  - 下一轮将 `sspai` 的登录审计入口从 `https://sspai.com/write` 改为 `https://sspai.com/my`（只用于判断登录态，避免触发写作页锁），再验证发布是否能成功。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 632 次尝试｜失败（登录审计改为 /my 后仍命中“编辑窗口已打开”；需要复用 tab 避免并发写作页）

- 命令：
  - `LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:open`
  - `LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（`blockers` 快照解析）：
  - `blockers.url = https://sspai.com/write#107887`
  - `blockers.editorAlreadyOpenDialog` 仍出现“本文编辑窗口已打开... 返回”
- 经验教训：
  - 该锁仍可能由**同时存在多个少数派写作页 tab**触发（例如 `live:open` 打开的写作页 + background 启动 job 时再次 `chrome.tabs.create` 打开新写作页）。

### 2026-03-28（Asia/Shanghai）｜mowen｜图片上传失败闪现（过快粘贴）｜结论：逐张等待更稳

- 现象：
  - 自动化连续粘贴多张图时，编辑器偶发出现“上传失败”提示一闪而过，随后图片不落稿或 OSS 回调失败。
  - 用户现场验证：在微信原文里右键“复制图片”，再到墨问编辑器手动 `Cmd+V` 可正常上传并显示。
- 关键结论：
  - 墨问图片“可靠路径”是**系统剪贴板包含真实图片数据（PNGf）+ 编辑器内 `Cmd+V`**；单纯复制纯文本/HTML 可能丢图。
  - 成功判定不要依赖 `<img src>` 从 `blob:` 变为非 `blob:`（上传后仍可能保持 `blob:` 预览）；应以网络请求为主（`/upload/prepare 200 + priv-sdn 200 + note/draft 200`）。
  - 连续粘贴过快是高概率触发点：即使上一张已插入 DOM，后端仍在异步处理时继续粘贴下一张会显著增加失败概率。
- 采取措施（已落盘脚本）：
  - `scripts/mowen-image-paste-probe.mjs`：验证“PNGf 写剪贴板 + `Cmd+V`”链路可用。
  - `scripts/mowen-weixin-image-paste-batch.mjs`：对每张图在判定成功后增加 `POST_IMAGE_WAIT_MS`（默认 5000ms）节流等待，再处理下一张。
  - 仅在脚本侧“尝试关闭页面”不够可靠（CDP 多连接/关闭失败时仍会残留），更稳的做法是：**扩展 background 在启动 job 时优先复用已存在的渠道 tab（按 URL 前缀匹配），避免重复创建写作页**。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 633 次尝试｜失败（CDP 脚本崩溃：Playwright `Page.handleJavaScriptDialog`）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai ... npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 现象：脚本中途异常退出，堆栈为 `Protocol error (Page.handleJavaScriptDialog): No dialog is showing`（Playwright 内部自动处理 JS dialog 的竞态）。
- 经验教训：
  - 仅在单个页面（如微信页）监听 `page.on('dialog')` 不够；其他页面（登录审计页/渠道页）触发 dialog 时，Playwright 可能走“自动 dismiss”，并在竞态下抛未捕获异常。
  - 下一轮在 CDP 连接后对 **context 全量安装 dialog 自动处理**（`beforeunload` -> accept，其余 -> dismiss），避免脚本崩溃影响发布流程。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 634 次尝试｜失败（connectOverCDP 卡死需强制重启；仍命中编辑锁 + 未保存离开 confirm）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai ... npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 现象：
  - `chromium.connectOverCDP` 对既有实例频繁超时；需在脚本内自动触发 `forceRestart` 后重连。
  - 结束阶段反复弹出 `confirm: 你还有内容未保存，确认离开此页面？`（若 dismiss 会阻止关闭 tab，可能残留写作页导致后续“编辑窗口已打开”）。
- 关键证据（`blockers` 快照解析）：`blockers.editorAlreadyOpenDialog` 仍出现；`blockers.url` 为 `/write#...`。
- 经验教训：
  - dialog 自动处理需要对 `confirm` 也走 `accept`（否则会反复弹、关闭失败、残留 tab）。
  - publish 脚本需对 connectOverCDP 增加“短超时 -> 自动重启重连”的降级策略。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 635 次尝试｜失败（发布后跳转路径不稳定，未进入 /write#id 或 /post/id）

- 现象：发布后落到其它页面（常见：草稿列表），触发 `waiting_user | 已触发发布，但未进入可验收页面...`。
- 经验教训：
  - 不应依赖“发布后必定停留在 /write#id 或 /post/id”的假设；应统一走 API 验收（`released_at`）并在必要时手动跳转到 `/post/<id>`。
  - 已将 `sspai` 发布后的验收逻辑统一改为 `stageVerifyPublished(articleId)`（不再分支判断页面路径）。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 636 次尝试｜失败（编辑锁消失但仍回落草稿列表；released_at 仍为 0）

- 关键证据（`blockers` 快照解析）：
  - `blockers.editorAlreadyOpenDialog = ""`（编辑锁不再是主阻塞）
  - `blockers.url = https://sspai.com/my/post/draft`（发布后重定向到草稿列表）
  - `released_at` 仍为 0
- 经验教训：
  - 需要把“验收失败”时的 API 信息补全（例如 `type/words_count/body_updated_at` 以及 API 错误信息），以判断是权限限制/必填项缺失/接口鉴权失败/投稿流程导致。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 637 次尝试｜失败（正文写入疑似仅插入图片占位，words_count_last=0，导致无法发布）

- 命令：
  - `LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:open`
  - `LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（CDP 读取 `bawei_v2_state_*` + 调接口校验）：
  - `articleId=107892`
  - `released_at=0`，结束时落到 `https://sspai.com/my/post/draft`
  - `words_count_last=0`，`custom_tags=[]`，`banner_id=0`，`type=4`
  - `body_last` 仅包含重复的 `<figure class="image ss-img-wrapper"><img></figure>`，正文文本与原文链接均缺失
- 经验教训：
  - “正文已写入”阶段不能只看 UI/状态文字，需要用 **API/编辑器 DOM** 二次验收（例如 `words_count_last > 0` 或 `body_last` 包含原文链接），否则会带着空正文进入发布阶段，必然 `released_at=0`。
  - 初步判断根因：`fillEditorByTokens` 的 `execCommand('insertHTML')` 在少数派 CKEditor 中可能**返回 false/无效果但未抛错**，导致文本 token 实际未写入，只写入了图片占位。
  - 下一轮改造方向：写入 HTML 时必须校验插入效果（textContent 增量），失败则回退为 `paste` 事件或纯文本写入。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 638 次尝试｜失败（修复 insertHTML 返回值后仍无正文；CKEditor 仍只保留图片占位）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据：
  - `articleId=107894`，`released_at=0`，结束时落到 `https://sspai.com/my/post/draft`
  - 接口 `article/single/info/get`：`words_count_last=0`、`custom_tags=[]`、`body_last` 仍是纯图片占位（无正文/无原文链接）
  - 页面 DOM（`.ck-editor__editable`）：`textHead≈"图像小部件"`，图片 `src` 为 `https://cdn-static.sspai.com/ui/error_placeholder.jpeg`（上传/渲染失败占位）
- 经验教训：
  - 仅判断 `execCommand` 的 boolean 返回值仍不够：在 CKEditor 中可能 **返回 true 但实际不生效/被模型回滚**。
  - 需要将 HTML 写入改为“**粘贴事件驱动**”（`ClipboardEvent('paste')` + `DataTransfer(text/html,text/plain)`），并在每段写入后用 `textContent` 增量做成功判定；否则继续回退为纯文本。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 639 次尝试｜失败（正文/图片已写入成功但仍未发布；released_at=0，疑似缺少题图/标签等必填项）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（`bawei_v2_state_*` + 接口 `article/single/info/get`）：
  - `articleId=107896`
  - `words_count_last=754`（正文已成功写入）
  - `body_last` 已包含正文文本 + 图片 `cdnfile.sspai.com/...`（图片上传也已成功），并追加 `原文链接：https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
  - 但 `released_at=0`，结束时落到 `https://sspai.com/my/post/draft`
  - `banner_id=0`（题图未设置）、`custom_tags=[]`（标签仍为空）
- 经验教训：
  - 发布未成功的根因很可能不再是“正文未写入”，而是**元信息未满足**（题图/标签/利益相关声明等）。
  - 下一轮需要把“题图上传”和“标签选择”做成稳定步骤：
    - 题图：`input[type=file].upload-input`（无 name/id）也要覆盖；
    - 标签：页面使用 Vue Multiselect（`.multiselect__input` + `.multiselect__option`），必须点击 option 才算真正选中，不能只 press Enter/全局找文本节点。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 640 次尝试｜失败（仍未设置题图/标签；banner_id=0、custom_tags=[]，released_at=0）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（`bawei_v2_state_*` + 接口 `article/single/info/get`）：
  - `articleId=107897`
  - `words_count_last=754`（正文已写入）
  - `released_at=0`
  - `banner_id=0`、`custom_tags=[]`
- 经验教训：
  - 虽然已改为“点击 `.multiselect__option` 选择标签”和“识别 `.upload-input` 题图输入”，但在实际 job 流程里**仍未生效**，需要进一步提升鲁棒性：
    - 标签：增加等待与激活（scrollIntoView + click tag 区域），并在选中后通过 DOM（`.multiselect__tag`）确认；
    - 题图：点击“添加题图/替换图片”触发器后再写入 `input[type=file]`，并轮询接口等待 `banner_id` 变为非 0；
    - 可能存在首次写作欢迎弹窗遮挡，需要自动关闭后再操作标签/题图。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 641 次尝试｜失败（已进入“设置标签”阶段但最终仍 banner_id=0、custom_tags=[]）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（`bawei_v2_state_*` + 接口 `article/single/info/get`）：
  - `articleId=107898`
  - `words_count_last=754`
  - `released_at=0`
  - `banner_id=0`、`custom_tags=[]`
- 经验教训：
  - 仅靠“找到 input 后 simulateType + click option/写入 file input”仍可能因为 UI 未就绪/未激活导致失效。
  - 下一轮进一步加强：
    - 标签：强制激活 multiselect（点击 `.multiselect__tags`），等待 `.multiselect__option` 出现后再点；点完再等待 `.multiselect__tag` 真正出现；
    - 题图：等待 `input[type=file]` 出现后再写入，并在写入后轮询接口确保 `banner_id` 更新（否则视为失败并继续重试）。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 642 次尝试｜失败（标签已选中但题图仍未上传；selectedTags=[AI]，banner_id=0）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（`bawei_v2_state_*` + 接口 `article/single/info/get`）：
  - `articleId=107900`
  - `blockers.selectedTags=["AI"]`（标签选择路径开始稳定）
  - 但 `banner_id=0`、`released_at=0`
- 经验教训：
  - 题图上传很可能对尺寸有硬性要求（页面提示建议 `1600x1200`），用扩展 `icon-128.png` 作为题图可能被拒绝。
  - 下一轮将题图改为在页面内用 `canvas(1600x1200)` 生成 JPG，再写入 `input[type=file]`，并继续轮询 `banner_id` 确认成功。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 643 次尝试｜失败（尝试 canvas 题图后仍 banner_id=0，标签也未稳定写入）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（`bawei_v2_state_*`）：
  - `articleId=107901`
  - `words_count_last=711`
  - `released_at=0`、`banner_id=0`
  - `selectedTags=[]`（标签未写入/快照未捕获到）
- 经验教训：
  - 仅在内容脚本里对 `input.files=` + `dispatchEvent(change)` 可能被站点以 `event.isTrusted` 等方式过滤，导致题图上传逻辑根本未触发。
  - 下一轮需要抓到真实的“题图上传/发布”网络请求与返回错误（用 Playwright/CDP 监听网络），确认是前端忽略事件、还是后端校验拒绝。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 644 次尝试｜失败（network log 为空；需要修复网络监听与继续定位题图上传失败原因）

- 关键证据：
  - `articleId=107902`，`released_at=0`、`banner_id=0`、`custom_tags=[]`
  - `tmp/network-sspai-1774551982125.ndjson` 为 0 bytes（说明网络监听实现未生效）
- 经验教训：
  - network logger 不能用 `page.url()` 作为去重 key（多个新页初始都是 `about:blank`，会导致后续页面未 attach），应改为 `WeakSet<Page>` 去重。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 645 次尝试｜失败（抓到 error=3006“本文编辑窗口已打开”；发布/更新被编辑锁拦截）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（network log：`tmp/network-sspai-1774552404927.ndjson`）：
  - `articleId=107903`
  - 多次 `POST https://sspai.com/api/v1/matrix/editor/article/auto/save` 返回：`{"error":3006,"msg":"本文编辑窗口已打开..."}`
  - `POST https://sspai.com/api/v1/matrix/editor/article/update` 同样返回 `error=3006`
  - 页面从 `https://sspai.com/write#107903` 被动跳转到 `https://sspai.com/my/post/draft`（疑似被编辑锁“踢回草稿列表”）
- 经验教训：
  - **真实阻塞点不是“题图/标签没写入”，而是编辑锁（error=3006）导致后续保存/更新/发布都无效**。
  - 需要进一步确认触发来源（是否多 Tab/多窗口、是否保存过于频繁、是否账号在其它设备也打开了写作页），并想办法在自动化里规避/抢占锁。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 646 次尝试｜失败（重启 Chrome + 复用 tab 仍出现 error=3006；已抓到 auto/save 请求体）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（network log：`tmp/network-sspai-1774553463330.ndjson`）：
  - `articleId=107904`
  - `article/add` 响应包含 `token=d72oivtb34tamgnu9bjg`
  - 已捕获 `auto/save` 请求体（示例字段）：`{id, token, title_last, body_last, update_at}`（说明保存链路可被 API 直调复刻）
  - 仍在短时间内出现 `error=3006`，并被跳转到 `https://sspai.com/my/post/draft`
- 经验教训：
  - 仅靠 background 侧“复用/关闭重复 write tab”不足以解决 3006（即使重启 Chrome 也会复现）。
  - 下一轮尝试：**尽量降低编辑器触发 auto-save 的频率/并发**（例如用“单次 HTML 粘贴写入”替代按 token 逐段写入 + 逐图上传），先让流程稳定走到“点击发布/抓到发布接口”，再逐步补齐题图/标签等细节。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 647 次尝试｜失败（已推进到“设置标签/验收”但仍被 error=3006 踢回草稿；未触发发布接口）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（network log：`tmp/network-sspai-1774554697657.ndjson`）：
  - `articleId=107905`
  - 已出现接口：`GET /api/v1/matrix/editor/article/benefits/statement/page/get`（利益相关声明列表）
  - `auto/save` 在成功返回一次 `error=0` 后，仍会突然返回 `error=3006`，随后页面跳转到 `https://sspai.com/my/post/draft`
  - 从日志看，本轮仍**没有出现明确的“发布/提交”接口**（说明点击发布未真正生效，或被 3006/页面跳转打断）
- 经验教训：
  - “单次 HTML 粘贴写入”确实让流程推进到了后续阶段，但 CKEditor 仍会对图片触发上传/占位符，带来大量 auto-save，仍可能触发 3006。
  - 下一轮进一步降级：**先去掉正文图片（改为图片链接/占位符）**，目标是让编辑器尽量少触发 auto-save，从而让“点击发布”真正打到发布接口并使 `released_at>0`。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 648 次尝试｜失败（图片降级为链接后仍触发 article/update，但 update/auto-save 返回 3006）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（network log：`tmp/network-sspai-1774555092304.ndjson`）：
  - `articleId=107906`
  - `article/update` 已发生（说明流程已经真实触发了“更新/发布前提交”链路），但响应为 `error=3006`
  - 同期 `article/auto/save` 也返回 `error=3006`，随后页面停留在 `https://sspai.com/my/post/draft`
  - `article/update` 请求体中出现 `body` 字段，且正文图片已降级为“图片链接”（`<a href="https://read.useai.online/api/image-proxy?...">`）
- 经验教训：
  - 现阶段关键不是“有没有触发 update”，而是 **update 被 3006 拦截**；需要拿到 `article/update` 的完整请求体与站点对 3006 的判定条件，才能进一步用 API 复刻/修复。
  - 下一轮：提升 network logger，**对 `article/update` 记录完整 postData**，确认是否缺少 `token`/`update_at`/`released_at`/`custom_tags` 等关键字段，并据此尝试“API 直发 + 失败重试/抢锁”。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 649 次尝试｜失败（拿到完整 article/update payload；已含 token/custom_tags 仍被 3006 拦截）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（network log：`tmp/network-sspai-1774555405013.ndjson`）：
  - `articleId=107907`
  - `POST /api/v1/matrix/editor/article/update` 的完整 payload 已记录，关键字段包括：
    - `id=107907`
    - `custom_tags=["AI"]`（标签已被写入到请求体）
    - `token=d72p255b34tamcnshm60`
    - `banner_id=0`、`released_at=0`
  - 但响应仍为：`{"error":3006,"msg":"本文编辑窗口已打开..."}`
- 经验教训：
  - 3006 并非“缺字段/缺 token”导致，更多像是**服务端编辑锁/会话锁**（可能要求在特定编辑会话/窗口上下文下提交）。
  - 下一轮尝试优先从前端交互层面规避误点击/跳转：更精准定位“发布按钮”、避免自动点击“返回”跳走草稿页；并在真正点到发布按钮后观察是否出现新的发布接口（非 update）。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 650 次尝试｜失败（加强“发布按钮/关闭弹窗”仍触发 tag search + update=3006；未出现新发布接口）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（network log：`tmp/network-sspai-1774555725413.ndjson`）：
  - `articleId=107908`
  - 出现：`GET /api/v1/matrix/editor/article/tag/search/page/get?title=AI...`（标签搜索）
  - 仍出现：`POST /api/v1/matrix/editor/article/update` 响应 `error=3006`，并伴随 `auto/save error=3006`
  - 未观察到除 `article/update` 之外的“发布/提交”新接口
- 经验教训：
  - 说明当前瓶颈仍在“编辑锁 3006”，而不是按钮误点击（即便更精准点击仍会被踢）。
  - 下一轮补充抓取：在 network log 中记录 `cookieNames`（不记录值）以确认是否存在 device/session 类 cookie 造成“克隆 profile 冲突”。  

### 2026-03-27（Asia/Shanghai）｜sspai｜第 651 次尝试｜失败（update/auto-save 在草稿页触发 3006；cookieNames 仍为空）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（network log：`tmp/network-sspai-1774556122379.ndjson`）：
  - `articleId=107909`
  - 在 `https://sspai.com/write#107909` 阶段，`POST /api/v1/matrix/editor/article/auto/save` 仍能成功返回 `error=0`（说明“写作页->保存”链路并非一开始就完全锁死）。
  - 随后页面跳转到 `https://sspai.com/my/post/draft`，并在该页面触发：
    - `POST /api/v1/matrix/editor/article/auto/save` 返回 `error=3006`
    - `POST /api/v1/matrix/editor/article/update` 返回 `error=3006`
  - network 记录中 `cookieNames=[]`（说明 Playwright 的 `req.headers()` 对 cookie 不完整/不稳定，无法用于排查 device/session 差异）。
- 经验教训：
  - `article/update` 的 `referer/page` 都落在草稿列表页，强烈暗示“发布按钮误命中/弹窗处理导致跳转/站点回落草稿页”仍是触发 3006 的关键路径之一；需要优先让发布动作稳定发生在 `/write#id` 上再判断是否仍会 3006。
  - network logger 必须改为使用 `await req.allHeaders()` 抓取 request cookie（只保留 cookie name 列表），否则无法继续定位 3006 的会话锁条件。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 652 次尝试｜失败（cookieNames 抓取成功；但 update/auto-save 仍在草稿页触发 3006）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（network log：`tmp/network-sspai-1774557101947.ndjson`）：
  - `articleId=107910`
  - `cookieNames` 已能记录（示例包含：`sspai_jwt_token`、`sspai_cross_token`、`_ga` 等），证明此前空数组是采集实现问题而非“请求没带 cookie”。
  - `POST /api/v1/matrix/editor/article/update` 与 `POST /api/v1/matrix/editor/article/auto/save` 仍在 `https://sspai.com/my/post/draft` 页面发出，并返回 `error=3006`。
- 经验教训：
  - 3006 更像是“发布/更新从草稿列表页发起”导致的编辑锁（而不是 cookie 缺失）；需要让发布动作发生在 `/write#id` 的编辑器上下文，或绕开 UI 直接在写作页用 API 提交。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 653 次尝试｜失败（重启 Chrome 后仍复现：update/auto-save 在草稿页触发 3006）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run publish:live -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（network log：`tmp/network-sspai-1774558266738.ndjson`）：
  - `articleId=107911`
  - `article/update` payload 里 `custom_tags=["AI"]` 已存在，但 `body_updated_at=0`；与写作页 `auto/save` 返回的 `body_updated_at` 不一致。
  - `article/update` 与草稿页 `auto/save` 均返回 `error=3006`，且 `page/referer` 为 `https://sspai.com/my/post/draft`。
- 经验教训：
  - 仅靠“重启浏览器/清理多 tab”无法解决：3006 依旧稳定复现。
  - 需要进一步验证：如果在 `/write#id` 上用 API `article/update`（携带正确 `body_updated_at`）提交，是否能绕过草稿页路径的 3006；若可行，则将发布逻辑改为“写作页 API 直发 + released_at 验收”。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 654 次尝试｜失败（写作页 API update 可成功置为 released，但详情页验收失败）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run publish:live -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（network log：`tmp/network-sspai-1774558863715.ndjson`）：
  - `articleId=107912`
  - 3006 未再出现（说明“写作页 API update”能绕开草稿页路径的编辑锁）
  - 但渠道最终进入：`waiting_user | 验收未通过：详情页未检测到原文链接`
- 经验教训：
  - 需要确认“发布成功”是否只是 released_at>0，但正文是否真正进入公开详情页；以及详情页验收是否需要等待内容异步加载。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 655 次尝试｜失败（确认发布成功但公开文章 body 为空：缺少 body_last 字段）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run publish:live -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（network log：`tmp/network-sspai-1774559134195.ndjson`）：
  - `articleId=107913`
  - `POST /api/v1/matrix/editor/article/update` 在 `/write#107913` 返回 `{"data":{"id":107913,"type":"released"},"error":0}`（已发布）
  - 详情页请求 `GET /api/v1/article/info/get?id=107913...` 返回：`body=""`、`words=0`（公开文章正文为空，导致原文链接验收必然失败）
  - 对比草稿页 update payload 与写作页 API payload：草稿页含 `body_last` 字段，写作页 API payload 缺失该字段
- 经验教训：
  - `matrix/editor/article/update` 发布时必须同时携带 `body` + `body_last`，否则会出现“发布成功但公开正文为空”的隐蔽失败。

### 2026-03-27（Asia/Shanghai）｜sspai｜第 656 次尝试｜✅ 成功（补齐 body_last 后发布成功且详情页验收通过）

- 命令：`LIVE_PUBLISH_CHANNELS=sspai STORAGE_STATE_PATH=tmp/mcp-storageState.skip.json npm run publish:live -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（network log：`tmp/network-sspai-1774559620582.ndjson`）：
  - `articleId=107914`
  - `matrix/editor/article/update` 在写作页返回 released（error=0），并跳转至 `https://sspai.com/post/107914`
  - 渠道状态最终为：`success | 验收通过：详情页包含原文链接`
- 经验教训：
  - 解决 3006 的关键不是 cookie/多 tab，而是避免“草稿列表页触发发布”，改为“写作页 API 直发（携带 body_last）+ released_at 验收”。

### 2026-03-27（Asia/Shanghai）｜mowen｜第 620 次尝试｜失败（登录审计阻塞：落到 account.mowen.cn/auth）

- 命令：`LIVE_PUBLISH_CHANNELS=mowen npm run live:publish -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 结果摘要：
  - `login-audit` 访问 `https://note.mowen.cn/editor` 后，最终 URL 落到：`https://account.mowen.cn/auth/?redirect=https%3A%2F%2Fnote.mowen.cn%2Feditor`
  - `tmp/mcp-login-audit.json`：`mowen.status=not_logged_in`、`reason=login-url`
  - `tmp/mcp-publish-progress.json`：`mowen.status=failed`、`notes=登录审计阻塞：login-url`
  - 脚本 stdout 仍打印 `✅ 全部渠道发布成功（1/1）`（实为 pending 为空导致的误判）
- 经验教训：
  - 当前默认使用的 profile（`tmp/chrome-cdp-live-profile-v8`）不含墨问登录 cookie，`note.mowen.cn` 会重定向到 `account.mowen.cn/auth`，因此登录审计会阻塞发布。
  - 在本机 `tmp/chrome-cdp-live-profile-*` 中扫描 Cookies DB，发现 `tmp/chrome-cdp-live-profile-v3` 存在疑似墨问登录 cookie（如 `._MWT`、`._MWTH`），下一轮应优先切换到该 profile（`CHROME_PROFILE_DIR=tmp/chrome-cdp-live-profile-v3`）再跑发布链路。
  - 另一个待修复点：当所有渠道都被登录审计标记为 `failed` 时，脚本不应输出“全部渠道发布成功”，而应输出失败并返回非 0，避免误导。

### 2026-03-27（Asia/Shanghai）｜mowen｜第 621 次尝试｜失败（/editor 弹“恢复未保存草稿”对话框导致编辑器未渲染）

- 命令：`CHROME_PROFILE_DIR=tmp/chrome-cdp-live-profile-v3 LIVE_PUBLISH_CHANNELS=mowen npm run publish:live -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 结果摘要：
  - `login-audit`：`mowen: logged_in (entry-page-accessible) https://note.mowen.cn/editor`
  - 发布阶段：`mowen attempt=621` 后迅速进入 `failed`（`tmp/mcp-publish-progress.json`：`failed | 执行失败`）
- 关键证据（CDP 现场检查 `https://note.mowen.cn/editor`）：
  - 页面文本包含：`你有未保存的「笔记」草稿，是否恢复？`，按钮为 `取消 / 确定`
  - 对话框出现时：`.ProseMirror[contenteditable=\"true\"]` 不存在、页面也无 `保存/发布` 按钮，导致 `stageFillContent` 无法定位编辑器并抛错（进而整渠失败）
  - 手动/脚本点击 `取消` 后：编辑器与 `保存/发布` 按钮立即出现（`.ProseMirror` 可见）
- 经验教训：
  - `mowen` 发布链路必须在填充正文前，自动处理该“恢复草稿”弹窗（优先点击 `取消` 以获得干净编辑器），否则会被误判为“未找到编辑器”而直接失败。
  - 下一轮在 `src/content/mowen-publisher.ts` 增加弹窗识别与自动关闭，再重跑 `attempt=622`。

### 2026-03-27（Asia/Shanghai）｜mowen｜第 622 次尝试｜失败（卡在第 2 张图上传；页面 toast=上传失败 -> 无进度超时）

- 命令：`CHROME_PROFILE_DIR=tmp/chrome-cdp-live-profile-v3 LIVE_PUBLISH_CHANNELS=mowen npm run publish:live -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 结果摘要（`tmp/mcp-publish-progress.json`）：
  - `attempts=622`
  - 最终失败：`发布无进度超时（180s）`
  - 阻塞点：`running | 正在上传图片（2/10）`（长时间无进度）
- 关键证据：
  - 通过 CDP 读取 `chrome-extension://.../src/background.js` 的 `bawei_v2_state_<jobId>`，确认 `mowen.stage=fillContent` 且 `userMessage=正在上传图片（2/10）` 持续不变。
  - CDP 检查 `https://note.mowen.cn/editor`：
    - 编辑器正文文本已写入（标题/正文前段可见），但 `.bottom-image` 区域无任何子节点，说明图片未成功插入。
    - 页面出现 toast：`上传失败`（class=`toast`），与“第 2 张图”阶段吻合。
- 经验教训：
  - 目前 `insertImageAtCursor` 在墨问场景会触发上传失败后长时间等待 `img inserted`（45s * 多种策略），最终被脚本按“无进度超时”杀掉；需要把“上传失败”的根因定位出来，而不是扩大 timeout。
  - 下一轮优先加 **mowen network logger**（`note/account/user.mowen.cn` 等域名）抓取上传接口与错误响应，判断是：
    - 图片尺寸/大小限制（平台拒绝）
    - 草稿未保存导致缺少 noteId/上下文（上传接口报错）
    - 认证/风控/跨域导致上传失败
  - 同时考虑为 `mowen` 提供 `insertImageAtCursorOverride`：直接走墨问可用的上传入口 + 以 DOM 变化（如 `.bottom-image` 子节点）作为插入成功判据，避免无效等待。

### 2026-03-27（Asia/Shanghai）｜mowen｜第 623 次尝试｜失败（抓到上传链路：upload/prepare=200，但 OSS POST=203，疑似 callback 失败）

- 命令：`CHROME_PROFILE_DIR=tmp/chrome-cdp-live-profile-v3 LIVE_PUBLISH_CHANNELS=mowen npm run publish:live -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（network log：`tmp/network-mowen-1774562162708.ndjson`）：
  - 触发图片上传时，会先请求：`POST https://misc.mowen.cn/api/file/v1/upload/prepare`（200）
    - 请求体示例：`{"appSource":1,"bizSource":6,"params":{"fileSize":15}}`
  - 随后发起：`POST https://priv-sdn.mowen.cn/`（multipart/form-data，疑似阿里 OSS 直传）
    - 关键异常：响应 status 为 **203**（而非 prepare 下发的 `success_action_status=200`）
  - 页面出现 toast：`上传失败`，并再次卡在 `正在上传图片（2/10）` 最终触发 180s 无进度超时。
- 经验教训：
  - “上传失败”很可能不是前端没触发上传，而是直传返回码/回调失败导致客户端判定失败；必须拿到 `priv-sdn.mowen.cn/` 的响应体（XML/JSON）才能定位具体错误码。
  - 下一轮已在 `scripts/live-publish-chrome-cdp.mjs` 将 mowen 的 network logger 调整为：当 status!=200 时强制抓取 `res.text()`（包括 203），重新跑 `attempt=624` 获取失败原因。

### 2026-03-27（Asia/Shanghai）｜mowen｜第 624 次尝试｜失败（确认 CallbackFailed：OSS 回调接口返回 500）

- 命令：`CHROME_PROFILE_DIR=tmp/chrome-cdp-live-profile-v3 LIVE_PUBLISH_CHANNELS=mowen npm run publish:live -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 关键证据（network log：`tmp/network-mowen-1774562502563.ndjson`）：
  - `POST https://priv-sdn.mowen.cn/` 响应 **203**，响应体为：
    - `Code=CallbackFailed`
    - `Message=Error status : 500.`
  - 说明：直传本身到 OSS 可能已完成，但 OSS 在回调 `https://misc.mowen.cn/api/file/v1/oss/upload/callback` 时得到 500，因此客户端收到 203 并提示“上传失败”。
  - decode `upload/prepare` 返回的 callback 配置，callbackBody 需要字段：`bucket/object/size/crc64/mimeType/file_name/file_id/file_uid`（其中 `file_*` 依赖表单 `x:file_*` 字段）。
- 经验教训：
  - 当前“图片上传失败”的根因明确是 **OSS callback 失败（500）**，而不是 fetch 图片失败或未触发上传。
  - 下一轮需要确认 `POST https://priv-sdn.mowen.cn/` 的 multipart 表单里是否带齐 `x:file_name/x:file_id/x:file_uid`（若缺失则是前端触发方式不完整），并尝试切换为更“原生”的上传触发方式（优先考虑用 CDP/Playwright 的 `setInputFiles` 触发 file chooser 流程）以避免 callback 500。

### 2026-03-27（Asia/Shanghai）｜mowen｜第 625 次尝试｜失败（登录态丢失：/editor 重定向到微信扫码登录）

- 命令：`CHROME_PROFILE_DIR=tmp/chrome-cdp-live-profile-v3 LIVE_PUBLISH_CHANNELS=mowen npm run publish:live -- https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg`
- 结果摘要：
  - `login-audit` 最终 URL 为 `https://account.mowen.cn/auth/?redirect=...`，并打开 `open.weixin.qq.com/connect/qrconnect` 扫码页，判定 `not_logged_in`。
  - `tmp/mcp-publish-progress.json`：`mowen.status=failed`、`notes=登录审计阻塞：login-url`
- 经验教训：
  - 墨问登录 cookie/会话可能在多次强制重启（SIGKILL）后丢失或被服务端失效；后续应尽量减少对已登录 profile 的硬杀，优先复用已登录实例。
  - 修复脚本误导输出：此前当登录审计把渠道标记为 failed 且 pending 为空时，stdout 会错误打印“全部渠道发布成功”；已在 `scripts/live-publish-chrome-cdp.mjs` 修正为按 `successCount` 计算并在失败时抛错。
