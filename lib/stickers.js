/**
 * 表情包上游访问层（纯 Node，不依赖 DSH API，便于单测）
 *
 * 上游 fabiaoqing.com / img.soutula.com 的两个硬约束：
 *   1. 图片 CDN 强制校验 Referer（必须是 https://fabiaoqing.com/），
 *      而浏览器直连不会带 Referer（DSH 的 <img> 写死 referrerPolicy="no-referrer"），
 *      所以必须由 Host 侧代理字节。
 *   2. 上游会限流、会挂住 —— 所有请求都必须带超时 + 重试，
 *      否则会把调用方永久吊死（实测踩到过，见 README）。
 */
import { Buffer } from 'node:buffer';

export const UPSTREAM_IMG_HOST = 'img.soutula.com';
export const REFERER = 'https://fabiaoqing.com/';
export const SEARCH_BASE = 'https://fabiaoqing.com/search/bqb/keyword/';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const IMG_TIMEOUT_MS = 10_000;
const SEARCH_TIMEOUT_MS = 8_000;

/** 允许的上游目录（同时也是防目录穿越的白名单） */
export const ALLOWED_DIRS = new Set(['large', 'bmiddle', 'thumb', 'small', 'mw600', 'mw690']);
export const PATH_RX = /^\/([A-Za-z0-9_]+)\/([A-Za-z0-9_.-]+\.(?:gif|jpg|jpeg|png|webp))$/i;

/** 字节上限 LRU：GIF 动图单张可达数百 KB～数 MB，只数字条会吃爆内存 */
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
let cacheBytes = 0;
const cache = new Map();

function remember(url, buf, type) {
  cache.set(url, { buf, type });
  cacheBytes += buf.byteLength;
  while (cacheBytes > CACHE_MAX_BYTES && cache.size > 1) {
    const oldest = cache.keys().next().value;
    cacheBytes -= cache.get(oldest).buf.byteLength;
    cache.delete(oldest);
  }
}

export function cacheStats() {
  return { entries: cache.size, bytes: cacheBytes };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带 Referer 拉取上游图片字节。
 * @param {string} url 形如 https://img.soutula.com/large/xxx.gif
 * @returns {Promise<{buf: Buffer, type: string}>}
 */
export async function fetchImage(url) {
  const hit = cache.get(url);
  if (hit) return hit;

  const headers = {
    'User-Agent': USER_AGENT,
    Referer: REFERER,
    Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
  };

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const up = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(IMG_TIMEOUT_MS),
      });
      if (!up.ok) throw new Error(`upstream HTTP ${up.status}`);
      const type = (up.headers.get('content-type') || '').split(';')[0].trim();
      if (!type.startsWith('image/')) throw new Error(`上游返回的不是图片: ${type || 'unknown'}`);
      const buf = Buffer.from(await up.arrayBuffer());
      remember(url, buf, type);
      return { buf, type };
    } catch (e) {
      lastError = e;
      if (attempt < 3) await sleep(150 * attempt);
    }
  }
  throw lastError;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * 搜索表情包。返回的 url 是**本插件自己的同源地址**（由 buildUrl 生成），
 * 这样浏览器取图不受 Referer 限制，也不依赖第二个端口/防火墙。
 *
 * @param {string} keyword 关键词
 * @param {number} limit 最多返回几张
 * @param {(dir: string, file: string) => string} buildUrl 由调用方注入同源 URL 构造器
 * @returns {Promise<Array<{title:string, animated:boolean, url:string, remote:string}>>}
 */
export async function searchStickers(keyword, limit, buildUrl) {
  let html;
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const up = await fetch(`${SEARCH_BASE}${encodeURIComponent(keyword)}`, {
        headers: { 'User-Agent': USER_AGENT, Referer: REFERER },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!up.ok) throw new Error(`搜索页 HTTP ${up.status}`);
      html = await up.text();
      break;
    } catch (e) {
      lastError = e;
      if (attempt < 2) await sleep(200);
    }
  }
  if (html === undefined) throw lastError;

  const rx = new RegExp(
    `data-original="(https://${UPSTREAM_IMG_HOST.replace(/\./g, '\\.')}/([A-Za-z0-9_]+)/([A-Za-z0-9_.-]+\\.(?:gif|jpg|jpeg|png|webp)))"[^>]*?(?:title|alt)="([^"]*)"`,
    'gi',
  );

  const items = [];
  const seen = new Set();
  let m;
  while ((m = rx.exec(html)) !== null) {
    const [, remote, dir, file, rawTitle] = m;
    if (seen.has(remote)) continue;
    seen.add(remote);
    items.push({
      title: decodeEntities(rawTitle).replace(/[-_ ]*发表情$/, '').trim(),
      animated: /\.gif$/i.test(file),
      url: buildUrl(dir, file),
      remote,
    });
    if (items.length >= limit) break;
  }
  return items;
}

/**
 * 把上游 URL 或 /s/<dir>/<file> 形态的路径解析成受信的上游 URL。
 * 非法输入返回 undefined（白名单 + 扩展名双重校验）。
 */
export function resolveRemote(input) {
  try {
    const parsed = new URL(input);
    if (parsed.hostname !== UPSTREAM_IMG_HOST) return undefined;
    const m = PATH_RX.exec(parsed.pathname);
    if (!m || !ALLOWED_DIRS.has(m[1])) return undefined;
    return `https://${UPSTREAM_IMG_HOST}/${m[1]}/${m[2]}`;
  } catch {
    return undefined;
  }
}

/** 由 dir/file 直接构造上游 URL（dir 必须已在白名单内）。 */
export function remoteFromParts(dir, file) {
  if (!ALLOWED_DIRS.has(dir)) return undefined;
  if (!/^[A-Za-z0-9_.-]+\.(?:gif|jpg|jpeg|png|webp)$/i.test(file)) return undefined;
  return `https://${UPSTREAM_IMG_HOST}/${dir}/${file}`;
}
