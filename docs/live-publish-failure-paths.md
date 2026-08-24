# live-publish 已验证失败路径与成功经验

更新时间：2026-08-22（Asia/Shanghai）

## 目标

记录真实站点发布过程中已经验证过的失败路径、低收益路径和稳定成功经验，避免后续在同一类问题上重复消耗。

> 2026-08-23 登录架构更新：本文较早日期中“长期复用专用 profile / 克隆日常 Chrome”的操作建议只保留为历史取证，不再是当前方案。现行实现固定使用“官方 API/OAuth → 中立 AES-256-GCM 最小状态 → Keychain 一次有界恢复 → 人工强验证”，运行时 profile 不再是权威认证源，`BOOTSTRAP_PROFILE=1` 会直接拒绝执行。

## 2026-08-22 飞书与 OSCHINA 验收恢复

- 防重边界：已经公开、提交审核、明确退回或等待人工验证的同内容保持冻结；修验收逻辑时不得借机再次投稿。
- OSCHINA：文章提交后，个人空间新版列表可能不再渲染文章链接，按标题搜索 DOM 会产生“列表未定位”假阴性。登录态页面可调用 `https://apiv1.oschina.net/oschinapi/user/osc/myDynamic?pageNum=1&pageSize=30`；现在先按完整标题精确匹配博客项并用 `objId` 构造详情页，DOM 列表探测仅作为接口不可用时的兜底。通用 `/u/<id>` 个人空间也会直接切到规范 `/u/<id>/blog/ai-write`。
- OSCHINA 图片：编辑器中残留的 `blob:`、`data:`、localhost、图片代理、扩展地址或微信原始 `qpic/qlogo` 地址都不是 OSCHINA 托管图，不能满足“平台托管图片”门槛。
- 飞书：同时打开多个 docx 时，后台先按标签标题复用目标文档；标题已被正文或原文链接覆盖时，可信恢复再按正文锚点和来源 URL 定位。标题必须先于综合证据修复，正文写入后重新断言标题，等待云端保存后刷新同一 URL 并再次聚合虚拟块。分享确认同时兼容 `[role=dialog]` 和新版 `.ud__dialog__wrap`。
- 百家号：人工验证只能用于当前正确稿件。若验证弹层下仍是旧稿，必须先取消旧弹层，再用相同 Markdown 恢复标题、正文、图片和封面后提交；平台为新提交重新下发的滑块仍只能由账号本人完成，自动化不得求解或绕过。

## 2026-08-21 六渠道定点修复

- 防重边界：CSDN、腾讯云、博客园、墨问已确认发布或提交成功，本轮不再进入编辑/投稿流程；只处理 OSCHINA、人人都是产品经理、少数派、百家号、今日头条、飞书。
- 少数派：复用 `/write`、`/my` 或 `/whoops` 标签页且目标 URL 未变化时，`chrome.tabs.update()` 不会生成新文档，旧内容脚本拿不到刚绑定的任务上下文。后台现在会在上下文绑定后显式 `chrome.tabs.reload()`。
- OSCHINA：空白写作页的直接根因是平台 `vite-legacy-polyfill` 带 `crossorigin`，但 CDN 响应缺少 CORS 头，继而出现 `System is not defined`。页面桥接现在会无 CORS 补载同一 polyfill，调用页面 `vite-legacy-entry[data-src]` 指定的 `System.import()`，并等待标题和 Tiptap 实例同时就绪。
- 人人都是产品经理：TinyMCE 4 的异步图片上传会把新图回填到当前选中图。当前链路每次只在空编辑器上传一张并收集 `image.woshipm.com` 地址，最后同步 iframe 正文 DOM 与 `#post_content` 隐藏字段并原子重建完整图文；重试保留带 `pid` 的既有草稿地址，避免创建同标题副本。
- 百家号：DOM 仍可能保存 `http://` 图片地址，而 Chromium `currentSrc` 会自动升级成 `https://`。验收仅统一 HTTP/HTTPS 协议，图片数量、顺序、主机、路径、查询参数和片段仍保持严格比较；后台同时保留现有编辑稿 URL。
- 今日头条：带 `pgc_id` 的现有草稿继续原址复用；正式投稿必须分别点击一次“预览并发布”和一次“确认发布”。最终确认后作品列表仍找不到标题会记为 `failed`，不再用 `submitted_not_indexed` 假报 `pending_review`。
- 飞书：新任务先在固定目录按完整标题复用现有文档，禁止重建同名副本；空文档从 `.page-block.root-block[data-content-editable-root=true]` 创建首个正文块。可信剪贴板恢复也先判断正文块是否存在，不再在创建正文块之前等待旧选择器超时。
- 回归门：类型检查、ESLint、V3 单元测试、后台串行集成、发布核心测试、十渠道未登录/草稿/发布全量 E2E、腾讯云退回语义和十渠道严格串行 E2E 全部通过；离线夹具额外断言 OSCHINA legacy 恢复、飞书不调用创建接口、人人都是产品经理图文顺序与托管域名、百家号新版 AI 声明，以及头条预览/确认各一次。

## 2026-08-17 终态口径纠正

- 本文 2026-03 的“发布成功”记录只证明当时完成了页面填充、按钮点击或登录态详情页检查，不能证明文章已经通过审核并对匿名用户公开；这些历史描述不得再作为 `success` 证据。
- 新口径下，正式发布只有在无 Cookie 上下文中打开平台公开详情页，并通过标题、至少两个正文锚点和预期平台托管图片验收，才记为 `success`。
- 投稿已接收但尚未匿名公开记为 `pending_review`；明确审核退回记为 `rejected`；必须由账号本人完成安全验证记为 `waiting_user`；技术异常与未登录分别记为 `failed`、`not_logged_in`。
- 2026-08-17 从固定登录 profile 只读回查人人都是产品经理“我的文章”，8 月 15、16、17 三篇 miaoa 营销文章均显示“【草稿】【作品与平台定位不符，无法发布】”。三次历史 `success 1/10` 均为误报，应更正为 `rejected 1/10; public success 0/10`。
- 同一渠道、同一内容哈希的公开成功、待审、退回或待人工验证记录都禁止再次投稿；待审只做状态复核，退回保留原因，待人工验证保留已填写现场。人人都是产品经理的新投稿还必须使用产品经理读者专用变体。

