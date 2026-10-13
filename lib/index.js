/**
 * dsh-sticker-mode — host half.
 *
 * 「表情包模式」：GUI 上一个开关（仿 jev），打开后 agent 每次回复末尾自动附一张表情包。
 *
 * 为什么需要这个插件（三个已实测的硬约束）：
 *   1. **模型发不出图片**。生产适配器声明 text-only 输出，assistant 消息里塞 image 块
 *      是前向兼容而非可用能力。所以图只能靠 Markdown 图片链接，由前端 <img> 渲染。
 *   2. **上游防盗链**。img.soutula.com 强制校验 Referer=fabiaoqing.com，而 DSH 的 <img>
 *      写死 referrerPolicy="no-referrer" —— 浏览器直连必然 403。故图片字节必须由 Host 代理。
 *   3. **客户端未必在本机**。DSH 的 Web 服务默认监听 0.0.0.0，浏览器可能在另一台设备上；
 *      所以 URL 里写死 127.0.0.1 会指向浏览器自己的 loopback（破图）。
 *      插件把图片路由挂在 DSH 自己的 Web 服务上（同源、免鉴权），
 *      并让浏览器半边上报 location.origin，从而永远生成客户端可达的地址。
 *
 * Agent 感知开关状态：靠 ctx.systemPrompt.section 的**函数式 text**——
 * 每次 model assembly 都重新求值，所以开关一翻立刻生效，且不增加任何 step。
 * （也顺带避免了「把状态写进工具 description」这种不存在的机制：
 *   dsh-tools 的 schemas() 只白名单 name/description/parameters，不会动态重算。）
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { gateMeta, isStickerModeOn, readGate, setStickerMode } from './gate.js';
import {
  ALLOWED_DIRS,
  PATH_RX,
  cacheStats,
  fetchImage,
  remoteFromParts,
  searchStickers,
} from './stickers.js';
import {
  LIBRARY_DIR,
  findLocal,
  loadLibrary,
  resolveLibraryFile,
  splitLibraryFile,
} from './library.js';

export const name = 'dsh-sticker-mode';

// webServer 必须 inject，否则 apply 会早于 Web 服务就绪、路由注册不上。
// （指令注入走 agent/pre-step 事件，不需要 systemPrompt 服务——见下文说明。）
export const inject = ['tools', 'webServer'];

/** 线上图片路由前缀。自定义路由不落在 /api 下，因此不经过三重同源校验，可匿名取图。 */
const IMG_PREFIX = '/sticker-mode/img';
/** 本地图库图片路由前缀（逐张过目筛选过的那 17 张）。 */
const LIB_PREFIX = '/sticker-mode/lib';
const STATE_PATH = '/sticker-mode/state';
const CLIENT_PATH = '/sticker-mode/client';

/** 选出内网 IPv4，作为「浏览器还没上报 origin」时的兜底。 */
function lanCandidates() {
  const out = [];
  try {
    for (const [ifName, addrs] of Object.entries(networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        out.push({ address: a.address, name: ifName });
      }
    }
  } catch {
    /* 拿不到网卡就退回下面的默认值 */
  }
  return out;
}

