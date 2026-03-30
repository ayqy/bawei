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

2. **多平台并发执行**
   - 一次开始后并发打开 10 个目标平台编辑页
   - 自动检测登录状态（未登录会在面板提示）
   - 自动填充标题与正文
   - 自动下载并上传正文图片（按原文顺序插入）
   - 支持“保存草稿 / 直接发布”
   - 点击任一渠道状态可跳转/重开该渠道 Tab

3. **智能兼容性**
   - 以页面内交互为准（模拟用户操作）
   - 针对各平台编辑器做基础适配

4. **用户友好设置**
   - 支持自动发布开关
   - 支持自动关闭原页面
   - 多语言界面支持

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
2. **并发打开渠道**：同时打开所选平台编辑页并开始执行，并自动检测登录状态
3. **填充与上传**：按原文顺序写入文本段落，并把正文图片下载后上传到各平台
4. **诊断与处理**：诊断区开始后自动展开；如遇未登录/验证码/实名/风控/图片上传失败等平台要求，按诊断提示手动完成后点击“继续/重试”

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
- V3 离线可重复 E2E（10/10 渠道）：`npm run e2e:v3`
- 导出登录态（用于复用已登录站点的 cookie / localStorage）：`npm run e2e:export-state`
- V2 真实站点 E2E（依赖你的真实登录态/可能需要人工处理验证码等）：`npm run e2e:v2`（可选：`npm run e2e:v2 <channelId>`）
- 真实站点两步发布（先打开渠道编辑页，再执行发布；复用同一浏览器，发布时不清理渠道 Tab）：
  - Step1：`npm run live:open`（自动 `npm run build`，启动/重启 CDP Chrome，并打开渠道编辑页；可选仅打开指定渠道：`LIVE_PUBLISH_CHANNELS=sspai,mowen npm run live:open`）
  - Step2：`npm run live:publish -- <微信文章URL>`（复用上一步浏览器执行单次发布；可选仅跑单渠道：`LIVE_PUBLISH_CHANNELS=sspai npm run live:publish -- <微信文章URL>`）
  - 如需在当前已登录浏览器上做页面内面板 UI 真测，可显式关闭后台直连并切换动作：
    - 草稿：`USE_BACKGROUND_DIRECT=0 LIVE_PUBLISH_ACTION=draft LIVE_PUBLISH_REQUIRE_EXISTING_CHROME=1 LIVE_PUBLISH_PRESERVE_EXISTING_PAGES=1 npm run live:publish -- <微信文章URL>`
    - 发布：`USE_BACKGROUND_DIRECT=0 LIVE_PUBLISH_ACTION=publish LIVE_PUBLISH_REQUIRE_EXISTING_CHROME=1 LIVE_PUBLISH_PRESERVE_EXISTING_PAGES=1 npm run live:publish -- <微信文章URL>`
    - 注意：执行 UI 真测前，要先在这次 CFT 会话里打开目标微信公众号文章页；仅执行 `live:open` 打开各渠道编辑页，不会自动让微信页内容脚本注入，右上角悬浮入口也不会出现。
- 真实站点一键发布（单次运行，失败即结束，脚本退出但浏览器保留）：`npm run publish:live`
  - 登录审计若判定 `not_logged_in` / 风控页，会立即标记失败并终止本轮
  - 发布阶段若返回 `not_logged_in`，按阻塞错误立即失败停止，不再自动重试
  - 不再自动触发“继续/重试”，每次执行只跑一轮；如需再次尝试请手动重跑命令
  - 默认使用 `artifacts/chrome-cdp-live-profile-v8` 持久化浏览器资料，避免每轮掉登录
  - 默认不做跨浏览器登录态引导（如需导入可显式设置 `BOOTSTRAP_PROFILE=1`）
  - 可通过 `CHROME_PROFILE_DIR=/abs/path` 指定固定 profile 目录，跨轮次复用
  - 想做到“登录一次，后续一直复用”，推荐固定专用 profile，并始终关闭引导覆盖：
    - 首次登录：`CHROME_PROFILE_DIR="$HOME/.bawei-live-profile" BOOTSTRAP_PROFILE=0 npm run live:open`
    - 在打开的专用浏览器里把各渠道登录完；之后不要删除该目录，也不要切换到别的 `CHROME_PROFILE_DIR`
    - 后续发布：`CHROME_PROFILE_DIR="$HOME/.bawei-live-profile" BOOTSTRAP_PROFILE=0 npm run live:publish -- <微信文章URL>`
  - 若确实要从你日常 Chrome 导入一次登录态，可显式设置 `BOOTSTRAP_PROFILE=1`；脚本默认只在目标 profile 未初始化时引导一次，如需强制再次覆盖可再加 `BOOTSTRAP_PROFILE_REFRESH=1`
  - 若同一篇文章在修复代码后需要强制重跑某个已成功渠道，可加：`LIVE_PUBLISH_FORCE_CHANNELS=tencent-cloud-dev npm run live:publish -- <微信文章URL>`
  - 历史失败路径简表见 `docs/live-publish-failure-paths.md`
- 基于 Playwright persistent context 的单渠道真跑脚本：`node scripts/mcp-live-publish.mjs <微信文章URL>`
  - 支持只跑指定渠道：`LIVE_PUBLISH_CHANNELS=cnblogs,woshipm node scripts/mcp-live-publish.mjs <微信文章URL>`
  - 如需强制改用本机稳定版 Chrome，可加：`PW_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`
  - 适合在“已成功渠道跳过、只盯剩余失败渠道”时做定点回归
  - 注意：源 profile 里即使存在目标站点 cookie，也不代表渠道仍处于已登录可发文状态；最终仍以真实编辑页 URL/DOM 为准

## 渠道补充说明

- `baijiahao`
  - 当前重点保证正文结构 fidelity：标题、段落、正文图片、原文链接都要在编辑器落地态和最终发布态保持完整。
- `toutiao` / `feishu-docs` / `woshipm`
  - 当前自动化优先保证“标题 + 正文文本 + 原文链接”闭环；正文图片默认跳过自动上传。
  - 若平台额外要求封面或图片，请按面板提示手动补齐后继续执行。
- `oschina` / `woshipm`
  - 入口页若已经退回首页且页面出现明显登录文案，当前脚本会直接判定 `not_logged_in`，不再反复首页跳转。
  - `oschina` 真实可写入口优先走 `https://my.oschina.net/u/1/blog/write`，不要再依赖 `https://www.oschina.net/blog/write` 的中转页。
  - `oschina` 发布后优先在详情页直接验收原文链接；不要在 `/blog/write` 成功弹层刚出现时就提前回退到列表页。