## 2026-08-17 同一冻结稿真实回归

- 内容 SHA-256：`a60445ce1d4a2c52513406d6eb2616b3e259dd7ea3331785880f46a527d4b948`；全程复用用户完成十渠道登录的 `~/.bawei-live-profile`，没有重启浏览器或替换 Profile。
- 匿名公开 `6/10`：博客园、OSCHINA、墨问、少数派、今日头条、飞书文档；六个详情页均通过无 Cookie 标题、正文锚点和三张平台托管图片验收。
- 待审核 `1/10`：CSDN 文章 `163823287` 的管理页已出现阅读、点赞、收藏和“浏览/推广”操作，但无 Cookie 详情页仍被安全滑块拦截为 HTTP 521，因此继续保留 `pending_review`，只复核状态，禁止再次投稿。
- 已退回 `2/10`：人人都是产品经理明确返回“作品与平台定位不符”；腾讯云明确返回“内容包含广告/引流信息”。二者均保留 `rejected` 和退回原因，同稿禁止再次投稿。
- 待人工验证 `1/10`：百家号接口返回 `errno=10000017`，要求验证绑定手机号。标题、正文、三张图片和封面均已填写并保留，但发布按钮只点击一次；自动化不得点击“去验证/其他验证”绕过，也不得重复提交。
- 技术失败 `0/10`、未登录 `0/10`。再次执行同稿时，六个公开渠道防重跳过，一个待审渠道只复核，两个退回渠道与待验证渠道均保持冻结，没有产生重复稿件。
- 飞书恢复链路使用可信富文本剪贴板与真实 `Meta+V`，并通过虚拟滚动聚合验证全文和三张图片。只有正式发布才开启“互联网获得链接的人可阅读”并做匿名验收；保存草稿只验云端保存，不改变分享权限。

## 本轮最终回归（2026-03-30）

1. **当时采用的 10 渠道“成功”定义（已废止）**
   - 已用固定发布 profile `~/.bawei-live-profile`，在**插件页面面板链路**下完成真实回归。
   - 本轮执行时显式设置了 `USE_BACKGROUND_DIRECT=0`，因此不是 background 直连捷径，而是走微信公众号文章页右上角悬浮入口 `#bawei-v2-launcher` 打开的发布面板。
   - 这一定义对应“插件一键发布成功”；但它是**微信文章页内悬浮面板 UI**，不是 Chrome 工具栏里的浏览器 action popup。

2. **当时的页面动作回归结果（不是公开成功）**
   - 目标文章：`https://mp.weixin.qq.com/s/NBlnaBCThLQGV1aYUP2O8g`
   - 草稿动作：10/10 完成
   - 投稿动作：10/10 完成；未按当前匿名公开标准复核，不能计为公开成功
   - 渠道：`cnblogs / oschina / woshipm / mowen / sspai / baijiahao / toutiao / feishu-docs / tencent-cloud-dev / csdn`

3. **对“插件 UI 实测”的边界说明**
   - 本轮已经验证的是：微信公众号文章页内的插件悬浮入口 + 发布面板 UI 可用，并可驱动 10 个渠道完成草稿/发布。
   - `src/popup/` 对应的 Chrome 工具栏 popup，本轮**没有单独作为 10 渠道回归入口再做一轮独立验证**。
   - 若后续要单独声明“popup 也 10/10 可用”，应再补一轮仅从工具栏 popup 发起的独立回归。

## 本轮草稿一致性审计（2026-03-31）

1. **审计基准**
   - 目标文章：`https://mp.weixin.qq.com/s/NBlnaBCThLQGV1aYUP2O8g`
   - 源标题：`Cursor公布的这张图，价值千金`
   - 源文图片数：`4`
   - 自动审计产物：`artifacts/live-publish/draft-audit.json`

2. **当前已确认不一致的渠道**
   - `tencent-cloud-dev`：标题对、原文链接在，但正文被压成少量大段，图片 `0/4`。
   - `toutiao`：标题对、原文链接在，但正文被压成少量大段，图片 `0/4`。
   - `oschina`：标题对、图片 `4/4`、原文链接在，但段落明显粘连，图片落点顺序也偏移。
   - `mowen`：是当前最接近原文的草稿，标题/图片/原文链接都对，但段落拆分仍与原文不一致。
   - `feishu-docs`：标题塌缩为整篇正文前缀，正文出现重复，图片 `0/4`。

3. **当前自动审计仍需二次取证的渠道**
   - `csdn`：`draft-audit.json` 报 `root not found`，但此前直接 iframe probe 已看见标题与正文落入编辑器；自动 extractor 目前不足以把它判成“已一致”。
   - `baijiahao`：`draft-audit.json` 报 `baijiahao root not found`，但此前直接页面 probe 已确认标题、图片与原文链接可见；当前仍需更稳的 extractor 才能纳入自动验收。
   - `cnblogs`：当前页仍停在 `https://i.cnblogs.com/posts/edit?postId=19798784` 且 DOM 只有“编辑器加载中...”，这轮自动取证无法确认正文是否完整落稿。
   - `sspai`：历史入口 `https://sspai.com/my` 会落到 `https://sspai.com/whoops`；现已改为统一从 `https://sspai.com/write` 进入。若当前会话仍停在 `whoops`，自动验收仍拿不到稳定的文章详情页 / article id。
   - `woshipm`：自动审计仍取不到稳定正文 root；结合既有策略，该渠道目前仍是“先保提交流程，不保正文图片 fidelity”。

4. **本轮审计新增结论**
   - “草稿保存成功”不等于“草稿 fidelity 合格”；标题、段落、图片数量、图片插入位置、原文链接都必须单独核对。
   - 自动 extractor 对自定义编辑器有明显误判风险；像 `csdn`、`baijiahao` 这类站点，必须结合真实 DOM probe / iframe probe 一起看，不能只看 `draft-audit.json` 的单一结论。
   - 本轮自动审计结果里，`leadingBrace` 已全部为 `false`；但百家号此前出现过前导 `}` 污染，因此仍需保留该项为固定检查项。

