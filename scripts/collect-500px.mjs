/** Collect a bounded set of publicly displayed 500px covers through the normal browser UI.
 * No private API, saved login, original URL reconstruction or access-control bypass is used.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomInt, createHash } from 'node:crypto';

export const DEFAULT_SEARCH =
  'https://500px.com/search?q=%E8%87%AA%E7%84%B6%E9%A3%8E%E6%99%AF&type=Photo';
const CDN_HOSTS = new Set(['cdn-resize-prod-com.500px.cloud', 'drscdn.500px.org']);
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function validateSearchUrl(input) {
  const url = new URL(input);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== '500px.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/search' ||
    url.hash
  )
    throw new Error('Use an HTTPS 500px.com /search URL.');
  if (
    [...url.searchParams.keys()].some((key) => !['q', 'type'].includes(key)) ||
    url.searchParams.get('type') !== 'Photo' ||
    !url.searchParams.get('q')?.trim() ||
    url.searchParams.get('q').length > 120
  )
    throw new Error('The search URL needs q and type=Photo, without extra routing parameters.');
  return url.href;
}

export function photoPageUrl(input) {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' &&
      url.hostname === '500px.com' &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/photo\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9._-]+)?$/.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function displayImageUrl(input) {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' &&
      CDN_HOSTS.has(url.hostname) &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.pathname.startsWith('/photo/')
      ? input
      : null;
  } catch {
    return null;
  }
}

/** Both addresses come directly from rendered DOM; only their signed size/query may differ. */
export function sameDisplayedPhoto(candidate, image) {
  return !!(
    displayImageUrl(candidate.url) &&
    displayImageUrl(image.url) &&
    new URL(candidate.url).pathname === new URL(image.url).pathname
  );
}

const scenic =
  /\b(sun(?:set|rise)?|dawn|dusk|lake|loch|mountain|coast|sea|ocean|forest|autumn|landscape|water|river|snow|mist|storm|night|valley|rain|light|morning|silence|norway|nebel)\b|风景|山|湖|海|雪|晨|秋|落日/i;
const wildlife =
  /\b(fox|wolf|bear|butterfl\w*|bird|tit|bulbul|heron|garganey|marten|frog|spider|insect|portrait|model|woman|man)\b/i;

export function chooseCandidates(cards, limit) {
  const seen = new Set();
  return cards
    .filter((card) => {
      if (
        !photoPageUrl(card.source) ||
        !displayImageUrl(card.url) ||
        seen.has(card.source) ||
        !card.author?.trim() ||
        !(card.width / card.height >= 1.35) ||
        !(card.width >= 500) ||
        wildlife.test(card.title || '')
      )
        return false;
      seen.add(card.source);
      return true;
    })
    .map((card) => ({
      card,
      priority: Number(scenic.test(card.title)),
      random: randomInt(0x7fffffff),
    }))
    .sort((a, b) => b.priority - a.priority || a.random - b.random)
    .slice(0, limit)
    .map((item) => item.card);
}

export function coverConfiguration(photos) {
  const seen = new Set();
  const slides = photos
    .filter((photo) => {
      if (
        !photoPageUrl(photo.source) ||
        !displayImageUrl(photo.url) ||
        !photo.author?.trim() ||
        !(photo.width >= 1024) ||
        !(photo.width / photo.height >= 1.35) ||
        seen.has(photo.source)
      )
        return false;
      seen.add(photo.source);
      return true;
    })
    .map((photo) => {
      const id = new URL(photo.source).pathname.split('/')[2];
      const clean = (value) =>
        String(value || '')
          .replace(/[\u0000-\u001f]/g, ' ')
          .trim()
          .slice(0, 220);
      return {
        id: `500px-${id}`,
        ...(photo.file ? { file: photo.file } : { url: photo.url }),
        title: clean(photo.title) || 'STILL MOMENTS',
        subtitle: '',
        author: clean(photo.author),
        source: photo.source,
        credit: `Photography by ${clean(photo.author)} · 500px`,
        displayOnly: true,
        focalPoint: { x: 50, y: 50 },
      };
    });
  if (!slides.length)
    throw new Error(
      'No suitable public landscape display images were found. Existing covers were not changed.',
    );
  return {
    allowedHosts: [
      ...new Set(slides.filter((slide) => slide.url).map((slide) => new URL(slide.url).hostname)),
    ],
    slides,
  };
}

