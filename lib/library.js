/**
 * lib/library.js — 本地图库（逐张过目筛选过的那份）
 *
 * 为什么要有本地图库：
 *   线上搜索只能按**标题**判断内容，上游标题经常与画面不符、甚至藏荤梗
 *   （实测搜"完美"第一张就是荤梗）。本地图库里的 17 张是我真的看过图之后
 *   选定的，标题/描述也是按画面写的，所以选图既准又干净；而且不再依赖
 *   上游可用性，图片字节直接从磁盘出（连 Referer 防盗链都绕过了）。
 *
 * 索引文件：library/index.json
 *   { "version":1, "tags": { "鼓掌": [ { "file":"鼓掌/1.gif", "title":"…", "desc":"…", "animated":true } ] } }
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LIBRARY_DIR = join(HERE, '..', 'library');
const INDEX_FILE = join(LIBRARY_DIR, 'index.json');

let cache = null;

/** 读取（并缓存）图库索引。读失败时降级成空库，不影响线上搜索那条路。 */
export function loadLibrary() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
    const entries = [];
    for (const [tag, arr] of Object.entries(raw?.tags ?? {})) {
      for (const e of arr ?? []) {
        if (typeof e?.file !== 'string') continue;
        entries.push({
          tag,
          file: e.file,
          title: String(e.title ?? ''),
          desc: String(e.desc ?? ''),
          animated: e.animated === true,
        });
      }
    }
    cache = {
      ok: true,
      version: raw?.version ?? 1,
      source: String(raw?.source ?? ''),
      tags: Object.keys(raw?.tags ?? {}),
      entries,
      byFile: new Map(entries.map((e) => [e.file, e])),
    };
  } catch (e) {
    cache = { ok: false, version: 0, source: '', tags: [], entries: [], byFile: new Map(), error: String(e?.message ?? e) };
  }
  return cache;
}

/** 仅按索引白名单解析文件 —— 不落在索引里的路径一律拒绝（顺带杜绝目录穿越）。 */
export function resolveLibraryFile(rel) {
  const lib = loadLibrary();
  return lib.byFile.get(rel) ?? null;
}

/** index.json 里的 file 形如 "鼓掌/1.gif"，拆成可安全编码的两段。 */
export function splitLibraryFile(rel) {
  const i = rel.lastIndexOf('/');
  if (i <= 0) return null;
  return { tag: rel.slice(0, i), name: rel.slice(i + 1) };
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * 在本地图库里按关键词找图。
 * 打分优先级：标签精确命中 > 标签包含 > 标题包含 > 描述包含。
 * @returns 命中的条目数组（含 score），最多 limit 条
 */
export function findLocal(query, limit = 5) {
  const q = norm(query);
  if (!q) return [];
  const scored = [];
  for (const e of loadLibrary().entries) {
    const tag = norm(e.tag);
    const title = norm(e.title);
    const desc = norm(e.desc);
    let score = 0;
    if (tag === q) score = 100;
    else if (tag.includes(q) || q.includes(tag)) score = 70;
    else if (title.includes(q)) score = 45;
    else if (desc.includes(q)) score = 25;
    if (score > 0) scored.push({ ...e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return scored.slice(0, limit);
}