## 通用结论

1. **不要做常驻无限重试**
   - 同一渠道卡死后不断自动继续，只会把 `attempts` 拉高，不会提升成功率。
   - 阻塞态应立即失败退出，等待有针对性的代码修复。

2. **`not_logged_in` 是硬阻塞，不要继续跑**
   - 登录页、风险页、验证码页不会在自动化里自行恢复。
   - 发现未登录后应直接停掉当前渠道。

3. **不能盲信“DOM value 已变化”**
   - React、Monaco、DraftJS、CKEditor 这类编辑器经常出现“DOM 看起来写进去了，但站点内部 state 没更新”。
   - 关键输入项必须用站点真正接受的事件链路，并增加“状态已生效”的二次判定。

4. **图片上传必须等“上传完成”，不能只等“元素出现”**
   - 富文本里出现 `img`、`blob:`、占位图，不代表图片已经落稿。
   - 必须等待站点自己的上传完成信号，例如：
     - `src` 回填为正式 CDN 地址
     - 草稿接口返回的正文里图片已完整持久化
     - 表单区域出现“修改封面”之类的状态变化

5. **验收不要依赖脆弱的前台搜索组件**
   - 一些站点的“搜文章名称”组件会跳出后台管理页，或者会保留隐藏 DOM，导致 probe 永远命中旧文章。
   - 更稳的验收方式通常是：
     - 后台管理列表里只取可见项 probe
     - 详情页直接检索原文链接
     - 有官方接口时优先查接口

6. **真实站点调试优先用真实目标文章**
   - 过短的占位内容会触发平台最短字数限制，调试结果失真。
   - 尤其是腾讯云开发者社区，这类平台会对标题、正文长度、标签、封面一起做前端校验。

7. **修改插件代码后，发布前要让扩展重新加载**
   - 测试浏览器若继续复用旧扩展进程，即使 `dist` 已重新构建，真实站点仍可能跑到旧逻辑。
   - 稳定做法是发布前重启 Chrome for Testing，并继续复用同一 profile 保留登录态。

8. **当前活跃浏览器会话 > 磁盘 profile 拷贝**
   - 本轮已确认：把当前活跃的 `Chrome for Testing` 登录态只按磁盘目录复制出来，再用新 CFT 实例打开，容易在 Intel macOS 14 上触发 `SIGTRAP`。
   - 如果必须复用“用户已经登录好的现场”，优先直接复用当前活跃浏览器会话；拿不到活跃会话时，再退回到稳定版 Chrome 的只读克隆 profile 做单渠道调试。

9. **单渠道真跑要支持过滤**
   - 多渠道脚本如果每轮都把已成功渠道重新带上，会稀释失败信号，也会污染进度文件。
   - 调试剩余问题时，应优先使用 `LIVE_PUBLISH_CHANNELS=...` 只跑目标渠道。

10. **稳定版 Chrome + 克隆 profile 适合做 DOM 探针，不等于可替代真实插件现场**

- 本轮尝试用 `PW_EXECUTABLE_PATH=/Applications/Google Chrome.app/...` + 克隆 profile 跑 `mcp-live-publish`，微信公众号页面上的扩展面板仍未稳定注入。
- 这条路径适合做站点登录态 / DOM 取样，不足以替代“当前真实已登录浏览器 + 已加载插件”的完整回归现场。

11. **先取证当前用户态 Chrome，别把“我以为已登录”当成事实**

- 2026-03-29 本轮直接读取了用户当前 `Google Chrome` 的真实标签页，结果与 DevTools 会话完全一致：`cnblogs` 是登录页、`baijiahao` 是登录页、`toutiao` 是登录页、`feishu-docs` 是登录页，`oschina`/`woshipm` 则停在带明显登录入口的首页。
- 对上述 6 个标签页执行浏览器内刷新后，URL 仍保持原状态，没有自动回到各自编辑页；因此本轮阻塞点确定是“当前浏览器会话未登录”，不是“页面陈旧未刷新”。
- 结论是：继续调代码前，必须先用真实页面 URL / DOM 取证确认登录态；否则会把“登录丢失”误判成“发布逻辑失效”。

12. **Cookie 存在 ≠ 渠道仍然已登录**

- 2026-03-29 本轮把用户真实 `Default` profile 按白名单克隆到独立 CFT 会话后重新审计：`cnblogs` / `baijiahao` / `feishu-docs` 虽然在源 profile 中能查到目标站点相关 cookie，但实际仍分别落到 `signin/login` 页面。
- 结论是：不要把“cookie 文件里有域名记录”当成登录成功；是否可发文必须以真实编辑页 URL/DOM 为准。

13. **长期复用必须依赖中立轻量状态，不再依赖专用发布 profile**

- CSDN、腾讯云开发者社区、今日头条和少数派只消费经过真实验证的最小 Cookie/localStorage 白名单；其余渠道在没有官方凭据时进入 Keychain 或人工强验证，不允许“全 Cookie 保险导入”。
- `CHROME_RUNTIME_DIR` 只保存扩展运行环境和本轮页面；旧 `CHROME_PROFILE_DIR` 是兼容别名。`BOOTSTRAP_PROFILE=1` 已改为 fail closed，不再复制日常 Chrome 的 Cookie、密码库、IndexedDB 或 Service Worker 数据。

14. **`LIVE_PUBLISH_REQUIRE_EXISTING_CHROME=1` 必须只复用，不得擅自重启**

