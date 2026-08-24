# 本地 Markdown 一键发布到 10 个渠道

bawei 可以把一篇本地 Markdown 依次发布到默认的 10 个渠道。执行时始终只聚焦一个渠道；该渠道完成一次尝试后，才会切换到下一个渠道。

## Markdown 格式

推荐在文件顶部声明标题和公开原文链接：

```markdown
---
title: 文章标题
source_url: https://example.com/posts/article
---

这里是正文。

![配图](./images/cover.png)

<!-- bawei:variant woshipm -->

# 面向产品经理读者的文章标题

## 用户问题

说明真实问题场景。

## 产品决策与取舍

说明为什么这样设计、没有选择什么。

## 适用边界

说明适合谁、不适合谁。

## 可复用洞察

总结可迁移的方法。

<!-- /bawei:variant -->
```

- `title` 可省略；省略时优先使用正文第一个一级标题，再退回文件名。
- `source_url` 可省略；省略时正文不追加原文链接，也绝不会写入 `127.0.0.1`、`localhost` 或其他临时地址。需要保留出处时请填写可长期访问的 `http/https` 地址。
- 图片可写 `http/https` URL，也可写相对于 Markdown 文件的本地路径。本地图片支持 PNG、JPEG、GIF、WebP、AVIF，单张不超过 10 MB。
- `bawei:variant <channel>` 是渠道专用正文，不会出现在其他渠道。正式发布到人人都是产品经理（`woshipm`）时该变体必填，并必须覆盖“用户问题、产品决策、取舍、适用边界、可复用洞察”；保存草稿不强制。

少数派渠道会先由扩展读取本地图片，再通过平台官方令牌直传其图片存储，最后把完整图文一次性写回草稿。技术失败后的重试会优先复用同标题、尚未发布的最新草稿，避免产生重复稿件，也避免逐图写入清空先前正文。

飞书渠道在多个 docx 同时打开时按完整标题选择目标文档；若标题已损坏，则用正文锚点或 `source_url` 找回同一文档。恢复写入后会等待云端保存并刷新该 docx，再验收标题、正文和全部图片。OSCHINA 发布后通过账号动态接口按完整标题精确解析文章 `objId`，随后进入详情页验收；页面列表搜索仅作接口异常时的兜底。两条链路都不会把 `blob:`、`data:`、localhost 等临时图片当成平台已托管。

## 一键执行

先查看十渠道中立认证状态（输出不含秘密）：

```bash
npm run auth:status
```

一条命令构建扩展并串行发布到全部 10 个渠道；脚本默认自行启动轻量运行时，依次尝试
官方适配器、加密最小状态和 Keychain 一次有界恢复：

```bash
npm run publish:markdown -- /绝对或相对路径/article.md
```

命令默认执行正式发布。只有全部渠道都已匿名公开或因同内容已经匿名公开而防重跳过时才以成功状态退出；待审、退回、失败、未登录或人工强验证阻塞都会以非零状态退出。非交互任务默认关闭运行时并快速失败；交互终端默认保留本轮现场。

正式发布会输出七类结果：

- `success`：无 Cookie 匿名访问详情页成功，标题、正文锚点和预期平台托管图片通过验收。
- `pending_review`：平台已接收投稿，但尚无匿名公开证据。
- `rejected`：平台明确退回，并保存审核状态或原因。
- `waiting_user`：平台要求手机号、验证码等只能由账号本人完成的安全验证；已填写稿件会保留，台账冻结该内容并禁止自动重投。
- `failed`：编辑、上传、提交或验收发生技术失败。
- `not_logged_in`：官方/轻量/Keychain 路由均未取得可用登录态，或真实编辑页审计失败。
- `skipped_duplicate`：同渠道、同内容哈希已有匿名公开记录，本轮没有再次投稿；命令摘要会单独列出。

发布台账位于 `artifacts/live-publish/publication-ledger.json`。同一渠道的同内容哈希处于 `success`、`pending_review`、`rejected` 或 `waiting_user` 时都禁止重复投稿：成功直接跳过，待审只复核候选公开页，退回保留原因，待人工验证保留现场并等待账号本人处理。只有明确的技术失败允许重试。台账和匿名验收证据均属于本机运行产物，不提交到 Git。

可用环境变量：

- 只发部分渠道：`LIVE_PUBLISH_CHANNELS=csdn,cnblogs`
- 改为保存草稿：`LIVE_PUBLISH_ACTION=draft`
- 重置旧进度文件中的指定渠道：`LIVE_PUBLISH_FORCE_CHANNELS=csdn,cnblogs`（不会绕过正式发布台账）
- 人工安全验证完成后恢复原稿：`LIVE_PUBLISH_RESUME_WAITING_USER_CHANNELS=baijiahao`。只允许指定渠道的同内容 `waiting_user` 记录重新进入发布队列；不会绕过 `success`、`pending_review` 或 `rejected` 防重。必须先在保留的渠道页面完成平台官方验证，再运行此开关；不要用它重发验证码。
- 关闭后退出浏览器：`KEEP_BROWSER_OPEN=0`

需要扫码、短信、验证码、2FA 或风控确认时，运行 `npm run live:open` 打开本轮页面；人工完成后，用 `LIVE_PUBLISH_REQUIRE_EXISTING_CHROME=1` 复用同一 CDP 现场继续回归。`BOOTSTRAP_PROFILE=1` 已被永久禁用，不能用重型 profile 复制绕过中立认证契约。

若 Chrome 自身的 `chrome://extensions` 管理接口在一次失败的 unpacked reload 后持续阻塞，但扩展已由同一浏览器原地重新启用、`dist` 已成功构建且构建版本已核对，可在该次有界恢复中同时设置 `LIVE_PUBLISH_SKIP_BUILD=1 LIVE_PUBLISH_SKIP_EXTENSION_REFRESH=1`。这样不会再次短暂删除正在加载的 unpacked 目录；脚本仍会刷新目标渠道页、重建 background bridge 并校验运行版本。这两个开关不得用于切换 Profile、复用未验证构建或绕过版本不一致。

当显式复用现有浏览器时，`publish:markdown` 会先完成构建，再在该运行时中禁用/启用一次 unpacked bawei 扩展以加载最新 `dist`；该过程不会重启浏览器。对本轮仍需提交且已经打开的渠道页，脚本随后会原址刷新一次，让刚构建的 content script 真正注入；已公开、待审或退回而被防重跳过的渠道不会刷新。若无法定位并重新启用 bawei，任务会直接失败，不会偷偷切换运行时。
