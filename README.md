# bawei（V3）

一款浏览器插件：在微信公众号文章页（`mp.weixin.qq.com`）抓取内容，并一键同步到多平台（CSDN / 腾讯云开发者社区 / 博客园 / OSCHINA / 人人都是产品经理 / 墨问 / 少数派 / 百家号 / 头条号 / 飞书文档）。

## 功能介绍

bawei 是一款专为内容同步发布设计的浏览器插件：打开微信公众号文章页后，通过页面内的发布面板，将文章抓取并同步到多个目标平台。

我们的核心目标是：**让内容创作者能够轻松实现跨平台内容分发，节省大量时间和精力。**

---

### ⭐ 核心功能

1. **一键内容提取**
   - 智能识别微信公众号文章的标题和正文
   - 保持原有的格式和样式
   - 支持富文本内容（图片、链接、格式等）

2. **多平台串行执行**
   - 一次开始后按顺序打开 10 个目标平台编辑页
   - 每次只聚焦并执行一个渠道，当前渠道结束一次尝试后再切换下一个
   - 自动检测登录状态（未登录会在面板提示）
   - 自动填充标题与正文
   - 自动下载并上传正文图片（按原文顺序插入）
   - 支持“保存草稿 / 提交发布”；投稿后需平台审核的渠道先显示“待审”，不会提前报公开成功
   - 点击任一渠道状态可跳转/重开该渠道 Tab

3. **智能兼容性**
   - 以页面内交互为准（模拟用户操作）
   - 针对各平台编辑器做基础适配
   - 复用同地址渠道标签页时会强制刷新，使新任务上下文绑定到新内容脚本

4. **用户友好设置**
   - 支持自动发布开关
   - 支持自动关闭原页面
   - 多语言界面支持

5. **公开验收与防重复投稿**
   - `success` 只表示文章详情页可在无 Cookie 的匿名浏览器中访问，且标题、正文锚点和平台托管图片通过验收
   - `pending_review`、`rejected`、`waiting_user`、`failed`、`not_logged_in` 分开记录，不再把点击投稿按钮或得到候选链接当成成功
   - 发布台账按“渠道 + 内容哈希”防重：公开成功、待审、退回和待人工验证内容都不会重复投稿；待审内容只复核公开状态
   - 平台人工安全验证完成后，可用 `LIVE_PUBLISH_RESUME_WAITING_USER_CHANNELS=<channel>` 只恢复指定 `waiting_user` 原稿；公开、待审和退回记录仍不可重投

## 如何使用

### 1. 安装插件

从 Chrome 网上应用店安装 bawei 插件。

### 2. 在微信公众号文章页面使用

1. 打开任意**微信公众号文章详情页**（`mp.weixin.qq.com/s...` 或 `mp.weixin.qq.com/s/...`）
2. 等待页面完全加载后，页面右上角会出现插件 icon，点击后打开“发布面板”
3. 点击面板右上角“关闭”，面板会收起并回到右上角 icon
4. 面板顺序固定为：动作选择 -> 渠道选择 -> 执行按钮（开始/停止）-> 诊断输出区（默认隐藏，开始后自动显示在按钮下方）
5. 渠道选择区支持：
   - 勾选本次执行渠道（checkbox）并在同一行右侧查看“状态 + 进度（stage/userMessage）”
   - 点击“检查登录”：批量检查当前已勾选渠道的登录状态；若未登录，会把该渠道名称标红，并在**后台静默打开**该渠道编辑页/登录页，不打断当前微信公众号页面
   - 诊断聚焦下拉：选择当前要查看诊断的渠道（执行过程中允许切换，仅影响诊断展示与下次启动时前台打开的渠道）
   - 全选/全不选：一键切换（执行中禁用）
6. 当执行渠道“全不选”时，“开始”按钮会置灰不可点击
7. 点击“开始”后按钮变红且文案变为“停止”，可随时点击“停止”强行中断后续步骤（不会关闭已打开的渠道 tab；状态保留停止时快照）

### 3. 发布流程（V3）

