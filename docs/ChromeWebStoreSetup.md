# Chrome Web Store 发布配置

本项目使用 Chrome Web Store API v2 上传扩展包并提交审核。上传、审核中、审核通过和公开上线是四个不同状态；脚本只有在版本化状态回读后才报告对应终态。

当前发布目标：

- Publisher ID：由本机或部署环境的 `CWS_PUBLISHER_ID` 提供，仓库不绑定账号专属默认值
- 扩展 ID：由 `CWS_EXTENSION_ID` 提供
- 正常发布方式：审核通过后自动公开
- API v2 请求固定为 `publishType: DEFAULT_PUBLISH`、`skipReview: false`、`blockOnWarnings: true`

## 凭据

本机优先从中立 `cws.oauth2` AES-256-GCM 状态读取 OAuth；Bawei 不 import 或定位其获取项目。根目录 `.env` 只保存扩展 ID、可选 Publisher ID 和代理，权限必须是 `0600`：

```bash
CWS_EXTENSION_ID=abcdefghijklmnopabcdefghijklmnop
CWS_PUBLISHER_ID=00000000-0000-4000-8000-000000000000
```

既有本机 `.env` 的三个 OAuth 值应由独立 `channel-auth` 获取端先调用官方 token 端点和 `fetchStatus` 校验扩展身份，成功后加密迁移并原子清空源秘密。Publisher ID 和扩展 ID 是必需的目标配置但不是认证凭据。GitHub Actions 等没有 macOS Keychain 的受控环境仍可通过仓库/环境 Secret 注入 `CWS_CLIENT_ID`、`CWS_CLIENT_SECRET`、`CWS_REFRESH_TOKEN`；这是官方 OAuth 的 CI 传输方式，不允许写入仓库文件。

网络边界只允许 CWS 和 X 使用代理。此脚本是 CWS 专用进程，必须从 `CWS_PROXY`（优先）或兼容代理环境取得代理；Bawei 十个内容渠道的浏览器运行时全部显式直连。不要把 CWS 代理变量注入通用内容发布浏览器；X 的代理由独立 COO 项目单独维护。

密文中的 access token 到期但 refresh token 仍有效时，CWS 适配器会先调用官方 token 端点刷新，再执行目标扩展身份回读；不会降级读取已清空的本机 OAuth 明文。

OAuth 客户端必须启用 Chrome Web Store API，并授权 `https://www.googleapis.com/auth/chromewebstore`。如 OAuth 应用仍处于 Testing，refresh token 可能按 Google 当前策略较快失效；以 Google Cloud Console 的实时状态和官方说明为准。

官方文档：

- <https://developer.chrome.com/docs/webstore/using-api>
- <https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/upload>
- <https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish>
- <https://developer.chrome.com/docs/webstore/publish/>

## 只读状态

```bash
npm run publish:cws -- --status --evidence-dir release/cws/<version>/evidence/status
```

状态命令不会构建、上传或提交。输出同时区分 submitted revision 与 published revision，并要求目标版本出现在对应 distribution channel 中。

## 本地预检

```bash
npm run publish:cws -- --dry-run --evidence-dir release/cws/<version>/evidence/dry-run
```

Dry run 会：

1. 校验 `manifest.json`、`package.json` 与 `dist/manifest.json` 版本一致。
2. 重新执行生产构建。
3. 从新的 `dist/` 生成 `plugin-<version>.zip`。
4. 记录 ZIP SHA-256、凭据是否齐全以及固定的 API v2 提交参数。
5. 不执行任何远端变更。

## 正式提交审核

正式提交只能在代码已测试、commit、push，且本地 HEAD 等于远端默认分支并保持干净之后执行。项目发布清单通过预检后，由发布阶段注入精确身份：

```bash
PUB_RELEASE_PHASE=submit \
PUB_RELEASE_IDENTITY=bawei:<version> \
npm run publish:cws -- --evidence-dir release/cws/<version>/evidence/submit
```

脚本会重新构建 ZIP，先读取当前版本化状态，再上传并调用 API v2 `publish`。如果同一版本已经在审核中或已公开，则只写幂等证据，不重复上传。若另一个版本正在审核，脚本会拒绝覆盖。

提交成功仅表示目标版本进入 `PENDING_REVIEW`/`SUBMITTED`，不表示已经公开。审核通过后仍需持续用 `--status` 回读，直到 `publishedItemRevisionStatus` 明确包含目标版本，再从公开商店下载实际 CRX 做版本和运行验收。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `invalid_grant` | 检查 refresh token 是否被撤销、OAuth 应用状态和授权账号，不要在日志中输出 token。 |
| 上传成功但提交失败 | 保留上传证据；只读检查商店后台的 Store Listing、Privacy、Test instructions 和 Distribution，不要盲目重复上传。 |
| 线上仍是旧版本 | 分别核对 submitted 与 published 的版本号；审核中不能宣称上线。 |
| 提示其他版本正在审核 | 保留当前状态，不自动取消或覆盖；先确认目标版本和操作范围。 |
