import chromium from '@sparticuz/chromium-min';
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

    if (typeof chromium.setGraphicsMode === 'function') {
      chromium.setGraphicsMode(false);
    }

    const executablePath = await chromium.executablePath(
      'https://github.com/Sparticuz/chromium/releases/download/v153.0.0/chromium-v153.0.0-pack.x64.tar'
    );

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: executablePath,
      headless: chromium.headless
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');

    await page.goto(targetUrl, { 
      waitUntil: 'domcontentloaded', 
      timeout: 25000 
    });

    await page.waitForSelector('.btn-main, a[download]', { timeout: 20000 });

    const pageData = await page.evaluate(() => {
      const btn = document.querySelector('.btn-main, a[download]');
      const pathEl = document.querySelector('.pathline .path');
      const sizeEl = document.querySelector('.pathline .size');

      return {
        directLink: btn ? btn.href : null,
        filename: pathEl ? pathEl.innerText.trim() : null,
        size: sizeEl ? sizeEl.innerText.trim() : null
      };
    });

    await browser.close();

    if (!pageData.directLink || pageData.directLink.startsWith('javascript:')) {
      return res.status(502).json({
        statusCode: 502,
        error: "Failed to resolve direct link (PoW verification failed)"
      });
    }

    return res.status(200).json({
      statusCode: 200,
      id: fileId,
      filename: pageData.filename || rawFallbackName,
      size: pageData.size || "Unknown",
      directLink: pageData.directLink.replace(/&amp;/g, '&')
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({
      statusCode: 500,
      error: err.message
    });
  }
}
