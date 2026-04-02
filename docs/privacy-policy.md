# Privacy Policy for bawei

**Last Updated:** April 2, 2026

## Overview

bawei is a Chrome extension that helps a user take the currently open WeChat Official Account article and send that content to user-selected supported publishing platforms for drafting or publishing. This Privacy Policy explains what information the extension processes, how that information is used, when it is transmitted as part of the requested workflow, and what controls the user has.

## Single Purpose

bawei has one narrow purpose: to extract content from a WeChat Official Account article that the user opens and, at the user's direction, publish or save that content as a draft on supported destination platforms. The extension is not designed for advertising, analytics, profile building, unrelated browsing assistance, or general account management.

## Information We Process

### Website content

When the user starts a publishing workflow from a supported WeChat Official Account article page, the extension processes website content from that page, including:

- the article title
- the article body content
- the source URL
- image URLs and image data needed to preserve article images during publishing

This information is processed only to perform the draft or publish workflow requested by the user.

### Authentication-related information

On some supported destination platforms, the extension may read authentication-related information that is already available in the page context or browser-provided storage for that site, such as site tokens, cookies, or CSRF tokens. This is done only when necessary to complete the user-requested draft or publish action on that same site. bawei does not operate its own account system and does not use this information for unrelated purposes.

### Settings and workflow state

The extension stores and processes:

- user settings, such as auto-publish, auto-close, and language preference
- temporary publish job data, such as article payload, selected channels, timestamps, and source tab references
- temporary per-channel runtime state, such as progress, status, error details, and verification results

This information is used only to operate the extension and keep the publishing workflow consistent across tabs.

## How We Use Information

bawei uses the information described above only to:

- extract the currently open WeChat article the user wants to reuse
- open and control the user-selected supported destination pages
- fill titles, body content, source links, and images into destination editors
- create drafts or submit publish actions requested by the user
- verify status and show progress, blocking conditions, and retry guidance
- fetch and prepare images when image handling is required for the publishing workflow

## Local Storage and Retention

User settings are stored in Chrome extension storage so the extension can remember preferences across browser sessions.

Temporary publish workflow data is stored locally in Chrome extension storage while a workflow is active or recent, including article payload and per-channel runtime state. Current implementation automatically removes expired workflow data after approximately 24 hours and limits the number of stored jobs.

Some channel-specific temporary markers may also be stored in page-scoped browser session storage during a workflow to support retries, page transitions, or verification steps. These values are temporary and are not used outside the requested workflow.

## When Information Is Shared or Transmitted

bawei does not sell user data. However, information may be transmitted in the following cases because that transmission is necessary to perform the workflow the user requested:

- **User-selected destination platforms.** When the user chooses one or more supported publishing platforms, the extension sends article content, source links, and related publishing data to those platforms so the platform can create or update a draft or published post for the user.
- **Image-related network endpoints.** When images need to be preserved during the publishing workflow, the extension may request image data from the original image host and may also use the currently configured image proxy service at `https://read.useai.online` to retrieve or normalize image resources for the requested workflow.

bawei does not transmit user information to third parties for advertising, analytics, or unrelated commercial purposes.

## What We Do Not Use Data For

bawei does not use or transfer user data to:

- sell user data
- serve ads, marketing, or personalized promotions
- build user profiles
- perform analytics unrelated to the extension's single purpose
- monitor unrelated browsing activity
- determine creditworthiness
- support lending or similar financial eligibility decisions

## Permissions

bawei requests the following permissions for its single-purpose workflow:

- **`storage`**: to store user settings and temporary workflow state needed to operate the extension
- **`tabs`**: to open, reuse, focus, update, and coordinate the source tab and user-selected destination platform tabs
- **`scripting`**: to run packaged extension scripts in supported destination pages when needed to interact with page-native editors and complete the requested publishing workflow
- **Host access**: to access the supported WeChat source page, supported destination platform pages, and image-related hosts needed to read source content, perform user-requested publishing actions, verify results, and handle images

These permissions are used only for the extension's single purpose described above.

## Remote Code

bawei does not use remote code. Its executable JavaScript is packaged with the extension. Network requests may be made to supported websites and image-related endpoints as part of the user-requested workflow, but the extension does not download and execute remote JavaScript or Wasm as application logic.

## User Controls

The user controls whether and when bawei runs:

- The user chooses whether to start a draft or publish workflow.
- The user chooses which supported destination platforms to use.
- The user can modify extension settings.
- The user can stop an in-progress workflow.
- The user can remove the extension to delete extension-stored local data from the browser.

## Security

bawei is designed to keep processing limited to the information necessary for its publishing workflow. Data used by the extension is primarily handled locally in the browser, with transmission occurring only when required to access supported sites, retrieve images, or send user-requested content to selected destination platforms. The extension does not rely on remote executable code.

## Changes to This Policy

We may update this Privacy Policy from time to time to reflect changes to the extension or its data practices. When we do, we will update the "Last Updated" date at the top of this document.

## Contact

If you have questions about this Privacy Policy or bawei's data practices, please contact us through GitHub Issues:

- https://github.com/ayqy/bawei/issues/new