- 2026-03-30 已修正并验证：当用户要求复用当前已登录浏览器会话时，`connectOverCDP` 失败会直接报错，不再偷偷重启浏览器。
- 这条约束很关键；否则即使 profile 没被覆盖，也会打断用户现场和扩展 worker 状态。
- 2026-04-01 再次踩坑确认：**只要在真实已登录现场误跑了不带 `LIVE_PUBLISH_REQUIRE_EXISTING_CHROME=1` 的 `open/publish`，脚本就可能进入 `forceRestart` 分支，直接替换掉用户当前会话。**
- 同理，人工强验证后的本轮真测不得切换 `CDP_PORT` 或 `CHROME_RUNTIME_DIR`；这只是在同一强验证 checkpoint 内保留现场，不代表运行时目录重新成为长期认证源。
- 执行纪律必须明确为：
  - 真测/回归前，先确认当前 `CDP_PORT` 对应的就是用户正在使用的那份已登录浏览器；
  - 真测期间只允许 `LIVE_PUBLISH_REQUIRE_EXISTING_CHROME=1` 的复用式命令；
  - 若目的是打开渠道完成人工强验证，后续发布必须继续复用同一实例；下一轮仍应优先由中立状态重新取得认证。

15. **正文 fidelity 要纳入所有剩余渠道的固定回归项**

- 2026-03-30 本轮新增的共性检查项：`段落是否粘连`、`正文图片是否丢失`、`是否出现多余的前导符号（如 }）`。
- 不能只验“有无原文链接”或“发布按钮是否可点”；还要同时核对编辑器落地态和最终详情页的正文结构。
- 后续处理剩余渠道时，正文至少要检查：标题、段落、图片、原文链接四项。
- 若站点侧点击发布时报出选择器/HTML 语法类错误（例如 `Syntax error, unrecognized expression: }<h1 ...`），应优先回查编辑器 DOM 是否混入了非法前导字符或脏富文本片段，而不是继续重试发布按钮。

16. **CFT 的 `live:open` 只打开渠道页，不会自动唤醒微信页面板**

- 2026-03-30 本轮已确认：即使 CFT 进程命令行已经带上 `--load-extension=dist`，如果这次会话里只打开了各渠道编辑页、没有在同一会话里真正进入目标微信公众号文章页，那么 `chrome-extension://.../src/background.js` 的 worker 可能不会出现在 CDP target 列表里，用户也会误以为“测试版浏览器没加载插件”。
- 修复方式不是覆盖 profile，而是在**当前运行时实例**中显式打开/刷新目标微信文章页，让 `wechat-content` 真实注入一次。
- 因此做插件 UI 真测时，检查顺序应改成：
  1.  用当前 `CHROME_RUNTIME_DIR` 启动 CFT；
  2.  打开目标微信文章页；
  3.  再确认右上角悬浮入口与 `chrome-extension://.../src/background.js` worker 是否出现；
  4.  之后才进入草稿 / 发布真测。

17. **微信页图片代理改写不能对同值属性反复 `setAttribute`**

- 2026-03-30 本轮新增确认：`wechat-content` 在文章图上做代理 URL 改写时，如果对已经是目标值的 `src/data-src/...` 继续重复 `setAttribute`，会反复触发自己监听的 `MutationObserver(attributes)`。
- 结果表现为：微信文章页控制台能看到内容脚本初始化成功，但随后页面主线程被持续属性变更拖慢，`page.evaluate`、`chrome.tabs.sendMessage`、面板探针都会超时，看起来像“插件 UI 没注入”或“content script 不响应”。
- 修复原则：只有在属性值确实变化时才写回；`srcset` 同理，避免自触发的属性抖动循环。

18. **“当前浏览器已加载新代码”不能想当然**

- 2026-03-31 本轮再次确认：即使 `dist/src/content/wechat-content.js` 已包含新按钮和新逻辑，当前 Chrome for Testing 会话里的微信文章页仍可能继续跑旧 content script。
- 直接表现为：页面上仍只有旧版 `#bawei-v2-panel`，没有 `#bawei-v2-check-login`，而 `verify-wechat-ui.cjs` 会报 `未找到检查登录按钮`。
- 这类问题不能靠读源码判断已生效；必须把“扩展 reload + 微信文章页刷新后重新取样 DOM”纳入真实回归步骤。

19. **草稿与发布的正文填充链路必须共用**

- 2026-03-31 复核后确认：大多数渠道当前都是 `stageFillTitle -> stageFillContent` 之后，才在末尾分叉到 `saveDraft` 或 `submitPublish`；也就是正文写入链路本来就应被 draft / publish 共用。
- 因此凡是发生在 `stageFillContent` 的问题——例如段落粘连、图片缺失、原文链接落点错误——原则上都不应只修 `draft` 或只修 `publish`，否则另一条链路会继续带病。
- 真正允许分叉的阶段只应是：最终保存/发布按钮、发布前附加必填项、以及详情页/列表页验收。

20. **微信公众号 payload 的 `contentTokens` 颗粒度过粗，会把所有渠道一起带偏**

- 2026-03-31 新确认的共性根因：微信侧 `buildArticlePayload()` 之前用默认 `buildRichContentTokens()` 生成 `contentTokens`，没有开启 `htmlMode='raw' + splitBlocks=true`。
- 结果是：下游渠道即使复用了同一套 `contentTokens`，拿到的也只是粗粒度大段文本，天然更容易出现“段落被压成几大块”的问题。
- 修复原则：优先在微信源头把 `contentTokens` 拆成保留块级结构的 token，再让各渠道共享这一份结构化输入；不要每个渠道各自继续消费粗粒度 token。

## 观测依据

- `artifacts/live-publish/mcp-publish-progress.json`
- `artifacts/live-publish/mcp-login-audit.json`
- `artifacts/live-publish/network-*.ndjson`
- `artifacts/live-publish/debug-*.png`
- 真实站点页面 DOM / CDP 现场检查

## 当前阻塞结果定义

- 登录审计阶段：`not_logged_in`、`unknown + captcha-or-risk-page`
- 发布阶段：`not_logged_in`、`waiting_user`、`failed`、`timeout`、`stalled`
- 处理方式：仅对当前渠道立即标记失败，本轮不再自动重试

## 渠道归纳

### `mowen`

- 已验证失败/低收益路径：
  - 只派发 `ClipboardEvent(paste)` 或 `drop`，可能只触发上传链路，不会把图片真正落到 ProseMirror 文档。
  - 用 `innerHTML=''` 清空编辑器会破坏编辑器内部 state，后续图片容易替换已有内容。
  - 详情页只看首屏 DOM 会出现假阴性，SPA 未渲染完时可能暂时看不到原文链接。