export function apply(ctx) {
  // ---------------------------------------------------------------- 状态
  //
  // origin（图片地址的前缀主机）必须**按会话**记，不能只存一个全局值。
  // 一台多网卡的机器上，不同客户端要用各自可达的地址：只留一个"最后上报值"
  // 会让别的客户端拿到不可达的 URL → 图全破（实测踩过：A 地址上报后，从 B 地址访问看不见图）。
  //
  // 另外一个固有限制：地址是在**工具调用那一刻写进消息文本**的，事后不会变。
  // 所以同一条消息在另一台设备上打开，仍会指向生成时的那个地址
  // —— 客户端半边会在渲染时就地改写前缀来兜这个底。
  const originBySession = new Map(); // sessionId -> { origin, at }
  let lastOrigin = null; // 兜底：最近一次任意客户端上报
  const ORIGIN_TTL_MS = 12 * 60 * 60 * 1000;
  const webPort = Number(process.env.DSH_STICKER_MODE_PORT) || 3080;

  /**
   * 兜底地址：只在「从来没有任何客户端上报过 origin」时用到。
   *
   * 默认 localhost，**不猜网卡** —— 多网卡机器上"取第一张网卡"实测会取错，
   * 而局域网访问本来就会被客户端上报覆盖，猜错只会更糟。
   * 需要固定值时用 DSH_STICKER_MODE_ORIGIN（例如 http://192.168.1.10:3080）。
   */
  function fallbackOrigin() {
    const env = process.env.DSH_STICKER_MODE_ORIGIN;
    if (env) return env.replace(/\/+$/, '');
    return `http://127.0.0.1:${webPort}`;
  }

  /** 取该会话对应浏览器可达的地址；没有则退回最近上报值，再退回服务端兜底。 */
  function originFor(sessionId) {
    const hit = sessionId ? originBySession.get(sessionId) : null;
    if (hit && Date.now() - hit.at < ORIGIN_TTL_MS) return hit.origin;
    return lastOrigin ?? fallbackOrigin();
  }

  const originNow = (sessionId) => originFor(sessionId);
  const originSource = (sessionId) =>
    sessionId && originBySession.has(sessionId) ? 'client-session' : lastOrigin ? 'client-global' : 'fallback';

  /** 线上图片地址。sessionId 决定用哪个主机前缀。 */
  const buildUrl = (dir, file, sessionId) =>
    `${originNow(sessionId)}${IMG_PREFIX}/${dir}/${file}`;

  /** 本地图库条目的可嵌入地址（磁盘目录是 ASCII slug，所以无需百分号编码）。 */
  const buildLibraryUrl = (rel, sessionId) => {
    const parts = splitLibraryFile(rel);
    if (!parts) return null;
    return `${originNow(sessionId)}${LIB_PREFIX}/${parts.tag}/${parts.name}`;
  };

  // ---------------------------------------------------------------- HTTP
  /** 同源校验：Origin 必须存在且与 Host 一致。用于有副作用的端点，防 CSRF。 */
  function sameOrigin(req) {
    const origin = req.headers?.origin;
    const host = req.headers?.host;
    if (typeof origin !== 'string' || typeof host !== 'string') return false;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  async function readBody(req, limit = 64 * 1024) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) throw new Error('body too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  function sendJson(res, code, obj) {
    const body = Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  function sendText(res, code, text) {
    const body = Buffer.from(String(text), 'utf8');
    res.writeHead(code, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  /** 图片代理：/sticker-mode/img/<dir>/<file> —— 同源、匿名可取的字节流。 */
  async function imageHandler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'only GET/HEAD');
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      return sendText(res, 400, 'bad url');
    }
    const rest = pathname.slice(IMG_PREFIX.length) || '/';
    const m = PATH_RX.exec(rest);
    if (!m || !ALLOWED_DIRS.has(m[1])) return sendText(res, 404, 'not found');
    const remote = remoteFromParts(m[1], m[2]);
    if (!remote) return sendText(res, 404, 'not found');
    try {
      const { buf, type } = await fetchImage(remote);
      res.writeHead(200, {
        'content-type': type,
        'content-length': String(buf.byteLength),
        'cache-control': 'public, max-age=86400',
        'referrer-policy': 'no-referrer',
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    } catch (e) {
      sendText(res, 502, `upstream failed: ${e?.message ?? e}`);
    }
  }

  /**
   * 本地图库图片：/sticker-mode/lib/<标签>/<文件>
   * 只认索引白名单里的条目——既限定了可服务的文件，也顺带杜绝目录穿越
   * （不存在的路径连白名单都进不去）。字节直接从磁盘出，不碰上游。
   */
  async function libraryImageHandler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'only GET/HEAD');
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      return sendText(res, 400, 'bad url');
    }
    let rel;
    try {
      rel = decodeURIComponent(pathname.slice(LIB_PREFIX.length) || '').replace(/^\/+/, '');
    } catch {
      return sendText(res, 400, 'bad encoding');
    }
    if (!resolveLibraryFile(rel)) return sendText(res, 404, 'not in library');
    const abs = join(LIBRARY_DIR, ...rel.split('/'));
    try {
      const buf = await readFile(abs);
      const lower = rel.toLowerCase();
      const type = lower.endsWith('.gif')
        ? 'image/gif'
        : lower.endsWith('.png')
          ? 'image/png'
          : lower.endsWith('.webp')
            ? 'image/webp'
            : 'image/jpeg';
      res.writeHead(200, {
        'content-type': type,
        'content-length': String(buf.byteLength),
        'cache-control': 'public, max-age=86400',
        'referrer-policy': 'no-referrer',
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    } catch (e) {
      sendText(res, 404, `library file unreadable: ${e?.message ?? e}`);
    }
  }

  /**
   * 状态读写：GET 读；POST {enabled, sessionId?} 写（带同源校验）。
   * GET 带 ?sessionId= 时返回该会话的生效状态；POST 带 sessionId 时写该会话的覆盖值。
   * 不带 sessionId 一律作用于 default（新会话的初始值）。
   */
  async function stateHandler(req, res) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      let sessionId = null;
      try {
        sessionId = new URL(req.url ?? '/', 'http://x').searchParams.get('sessionId') || null;
      } catch {
        /* 解析失败就按无会话处理 */
      }
      return sendJson(res, 200, {
        gate: readGate(sessionId),
        scope: sessionId ? 'session' : 'default',
        origin: originNow(sessionId),
        originSource: originSource(sessionId),
        originsBySession: [...originBySession.entries()].map(([id, v]) => ({
          sessionId: id,
          origin: v.origin,
          ageMs: Date.now() - v.at,
        })),
        gateFile: gateMeta(),
        candidates: lanCandidates(),
        cache: cacheStats(),
        library: { ok: loadLibrary().ok, tags: loadLibrary().tags, count: loadLibrary().entries.length },
      });
    }
    if (req.method !== 'POST') return sendText(res, 405, 'only GET/POST');
    if (!sameOrigin(req)) return sendText(res, 403, 'cross-origin write rejected');
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (typeof body.enabled !== 'boolean') return sendText(res, 400, 'expected {enabled:boolean}');
      const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null;
      setStickerMode(body.enabled, 'panel', sessionId);
      return sendJson(res, 200, { ok: true, scope: sessionId ? 'session' : 'master', gate: readGate(sessionId) });
    } catch (e) {
      return sendText(res, 400, `bad request: ${e?.message ?? e}`);
    }
  }

  /** 浏览器上报 location.origin —— 让 Host 知道「客户端可达地址」到底是哪个。 */
  async function clientHandler(req, res) {
    if (req.method !== 'POST') return sendText(res, 405, 'only POST');
    if (!sameOrigin(req)) return sendText(res, 403, 'cross-origin write rejected');
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const origin = String(body.origin ?? '');
      const parsed = new URL(origin);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return sendText(res, 400, 'origin must be http(s)');
      }
      const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null;
      const at = Date.now();
      if (sessionId) originBySession.set(sessionId, { origin: parsed.origin, at });
      lastOrigin = parsed.origin;
      return sendJson(res, 200, {
        ok: true,
        origin: parsed.origin,
        sessionId,
        sessions: originBySession.size,
      });
    } catch (e) {
      return sendText(res, 400, `bad request: ${e?.message ?? e}`);
    }
  }

  /**
   * 注册必须"失败即降级"。apply 里抛异常会让整个 web shell 起不来；
   * 而重复注册（例如插件既被 patch 行加载、又被 market 热挂载）会直接抛错。
   * 所以每一项都单独兜住，坏一项不影响其余。
   */
  function safely(label, register) {
    try {
      ctx.effect(
        () => {
          try {
            return register();
          } catch (e) {
            ctx.logger?.warn?.(`[sticker-mode] ${label} failed: ${e?.message ?? e}`);
            return () => {};
          }
        },
        `sticker-mode: ${label}`,
      );
    } catch (e) {
      ctx.logger?.warn?.(`[sticker-mode] effect(${label}) failed: ${e?.message ?? e}`);
    }
  }

  safely('image route', () =>
    ctx.webServer.register({ kind: 'prefix', path: IMG_PREFIX, handler: imageHandler }),
  );
  safely('library image route', () =>
    ctx.webServer.register({ kind: 'prefix', path: LIB_PREFIX, handler: libraryImageHandler }),
  );
  safely('state route', () =>
    ctx.webServer.register({ kind: 'exact', path: STATE_PATH, handler: stateHandler }),
  );
  safely('client-origin route', () =>
    ctx.webServer.register({ kind: 'exact', path: CLIENT_PATH, handler: clientHandler }),
  );

  // ------------------------------------------------- 每步重算的系统提示
  const libTags = loadLibrary().tags;
  const INSTRUCTION = [
    '## 表情包模式（已开启）',
    '',
    '用户打开了「表情包模式」。请在**本次回复的最后一行**附上一张与对话内容相关的表情包：',
    '',
    '1. 调用 `sticker_pick` 工具搜索。**内置图库标签优先**：' + (libTags.length ? libTags.join('、') : '（图库为空）'),
    '   —— 这些是逐张看过后挑选的干净表情，命中就用；没有合适的标签再用其它关键词去线上搜。',
    '2. 工具会返回一行完整的 `![标题](URL)`，**把它原样放在回复末尾**；',
    '3. 只放一张。不要为它加标题、编号或解释文字，也不要放进代码块。',
    '',
    '若返回的标题明显不贴合语境，可以用 `index` 参数换一张，或换个关键词再调一次。',
    '若工具报错或搜不到图，正常结束回复即可，不要为出图而卡住。',
  ].join('\n');

  /**
   * 指令注入：agent/pre-step（每个 model step 的输入组装点）。
   *
   * 为什么不用 systemPrompt.section：它的 text(context) 里 **context.agent 在
   * 真实组装时是 undefined**（类型上有 dsh-agent 的声明合并，运行时却没带）——
   * 于是按会话判断永远落到「关」，开关开着模型也收不到指令（实测踩过）。
   * 而 pre-step 的 payload 直接带 agent（与工具 exec.agent 是同一对象，
   * 会话身份已实测可靠），并且**不增加任何 step**——只是往本步输入里补一条消息。
   * 照搬 dsh-time-context 的官方写法（每步注入当前时间）。
   */
  safely('per-step instruction', () =>
    ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
      const decision = await next();
      if (!decision || decision.kind === 'reject') return decision;
      if (signal?.aborted) return decision;
      if (!Array.isArray(decision.messages)) return decision;
      // 每回合只在第 1 步注入一次：pre-step 每个 model step 都会触发，
      // 无条件注入就是每步一条（实测 81 步的会话被注了 81 条，全是对话噪音）。
      // 指令进入会话日志后，后续 step 本来就能看到它，不需要每步重复。
      if (step !== 1) return decision;
      const sid = agent?.session?.id ?? agent?.sessionId ?? null;

      if (isStickerModeOn(sid)) {
        return {
          ...decision,
          messages: [
            ...decision.messages,
            createUserMessage({
              content: [{ type: 'text', text: INSTRUCTION }],
              source: {
                kind: 'plugin',
                plugin: name,
                form: 'snapshot',
                sections: [{ name: 'sticker-mode', text: INSTRUCTION }],
              },
            }),
          ],
        };
      }

      // 关着的会话注入一句简短的"不要贴"——不注的话，模型会模仿上下文里
      // 历史消息的贴图行为（实测：关掉之后仍跟风贴了一张）。
      const offNote =
        '（表情包模式：本会话未开启。回复中不要附带任何表情包或表情图片——即使更早的消息里有。）';
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text: offNote }],
            source: {
              kind: 'plugin',
              plugin: name,
              form: 'snapshot',
              sections: [{ name: 'sticker-mode-off', text: offNote }],
            },
          }),
        ],
      };
    }),
  );

  // ---------------------------------------------------------------- 工具
  //
  // ⚠️ 两套 schema 方言的坑（实测踩过，会让整个插件加载失败）：
  //   - parameters 与 output.schema 走的都是**作者 DSL**，不是原始 JSON Schema；
  //   - output.schema 写顶层 required: ['text'] 会报
  //     "schema.required is not supported by the value schema DSL"；
  //   - parameters 里可选参数**不能写 required: false**，会报
  //     "parameters.x.required must be true when present"。
  //   必需性只能写在**叶子**上：{ type:'string', required:true }；
  //   可选参数则整个省略 required 字段。
  const TEXT_OUT = {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  };
  const textRender = (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }];

  /** 标题会进 Markdown 的 alt 位置，必须清掉会破坏语法的字符。 */
  const safeAlt = (s) =>
    String(s ?? '')
      .replace(/[[\]]/g, '')
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 60) || '表情包';

  safely('sticker_pick tool', () =>
      ctx.tools.register(
        defineTool({
          name: 'sticker_pick',
          description:
            '搜索并挑选一张表情包，返回一行可直接放进回复末尾的 Markdown 图片（![标题](URL)）。' +
            '优先在内置图库（逐张看过后筛选的干净表情）里找，找不到才去线上搜。' +
            '仅当「表情包模式」开启、需要在回复末尾附一张表情包时调用。',
          parameters: {
            keyword: {
              type: 'string',
              required: true,
              description:
                '中文关键词/标签。内置图库标签：' +
                (libTags.join('、') || '（空）') +
                '；也可用其它词（如「无语」「摸鱼」）去线上搜',
            },
            index: {
              type: 'number',
              description: '候选序号，默认 0（最贴切的那张）。默认那张不贴合时用 1~5 换一张。',
            },
            source: {
              type: 'string',
              description: 'auto（默认，图库优先）/ library（只用内置图库）/ web（只用线上搜索）',
            },
          },
          timeoutMs: 30000,
          output: { schema: TEXT_OUT, render: textRender },
          async execute(args, exec) {
            const keyword = String(args?.keyword ?? '').trim();
            if (!keyword) return { text: 'keyword 不能为空。' };
            const source = ['auto', 'library', 'web'].includes(String(args?.source))
              ? String(args.source)
              : 'auto';
            // 取本会话对应的浏览器地址前缀：多网段下每个客户端要拿各自可达的地址。
            // Agent 上没有直接的 sessionId 字段，会话身份在 agent.session.id（Session 接口）。
            const sessionId =
              exec?.agent?.session?.id ?? exec?.agent?.sessionId ?? exec?.sessionId ?? null;
            // 会话级的礼貌护栏：这个会话没开表情包模式就不贴图（开关按会话区分）。
            if (!isStickerModeOn(sessionId)) {
              return {
                text:
                  '当前会话没有开启表情包模式（开关按会话区分，可在输入框右侧打开，' +
                  '或调用 sticker_mode 工具开启），因此不附图。',
              };
            }
            const webUrl = (dir, file) => buildUrl(dir, file, sessionId);
            const libUrl = (rel) => buildLibraryUrl(rel, sessionId);

            // ---- 1) 内置图库优先：内容经过过目，标题与画面一致，且不依赖上游 ----
            if (source !== 'web') {
              const hits = findLocal(keyword, 6);
              if (hits.length > 0) {
                const want = Math.min(Math.max(Number(args?.index) || 0, 0), hits.length - 1);
                const chosen = hits[want];
                const url = libUrl(chosen.file);
                const others = hits
                  .map((h, i) => ({ h, i }))
                  .filter(({ i }) => i !== want)
                  .slice(0, 5)
                  .map(({ h, i }) => `${i}. ${h.tag}｜${h.title}`)
                  .join('\n');
                return {
                  text: [
                    `已选（内置图库，标签「${chosen.tag}」，序号 ${want}）：${chosen.title}${chosen.animated ? '［动图］' : ''}`,
                    chosen.desc ? `画面：${chosen.desc}` : '',
                    '',
                    '把下面这行**原样**放在回复的最后一行：',
                    '',
                    url ? `![${safeAlt(chosen.title)}](${url})` : '（图库地址构造失败）',
                    '',
                    others ? `图库内其他候选（想换就带 index 再调一次）：\n${others}` : '',
                  ]
                    .filter((l) => l !== '')
                    .join('\n'),
                };
              }
              if (source === 'library') {
                return {
                  text: `内置图库里没有和「${keyword}」相关的条目。可用标签：${libTags.join('、')}`,
                };
              }
            }

            // ---- 2) 回落到线上搜索 ----
            // 上游会限流/超时——搜索失败要优雅降级成一句话，而不是把异常抛给模型。
            let items;
            try {
              items = await searchStickers(keyword, 6, webUrl);
            } catch (e) {
              return {
                text:
                  `线上搜索暂时不可用（${e.message}）。可稍后重试，或改用内置图库标签：${libTags.join('、')}`,
              };
            }
            if (items.length === 0) {
              return { text: `没搜到「${keyword}」相关的表情包，换个关键词再试。` };
            }
            const want = Math.min(Math.max(Number(args?.index) || 0, 0), items.length - 1);

            // 逐张验证后再返回：上游偶有死链/限流，未经验证的 URL 会变成对话里的破图
            // （实测踩过：搜索「问号」贴出去的图就是 502）。从指定序号开始环形尝试，
            // 最多验证 4 张；图库命中时无需验证（本地文件存在性由索引保证）。
            const order = [...items.slice(want), ...items.slice(0, want)];
            let chosen = null;
            const failed = [];
            for (const it of order.slice(0, 4)) {
              try {
                await fetchImage(it.remote);
                chosen = it;
                break;
              } catch (e) {
                failed.push(`${(it.title || it.file).slice(0, 30)}：${e.message}`);
              }
            }
            if (!chosen) {
              return {
                text:
                  `「${keyword}」的候选图 ${failed.length} 张全部拉取失败（上游限流或死链），` +
                  `这次先不贴图。可以换个关键词再试，或稍后重试。\n` +
                  failed.map((f) => `- ${f}`).join('\n'),
              };
            }
            const wantIndex = items.indexOf(chosen);
            const others = items
              .map((it, i) => ({ it, i }))
              .filter(({ i }) => i !== wantIndex)
              .slice(0, 4)
              .map(({ it, i }) => `${i}. ${it.title}`)
              .join('\n');

            return {
              text: [
                `已选（线上搜索，关键词「${keyword}」，序号 ${wantIndex}，已验证可加载）：${chosen.title}${chosen.animated ? '［动图］' : ''}`,
                '',
                '把下面这行**原样**放在回复的最后一行：',
                '',
                `![${safeAlt(chosen.title)}](${chosen.url})`,
                '',
                others ? `其他候选（想换就带 index 再调一次）：\n${others}` : '',
              ]
                .filter((l) => l !== '')
                .join('\n'),
            };
          },
          presentCall: (args) => ({ card: 'generic', title: `表情包：${args?.keyword ?? ''}` }),
        }),
      ),
  );

  safely('sticker_mode tool', () =>
      ctx.tools.register(
        defineTool({
          name: 'sticker_mode',
          description:
            '查看或切换「表情包模式」开关，**按会话区分**（用户在输入框右侧的开关上切换的是当前会话）。' +
            '不带参数时只读当前会话的生效状态。',
          parameters: {
            enabled: {
              type: 'boolean',
              description: '省略则只读状态；true 打开、false 关闭（作用于 scope 指定的范围）',
            },
            scope: {
              type: 'string',
              description: "写入范围：session（默认，只影响当前会话）/ master（总开关：控制输入框是否显示表情包开关）",
            },
          },
          output: { schema: TEXT_OUT, render: textRender },
          async execute(args, exec) {
            const sessionId =
              exec?.agent?.session?.id ?? exec?.agent?.sessionId ?? exec?.sessionId ?? null;
            const scope = String(args?.scope ?? 'session') === 'master' ? 'master' : 'session';

            if (typeof args?.enabled === 'boolean') {
              const target = scope === 'master' ? null : sessionId;
              const next = setStickerMode(args.enabled, 'tool', target);
              return {
                text:
                  scope === 'master'
                    ? `总开关已${next.master ? '打开' : '关闭'}（控制输入框是否显示表情包开关）。`
                    : `本会话表情包模式已${next.effective ? '打开' : '关闭'}。`,
              };
            }
            const gate = readGate(sessionId);
            const lib = loadLibrary();
            return {
              text: [
                `总开关（设置页）：${gate.master ? '开' : '关'}——开=输入框显示表情包开关`,
                `本会话（${sessionId ?? '未知'}）：${gate.effective ? '已开启' : '已关闭'}` +
                  (gate.sessionOverride === null ? '（无会话覆盖 → 不贴图）' : `（会话覆盖：${gate.sessionOverride ? '开' : '关'}）`),
                `已有会话覆盖 ${gate.sessions} 个`,
                `本会话图片地址前缀：${originNow(sessionId)}${IMG_PREFIX}/（来源：${originSource(sessionId)}）`,
                lib.ok
                  ? `内置图库：${lib.entries.length} 张 / ${lib.tags.length} 个标签（${lib.tags.join('、')}）`
                  : `内置图库：读取失败（${lib.error ?? 'unknown'}），将只用线上搜索`,
              ].join('\n'),
            };
          },
          presentCall: () => ({ card: 'generic', title: '表情包模式' }),
        }),
      ),
  );

  // 便于排障：把内部状态挂到全局，控制台可直接看
  try {
    globalThis.__dshStickerModeHost = { originNow, cacheStats };
  } catch {
    /* ignore */
  }
}