/** Accept bytes only from the exact public display-image response already loaded by the browser. */
export function validateDisplayResponse({ url, status, mime, body, base64Encoded }) {
  if (!displayImageUrl(url) || status !== 200)
    throw new Error('The displayed photo response is unavailable; no alternate URL was requested.');
  const type = String(mime || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  const extension = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[type];
  if (!extension || base64Encoded !== true || typeof body !== 'string')
    throw new Error('The browser response is not a supported binary display image.');
  if (body.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body))
    throw new Error('The display image is invalid or exceeds 30 MiB.');
  const bytes = Buffer.from(body, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new Error('The display image is empty or exceeds 30 MiB.');
  const matches =
    type === 'image/jpeg'
      ? bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      : type === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
          bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!matches) throw new Error('The display response content does not match its image type.');
  return { bytes, extension };
}

async function saveDisplayResponse(directory, response) {
  const { bytes, extension } = validateDisplayResponse(response);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const filename = path.join(directory, digest + extension);
  try {
    await fs.writeFile(filename, bytes, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await fs.readFile(filename);
    if (createHash('sha256').update(existing).digest('hex') !== digest)
      throw new Error('An existing cache file has unexpected contents.');
  }
  return filename;
}

async function browserExecutable(requested) {
  const candidates = requested
    ? [requested]
    : [
        path.join(
          process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)',
          'Microsoft/Edge/Application/msedge.exe',
        ),
        path.join(
          process.env.PROGRAMFILES || 'C:/Program Files',
          'Microsoft/Edge/Application/msedge.exe',
        ),
        path.join(
          process.env.PROGRAMFILES || 'C:/Program Files',
          'Google/Chrome/Application/chrome.exe',
        ),
      ];
  for (const item of candidates) {
    if (!path.isAbsolute(item)) continue;
    try {
      if ((await fs.stat(item)).isFile() && /(?:msedge|chrome)\.exe$/i.test(item)) return item;
    } catch {
      /* Try the next installed browser. */
    }
  }
  throw new Error(
    'Microsoft Edge or Google Chrome was not found. Pass --browser with its absolute executable path.',
  );
}

