import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getChannelConfig, matchesConfiguredUrl } from './channel-config.mjs';

function decodeBasicHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function normalizePublicationText(value) {
  return decodeBasicHtml(value)
    .replace(/\s+/g, ' ')
    .trim();
}

export function deriveBodyAnchors(contentHtml, limit = 2) {
  const html = String(contentHtml || '')
    .replace(/<(script|style|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<img\b[^>]*>/gi, ' ');
  const blocks = Array.from(html.matchAll(/<(?:p|h[1-6]|li|blockquote)\b[^>]*>([\s\S]*?)<\/(?:p|h[1-6]|li|blockquote)>/gi))
    .map((match) => normalizePublicationText(String(match[1] || '').replace(/<[^>]+>/g, ' ')))
    .filter((text) => text.length >= 12);
  if (!blocks.length) {
    const fallback = normalizePublicationText(html.replace(/<[^>]+>/g, ' '));
    if (fallback) blocks.push(fallback);
  }
  return Array.from(new Set(blocks))
    .slice(0, Math.max(1, limit))
    .map((text) => text.slice(0, 80));
}

function canonicalImageIdentity(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim());
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(rawUrl || '').trim();
  }
}

export function isDurablePublicImageUrl(rawUrl, sourceImageUrls = []) {
  const value = String(rawUrl || '').trim();
  if (!value || /^(?:blob:|data:|chrome-extension:|moz-extension:)/i.test(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') return false;
    if (host === 'read.useai.online' && url.pathname.startsWith('/api/image-proxy')) return false;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const identity = canonicalImageIdentity(url.toString());
    return !sourceImageUrls.some((sourceUrl) => canonicalImageIdentity(sourceUrl) === identity);
  } catch {
    return false;
  }
}

export function preferredPublicImageUrl(image = {}) {
  const candidates = [image.currentSrc, image.src, image.dataSrc, image.dataOriginal]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return candidates.find((value) => /^https?:\/\//i.test(value)) || candidates[0] || '';
}

export function redactEvidenceUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (/token|access|auth|code|secret|sign|signature|key/i.test(key)) url.searchParams.set(key, '<redacted>');
    }
    url.hash = '';
    return url.toString();
  } catch {
    return value.replace(/([?&](?:token|access_token|auth|code|secret|sign|signature|key)=)[^&#]+/gi, '$1<redacted>');
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function writePublicationEvidence(outputDir, evidence, screenshotBuffer) {
  fs.mkdirSync(outputDir, { recursive: true });
  const screenshotPath = path.join(outputDir, 'anonymous-publication.png');
  if (screenshotBuffer?.length) fs.writeFileSync(screenshotPath, screenshotBuffer, { mode: 0o600 });
  const payload = {
    ...evidence,
    finalUrl: redactEvidenceUrl(evidence.finalUrl),
    candidatePublicUrl: redactEvidenceUrl(evidence.candidatePublicUrl),
    screenshotSha256: screenshotBuffer?.length ? sha256File(screenshotPath) : '',
  };
  const evidencePath = path.join(outputDir, 'anonymous-evidence.json');
  fs.writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  const evidenceSha256 = sha256File(evidencePath);
  fs.writeFileSync(path.join(outputDir, 'anonymous-evidence.sha256'), `${evidenceSha256}  anonymous-evidence.json\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return { evidencePath, evidenceSha256, screenshotPath: screenshotBuffer?.length ? screenshotPath : '' };
}

export async function verifyPublicationAnonymously(options) {
  const { browser, channelId, candidatePublicUrl, title, contentHtml, expectedImageCount, sourceImageUrls = [], outputDir } = options;
  const config = getChannelConfig(channelId);
  const anchors = deriveBodyAnchors(contentHtml, 2);
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  const evidence = {
    checkedAt: new Date().toISOString(),
    channelId,
    candidatePublicUrl,
    finalUrl: '',
    responseStatus: null,
    titleExpected: normalizePublicationText(title),
    titleObserved: '',
    anchorsExpected: anchors,
    anchorsMatched: [],
    expectedImageCount: Number(expectedImageCount || 0),
    observedImageCount: 0,
    loadedImageCount: 0,
    urlRuleMatched: false,
    loginRedirected: false,
    ok: false,
    errors: [],
  };
  let screenshotBuffer = null;

  try {
    const response = await page.goto(candidatePublicUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    evidence.responseStatus = response?.status() ?? null;
    // 今日头条等站点会在首个 DOMContentLoaded 后继续从 /item/ 切换到
    // /article/ 并重建正文 DOM。给客户端路由一个稳定窗口，避免在中间态取证。
    await page.waitForTimeout(5000);
    evidence.finalUrl = page.url();
    evidence.urlRuleMatched = matchesConfiguredUrl(evidence.finalUrl, config.publicUrlPatterns);
    evidence.loginRedirected = matchesConfiguredUrl(evidence.finalUrl, config.loginUrlPatterns);

    // 多数内容平台对长文图片使用视口懒加载。先逐图滚动并等待 load/error，
    // 再采集 naturalWidth，避免把“尚未进入视口”误判为公开图片损坏。
    await page.evaluate(async (selectors) => {
      const images = [];
      for (const selector of selectors) {
        for (const image of Array.from(document.querySelectorAll(selector))) {
          if (image instanceof HTMLImageElement && !images.includes(image)) images.push(image);
        }
      }
      for (const image of images) {
        image.scrollIntoView({ block: 'center', inline: 'nearest' });
        const currentUrl = image.currentSrc || image.getAttribute('src') || '';
        const lazyUrl = image.getAttribute('data-src') || image.getAttribute('data-original') || '';
        if (!/^https?:\/\//i.test(currentUrl) && /^https?:\/\//i.test(lazyUrl)) {
          image.setAttribute('src', lazyUrl);
        }
        if (!image.complete) {
          await Promise.race([
            new Promise((resolve) => image.addEventListener('load', resolve, { once: true })),
            new Promise((resolve) => image.addEventListener('error', resolve, { once: true })),
            new Promise((resolve) => setTimeout(resolve, 5000)),
          ]);
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }, config.publicImageSelectors);

    const snapshot = await page.evaluate((runtimeConfig) => {
      const firstText = (selectors) => {
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          const text = String(node?.textContent || '').replace(/\s+/g, ' ').trim();
          if (text) return text;
        }
        return '';
      };
      let articleRoot = null;
      for (const selector of runtimeConfig.publicArticleSelectors) {
        articleRoot = document.querySelector(selector);
        if (articleRoot) break;
      }
      const root = articleRoot || document.body;
      const bodyText = String(root?.textContent || '').replace(/\s+/g, ' ').trim();
      const imageNodes = [];
      for (const selector of runtimeConfig.publicImageSelectors) {
        for (const image of Array.from(document.querySelectorAll(selector))) {
          if (!imageNodes.includes(image)) imageNodes.push(image);
        }
      }
      return {
        title: firstText(runtimeConfig.publicTitleSelectors) || document.title,
        bodyText,
        images: imageNodes.map((image) => ({
          currentSrc: image.currentSrc || '',
          src: image.getAttribute('src') || '',
          dataSrc: image.getAttribute('data-src') || '',
          dataOriginal: image.getAttribute('data-original') || '',
          complete: image.complete,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
        })),
      };
    }, config);

    evidence.titleObserved = normalizePublicationText(snapshot.title);
    evidence.anchorsMatched = anchors.filter((anchor) => normalizePublicationText(snapshot.bodyText).includes(anchor));
    const durableImages = snapshot.images
      .map((image) => ({ ...image, resolvedSrc: preferredPublicImageUrl(image) }))
      .filter((image) => isDurablePublicImageUrl(image.resolvedSrc, sourceImageUrls));
    evidence.observedImageCount = durableImages.length;
    evidence.loadedImageCount = durableImages.filter(
      (image) => image.complete && Number(image.naturalWidth || 0) > 0 && Number(image.naturalHeight || 0) > 0
    ).length;

    if (!evidence.urlRuleMatched) evidence.errors.push('final-url-not-public');
    if (evidence.loginRedirected) evidence.errors.push('redirected-to-login');
    if (evidence.responseStatus !== null && evidence.responseStatus >= 400) evidence.errors.push(`http-${evidence.responseStatus}`);
    const expectedTitle = evidence.titleExpected;
    const observedTitle = evidence.titleObserved;
    if (!expectedTitle || !observedTitle || (!observedTitle.includes(expectedTitle) && !expectedTitle.includes(observedTitle))) {
      evidence.errors.push('title-mismatch');
    }
    if (anchors.length < 2 || evidence.anchorsMatched.length < 2) evidence.errors.push('body-anchor-mismatch');
    if (evidence.loadedImageCount < evidence.expectedImageCount) evidence.errors.push('image-count-or-load-mismatch');
    evidence.ok = evidence.errors.length === 0;
    screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' }).catch(() => null);
  } catch (error) {
    evidence.errors.push(error instanceof Error ? error.message : String(error));
    evidence.finalUrl = page.url();
    screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' }).catch(() => null);
  } finally {
    await context.close();
  }

  const persisted = writePublicationEvidence(outputDir, evidence, screenshotBuffer);
  return { ...evidence, ...persisted };
}
