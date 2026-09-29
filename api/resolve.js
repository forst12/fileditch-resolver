import chromium from '@sparticuz/chromium';
import puppeteerCore from 'puppeteer-core';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

export const maxDuration = 45;

export default async function handler(req, res) {
  const startTime = Date.now();
  console.log('[RESOLVER] 1. Request received at', new Date().toISOString());

  const targetUrl = req.query.link || req.query.url;
  if (!targetUrl) {
    return res.status(400).json({
      statusCode: 400,
      error: "Missing required parameter ?link="
    });
  }

  let browser = null;
  const safeClose = async (b) => {
    if (!b) return;
    try {
      await Promise.race([b.close(), new Promise(r => setTimeout(r, 1000))]);
    } catch (e) {}
    try {
      if (b.process()) b.process().kill('SIGKILL');
    } catch (e) {}
  };

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
        '--disable-blink-features=AutomationControlled',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--mute-audio',
        '--no-first-run'
      ],
      defaultViewport: { width: 1280, height: 800 },
      executablePath: executablePath,
      headless: chromium.headless
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36');

    page.on('console', msg => console.log('[PAGE]', msg.text()));
    page.on('response', resp => {
      const u = resp.url();
      if (u.includes('fileditch') || u.includes('challenge-platform')) {
        console.log('[HTTP ' + resp.status() + ']', u.slice(0, 70));
      }
    });

    // Natively block heavy fonts, images, media, and third-party trackers via CDP
    try {
      const cdp = await page.createCDPSession();
      await cdp.send('Network.setBlockedURLs', {
        urls: [
          '*.woff*',
          '*.ttf*',
          '*.otf*',
          '*.png*',
          '*.jpg*',
          '*.jpeg*',
          '*.gif*',
          '*.webp*',
          '*.mp4*',
          '*.webm*',
          '*beacon.min.js*',
          '*tag.min.js*'
        ]
      });
    } catch (e) {
      console.log('[RESOLVER] CDP block warning:', e.message);
    }

    console.log('[RESOLVER] 2. Navigating to ' + targetUrl + '...');
    const tNav = Date.now();
    await page.goto(targetUrl, { 
      waitUntil: 'domcontentloaded', 
      timeout: 20000 
    });
    console.log('[RESOLVER] 2. Navigated in ' + (Date.now() - tNav) + 'ms');

    let directLink = null;
    let filename = null;
    let size = null;

    console.log('[RESOLVER] 3. Polling for resolution (100ms interval)...');
    const pollStart = Date.now();
    while (Date.now() - pollStart < 25000) {
      try {
        const data = await page.evaluate(() => {
          const btn = document.querySelector('.btn-main, a[download]');
          const pathEl = document.querySelector('.pathline .path, h1, .filename');
          const sizeEl = document.querySelector('.pathline .size, .filesize');
          const errEl = document.querySelector('.error-badge');

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
          console.log('[RESOLVER] Direct link resolved in ' + (Date.now() - pollStart) + 'ms!');
          break;
        }
      } catch (navErr) {
        // Navigation or context switch in progress; continue polling
      }
      await new Promise(r => setTimeout(r, 100));
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

      console.log('[RESOLVER] Failed within timeout. Page state:', JSON.stringify(pageInfo));
      await safeClose(browser);
      browser = null;

      return res.status(502).json({
        statusCode: 502,
        error: "PoW wait timeout. Title: " + pageInfo.title + ", Url: " + pageInfo.url + ", Btn: " + pageInfo.btnHref + ", Text: " + pageInfo.text.replace(/\n+/g, ' ')
      });
    }

    await safeClose(browser);
    browser = null;

    console.log('[RESOLVER] Returning success in ' + (Date.now() - startTime) + 'ms');
    return res.status(200).json({
      statusCode: 200,
      id: fileId,
      filename: filename || rawFallbackName,
      size: size || "Unknown",
      directLink: directLink.replace(/&amp;/g, '&')
    });

  } catch (err) {
    console.error('[RESOLVER ERR]', err);
    if (browser) await safeClose(browser);
    return res.status(500).json({
      statusCode: 500,
      error: err.message
    });
  }
}