- 稳定成功经验：
  - 标题单独作为第一行，正文与图片拆成两条链路处理。
  - 图片逐张插入，每张后等待 `8s~10s`，并在末尾补空段落，稳定下一张图片的落点。
  - 验收优先调用 `note/show` 接口，再从返回 HTML 中校验原文链接和图片数量。
  - 当前状态：
  - 历史页面动作曾完成；是否公开必须按匿名验收重新判定，不能依据本节旧记录跳过。

### `sspai`

- 已验证失败/低收益路径：
  - 登录审计直接访问 `/write` 容易误判登录状态，还会触发“本文编辑窗口已打开”的编辑锁。
  - 顶部“发布”不是最终发布动作；若未处理“选择发布通道”弹窗，`released_at` 会一直是 `0`。
  - 图片尚未完成回填就保存/跳转，会把空 `src` 落稿，回看时全部裂图。
  - 页面上同时存在多个 dialog，简单 `querySelector` 很容易命中错误弹窗。
- 稳定成功经验：
  - 登录审计改走 `/my`，发布阶段复用单一写作 tab，避免并发打开多个编辑页。
  - 发布链路改为 API 流程，绕开 `/write` 页面编辑锁与弹窗不稳定性。
  - 发布前补齐 `body_last`、标签、题图，并强制等待图片 `src` 全部回填完成。
- 当前状态：
  - 已通过插件一键完整发布，段落与图片均正常。

### `csdn`

- 已验证失败/低收益路径：
  - `background` 直连模式如果 fallback 到旧 job payload，会把错误文章发到 CSDN。
  - CKEditor 连续快速插图会覆盖已写入正文，最后只剩最后一张图和开头一句话。
  - 封面“图片编辑”弹窗是 `position: fixed` 遮罩，不能再用 `offsetParent !== null` 判可见；否则会误判弹窗不存在，自动化就不会点到 `确认上传`。
  - 底部提交按钮必须精确命中真实 `button` 文案 `发布博客`；如果只按“包含发布博客”去扫 `div/span`，很容易先命中祖先容器，点击后无任何提交动作，随后误报“请确认发布已完成”。
- 稳定成功经验：
  - `loadArticlePayloadFromBackground()` 只在 `articleUrl` 规范化匹配时复用 payload，不再 fallback 到历史 job。
  - 插图前先把光标折叠到末尾，插图后等待上传完成，再补一个空行继续写，避免覆盖已有内容。
  - 封面验收要以外层 `img.preview` 是否拿到真实远程图为准；即使裁剪弹窗 DOM 还挂在页面里，只要预览图已落地就应视为封面已应用。
  - 发布动作优先点底部真实 `button`，确认后允许 success/manage/detail 页自己的 content script 接管后续验收，不要在编辑页祖先容器上空点。
- 当前状态：
  - 已通过插件一键完整发布并验收通过。
  - 2026-08-17 同稿文章 `163823287` 的管理页已出现阅读、点赞、收藏和“浏览/推广”操作，但无 Cookie 详情页仍返回 HTTP 521 安全验证；当前保持 `pending_review` 并禁止重投。

### `tencent-cloud-dev`

- 已验证失败/低收益路径：
  - `mcp-publish-progress.json` 会保留历史 `success`；同一篇微信文章在代码修复后重跑，如果不重置状态或不显式强制重跑，脚本会直接短路成“全部成功”，实际上根本没重新发布。
  - “搜文章名称”组件会跳转到全站搜索页 `https://cloud.tencent.com/developer/search/article-`，不能用于创作者中心验收。
  - 列表页搜索无结果时，DOM 里仍可能残留隐藏历史文章链接；若 probe 不筛 visible，会一直命中旧文章。
  - 新版编辑器正文是 Monaco；content script 不能依赖 `window.monaco`，必须直接驱动 `textarea.inputarea`。
  - 标题框 `textarea.article-title` 不能用通用 `simulateType`；DOM `value` 虽然变化，但站点内部 state 不更新，结果仍会 toast “请输入文章标题”。
  - 腾讯云页面里“插入内联 `<script>` 再执行主世界代码”的路径不稳定；当前更稳的做法是直接对原生 `textarea/article-title`、`input.com-2-tag-input` 走 `execCommand('insertText') + input/change`，让站点内部 state 真正更新。
  - 标题阶段不能只等 `textarea.article-title` 出现；写作页会先拉取草稿列表并继续初始化，过早写标题会出现 `value=` 空、标题计数器未出现的假失败。
  - 文章标签输入框也不能只靠 `simulateType + Enter`；在腾讯云上这不会生成 tag chip，必须先用原生 setter 触发候选，再点击可见的 `li[data-id]`。
- 文章封面上传是异步链路；只给 file input 赋值后立即点“确认发布”不稳，必须等待侧栏出现 `修改文章封面` 或 `img.col-editor-upload-image`。
- “确认发布”按钮在标题、正文、标签、封面未满足时仍可能可点，必须捕获 toast 校验文案并自动补齐后重试。
- 博客园的新随笔可能在发布后约 1 分钟才出现在后台列表。列表验收需覆盖至少 2 分钟；超过窗口仍未出现时保留为 `pending_review` 并禁止重投，不能把已点击并被页面接收的投稿降为可重试技术失败。
  - 腾讯云存在正文最短字数限制；调试时应优先使用真实目标公众号文章内容，而不是短占位文本。
  - 用户账号下已存在目标文章相关草稿时，写作页初始化会比空白新稿更慢；必须先等草稿拉取与编辑器 DOM 稳定，再进入标题/正文写入。
  - `CreateArticleDraft` / `getDraftDetail` 成功，只能证明“草稿保存 + 图片转存成功”，不能当作真正“发布成功”。
  - 若“确认发布”阶段超时，流程必须停在当前页，不能继续跳文章管理页做验收；否则会把旧文章误判成新发布结果。
  - 在当前机器（`MacBookPro16,1` / Intel）上，把主 Chrome 磁盘 profile 直接复制给 `Chrome for Testing 145.0.7632.6` 使用，会导致浏览器启动后立刻 `SIGTRAP` 崩溃；这条路径对腾讯云已证伪。
  - 仅复制磁盘 profile 也无法稳定继承腾讯云登录态；即使不崩，仍可能直接落到 `https://cloud.tencent.com/login?...`。
  - 腾讯云富文本链路里，如果“图片上传完成”的判断又退回去看编辑器 DOM `img` 数量，极易误判成“富文本失败”，随后触发 Markdown fallback，最终把同一篇正文重复插入两遍。
  - `https://cloud.tencent.com/developer/article/2647310`：旧 Markdown/纯文本链路样本，正文压扁且图片丢失，不可再作为“成功格式”参考。
  - `https://cloud.tencent.com/developer/article/2647314`：腾讯云专用图片上传链路已恢复图片，但由于错误触发 fallback，正文仍出现段落粘连和重复内容，属于中间失败样本。
  - `https://cloud.tencent.com/developer/article/2647318`：移除“按 DOM `img` 数量判失败”前的样本，图片与块级拆分已有改善，但仍保留了错误 fallback 生成的重复正文，不能作为最终成功样本。
