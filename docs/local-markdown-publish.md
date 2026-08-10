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
```

- `title` 可省略；省略时优先使用正文第一个一级标题，再退回文件名。
- `source_url` 可省略；省略时会使用只在本次命令运行期间有效的本地链接。正式发布建议填写可长期访问的 `http/https` 原文地址。
- 图片可写 `http/https` URL，也可写相对于 Markdown 文件的本地路径。本地图片支持 PNG、JPEG、GIF、WebP、AVIF，单张不超过 10 MB。

## 一键执行

首次使用时，先打开专用浏览器并登录各渠道：

```bash
CHROME_PROFILE_DIR="$HOME/.bawei-live-profile" BOOTSTRAP_PROFILE=0 npm run live:open
```

登录完成后，一条命令构建扩展并串行发布到全部 10 个渠道：

```bash
CHROME_PROFILE_DIR="$HOME/.bawei-live-profile" BOOTSTRAP_PROFILE=0 npm run publish:markdown -- /绝对或相对路径/article.md
```

命令默认执行正式发布。只有 10 个渠道都返回成功时才以成功状态退出；任一渠道失败、未登录或需要人工处理时，命令会列出失败渠道并以非零状态退出，浏览器默认保留，便于检查现场。

可用环境变量：

- 只发部分渠道：`LIVE_PUBLISH_CHANNELS=csdn,cnblogs`
- 改为保存草稿：`LIVE_PUBLISH_ACTION=draft`
- 强制重跑已成功渠道：`LIVE_PUBLISH_FORCE_CHANNELS=csdn,cnblogs`
- 关闭后退出浏览器：`KEEP_BROWSER_OPEN=0`