1. **内容提取**：提取标题、正文渲染后 HTML、原文链接（当前页面 URL）
2. **串行执行渠道**：逐个聚焦所选平台编辑页并开始执行，并自动检测登录状态
3. **填充与上传**：按原文顺序写入文本段落，并把正文图片下载后上传到各平台
4. **诊断与处理**：诊断区开始后自动展开；如遇未登录/验证码/实名/风控/图片上传失败等平台要求，按诊断提示处理
5. **终态验收**：草稿以平台保存结果为准；正式发布只有匿名公开验收通过才记为成功，审核中和退回会保留各自终态及证据

### 4. 设置选项

您可以在插件设置中配置：

- **自动发布**：是否在填充内容后自动点击发布按钮
- **自动关闭原页面**：是否在成功发布后自动关闭微信文章页面
- **语言设置**：选择界面语言（中文/英文）

## 技术特点

- **纯前端实现**：无需任何服务器，完全在浏览器中运行
- **智能等待机制**：自动检测页面元素加载状态
- **兼容性强**：支持多种富文本编辑器
- **用户体验优化**：提供实时反馈和状态提示

## 注意事项

- 建议在发布前检查内容格式是否正确
- 某些特殊格式可能需要手动调整
- 图片策略：打开微信公众号文章时会先将正文图片 URL 代理化（`https://read.useai.online/api/image-proxy?...`），再进入多平台发布流程。上传链路优先走通用粘贴/拖拽/文件注入，若编辑器在 iframe 或通用链路失败，会自动尝试“插图按钮 + 本地文件”兜底。如遇风控/上传失败，会进入“等待处理”，请按诊断提示手动上传后继续。

---

希望这款插件能够帮助您更高效地进行跨平台内容分发！如果您有任何问题或建议，欢迎反馈。

## E2E 测试（Playwright）

- 单元测试（tokens 拆分 + 图片插入桥接）：`npm run test:v3:unit`
- 串行队列单元测试：`npm run test:serial`
- 十渠道后台串行集成测试：`npm run test:serial:integration`
- 十渠道真实 Chrome 串行聚焦 E2E：`npm run test:serial:e2e`
- 本地 Markdown 转换单元测试：`npm run test:markdown`
- V3 离线可重复 E2E（10/10 渠道）：`npm run e2e:v3`
- 登录状态只读检查（不输出 Cookie/token/账号）：`npm run auth:status`
- 旧的 `npm run e2e:export-state` 已安全停用：Bawei 不再生成全量明文 Cookie/localStorage 文件
- V2 真实站点 E2E（依赖你的真实登录态/可能需要人工处理验证码等）：`npm run e2e:v2`（可选：`npm run e2e:v2 <channelId>`）
- 真实站点发布默认自行启动轻量运行时浏览器，并在发布前按固定顺序解析认证：官方 API/OAuth（仅限当前动作有官方适配器）→ 加密最小浏览器状态 → Keychain 一次有界密码恢复 → 人工强验证。
  - 默认状态根目录是 `~/Library/Application Support/channel-auth/v1`，可用 `CHANNEL_AUTH_HOME` 指向任何生成同一 v1 契约的目录；Bawei 不 import、也不硬编码 `login` 仓库路径。
  - CSDN、腾讯云开发者社区、今日头条、少数派、飞书文档、墨问只注入已验证的最小 Cookie/localStorage 键；飞书仅使用 `.feishu.cn` 的 `session`，墨问仅使用 `_MWT + _MWTH`，其余渠道没有有效基线时拒绝全量 Cookie 降级。
  - `npm run live:open` 仅用于需要扫码、短信、验证码或风控确认时打开本轮运行时页面；完成后可用 `LIVE_PUBLISH_REQUIRE_EXISTING_CHROME=1 npm run live:publish -- <微信文章URL>` 继续同一现场。
  - `npm run live:publish -- <微信文章URL>` 默认不要求预先启动专用浏览器；可选仅跑单渠道：`LIVE_PUBLISH_CHANNELS=sspai npm run live:publish -- <微信文章URL>`。
  - 如需在当前已登录浏览器上做页面内面板 UI 真测，可显式关闭后台直连并切换动作：
    - 草稿：`USE_BACKGROUND_DIRECT=0 LIVE_PUBLISH_ACTION=draft LIVE_PUBLISH_REQUIRE_EXISTING_CHROME=1 LIVE_PUBLISH_PRESERVE_EXISTING_PAGES=1 npm run live:publish -- <微信文章URL>`
    - 发布：`USE_BACKGROUND_DIRECT=0 LIVE_PUBLISH_ACTION=publish LIVE_PUBLISH_REQUIRE_EXISTING_CHROME=1 LIVE_PUBLISH_PRESERVE_EXISTING_PAGES=1 npm run live:publish -- <微信文章URL>`
    - 注意：执行 UI 真测前，要先在这次 CFT 会话里打开目标微信公众号文章页；仅执行 `live:open` 打开各渠道编辑页，不会自动让微信页内容脚本注入，右上角悬浮入口也不会出现。