async function openBrowser(executable, deadline) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'guangying-500px-'));
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-extensions',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`,
      '--window-size=1600,1000',
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  let socket;
  const pending = new Map();
  const imageResponses = new Map();
  const requests = new Map();
  let nextId = 0;
  let failure = '';
  child.on('error', (error) => {
    failure = error.message;
  });
  child.on('exit', () => {
    for (const task of pending.values()) {
      clearTimeout(task.timer);
      task.reject(new Error('The isolated browser closed before collection finished.'));
    }
    pending.clear();
  });
  const timer = setTimeout(() => child.kill(), Math.max(1, deadline - Date.now()));
  async function close() {
    clearTimeout(timer);
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        await send('Browser.close', {}, 1500);
      } catch {
        /* Kill only this owned browser. */
      }
      socket.close();
    }
    if (child.exitCode === null) child.kill();
    await pause(250);
    // The recursive cleanup target is the exact private directory created above.
    const tempRoot = path.resolve(os.tmpdir());
    const fullProfile = path.resolve(profile);
    if (
      path.dirname(fullProfile) === tempRoot &&
      path.basename(fullProfile).startsWith('guangying-500px-')
    )
      await fs
        .rm(fullProfile, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
        .catch(() => {});
  }
  function send(method, params = {}, timeout = 8000) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(new Error(`Browser request timed out: ${method}`));
        },
        Math.max(1, Math.min(timeout, deadline - Date.now())),
      );
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  try {
    let port;
    const launchDeadline = Math.min(deadline, Date.now() + 15000);
    while (Date.now() < launchDeadline) {
      if (failure) throw new Error(failure);
      try {
        port = Number(
          (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0],
        );
        if (port) break;
      } catch {
        /* Browser is starting. */
      }
      await pause(150);
    }
    if (!port) throw new Error('The isolated browser did not become ready.');
    const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: 'PUT',
      signal: AbortSignal.timeout(5000),
    });
    const target = await response.json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Browser debugger connection timed out.')),
        5000,
      );
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('Browser debugger connection failed.'));
        },
        { once: true },
      );
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Network.responseReceived') {
        const { type, response, requestId } = message.params;
        if (
          type === 'Document' &&
          /^https:\/\/500px\.com\/(search|photo\/)/.test(response.url) &&
          [401, 403, 429].includes(response.status)
        )
          failure = `500px returned HTTP ${response.status}. Collection stopped without retrying or bypassing access controls.`;
        if (type === 'Image' && displayImageUrl(response.url)) {
          const record = {
            requestId,
            url: response.url,
            mime: response.mimeType,
            status: response.status,
            finished: false,
            encodedBytes: 0,
          };
          imageResponses.set(response.url, record);
          requests.set(requestId, record);
        }
      }
      if (message.method === 'Network.loadingFinished') {
        const record = requests.get(message.params.requestId);
        if (record) {
          record.finished = true;
          record.encodedBytes = message.params.encodedDataLength;
        }
      }
      if (message.method === 'Network.loadingFailed') {
        const record = requests.get(message.params.requestId);
        if (record) record.failed = true;
      }
      const task = pending.get(message.id);
      if (!task) return;
      clearTimeout(task.timer);
      pending.delete(message.id);
      if (message.error) task.reject(new Error(message.error.message));
      else task.resolve(message.result);
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable', {
      maxTotalBufferSize: 100 * 1024 * 1024,
      maxResourceBufferSize: MAX_IMAGE_BYTES,
    });
    const evaluate = async (expression) => {
      if (failure) throw new Error(failure);
      const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails)
        throw new Error('The page could not be read through its normal DOM.');
      return result.result.value;
    };
    return {
      send,
      evaluate,
      close,
      async displayResponse(url) {
        if (!displayImageUrl(url))
          throw new Error('Only the exact displayed 500px CDN image can be saved.');
        const record = imageResponses.get(url);
        if (!record)
          throw new Error(
            'The browser did not retain this displayed photo response. No extra download request was made.',
          );
        const until = Math.min(deadline, Date.now() + 3000);
        while (!record.finished && !record.failed && Date.now() < until) await pause(100);
        if (
          !record.finished ||
          record.failed ||
          record.status !== 200 ||
          record.encodedBytes > MAX_IMAGE_BYTES
        )
          throw new Error('The displayed photo response was incomplete, denied or too large.');
        const body = await send('Network.getResponseBody', { requestId: record.requestId });
        return { ...record, ...body };
      },
      check() {
        if (failure) throw new Error(failure);
        if (Date.now() >= deadline)
          throw new Error(
            'Collection exceeded its 60-second time limit. Existing covers were not changed.',
          );
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

const cardsExpression = `(() => ({url:location.href,title:document.title,text:document.body.innerText.slice(0,1000),challenge:[...document.querySelectorAll('iframe')].some(f=>/captcha|challenge/i.test(f.src)&&f.getClientRects().length),search:[...document.querySelectorAll('input[type="search"]')].find(i=>i.getClientRects().length)?.value,cards:[...document.querySelectorAll('[data-track-id="card_body"]')].slice(0,60).map(c=>{const i=c.querySelector('img');return {source:c.querySelector('a[href*="/photo/"]')?.href,url:i?.currentSrc||i?.src,title:i?.alt||c.querySelector('a')?.getAttribute('aria-label')||'',author:c.querySelector('[data-track-id="creator_avatar"]')?.textContent?.trim()||'',width:i?.naturalWidth||0,height:i?.naturalHeight||0};})}))()`;

function assertAccessible(snapshot) {
  if (!snapshot?.url?.startsWith('https://500px.com/'))
    throw new Error(
      'The browser could not reach 500px. Check the network connection; no bypass was attempted.',
    );
  if (
    /^https:\/\/500px\.com\/(?:login|signup|auth)(?:\/|\?|$)/.test(snapshot.url) ||
    snapshot.challenge ||
    /access denied|verify you are human|just a moment|too many requests|checking your browser|验证码|访问受限/i.test(
      `${snapshot.title}\n${snapshot.text?.slice(0, 500)}`,
    )
  )
    throw new Error(
      '500px requires sign-in, human verification or has limited access. Collection stopped; existing covers were not changed.',
    );
}

async function waitSnapshot(browser, expression, accepts, timeout, deadline) {
  const until = Math.min(deadline, Date.now() + timeout);
  let snapshot;
  while (Date.now() < until) {
    browser.check();
    snapshot = await browser.evaluate(expression);
    assertAccessible(snapshot);
    if (accepts(snapshot)) return snapshot;
    await pause(350);
  }
  const error = new Error(
    '500px did not provide readable public display images in time. Existing covers were not changed.',
  );
  error.code = 'PUBLIC_DISPLAY_TIMEOUT';
  throw error;
}

export async function collect500px({
  url = DEFAULT_SEARCH,
  output,
  limit = 6,
  browser: requestedBrowser,
  query,
  downloadDir,
} = {}) {
  url = validateSearchUrl(url);
  if (!output || !Number.isInteger(limit) || limit < 1 || limit > 6)
    throw new Error('Provide --output and a --limit between 1 and 6.');
  if (
    query !== undefined &&
    (typeof query !== 'string' ||
      !query.trim() ||
      query.length > 120 ||
      /[\u0000-\u001f]/.test(query))
  )
    throw new Error('--query must be a short search phrase.');
  if (
    downloadDir !== undefined &&
    (typeof downloadDir !== 'string' || !path.isAbsolute(downloadDir))
  )
    throw new Error('--download-dir must be an absolute private directory.');
  if (downloadDir) {
    const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
    const full = path.resolve(downloadDir);
    if (full === publicDir || full.startsWith(publicDir + path.sep))
      throw new Error('Raw download cache must stay outside the public directory.');
    await fs.mkdir(full, { recursive: true });
    downloadDir = await fs.realpath(full);
  }
  const deadline = Date.now() + 60000;
  const browser = await openBrowser(await browserExecutable(requestedBrowser), deadline);
  try {
    const navigation = await browser.send('Page.navigate', { url });
    if (navigation.errorText) throw new Error(`500px navigation failed: ${navigation.errorText}`);
    let search = await waitSnapshot(
      browser,
      cardsExpression,
      (state) => state.cards.length > 0 && state.search === new URL(url).searchParams.get('q'),
      14000,
      deadline,
    );
    if (query && query.trim() !== search.search) {
      await browser.evaluate(
        `(() => { const input=[...document.querySelectorAll('input[type="search"]')].find(i=>i.getClientRects().length); input.focus(); input.select(); })()`,
      );
      await browser.send('Input.insertText', { text: query.trim() });
      await browser.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      await browser.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      // The address/input update before React replaces the old result cards.
      await pause(2200);
      search = await waitSnapshot(
        browser,
        cardsExpression,
        (state) =>
          state.cards.length > 0 &&
          state.search === query.trim() &&
          new URL(state.url).searchParams.get('q') === query.trim(),
        10000,
        deadline,
      );
    }
    // One bounded normal scroll allows the initial visible result cards to load their display images.
    await browser.evaluate('window.scrollBy(0, 650)');
    await pause(1000);
    search = await waitSnapshot(
      browser,
      cardsExpression,
      (state) => chooseCandidates(state.cards, limit).length >= Math.min(limit, 3),
      8000,
      deadline,
    );
    const candidates = chooseCandidates(search.cards, limit);
    const photos = [];
    for (const candidate of candidates) {
      browser.check();
      const previousDocument = await browser.evaluate('performance.timeOrigin');
      const result = await browser.send('Page.navigate', { url: candidate.source });
      if (result.errorText) throw new Error(`500px photo navigation failed: ${result.errorText}`);
      const expression = `(() => ({url:location.href,timeOrigin:performance.timeOrigin,readyState:document.readyState,title:document.title,text:document.body.innerText.slice(0,1000),challenge:[...document.querySelectorAll('iframe')].some(f=>/captcha|challenge/i.test(f.src)&&f.getClientRects().length),images:[...document.images].filter(i=>i.getClientRects().length&&i.naturalWidth>=1024&&i.naturalWidth/i.naturalHeight>=1.35).map(i=>({url:i.currentSrc||i.src,title:i.alt,width:i.naturalWidth,height:i.naturalHeight}))}))()`;
      const matches = (image) => sameDisplayedPhoto(candidate, image);
      let detail;
      try {
        detail = await waitSnapshot(
          browser,
          expression,
          (state) =>
            state.timeOrigin !== previousDocument &&
            ['interactive', 'complete'].includes(state.readyState) &&
            photoPageUrl(state.url) === candidate.source &&
            state.images.some(matches),
          9000,
          deadline,
        );
      } catch (error) {
        if (error.code === 'PUBLIC_DISPLAY_TIMEOUT' && Date.now() < deadline) continue;
        throw error;
      }
      const image = detail.images
        .filter(matches)
        .sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (image) {
        const file = downloadDir
          ? await saveDisplayResponse(downloadDir, await browser.displayResponse(image.url))
          : undefined;
        photos.push({ ...candidate, ...image, title: candidate.title, ...(file ? { file } : {}) });
      }
    }
    const config = coverConfiguration(photos);
    const filename = path.resolve(output);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
      await fs.rename(temporary, filename);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    return {
      output: filename,
      count: config.slides.length,
      requestedSearch: url,
      actualSearch: search.url,
      displayOnly: true,
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const values = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index],
      value = process.argv[index + 1];
    if (
      !['--url', '--output', '--limit', '--browser', '--query', '--download-dir'].includes(key) ||
      !value
    )
      throw new Error(
        'Usage: node scripts/collect-500px.mjs --output <private-config.json> [--url <500px search URL>] [--query <phrase>] [--limit 1..6] [--browser <absolute Edge/Chrome path>] [--download-dir <absolute private directory>]',
      );
    values[key === '--download-dir' ? 'downloadDir' : key.slice(2)] =
      key === '--limit' ? Number(value) : value;
  }
  console.log(JSON.stringify(await collect500px(values)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
