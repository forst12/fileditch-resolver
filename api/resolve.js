import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

export const maxDuration = 45;

export default async function handler(req, res) {
  const targetUrl = req.query.link || req.query.url;

  if (!targetUrl) {
    return res.status(400).json({
      statusCode: 400,
      error: "Missing required parameter ?link="
    });
  }

  let browser = null;
  try {
    const parsedUrl = new URL(targetUrl);
    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
    const fileId = pathSegments.length >= 2 ? pathSegments[pathSegments.length - 2] : (pathSegments[0] || "unknown");
    const rawFallbackName = pathSegments.length > 0 ? decodeURIComponent(pathSegments[pathSegments.length - 1]) : "unknown";

    const executablePath = await chromium.executablePath();

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ],
      defaultViewport: { width: 1280, height: 800 },
      executablePath: executablePath,
      headless: chromium.headless
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');

    // Emulate authentic Windows client environment for PoW verification
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

      const canvasBase64 = "data:image/png;base64,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";
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function(...args) {
        if (this.width === 128 && this.height === 32) {
          return canvasBase64;
        }
        return origToDataURL.apply(this, args);
      };
    });

    await page.goto(targetUrl, { 
      waitUntil: 'domcontentloaded', 
      timeout: 20000 
    });

    let directLink = null;
    let filename = null;
    let size = null;

    const startTime = Date.now();
    while (Date.now() - startTime < 18000) {
      try {
        const data = await page.evaluate(() => {
          const btn = document.querySelector('.btn-main, a[download]');
          const pathEl = document.querySelector('.pathline .path, h1, .filename');
          const sizeEl = document.querySelector('.pathline .size, .filesize');
          if (btn && btn.href && btn.href.startsWith('http') && !btn.href.startsWith('javascript:')) {
            return {
              directLink: btn.href,
              filename: pathEl ? pathEl.innerText.trim() : null,
              size: sizeEl ? sizeEl.innerText.trim() : null
            };
          }
          return null;
        });

        if (data && data.directLink) {
          directLink = data.directLink;
          filename = data.filename;
          size = data.size;
          break;
        }
      } catch (navErr) {
        // Navigation or context switch in progress; continue polling
      }
      await new Promise(r => setTimeout(r, 400));
    }

    if (!directLink) {
      const pageInfo = await page.evaluate(() => {
        const btn = document.querySelector('.btn-main, a[download]');
        return {
          title: document.title,
          url: location.href,
          btnHref: btn ? btn.href : 'no btn',
          text: document.body ? document.body.innerText.slice(0, 300) : ''
        };
      }).catch(e => ({ title: 'unknown', url: 'unknown', btnHref: 'unknown', text: e.message }));

      await browser.close();
      browser = null;

      return res.status(502).json({
        statusCode: 502,
        error: "PoW wait timeout. Title: " + pageInfo.title + ", Url: " + pageInfo.url + ", Btn: " + pageInfo.btnHref + ", Text: " + pageInfo.text.replace(/\n+/g, ' ')
      });
    }

    await browser.close();
    browser = null;

    return res.status(200).json({
      statusCode: 200,
      id: fileId,
      filename: filename || rawFallbackName,
      size: size || "Unknown",
      directLink: directLink.replace(/&amp;/g, '&')
    });

  } catch (err) {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
    return res.status(500).json({
      statusCode: 500,
      error: err.message
    });
  }
}