- 真实站点一键发布（单次运行，失败即结束，脚本退出但浏览器保留）：`npm run publish:live`
  - 登录审计若判定 `not_logged_in` / `blocked_external`，非交互任务会立即标记失败并终止本轮，不会占住调度器等待人工
  - 交互终端默认允许人工处理；可显式设 `WAIT_FOR_LOGIN=0` 快速失败或 `WAIT_FOR_LOGIN=1` 等待本轮强验证
  - 发布阶段若返回 `not_logged_in`，按阻塞错误立即失败停止，不再自动重试
  - 不再自动触发“继续/重试”，每次执行只跑一轮；如需再次尝试请手动重跑命令
  - 默认运行时目录为 `artifacts/chrome-cdp-runtime-profile-v1`；它只承载扩展进程和本轮页面，不再作为权威登录状态源。可用 `CHROME_RUNTIME_DIR=/abs/path` 覆盖；旧 `CHROME_PROFILE_DIR` 仅作运行目录兼容别名。
  - 重型 profile 复制已删除；任何 `BOOTSTRAP_PROFILE=1` 都会 fail closed，不会从日常 Chrome 复制 Cookie、密码库或本地存储。
  - Keychain 恢复项使用 `channel-auth.recovery.<channel>` / `credential-pair-v1`。脚本只在同时存在可见账号与密码框、且页面没有必须完成的验证码/2FA/风控时提交一次；普通登录页即使同时展示二维码备选入口也不误拦截，只有二维码是唯一入口时才转人工强验证。之后仍必须通过真实编辑页登录审计。
  - 网络代理固定为“仅 X、CWS”：Bawei 当前十个内容渠道的所有 CFT/Playwright 入口都强制 `--no-proxy-server`，不会继承系统或 shell 代理；显式复用已有 CDP 浏览器时也会检查其进程启动参数，无法证明直连就拒绝复用。CWS 官方 OAuth/API 在独立发布进程中要求代理。X 由独立 COO 项目接入，不进入 Bawei 的通用直连浏览器。
  - `LIVE_PUBLISH_FORCE_CHANNELS` 只重置旧进度文件，不能绕过正式发布台账；已公开、待审、退回或待人工验证的同内容仍禁止重投
  - 完成平台官方人工安全验证后，可用 `LIVE_PUBLISH_RESUME_WAITING_USER_CHANNELS=baijiahao` 恢复同内容原稿；该开关只解除指定渠道的 `waiting_user` 冻结，不会绕过公开、待审或退回防重，也不得用于自动重发验证码
  - 历史失败路径简表见 `docs/live-publish-failure-paths.md`
- 本地 Markdown 一键串行发布到默认 10 个渠道：`npm run publish:markdown -- /path/to/article.md`
  - 命令会先构建扩展，再逐个聚焦渠道并执行正式发布；人人都是产品经理正式投稿必须提供 `bawei:variant woshipm` 专用变体
  - `source_url` 可省略；省略时不会把 `127.0.0.1` 临时地址写进正文，本机 HTTP 服务只负责传输本地图片
  - 完整格式、七类终态、防重规则、登录准备和本地图片说明见 `docs/local-markdown-publish.md`
- 基于 Playwright persistent context 的单渠道真跑脚本：`node scripts/mcp-live-publish.mjs <微信文章URL>`
  - 支持只跑指定渠道：`LIVE_PUBLISH_CHANNELS=cnblogs,woshipm node scripts/mcp-live-publish.mjs <微信文章URL>`
  - 如需强制改用本机稳定版 Chrome，可加：`PW_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`
  - 适合在“已成功渠道跳过、只盯剩余失败渠道”时做定点回归
  - 该入口同样只消费中立加密状态；运行时目录中的旧 Cookie 不能代替真实编辑页 URL/DOM 与发布权限审计

