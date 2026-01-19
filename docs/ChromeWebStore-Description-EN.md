# bawei - Cross-post WeChat Official Account Articles

bawei is a Chrome extension that helps you publish the same WeChat Official Account article to multiple platforms. When you open an article page on `mp.weixin.qq.com`, bawei injects a publish panel, extracts the article title and rendered HTML content, then opens the target editors and fills everything for you.

## What it does

- Extracts: title, rendered HTML content, and the source URL (current page)
- Runs multi-platform publishing concurrently (save draft or publish)
- “Original-first” behavior: if a platform has no usable source-link field (or it’s not available in original mode), bawei appends `原文链接：<url>` to the end of the content
- Built-in diagnostics: if you hit login / captcha / identity verification / required fields / risk-control prompts, bawei shows guidance in the panel so you can fix it and continue/retry

## Supported platforms (V2)

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

## Privacy

- 100% local: no server required, no article content is uploaded by bawei
- Permissions are used only to read the WeChat article page, open target tabs, and automate form filling/verification on those pages

## Notes

- Image policy (current version): no image uploading. External image links are kept; if a platform blocks external images, follow the panel hints to fix them manually.
