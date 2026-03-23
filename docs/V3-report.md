# V3：汇报材料（口头汇报用）

> 结论：V3 已按验收口径完成，进入可发布状态。

## 1. 本次目标
- V3：支持图片自动上传 + 一键正式发布 + 自动检测登录状态

## 2. 需求完成情况（逐条）
### 2.1 图片自动上传
- 状态：✅ 已完成
- 已实现效果：
  - 微信正文解析为富内容 `tokens`（`html`/`image` 分段），保证“文字-图片-文字”顺序不乱
  - 后台在本机浏览器内下载微信 CDN 图片二进制；各渠道编辑器侧通过“粘贴/拖拽/文件 input”触发平台原生上传
  - 面板实时展示图片上传进度（`正在上传图片（x/y）`）；上传失败进入 `waiting_user` 并提示手动处理后继续
- 覆盖渠道：
  - CSDN / 腾讯云开发者社区 / 博博客园 / OSCHINA / 人人都是产品经理 / 墨问 / 少数派 / 百家号 / 头条号 / 飞书文档
- 已知限制/风险：
  - 仅允许下载 `*.qpic.cn` / `*.qlogo.cn` 图片，且单张上限 10MB（超限会明确报错）
  - 少数平台可能拦截粘贴/拖拽（风控/权限/编辑器限制），此时会提示手动上传后继续

### 2.2 一键正式发布（同时支持草稿/发布）
- 状态：✅ 已完成
- 已实现效果：
  - 面板支持一键 `draft`（保存草稿）与 `publish`（直接发布）
  - `publish` 动作会自动点击至“发布完成”（除登录/实名/验证码/必填项/风控等客观阻塞）
  - 渠道状态 badge 支持点击跳转：优先聚焦已有 Tab；Tab 关闭则自动重开入口页
- 已知限制/风险：
  - 平台强制的二次确认/实名/验证码等会进入 `waiting_user`，需用户按提示处理后点“继续/重试”

### 2.3 自动检测登录状态
- 状态：✅ 已完成
- 已实现效果：
  - 后台监听渠道 Tab 的 URL 变化，命中登录/鉴权 URL 特征则立刻标记 `not_logged_in`
  - 各渠道内容脚本提供 `stageDetectLogin()` DOM 兜底检测（登录 URL + 密码框 + 登录文案）
  - 面板显示“未登录”，并提供“重试”；点击状态可跳转/重开对应渠道页
- 已知限制/风险：
  - 部分渠道统一认证/SSO 场景需要用户完成登录后再点“重试”

## 3. 测试情况
- 单元测试：✅ 新增 `npm run test:v3:unit`（tokens 拆分 + 图片插入桥接），已通过
- E2E：✅ 新增 `npm run e2e:v3`（Playwright 离线 mock，全渠道覆盖 not_logged_in/draft/publish + badge 跳转 Tab + 图片上传断言），已通过
- 质量检查：✅ `npm run type-check` / `npm run lint` / `npm run build` 已通过
- 人工回归：按 `docs/V3-test-cases.md` 执行（需在你的账号环境做最终回归）

## 4. 代码改动范围（目录/文件）
- `src/shared/`：
  - `src/shared/rich-content.ts`（微信 HTML -> tokens）
  - `src/shared/image-bridge.ts`（后台取图 + 编辑器插图/填充）
  - `src/shared/events.ts`（补齐 files paste/drop/input 事件模拟）
  - `src/shared/v2-types.ts` / `src/shared/v2-protocol.ts`（新增 `not_logged_in`、`V2_FOCUS_CHANNEL_TAB`、`V3_FETCH_IMAGE`）
- `src/background.ts`：
  - 频道 Tab 跳转/重开
  - 图片下载与缓存（白名单域名 + 10MB 上限）
  - 自动登录检测（URL 特征）
  - Tab 关闭状态更新优化（避免误伤已成功渠道）
- `src/content/`：
  - `src/content/wechat-content.ts`：生成 tokens、状态 badge 点击跳转
  - `src/content/*-publisher.ts`：10 个渠道接入 tokens + 图片上传 + 登录检测
- `manifest.json`：增加 `qpic.cn/qlogo.cn` `host_permissions`
- `_locales/`：新增/更新 V3 文案（未登录/上传进度/手动处理建议）
- `scripts/`：新增 `scripts/v3-unit.mjs` + `test:v3:unit`
- `docs/`：新增 `V3-1/2/3`、测试用例、汇报材料；更新 `docs/V3.md`