- 关键证据：
  - `artifacts/live-publish/debug-tencent-after-confirm-1774739267157.png`
  - `artifacts/live-publish/debug-tencent-live-modal.png`
  - `artifacts/live-publish/debug-tencent-tag-simulate-events.png`
  - `artifacts/live-publish/debug-tencent-title-simulate-events.png`
  - `artifacts/live-publish/debug-tencent-cover-upload.png`
- 稳定成功经验：
  - 发布链路继续使用“先等编辑器 ready，再用原生输入链路驱动标题/标签 + 等封面上传完成”的路径。
  - 验收继续使用“文章管理可见列表 probe + 详情页原文链接检测”，并且只有在真正完成发布确认后才进入验收。
  - 腾讯云不要复用“从主 Chrome 磁盘复制过来的测试 profile”；应改用**独立干净的 Chrome for Testing profile**。
  - 第一次跑腾讯云时，直接在这份独立测试 profile 里手动登录一次；登录完成后复用该 profile，插件发布流程可继续自动完成。
  - 富文本图片是否成功，以腾讯云自己的上传网络链路（`GenObjectKey` / `GetTmpSecret` / COS 上传 / `CreateArticle*`）为准，不再用编辑器里的 `img` 数量决定是否 fallback。
  - 同一篇文章要重跑时，使用 `LIVE_PUBLISH_FORCE_CHANNELS=tencent-cloud-dev`，或先清空对应进度；否则历史 `success` 会直接短路本轮执行。
  - 最新验证通过样本：`https://cloud.tencent.com/developer/article/2647319`。该样本确认正文不再重复、图片正常显示（9 张）、原文链接保留，且块级段落拆分明显优于 `2647314`。
- 当前状态：
  - 已恢复真实发布；后续重点维持“单次富文本成功后不误触 Markdown fallback”。
  - 2026-08-17 同稿 `2727509` 已被平台退回，原因为“内容包含广告/引流信息”。管理页退回解析现优先于详情页探测，状态记为 `rejected`，同内容禁止重投，不再打开 404 详情页误判公开成功。

### `cnblogs`

- 已验证失败/低收益路径：
  - 只改 TinyMCE iframe body、只改隐藏 `textarea`、或只调 `editor.save()` 中任何一层，都可能出现“编辑页里看到了原文链接，但发布详情页最终没有原文链接”。
  - 正文填充后如果不在“发布前”再做一次底层同步，博客园会用旧内容提交。
  - 草稿保存后页面会跳到 `https://i.cnblogs.com/posts/edit-done;postId=...;isPublished=false`；如果仍按 `/posts*` 统一当列表页处理，流程会卡在 `confirmSuccess`，草稿其实已成功但状态永远不收敛。
- 稳定成功经验：
  - 填充结束后与点击“发布”前，都强制同步三层状态：TinyMCE 实例、`#Editor_Edit_EditorBody`、`#Editor_Edit_EditorBody_ifr` 的 `body.innerHTML`。
  - 原文链接不要只依赖富文本 DOM 已可见，必须确保隐藏 `textarea` 里的最终 HTML 也包含该链接。
  - 对 `edit-done;...isPublished=false` 要单独识别为“草稿成功页”，直接上报 `success/done`，不要再走列表验收分支。
  - 若草稿成功信号已在当前编辑页内被识别到，`draft` 分支本身也必须立即上报最终 `success/done`；不能只停在“已检测到成功提示，准备验收”。
- 当前状态：
  - 2026-03-29 用用户真实 `Default` profile 克隆回归后，仍直接落到 `https://account.cnblogs.com/signin?...`；说明 `.cnblogs.com / i.cnblogs.com` cookie 记录存在，也不等于编辑页仍可用。
  - 2026-03-30 已补强发布前同步链路，并修复草稿成功页 `edit-done` 被误判成列表页的问题；当前 `cnblogs` 草稿流不再应卡在“已检测到成功提示，准备验收”。

### `oschina`

- 已验证失败/低收益路径：
  - `https://www.oschina.net/blog/write` 只是入口，不等于真正可写页；如果没有跳到 `my.oschina.net/.../blog/write`，流程会停留在入口页或首页。
  - 未登录时继续反复点“写博客”没有意义，只会把当前轮次拖成 `not_logged_in`。
  - 当前真实写作页已经不是旧的 CKEditor iframe；如果正文填充还硬编码去找 `iframe.cke_wysiwyg_frame`，会直接在 `fillContent` 失败。
  - 发布确认弹层里已经出现 `待审核 / 正在审核中 / 重新编辑`，不等于可以立刻切去列表页；如果这时还停留在 `/blog/write`，过早返回会把真正即将跳转的详情页截断。
  - 在 `/u/1/blog/<id>` 这类 synthetic 路径上，如果详情页验收前先做“空间迁移”并把 `/u/1` 改写成真实空间路径，会把当前详情页误跳到 `osadmin` 个人页，导致验收跑偏。
  - 草稿按钮若在 `div/span` 上模糊匹配“草稿”，可能点中整个操作栏；若成功验收又只检查静态“草稿”二字，会在没有任何保存请求时误报成功。
