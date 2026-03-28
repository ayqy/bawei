# V3：测试用例（单元 + E2E + 人工回归）

## 1. 单元测试（必须）
> 运行：`npm run test:v3:unit`

### 1.1 富内容分段（tokens）
- 输入：包含 `data-src`/`src` 的微信正文 HTML
- 断言：
  - `data-src` 优先于 `src`
  - tokens 顺序与原文一致（html/image/html）
  - html token 内不包含 `<img`
  - 末尾存在“原文链接”对应 token

### 1.2 图片下载（后台 fetch）
- 输入：允许域名（如 `mmbiz.qpic.cn`）图片 URL
- 断言：
  - 返回 `mimeType` 与 `ArrayBuffer` 非空
  - `content-type` 必须为 `image/*`（拒绝 HTML/JSON 误判为图片）
  - 超过大小上限/非白名单域名时返回明确错误

## 2. E2E（Playwright，可重复跑）
> 运行：`npm run e2e:v3`（离线 mock：10/10 渠道覆盖 `not_logged_in` / `draft` / `publish`，无需真实站点登录态）

### 2.1 面板基础链路
- 在微信文章页：
  - 打开面板
  - 选择动作（草稿/发布）
  - 勾选 1~N 个渠道
  - 点击开始
- 断言：
  - 后台成功创建 job
  - 渠道 Tab 被打开
  - 面板状态从“未开始”进入“进行中”

### 2.2 状态点击跳转 Tab
- 对任一渠道：
  - 点击状态 badge
- 断言：
  - 浏览器聚焦到对应渠道 Tab（URL/标题变化可验证）
  - 若 Tab 被关闭后再点 badge：可重新打开创作页

### 2.3 未登录检测
- 断言：
  - 面板显示该渠道 `未登录`
  - 点击状态可跳转到登录页/创作页
  - 登录完成后点“重试/继续”可推进流程

### 2.4 图片上传（最小断言）
- 输入：微信文章“至少包含 1 张图片”
- 断言（E2E 脚本对所有渠道都做）：
  - 编辑器区域内 `img` 数量相较写入前增加
  - 面板诊断出现“上传图片（x/y）”进度文案
  - 至少触发 1 次 `resourceType=fetch` 的 `*.qpic.cn/*.qlogo.cn` 图片下载请求（等价于 `V3_FETCH_IMAGE` 全链路跑通）
  - `read.useai.online/api/image-proxy` 回退请求计数应为 0（直连成功路径）

## 3. 人工回归清单（发布前必须）
- 任意含图文章：10 个渠道全选并发跑一遍
- 任意无图文章：10 个渠道全选并发跑一遍
- 关闭任一渠道 Tab：面板能提示并允许点击状态重开
- publish 动作下：每个渠道不需要额外确认即可触发发布（除登录/实名/验证码/必填项等客观限制）

## 4. 真实发布长跑脚本（CDP）
> 推荐两步运行（复用同一浏览器，便于先登录/过验证码）：
> 1) `npm run live:open`
> 2) `npm run live:publish -- <微信文章URL>`
>
> 兼容旧用法（单次发布）：`npm run publish:live -- <微信文章URL>`

- 断言：
  - 首轮登录审计会写入 `tmp/mcp-login-audit.json`（明确标记未登录渠道）
  - 发布进度持续写入 `tmp/mcp-publish-progress.json`（`success` 渠道不会重复发）
  - 脚本重启后读取同一 profile 目录，已登录渠道状态应保持，不应整批掉线