Chrome Web Store 发布也优先读取 `cws.oauth2` 中立密文；过期 access token 只要仍有 refresh token 就先走官方刷新，不会误降级。GitHub Actions 等没有 macOS Keychain 的受控环境可继续使用平台 Secret 注入。既有本机 `.env` 可由独立获取端先做官方 OAuth + 扩展身份探针，再迁移并清空秘密；Bawei 本地 `.env` 只保留 Publisher ID、扩展 ID、代理等非秘密运行配置，仓库不再绑定账号专属默认值。

## 渠道补充说明

- `baijiahao`
  - 当前重点保证正文结构 fidelity：标题、段落、正文图片、原文链接都要在编辑器落地态和最终发布态保持完整。
  - 平台 DOM 的 `http://` 图片地址与 Chromium 自动升级为 `https://` 的 `currentSrc` 只统一协议后比较；图片数量、顺序、主机、路径和查询参数仍严格验收。
- `toutiao`
  - 正式发布必须依次触发“预览并发布”和独立的“确认发布”，且每个动作只允许一次；确认后作品列表持续找不到标题会记为 `failed`，不会再假报 `pending_review`。
  - 已带 `pgc_id` 的草稿编辑页会原址复用，避免重新创建同题稿件。
- `feishu-docs`
  - 创建前先在固定目录按完整标题复用已有文档；同时打开多个文档时会优先复用标签标题匹配的目标 docx，标题损坏时再按正文锚点或原文链接定位，避免写入其他文档。
  - 空文档会从 `data-content-editable-root` 创建首个正文块，可信剪贴板恢复也支持正文块尚不存在的状态。写入后必须等待云端保存、刷新同一 docx，并重新验收标题、全文块和全部平台托管图片。
  - 正式发布会兼容新版分享确认框，开启匿名可读链接并做无 Cookie 验收；不再降级为无图正文。
- `woshipm`
  - 正式投稿必须使用面向产品经理读者的渠道变体，并覆盖用户问题、产品决策、取舍、适用边界和可复用洞察。
  - TinyMCE 图片采用“每次在空编辑器上传一张并收集平台 URL，最后同步 iframe 正文 DOM 与 `#post_content` 隐藏字段，一次性重建完整图文”的方式，避免后上传图片覆盖当前选中图；重试会保留带 `pid` 的既有草稿地址。
  - 投稿后会读取“我的文章”中的审核状态和退回原因；“作品与平台定位不符，无法发布”记为 `rejected`，不会再算成功或自动重投。
- `oschina` / `woshipm`
  - 入口页若已经退回首页且页面出现明显登录文案，当前脚本会直接判定 `not_logged_in`，不再反复首页跳转。
  - `oschina` 真实可写入口统一走 `https://my.oschina.net/blog/ai-write`，不要再依赖旧的 `/blog/write` 中转页。
  - `oschina` 的 Tiptap 主世界写入优先加载仅对 `my.oschina.net` 开放的外部页面桥接；若平台 legacy polyfill 因错误的 CORS 属性加载失败，桥接会以无 `crossorigin` 的经典脚本补载 SystemJS，再重新导入页面声明的 legacy 入口并等待编辑器就绪。
  - `oschina` 若被平台带回 `/u/<id>` 通用个人空间，页面桥接会切到该空间规范的 `/u/<id>/blog/ai-write`，不会在个人空间误判编辑器损坏。
  - `oschina` 图片先由扩展读取为 `File`，再调用编辑器自身的 `commands.uploadImage(file)`；`blob:`、`data:`、localhost、扩展临时地址以及微信原始 `qpic/qlogo` 地址都不能算平台托管图片，只有稳定 HTTP(S) 平台图片数达到期望值才允许投稿。
  - `oschina` 发布后优先在详情页直接验收原文链接；若平台返回个人空间，则通过 `myDynamic` 接口按完整标题精确解析 `objId` 后进入详情页，列表 DOM 探测只作为接口不可用时的兼容兜底。