- 稳定成功经验：
  - 不能只看 `https://www.oschina.net/` 首页 DOM 判登录；该页即使看起来像匿名首页，当前会话仍可能已经具备写作权限。
  - 当前统一入口为 `https://my.oschina.net/blog/ai-write`；历史 `/u/<占位>/blog/write` 只作为旧页面兼容证据，不再作为默认入口。
  - 内容脚本不要先在 `www.oschina.net` 首页做未登录拦截；应优先尝试跳到真实写作页，再在落地页判断是否仍需登录。
  - 当前正文编辑器要按 `tiptap/ProseMirror` 处理；应优先复用通用 token 填充链路写入 `.tiptap.ProseMirror.aie-content`，不要再假设存在 iframe。
  - Tiptap 主世界命令优先通过 `src/assets/oschina-page-bridge.js` 外部资源安装受控页面桥接，只允许清空、插入 HTML、聚焦结尾、上传图片四种操作；不要依赖页面允许内联脚本。后台 `chrome.scripting.executeScript` 仅作为外部桥接不可用时的后备路径，并要求 manifest 在 `host_permissions` 中显式包含 `https://my.oschina.net/*`。
  - 合成粘贴可能只把图片短暂写进 ProseMirror DOM，后续正文事务会按编辑器状态重绘并移除它；应把扩展读取到的 `File` 交给编辑器官方 `commands.uploadImage(file)`，并在投稿前重新核对平台托管图片数量。
  - 发布后要优先等待 URL 真正进入 `/blog/<id>` 详情页，再开始验收；不能仅凭弹层成功文案就提前回退到列表页。
  - 详情页验收顺序要先检查原文链接，再决定是否做空间迁移或列表兜底；否则 synthetic 写作入口会把已成功的详情页误改到错误个人空间。
  - 真实验收应优先复用“用户当前已登录的浏览器会话”，不要仅依赖复制后的磁盘 profile。
  - 保存草稿只能在可见的 `button/a/[role=button]` 上精确匹配保存动作，且最终只接受“草稿已保存 / 自动保存成功 / 保存成功 / 已保存”等完成信号，不能接受按钮自身的静态文案。
- 当前状态：
  - 2026-03-29 在用户当前 `Google Chrome` 标签页中，实际页面是 `https://www.oschina.net/`，顶部可见 `登录` / `注册`，当前会话并未处于可写作状态。
  - 2026-03-30 使用专用发布 profile `~/.bawei-live-profile` 真实取证后发现：`https://www.oschina.net/blog/write` 会回首页，但直接打开 `https://my.oschina.net/u/1/blog/write` 可稳定进入编辑器，且 `u/1` / `u/999999999` / `u/not-real-user` 都能落到当前账号的写作页。
  - 同日进一步取证确认：手动点发布后页面会进入详情页并显示 `待审核`、`正在审核中，请耐心等待` 与原文链接；此前失败点不是“未发布成功”，而是 **发布后过早回退列表 + 详情页先做空间迁移** 两个验收时序问题。
  - 因此根因不是“账号未登录”，而是 **把 `www.oschina.net/blog/write` 当成唯一可用入口**，以及 **详情页验收时序错误**；现已改成固定直达 `my.oschina.net/blog/ai-write`，并让内容脚本在详情页优先验原文链接、只在必要时再回列表兜底。
  - 2026-08-17 同稿已匿名公开并通过三图验收：`https://my.oschina.net/u/4581386/blog/19741241`。

### `woshipm`

- 已验证失败/低收益路径：
  - 正文图片上传会长时间卡在 `1/9 ~ 4/9`，没有明确失败信号，整条发布链路因此被拖死。
  - 在该站点上等待图片链路完成的收益明显低于直接完成“无图正文 + 原文链接”的闭环。
  - 站点掉回首页时，如果只看到 `注册 | 登录` / `立即登录` 仍继续跳 `我的文章`，会把“登录已失效”伪装成“列表识别失败”。
  - 发布链路最后的三个协议项虽然是 `input[type="checkbox"]`，但真实可点击的是各自 `label.demo--label` / `.demo--radioInput.demo--checkbox`；直接点隐藏 input 或误点外层大容器，都可能看起来“已执行勾选逻辑”但实际仍未勾选，导致 `提交审核` 无效。
- 稳定成功经验：
  - 当前优先走**无图正文**策略：过滤正文图片 token，只写标题、正文文本和原文链接，先保证一键提交成功。
  - 若站点后续确实要求图片，再由面板提示用户手动补图，而不是让自动化一直卡在上传阶段。
  - 首页若出现 `注册 | 登录`、`立即登录`、`点我注册` 等文案，应直接判 `not_logged_in`，不要继续首页 -> 我的文章循环。
  - 提交审核前要先滚到表单底部，按 `name=copyright / copyright_other / copyright_pm` 精确找到三个 checkbox，再点击各自 label 内部的可视化 checkbox span 或 label 本身，并在点击后逐项确认 `input.checked === true`。
- 当前状态：
  - 2026-03-29 在用户当前 `Google Chrome` 标签页中，实际页面是 `https://www.woshipm.com/`，头部可见 `发布`、`注册 | 登录`、`立即登录`，当前会话并未登录。
  - 已补内容脚本首页未登录早判，并同步修正 CDP/Playwright 审计；克隆回归现在会在首页直接拦成 `not_logged_in`。
  - 2026-08-17 同稿明确被退回“作品与平台定位不符”，已记为 `rejected`，同内容禁止再次投稿。

### `baijiahao`

- 已验证失败/低收益路径：
  - 标题控件选择器漂移后，原逻辑会一直等 `contenteditable`/`textarea` 命中，导致渠道长时间停在 `fillTitle`，最终被脚本按“无进度超时”判失败。
  - 把微信公众号富文本原样走 paste 事件写进百家号，会把 `data-pm-slice / leaf / nodeleaf / textstyle` 等编辑器元数据一起带进去，正文里出现前导 `}`，随后在点击发布时触发站点侧 jQuery `Syntax error, unrecognized expression`。
  - 只看“字数正常 / 已保存 / 发布按钮可点”不够；如果编辑器 DOM 里已经出现 `}` 文本节点、顶层裸 `span`、或图片数少于源文，后面的发布校验大概率仍会失败。
