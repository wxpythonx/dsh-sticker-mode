#!/usr/bin/env node
/**
 * tools/curate.mjs — 表情包图库候选抓取 + 对比图生成
 *
 * 为什么要有"对比图"这一步：
 *   插件运行时我看不到图，只能按标题猜（因此才会搜出"枣 蟹"那种荤梗）。
 *   但**离线策展时我能真的看图** —— read_image 会把图喂给模型。
 *   为了不至于为 60 张候选消耗巨量上下文，这里把每个标签的候选
 *   拼成一张带序号的对比图：一个标签看一屏，还能横向比较。
 *
 * 用法：node tools/curate.mjs
 * 输出：library/_staging/<标签>/c<序号>.<ext>  候选原图
 *       library/_staging/<标签>/sheet.jpg     带序号的对比图（供人工/模型过目）
 *       控制台打印 manifest（序号 → 标题 → 文件名 → 大小）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

// sharp 用来拼对比图。它随 DSH 的附件体系一起装，所以在工作区里解析不到 ——
// 从 DSH profile 的 node_modules 借。可用 DSH_PROFILE_DIR 覆盖。
const profileDir = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'web');
let sharp;
try {
  sharp = createRequire(pathToFileURL(join(profileDir, 'package.json')))('sharp');
} catch (cause) {
  console.error(
    `找不到 sharp（试过 ${profileDir}）。\n` +
      '  它随 DSH 的附件体系安装；若 profile 不在该位置，用 DSH_PROFILE_DIR 指定，\n' +
      '  或在本仓库里 npm i -D sharp。',
  );
  throw cause;
}

const REFERER = 'https://fabiaoqing.com/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SEARCH_BASE = 'https://fabiaoqing.com/search/bqb/keyword/';

const OUT_ROOT = process.argv[2] || 'library/_staging';
/** 每个标签取几张候选 */
const PER_TAG = 5;
const CELL = 320;

/** 标签 → 搜索关键词。标签是要给模型用的语义入口，关键词是给上游用的。 */
const TAGS = [
  ['鼓掌', '鼓掌'],
  ['无语', '无语'],
  ['震惊', '震惊'],
  ['摸鱼', '摸鱼'],
  ['谢谢', '谢谢'],
  ['加油', '加油'],
  ['收到', '收到'],
  ['厉害', '厉害'],
  ['告辞', '告辞'],
  ['尴尬', '尴尬'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(keyword) {
  const r = await fetch(`${SEARCH_BASE}${encodeURIComponent(keyword)}`, {
    headers: { 'User-Agent': UA, Referer: REFERER },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`search HTTP ${r.status}`);
  const html = await r.text();
  const rx = /data-original="(https:\/\/img\.soutula\.com\/([A-Za-z0-9_]+)\/([A-Za-z0-9_.-]+\.(?:gif|jpg|jpeg|png|webp)))"[^>]*?(?:title|alt)="([^"]*)"/gi;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = rx.exec(html)) !== null) {
    const [, url, dir, file, title] = m;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      dir,
      file,
      ext: (file.split('.').pop() || 'jpg').toLowerCase(),
      animated: /\.gif$/i.test(file),
      title: title.replace(/&amp;/g, '&').replace(/[-_ ]*发表情$/, '').trim(),
    });
    if (out.length >= PER_TAG) break;
  }
  return out;
}

async function download(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: REFERER, Accept: 'image/*' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`img HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const labelSvg = (n) =>
  `<svg width="38" height="28" xmlns="http://www.w3.org/2000/svg">` +
  `<rect width="38" height="28" rx="6" fill="#111" fill-opacity="0.84"/>` +
  `<text x="19" y="20" font-family="sans-serif" font-size="17" font-weight="700" ` +
  `fill="#fff" text-anchor="middle">${n}</text></svg>`;

/** 把若干候选拼成一张 CELL 见方 × N 的对比图，每格左上角标序号。 */
async function makeSheet(files, sheetPath) {
  const composites = [];
  for (let i = 0; i < files.length; i++) {
    let buf;
    try {
      buf = await sharp(files[i], { failOn: 'none' })
        .resize(CELL - 20, CELL - 20, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 90 })
        .toBuffer();
    } catch (e) {
      console.log(`      (第 ${i} 张无法解码：${e.message})`);
      continue;
    }
    const meta = await sharp(buf).metadata();
    const left = i * CELL + Math.round((CELL - meta.width) / 2);
    const top = Math.round((CELL - meta.height) / 2);
    composites.push({ input: buf, left, top });
    composites.push({ input: Buffer.from(labelSvg(i)), left: i * CELL + 8, top: 8 });
  }
  await sharp({
    create: { width: CELL * files.length, height: CELL, channels: 3, background: '#ffffff' },
  })
    .composite(composites)
    .jpeg({ quality: 90 })
    .toFile(sheetPath);
}

const manifest = {};
for (const [tag, keyword] of TAGS) {
  const dir = join(OUT_ROOT, tag);
  try {
    const items = await search(keyword);
    if (items.length === 0) {
      console.log(`### ${tag}  —— 上游没返回结果`);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    const files = [];
    const rows = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      try {
        const buf = await download(it.url);
        const file = join(dir, `c${i}.${it.ext}`);
        writeFileSync(file, buf);
        files.push(file);
        rows.push({ i, tag, keyword, file: `c${i}.${it.ext}`, remote: it.url, dir: it.dir, name: it.file, animated: it.animated, title: it.title, bytes: buf.length });
      } catch (e) {
        console.log(`      (下载失败 #${i}：${e.message})`);
      }
      await sleep(120); // 上游会限流，客气一点
    }
    if (files.length > 0) await makeSheet(files, join(dir, 'sheet.jpg'));
    manifest[tag] = rows;
    console.log(`### ${tag}  (关键词「${keyword}」, ${rows.length} 张)  sheet: ${join(dir, 'sheet.jpg')}`);
    for (const r of rows) {
      console.log(`   ${r.i}. [${r.animated ? '动' : '静'}] ${(r.bytes / 1024).toFixed(0)}KB  ${r.title.slice(0, 62)}`);
    }
  } catch (e) {
    console.log(`### ${tag}  —— 失败：${e.message}`);
  }
  await sleep(250);
}

writeFileSync(join(OUT_ROOT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nmanifest -> ${join(OUT_ROOT, 'manifest.json')}`);
