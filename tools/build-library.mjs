#!/usr/bin/env node
/**
 * tools/build-library.mjs — 把过目后选中的候选固化成正式图库
 *
 * 输入：library/_staging/<标签>/c<序号>.<ext>（由 curate.mjs 抓取）
 * 输出：library/<标签>/<n>.<ext> + library/index.json + library/_audit.jpg（审核图）
 *
 * ⚠️ 一个必须小心的坑（第一次就踩到了）：
 *   抓取阶段上游会限流，某些候选下载失败 → 文件号出现断档
 *   （例如「谢谢」只剩 c0 和 c4）。而对比图 sheet.jpg 上的标签是
 *   **排列序号**（files 数组下标），不是文件号 —— 两者在断档时不相等。
 *   所以 CHOICES 里一律用**文件号**（= 对比图上第几个格子的实际来源），
 *   并在最后生成 _audit.jpg 全量核对一遍：图库里的每张图到底是什么。
 *
 * CHOICES 里的标题/描述都是**看过图之后**写的，不是照抄上游标题
 * （上游标题常与画面不符，甚至藏荤梗）。被否掉的典型：
 *   尴尬 #2（低俗）、厉害 #0/#2/#3/#4（是"万能回复表格"不是表情包）、
 *   收到 #2（转账营销）、加油 #0（"男神加油"，语境太窄）。
 */
import { mkdirSync, writeFileSync, readdirSync, copyFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

// sharp 用来拼对比图/审核图。它随 DSH 的附件体系一起装，所以在工作区里
// 解析不到 —— 从 DSH profile 的 node_modules 借。可用 DSH_PROFILE_DIR 覆盖。
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

const STAGING = 'library/_staging';
const LIB = 'library';
const CELL = 260;

/**
 * 标签 → 磁盘目录名（ASCII）。
 *
 * 为什么不用中文目录名：URL 里的中文必须百分号编码（%E6%91%B8%E9%B1%BC），
 * 而 DSH 的 Markdown 净化器是压缩过的、无法确认它会不会把 `%` 再编码一次
 * （变成 %25E6... → 404 破图）。用 ASCII slug 就把这个不确定性彻底消掉，
 * 同时 URL 也更好读。**中文标签仍然是检索键**（index.json 的 tags 的 key）。
 */
const SLUGS = {
  鼓掌: 'guzhang',
  无语: 'wuyu',
  震惊: 'zhenjing',
  摸鱼: 'moyu',
  谢谢: 'xiexie',
  加油: 'jiayou',
  收到: 'shoudao',
  厉害: 'lihai',
  告辞: 'gaoci',
  尴尬: 'ganga',
};

/** [标签, 候选文件号, 输出序号, 标题, 描述] */
const CHOICES = [
  ['鼓掌', 3, 1, '啥也别说了，鼓掌吧！', '熊猫头举双手鼓掌，配文「啥也别说了，鼓掌吧！」，动图'],
  ['鼓掌', 4, 2, '鼓掌（小黄鸡）', '小黄鸡拍手鼓掌，画面干净可爱，动图'],

  ['无语', 1, 1, '我是一滴无语泉水', '蓝色水滴小人翻着白眼微笑，配文「我是一滴无语泉水」，表达被无语到'],
  ['无语', 2, 2, '无语到家了', 'Hello Kitty 面无表情，配文「无语妈妈给无语开门 无语到家了」'],

  ['震惊', 1, 1, '啊这', '游戏卡牌造型，配文「啊这」＋「当别人发出令人震惊的消息，你可以发动此卡」，万用反应图'],
  ['震惊', 2, 2, '震惊', '熊猫头瞪圆眼睛，配文「震惊」，最通用的一张'],

  ['摸鱼', 2, 1, '今天我们都是摸鱼人', '许多只手一起摸鱼，配文「今天 我们都是摸鱼人」'],
  ['摸鱼', 3, 2, '论摸鱼你是比不过我的', '大笑表情抱着鱼，配文「论摸鱼 你是比不过我的」'],

  ['谢谢', 4, 1, '多谢，谢谢大家', '猫和老鼠汤姆抱拳致谢，配文「多谢 谢谢 谢谢大家」'],

  ['加油', 2, 1, '加油加油！', '真人女孩握拳鼓劲，配文「加油 加油！」，语气中性通用，动图'],

  ['收到', 0, 1, '收到收到 over', '熊猫头手持对讲机，配文「收到收到 over」，动图'],
  ['收到', 4, 2, '收到请回复！Over！', '熊猫头拿对讲机，配文「日常保持小火苗 收到请回复！Over！」'],

  ['厉害', 1, 1, '厉害了我的哥', '蘑菇头竖大拇指点赞，配文「厉害了我的哥」，表示佩服'],

  ['告辞', 2, 1, '我家床生病了，告辞', '黑白人脸伸手做告别状，配文「我家床生病了，我要回去照顾它，告辞」，礼貌撤离话题'],
  ['告辞', 4, 2, '套路这么深！告辞', '同一形象，配文「套路这么深！告辞」'],

  ['尴尬', 1, 1, '冒汗', '极简简笔画小人，头上三条汗线，表达尴尬；画面最干净的一张，动图'],
  ['尴尬', 4, 2, '绿色熊头冒汗', '绿色熊头满脸汗珠，下方一排省略号，适合尴尬到说不出话'],
];

// 清掉上次的产物，避免残留脏文件（例如换了扩展名/目录名后旧文件还在）。
// 注意：rmSync(force:true) 在这里实测会**静默不删**（Windows 上删目录失败不报错），
// 所以这里显式 try/catch + 打印，最后还有一道构建后断言兜底。
for (const tag of new Set(CHOICES.map((c) => c[0]))) {
  for (const dirName of [SLUGS[tag] ?? tag, tag]) {
    const d = join(LIB, dirName);
    if (!existsSync(d)) continue;
    try {
      rmSync(d, { recursive: true });
    } catch (e) {
      console.log(`  ! 清理 ${d} 失败：${e.message}（构建后断言会兜住）`);
    }
  }
}

const index = { version: 1, source: 'fabiaoqing.com（逐张过目筛选）', tags: {} };
const picked = []; // { tag, rel, title, animated }
const missing = [];

for (const [tag, srcIdx, outIdx, title, desc] of CHOICES) {
  const dir = join(STAGING, tag);
  const hit = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith(`c${srcIdx}.`)) : null;
  if (!hit) {
    missing.push(`${tag}#${srcIdx}`);
    continue;
  }
  const ext = extname(hit).toLowerCase();
  const animated = ext === '.gif'; // 以实际文件类型为准，不靠手写
  const slug = SLUGS[tag] ?? tag;
  const rel = `${slug}/${outIdx}${ext}`;
  mkdirSync(join(LIB, slug), { recursive: true });
  copyFileSync(join(dir, hit), join(LIB, rel));
  (index.tags[tag] ??= []).push({ slug, file: rel, title, desc, animated });
  picked.push({ tag, rel, title, animated });
  console.log(`  ${rel.padEnd(16)} ${animated ? '动图' : '静图'}  ${title}`);
}

