import chromium from '@sparticuz/chromium';
import puppeteerCore from 'puppeteer-core';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

export const maxDuration = 45;

let cachedExecutablePath = null;

export default async function handler(req, res) {
  const startTime = Date.now();
  console.log('[RESOLVER] 1. Request received at', new Date().toISOString());

  const rawUrl = req.query.link || req.query.url;
  if (!rawUrl) {
    return res.status(400).json({
      statusCode: 400,
      error: "Missing required parameter ?link="
    });
  }

  // 1. Early URL Sanitization and Validation
  const targetUrl = String(rawUrl).trim().replace(/^["']|["']$/g, '');
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Protocol must be http or https');
    }
  } catch (e) {
    return res.status(400).json({
      statusCode: 400,
      error: "Invalid target URL: " + e.message
    });
  }

  const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
  const fileId = pathSegments.length >= 2 ? pathSegments[pathSegments.length - 2] : (pathSegments[0] || "");
  const rawFallbackName = pathSegments.length > 0 ? decodeURIComponent(pathSegments[pathSegments.length - 1]) : "unknown";

  let browser = null;
  const fastClose = (b) => {
    if (!b) return;
    try {
      const p = b.process();
      if (p) p.kill('SIGKILL');
    } catch (e) {}
    try {
      b.close().catch(() => {});
    } catch (e) {}
  };

  try {
    // 2. Cached Executable Path
    if (!cachedExecutablePath) {
      cachedExecutablePath = await chromium.executablePath();
    }

    // 3. Optimized Launch & Compact Viewport
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--disable-blink-features=AutomationControlled',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--mute-audio',
        '--no-first-run',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-ipc-flooding-protection',
        '--disable-breakpad',
        '--disable-component-update',
        '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints'
      ],
      defaultViewport: { width: 800, height: 600 },
      executablePath: cachedExecutablePath,
      headless: chromium.headless
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36');

    page.on('console', msg => console.log('[PAGE]', msg.text()));

    let resolvedData = null;
    let initialTitle = null;
    let initialNavDone = false;

    const parseAndSetResult = (html, source) => {
      if (resolvedData || !html) return false;
      const b64Match = html.match(/atob\(\s*["'](aHR0c[A-Za-z0-9+/=]+)["']\s*\)/i);
      if (!b64Match) return false;

      const cleanB64 = b64Match[1].replace(/\\/g, '');
      let link = null;
      try {
        link = Buffer.from(cleanB64, 'base64').toString('utf8');
      } catch (e) {
        return false;
      }

      if (!link || !link.startsWith('http')) return false;

      const pathMatch = html.match(/class=["']path["'][^>]*>([^<]+)<\//i);
      const sizeMatch = html.match(/class=["']size["'][^>]*>([^<]+)<\//i);

      resolvedData = {
        directLink: link.replace(/&amp;/g, '&'),
        filename: pathMatch ? pathMatch[1].trim() : (initialTitle || rawFallbackName),
        size: sizeMatch ? sizeMatch[1].trim() : "Unknown"
      };
      console.log(`[RESOLVER] Direct link intercepted via ${source} in ${Date.now() - startTime}ms!`);
      return true;
    };

    // Attach response listeners
    page.on('response', async (resp) => {
      const u = resp.url();
      if (u.includes('fileditch') || u.includes('challenge-platform')) {
        console.log('[HTTP ' + resp.status() + ']', u.slice(0, 70));
      }
      if (!resolvedData && resp.status() === 200 && resp.request().method() === 'POST') {
        const matchesTarget = fileId ? u.includes(fileId) : true;
        if (matchesTarget) {
          try {
            const body = await resp.text();
            parseAndSetResult(body, 'PUPPETEER_POST');
          } catch (e) {}
        }
      }
    });

    // Native CDP setup: block unnecessary assets and listen to Network events
    try {
      const cdp = await page.createCDPSession();
      await cdp.send('Network.enable');
      await cdp.send('Network.setBlockedURLs', {
        urls: [
          '*.woff*',
          '*.woff2*',
          '*.ttf*',
          '*.otf*',
          '*.eot*',
          '*.png*',
          '*.jpg*',
          '*.jpeg*',
          '*.gif*',
          '*.webp*',
          '*.svg*',
          '*.ico*',
          '*.mp4*',
          '*.webm*',
          '*.mp3*',
          '*.wav*',
          '*beacon.min.js*',
          '*tag.min.js*',
          '*/js/render.js*',
          '*fonts.googleapis.com*',
          '*fonts.gstatic.com*',
          '*cdn-cgi/rum?*',
          '*cdn.plyr.io*'
        ]
      });

      cdp.on('Network.responseReceived', async (params) => {
        if (initialNavDone && !resolvedData && params.response.status === 200 && params.type === 'Document') {
          const u = params.response.url;
          const matchesTarget = fileId ? u.includes(fileId) : true;
          if (matchesTarget) {
            try {
              const res = await cdp.send('Network.getResponseBody', { requestId: params.requestId });
              const html = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
              if (html) parseAndSetResult(html, 'CDP_RESPONSE');
            } catch (e) {}
          }
        }
      });
    } catch (e) {
      console.log('[RESOLVER] CDP setup warning:', e.message);
    }

    console.log('[RESOLVER] 2. Navigating to ' + targetUrl + '...');
    const tNav = Date.now();
    const navResp = await page.goto(targetUrl, { 
      waitUntil: 'domcontentloaded', 
      timeout: 20000 
    });
    initialNavDone = true;
    console.log('[RESOLVER] 2. Navigated in ' + (Date.now() - tNav) + 'ms');

    // Fast check for HTTP 404 from host
    if (navResp && navResp.status() === 404) {
      fastClose(browser);
      return res.status(404).json({
        statusCode: 404,
        error: "File not found (HTTP 404 from host)"
      });
    }

    // Fast check for missing/deleted file or title
    try {
      const pageMeta = await page.evaluate(() => {
        const goneEl = document.querySelector('.gone, .error-404');
        const notFoundText = document.body && (document.body.innerText.includes('File Not Found') || document.body.innerText.includes('File gone'));
        return {
          title: document.title,
          isGone: !!(goneEl || notFoundText)
        };
      });

      if (pageMeta.isGone) {
        console.log('[RESOLVER] Detected missing/deleted file in ' + (Date.now() - startTime) + 'ms');
        fastClose(browser);
        return res.status(404).json({
          statusCode: 404,
          error: "File not found or deleted on FileDitch"
        });
      }

      if (pageMeta.title && !pageMeta.title.includes('FileDitch') && !pageMeta.title.includes('Just a moment')) {
        initialTitle = pageMeta.title.trim();
      }
    } catch (e) {}

    // Safe evaluate helper
    const evalWithTimeout = (fn, timeoutMs = 1000) => {
      return Promise.race([
        page.evaluate(fn),
        new Promise((_, reject) => setTimeout(() => reject(new Error('eval_timeout')), timeoutMs))
      ]);
    };

    let lastErrorBadge = null;
    console.log('[RESOLVER] 3. Waiting for resolution...');
    const pollStart = Date.now();

    while (Date.now() - pollStart < 25000) {
      if (resolvedData) break;

      try {
        const data = await evalWithTimeout(() => {
          const btn = document.querySelector('.btn-main, a[download]');
          const pathEl = document.querySelector('.pathline .path, h1, .filename');
          const sizeEl = document.querySelector('.pathline .size, .filesize');
          const errEl = document.querySelector('.error-badge');
          const goneEl = document.querySelector('.gone');

          if (goneEl) {
            return { isGone: true };
          }

          if (btn && btn.href && btn.href.startsWith('http') && !btn.href.startsWith('javascript:')) {
            return {
              directLink: btn.href,
              filename: pathEl ? pathEl.innerText.trim() : null,
              size: sizeEl ? sizeEl.innerText.trim() : null
            };
          }

          if (errEl && errEl.innerText) {
            return { errorBadge: errEl.innerText.trim() };
          }

          return null;
        }, 800);

        if (data && data.isGone) {
          fastClose(browser);
          return res.status(404).json({
            statusCode: 404,
            error: "File not found or deleted on FileDitch"
          });
        }

        if (data && data.directLink) {
          resolvedData = {
            directLink: data.directLink.replace(/&amp;/g, '&'),
            filename: data.filename || initialTitle || rawFallbackName,
            size: data.size || "Unknown"
          };
          console.log('[RESOLVER] Direct link resolved via DOM eval in ' + (Date.now() - pollStart) + 'ms!');
          break;
        }

        if (data && data.errorBadge) {
          lastErrorBadge = data.errorBadge;
        }
      } catch (navErr) {}

      await new Promise(r => setTimeout(r, 50));
    }

    if (!resolvedData) {
      const pageInfo = await evalWithTimeout(() => {
        const btn = document.querySelector('.btn-main, a[download]');
        return {
          title: document.title,
          url: location.href,
          btnHref: btn ? btn.href : 'no btn',
          text: document.body ? document.body.innerText.slice(0, 300) : ''
        };
      }, 1200).catch(e => ({ title: 'unknown', url: 'unknown', btnHref: 'unknown', text: e.message }));

      console.log('[RESOLVER] Failed within timeout. Page state:', JSON.stringify(pageInfo), 'Last badge:', lastErrorBadge);
      fastClose(browser);
      browser = null;

      return res.status(502).json({
        statusCode: 502,
        error: "PoW wait timeout (max 25s). State: " + (lastErrorBadge || pageInfo.text.replace(/\n+/g, ' ') || pageInfo.title)
      });
    }

    fastClose(browser);
    browser = null;

    console.log('[RESOLVER] Returning success in ' + (Date.now() - startTime) + 'ms');
    return res.status(200).json({
      statusCode: 200,
      id: fileId,
      filename: resolvedData.filename,
      size: resolvedData.size,
      directLink: resolvedData.directLink
    });

  } catch (err) {
    console.error('[RESOLVER ERR]', err);
    if (browser) fastClose(browser);
    return res.status(500).json({
      statusCode: 500,
      error: err.message
    });
  }
}