- 稳定成功经验：
  - 标题识别要优先匹配带 `placeholder / aria-label / data-placeholder / class / id` 标题语义的 `input / textarea / contenteditable`，不能只靠通用可编辑节点。
  - 在等待标题区或安全验证解除期间，要持续回写 `fillTitle` 进度心跳，避免被外层脚本误判为卡死。
  - 百家号正文要先做定向清洗：剥掉微信编辑器元数据属性和空白占位块，再走 `insertHTML` 路径写入，避免 paste 路径把脏标记转成可见字符。
  - 写入后还要再扫一遍编辑器 DOM，移除孤立的 `}` 文本节点，并把顶层裸 `span / a / strong` 等 inline 片段重新包成段落，防止段落粘连。
  - 正文图片不能再被过滤；验收时要同时核对编辑器内图片数与最终详情页图片是否一致。
  - 当前更稳的正文链路是直接走页面主世界暴露的 `editor.setContent()` / `editor.sync()`；不要从 content script 直接改 iframe DOM，更不要再走会把富文本元数据污染进编辑器的 paste-html 路径。
- 当前状态：
  - 2026-03-29 用用户真实 `Default` profile 克隆回归后，仍落到 `https://baijiahao.baidu.com/builder/theme/bjh/login`；说明 `.baidu.com` cookie 存在，也不等于百家号创作后台仍在线。
  - 2026-03-30 已确认“发布时报 jQuery selector 语法错误”的直接根因是正文 HTML 中混入了前导 `}`；这和微信富文本元数据 + paste 路径共同作用有关。
  - 2026-03-30 已改为走页面主世界 `editor.setContent()` + `editor.execCommand('inserthtml', 原文链接)` + `editor.sync()`，并用预览页 `https://baijiahao.baidu.com/builder/preview/s?id=1861050625531017101` 取证通过：标题存在、原文链接存在、图片存在，且 `}` 污染消失。
  - 2026-08-17 同稿发布接口返回 `errno=10000017` 并要求绑定手机号验证；标题、正文、三图和封面均保留，状态为 `waiting_user`，自动化不会点击验证入口或再次提交。

### `toutiao`

- 已验证失败/低收益路径：
  - 头条号若落在登录页/异常页，旧逻辑会直接反复执行“返回编辑器”，状态看起来始终卡在 `openEntry`，但实际上从未真正进入登录检测。
  - 编辑页/List 页之间存在同域导航，若只改 `location.href` 而不重新触发 bootstrap，内容脚本可能停在旧状态。
  - 本期规格不要求自动上传正文图片，继续走图片链路会放大不确定性。
- 稳定成功经验：
  - 对所有非编辑页先做 `detectLogin`，确认不是登录页后再返回编辑器，避免 `openEntry` 假卡死。
  - 同域导航后主动重新触发 bootstrap，保证编辑页 -> 列表页的流程能继续跑下去。
  - 按规格降级为**无图正文**。
- 当前状态：
  - 2026-03-29 用用户真实 `Default` profile 克隆回归后，仍落到 `https://mp.toutiao.com/auth/page/login?...`。
  - 已补登录页判定与同域导航重入。2026-08-17 同稿 `pgc_id=7674937095891075636` 已转为“已发布”，公开页通过无 Cookie 标题、两段正文和三张头条托管图片验收；懒加载验收会等待 `/item/` 到 `/article/` 的客户端路由稳定，并从 `data-src` 读取真实图片地址。

### `feishu-docs`

- 已验证失败/低收益路径：
  - 飞书云盘目录 -> `docx` -> 目录是典型同域 SPA/半 SPA 路由；只做 `location.href` 跳转时，内容脚本可能停在 `openEntry`，后续写入逻辑根本没接上。
  - 用 API 创建空白文档时，如果请求长时间无响应，外层脚本也会把它看成“无进度超时”。
  - 旧规格曾按无图正文降级，但该路径无法满足当前营销图文发布和匿名验收要求。
  - 飞书 docx 页面里 `.zone-container.text-editor` 不止一个：标题区自身也包着一个 `text-editor`。如果正文选择器命中过标题区，再走 `fillEditorByTokens`，整篇正文会被写进标题，表现为“标题变成长正文，正文区仍为空”。
  - 2026-03-31 这类回归就是由“统一 token 生成”改动引入的：飞书从原来的 `text + 无图` 路径切到了 `raw/html + 图片` 路径，同时正文 root 选择器仍是通用 `.zone-container.text-editor`，于是正文被打进标题区。
- 稳定成功经验：
  - 创建文档 API 要加超时；API 成功或同域路由切换后，都要主动重新触发 bootstrap。
  - 目录页回写、文档页写入、再回目录页验收，三段都要按“可能是同文档路由切换”处理。
  - 正文 root 要优先命中 `.page-block-children .block.docx-text-block .zone-container.text-editor[contenteditable="true"]`，至少也要排除位于 `h1` / `.page-block-header` 内的 `text-editor`。
  - 当前恢复链路使用可信富文本剪贴板与真实 `Meta+V`，通过虚拟滚动聚合验收标题、全文块和全部平台托管图片；标题仍必须与正文区分开处理。
  - 只有正式发布才开启“互联网获得链接的人可阅读”并做无 Cookie 验收；保存草稿只验云端保存，不能改变分享权限。
- 当前状态：
  - 2026-03-29 用用户真实 `Default` profile 克隆回归后，仍落到 `https://accounts.feishu.cn/.../login`；说明 `.feishu.cn` cookie 存在，也不等于云文档目录仍可直接进入。
  - 已补 API 超时、同域导航重入、正文 root 精确选择、可信剪贴板恢复和虚拟全文验收。
  - 2026-08-17 同稿已匿名公开且标题、正文与三图验收通过：`https://wuxinxuexi.feishu.cn/docx/L8pMd4xN9oEnDCxn8yKcFPBnnmT`。
