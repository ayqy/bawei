import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const PORT = process.env.CDP_PORT || "52607";
const OUT = process.env.OUT || path.resolve(process.cwd(), "tmp/mcp-storageState.json");

const TARGET_URLS = [
  "https://sspai.com/",
  "https://baijiahao.baidu.com/",
  "https://mp.toutiao.com/",
  "https://wuxinxuexi.feishu.cn/",
  // 旧渠道（保险起见）
  "https://mp.csdn.net/",
  "https://cloud.tencent.com/",
  "https://i.cnblogs.com/",
  "https://www.oschina.net/",
  "https://www.woshipm.com/",
  "https://note.mowen.cn/",
];

async function getLocalStorageEntries(page) {
  return await page.evaluate(() => {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        const v = localStorage.getItem(k);
        out.push({ name: k, value: v ?? "" });
      }
    } catch {
      // ignore
    }
    return out;
  });
}

async function main() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const contexts = browser.contexts();
  if (!contexts.length) throw new Error("no contexts");
  const context = contexts[0];

  // Prefer an existing tab to avoid triggering bot detection on fresh tabs.
  const page = context.pages()[0] || (await context.newPage());

  const origins = [];
  for (const url of TARGET_URLS) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
      const ls = await getLocalStorageEntries(page);
      if (ls.length) {
        origins.push({ origin: new URL(url).origin, localStorage: ls });
      }
      console.log("[ok]", new URL(url).origin, "localStorage:", ls.length);
    } catch (e) {
      console.log("[warn]", url, e?.message || e);
    }
  }

  const cookies = await context.cookies();

  const state = { cookies, origins };
  fs.writeFileSync(OUT, JSON.stringify(state, null, 2));
  console.log("\n写入:", OUT);
  console.log("cookies:", cookies.length, "origins:", origins.length);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
