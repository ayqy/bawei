# bawei — Cross-post WeChat Articles with Verifiable Results

bawei is a Chrome extension for authors who need to reuse one WeChat Official Account article across multiple publishing platforms. Open an article on `mp.weixin.qq.com`, choose draft or publish, and bawei extracts the title, structured body, supported images, and optional source URL before processing the selected channels one at a time.

## Supported platforms

- CSDN
- Tencent Cloud Developer Community
- CNBlogs
- OSCHINA
- WoShiPM
- Mowen
- SSPAI
- Baijiahao
- Toutiao
- Feishu Docs

## What bawei does

- Runs selected channels serially so only one editor is active at a time.
- Preserves headings, paragraphs, lists, links, and supported images when the destination editor allows them.
- Uploads images to the destination platform where supported instead of treating temporary local or proxy URLs as published media.
- Supports saving drafts and submitting formal publications.
- Reports seven distinct outcomes: public success, pending review, rejected, waiting for user security verification, technical failure, not logged in, and skipped duplicate.
- Prevents duplicate submissions using a per-channel content hash. Pending, rejected, and user-verification states are rechecked or retained, not silently reposted.
- Counts a formal publication as successful only after a fresh anonymous browser context can open the public detail page and verify the title, body anchors, and expected platform-hosted images.

## Privacy and permissions

bawei runs locally in Chrome and does not operate an article-processing server. Article content is read from the page you selected and sent only to the publishing sites you chose. The extension uses storage for local settings and publishing state, tabs to open and focus destination editors, scripting to automate those pages, and narrowly scoped host access for supported image transfer and local Markdown publishing.

## Important limitations

Each destination platform controls login, CAPTCHA, identity verification, required fields, moderation, and publication timing. bawei does not bypass those controls. A clicked submit button or an item visible only in an authenticated management list is not reported as public success. If a platform changes its editor or blocks an action, bawei keeps the browser open and reports the concrete blocker so you can inspect it safely.