writeFileSync(join(LIB, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);

// ---- 构建后断言：磁盘目录必须与索引严格一一对应，否则拒绝继续 ----
{
  const refs = new Set();
  for (const arr of Object.values(index.tags)) for (const e of arr) refs.add(e.file);
  const onDisk = [];
  for (const d of readdirSync(LIB)) {
    if (d === '_staging' || d.startsWith('_audit')) continue;
    const abs = join(LIB, d);
    if (!statSync(abs).isDirectory()) continue;
    for (const f of readdirSync(abs)) onDisk.push(`${d}/${f}`);
  }
  const missing = [...refs].filter((r) => !onDisk.includes(r));
  const extra = onDisk.filter((f) => !refs.has(f));
  if (missing.length || extra.length) {
    console.error('\n✗ 图库自检失败：');
    if (missing.length) console.error('  索引引用但磁盘缺失:', missing.join(', '));
    if (extra.length) console.error('  磁盘存在但未索引（脏文件）:', extra.join(', '));
    process.exit(1);
  }
  console.log(`\n✓ 自检通过：索引 ${refs.size} 条 = 磁盘 ${onDisk.length} 个文件，无缺失无多余`);
}

// ---- 审核图：分条输出（一条最多 6 格，接近原始分辨率，缩图后仍看得清）----
const PER_STRIP = 6;
const labelSvg = (n, tag) =>
  `<svg width="${CELL}" height="28" xmlns="http://www.w3.org/2000/svg">` +
  `<rect width="${CELL}" height="28" fill="#111" fill-opacity="0.86"/>` +
  `<text x="26" y="20" font-family="sans-serif" font-size="16" font-weight="700" ` +
  `fill="#fff" text-anchor="middle">${n}</text>` +
  `<text x="70" y="20" font-family="sans-serif" font-size="15" ` +
  `fill="#9be89b" text-anchor="start">${tag}</text></svg>`;

const stripFiles = [];
for (let s = 0; s * PER_STRIP < picked.length; s++) {
  const slice = picked.slice(s * PER_STRIP, (s + 1) * PER_STRIP);
  const composites = [];
  for (let i = 0; i < slice.length; i++) {
    const buf = await sharp(join(LIB, slice[i].rel), { failOn: 'none' })
      .resize(CELL - 20, CELL - 42, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 90 })
      .toBuffer();
    const meta = await sharp(buf).metadata();
    composites.push({
      input: buf,
      left: i * CELL + Math.round((CELL - meta.width) / 2),
      top: 34 + Math.round((CELL - 42 - meta.height) / 2),
    });
    composites.push({ input: Buffer.from(labelSvg(s * PER_STRIP + i, slice[i].tag)), left: i * CELL, top: 0 });
  }
  const out = join(LIB, `_audit-${s + 1}.jpg`);
  await sharp({ create: { width: CELL * slice.length, height: CELL, channels: 3, background: '#ffffff' } })
    .composite(composites)
    .jpeg({ quality: 90 })
    .toFile(out);
  stripFiles.push(`${out}  (编号 ${s * PER_STRIP}–${s * PER_STRIP + slice.length - 1})`);
}

console.log(`\n共 ${picked.length} 张 / ${Object.keys(index.tags).length} 个标签`);
console.log('审核图编号 → 内容：');
picked.forEach((p, i) => console.log(`  ${String(i).padStart(2)}  ${p.tag.padEnd(4)} ${p.title}`));
if (missing.length) console.log(`\n缺失（候选未抓到，需重跑 curate）：${missing.join(', ')}`);
console.log(`\nindex -> ${join(LIB, 'index.json')}`);
console.log('audit ->');
for (const f of stripFiles) console.log(`  ${f}`);
