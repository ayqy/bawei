### **技术规格文档 (Technical Specification Document) - bawei 浏览器插件**

| **文档版本** | **V3.0** | **状态** | **已确认** |
| :--- | :--- | :--- | :--- |
| **创建日期** | 2024-12-01 | **技术负责人** | bawei 团队 |
| **对应PRD** | V3.0 | **项目代号** | Project "bawei" |

---

### **1. 概述 (Overview)**

本文档描述了 bawei 浏览器插件（版本 V3）的技术架构、核心流程和主要实现细节。该插件主要用于从微信公众号文章页面提取内容，并自动分发（草稿/发布）到多个目标技术社区平台。

### **2. 架构设计 (Architecture)**

采用基于 Manifest V3 的标准 Chrome 插件架构：

1.  **Content Script (内容脚本):**
    *   **注入层:** 仅在 `mp.weixin.qq.com/s*` 页面注入 UI 悬浮面板（基于 Preact + Shadow DOM 实现，隔离样式）。
    *   **提取层:** 负责解析当前页面的 DOM 结构，提取标题、正文 HTML 及原文链接，并替换图片为代理 URL。
2.  **Background Service Worker (后台服务):**
    *   作为协调中心，接收 Content Script 传来的发布指令和数据。
    *   负责批量打开/聚焦各个目标渠道的编辑页面 (`chrome.tabs.create` / `chrome.windows.update`)。
    *   维护全局状态机，追踪每个渠道 Tab 的执行进度。
3.  **Publisher Content Scripts (渠道执行脚本):**
    *   在各目标平台（如 CSDN、博客园等）的编辑/发布页面上执行。
    *   根据预定义的各平台发布者策略（Strategy Pattern），利用 DOM 自动化操作（查找输入框、模拟点击、处理富文本编辑器 iframe 等）进行内容注入和发布提交。
    *   处理平台特定的图片上传逻辑（拖拽模拟、剪贴板粘贴模拟或平台特定按钮点击）。

### **3. 核心流程与技术细节 (Core Workflows)**

#### **3.1. 内容提取与清洗**
*   在微信文章页，提取 `.rich_media_title` 和 `#js_content` 的内容。
*   清理不必要的格式标签，将内联样式和特殊的微信自定义标签做标准化转换，确保在目标平台编辑器的兼容性。

#### **3.2. 图片代理与上传机制 (Image Handling)**
*   由于微信图片防盗链机制，直接复制图片链接到其他平台无法显示。
*   插件通过代理服务（如 `read.useai.online`）将原始 `data-src` 转化为可跨域访问的 URL。
*   在渠道编辑器端，优先采用**模拟粘贴/拖拽 (DataTransfer)** 技术进行图片自动上传。对于处于 iframe 内部的编辑器，或者拦截了通用事件的编辑器，执行特定的后备上传策略。

#### **3.3. 并发控制与状态同步**
*   插件基于 `chrome.tabs` API 并发打开最多 10 个渠道编辑页。
*   使用 `chrome.runtime.sendMessage` 和 `chrome.runtime.onMessage` 在后台和各渠道 Tab 之间进行双向通信。
*   建立状态机，跟踪：`init` -> `login_check` -> `filling_title` -> `filling_content` -> `uploading_images` -> `submitting` -> `success` / `failed`。

#### **3.4. 诊断系统**
*   由于前端 DOM 自动化易受目标网站 UI 更新影响，插件内置详细的诊断日志输出功能。
*   在遇到未知弹窗（如验证码、实名认证等）或节点查找超时时，触发暂停状态，并将错误信息传递回微信页的控制面板，允许用户手动介入（例如手动滑块验证）后点击“继续执行”。

### **4. 开发与测试 (Development \u0026 Testing)**

*   **技术栈:** TypeScript, Preact, Vite.
*   **自动化测试:** 集成 Playwright 进行 E2E 测试 (`npm run e2e:v3`)，支持基于 CDP (Chrome DevTools Protocol) 在真实带登录态的浏览器配置文件中进行真跑测试 (`npm run publish:live`)。