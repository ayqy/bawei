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

## 一键执行

首次使用时，先打开专用浏览器并登录各渠道：

```bash
CHROME_PROFILE_DIR="$HOME/.bawei-live-profile" BOOTSTRAP_PROFILE=0 npm run live:open
```

登录完成后，一条命令构建扩展并串行发布到全部 10 个渠道：

```bash
CHROME_PROFILE_DIR="$HOME/.bawei-live-profile" BOOTSTRAP_PROFILE=0 npm run publish:markdown -- /绝对或相对路径/article.md
```

命令默认执行正式发布，并复用当前已登录浏览器。只有全部渠道都已匿名公开或因同内容已经匿名公开而防重跳过时才以成功状态退出；待审、退回、失败或未登录都会以非零状态退出，浏览器默认保留，便于检查现场。

正式发布会输出七类结果：

- `success`：无 Cookie 匿名访问详情页成功，标题、正文锚点和预期平台托管图片通过验收。
- `pending_review`：平台已接收投稿，但尚无匿名公开证据。
- `rejected`：平台明确退回，并保存审核状态或原因。
- `waiting_user`：平台要求手机号、验证码等只能由账号本人完成的安全验证；已填写稿件会保留，台账冻结该内容并禁止自动重投。
- `failed`：编辑、上传、提交或验收发生技术失败。
- `not_logged_in`：当前专用浏览器中的渠道登录已失效。
- `skipped_duplicate`：同渠道、同内容哈希已有匿名公开记录，本轮没有再次投稿；命令摘要会单独列出。

发布台账位于 `artifacts/live-publish/publication-ledger.json`。同一渠道的同内容哈希处于 `success`、`pending_review`、`rejected` 或 `waiting_user` 时都禁止重复投稿：成功直接跳过，待审只复核候选公开页，退回保留原因，待人工验证保留现场并等待账号本人处理。只有明确的技术失败允许重试。台账和匿名验收证据均属于本机运行产物，不提交到 Git。

可用环境变量：

- 只发部分渠道：`LIVE_PUBLISH_CHANNELS=csdn,cnblogs`
- 改为保存草稿：`LIVE_PUBLISH_ACTION=draft`
- 重置旧进度文件中的指定渠道：`LIVE_PUBLISH_FORCE_CHANNELS=csdn,cnblogs`（不会绕过正式发布台账）
- 关闭后退出浏览器：`KEEP_BROWSER_OPEN=0`

真实回归必须显式保持当前现场：`LIVE_PUBLISH_REQUIRE_EXISTING_CHROME=1`、`BOOTSTRAP_PROFILE=0`，并使用同一个 `CHROME_PROFILE_DIR`。不要在登录完成后再次执行会重启浏览器的 `live:open`。

`publish:markdown` 会先完成构建，再在这个现有浏览器中禁用/启用一次 unpacked bawei 扩展以加载最新 `dist`；该过程不会重启浏览器、替换 Profile 或清除渠道登录态。对本轮仍需提交且已经打开的渠道页，脚本随后会原址刷新一次，让刚构建的 content script 真正注入；已公开、待审或退回而被防重跳过的渠道不会刷新。若无法在当前浏览器中定位并重新启用 bawei，任务会直接失败，不会回退到新浏览器。
