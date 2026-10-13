/**
 * 开关状态：~/.dsh/sticker-mode.json
 *
 * 结构（v3，两级开关）：
 *   { "master": true,      ← 总开关：是否在输入框显示表情包开关（功能总入口）
 *     "sessions": { "<sessionId>": { "enabled": true, "at": "ISO" } } }
 *
 * 语义：
 *   - master 关  → 功能整体停用：输入框不显示开关、不注入指令、sticker_pick 拒绝；
 *     已有的会话覆盖保留在文件里（重新打开总开关后原样恢复）。
 *   - master 开  → 每个会话由自己的覆盖值决定；**没有覆盖的会话一律不贴**
 *     （想贴就在那个会话里点开）。所以不存在"新会话默认值"这个概念。
 *
 * 迁移（自动，无需手工）：
 *   - v1 {enabled,…}        → master=true, sessions={}
 *   - v2 {default,sessions} → master=true, sessions 原样保留
 *   （v2 的 default 是"新会话初始模式"，v3 里不再有这个概念；总开关先设为开，
 *     让升级后能看到开关，不想用再去设置里关。）
 *
 * 与 jev 的 gate 保持同一套约定：
 *   - 文件是唯一真相，Agent 可以直接读它；
 *   - **每次判定都重新读文件、不做缓存**，外部改动立即生效；
 *   - 读失败/损坏按「总开关关闭」降级（这个开关只是加表情，不是护栏）。
 */
import { mkdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

/** 会话覆盖最多保留多少条（防止无限增长）；超量按 at 淘汰最旧的。 */
const MAX_SESSION_ENTRIES = 200;
/** 会话覆盖的过期时间（之后该会话视为未覆盖 → 不贴）。 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function gatePath(explicit) {
  return explicit || process.env.DSH_STICKER_MODE_PATH || join(homedir(), '.dsh', 'sticker-mode.json');
}

/** 读原始文件并归一化成 v3 形态。文件不存在 → 总开关开（首次安装的友好默认）；
 *  存在但损坏 → 总开关关（安全降级）。 */
function readRaw(explicitPath) {
  const file = gatePath(explicitPath);
  if (!existsSync(file)) return { master: true, sessions: {} };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof raw !== 'object' || raw === null) throw new Error('not an object');
    // 迁移：v1/v2 没有 master 字段 —— 升级时总开关设为开（见文件头说明）
    const master = typeof raw.master === 'boolean' ? raw.master : true;
    const sessions = {};
    for (const [id, v] of Object.entries(raw.sessions ?? {})) {
      if (typeof id === 'string' && id && v && typeof v.enabled === 'boolean') {
        sessions[id] = { enabled: v.enabled, at: typeof v.at === 'string' ? v.at : new Date(0).toISOString() };
      }
    }
    return { master, sessions };
  } catch {
    return { master: false, sessions: {} };
  }
}

function writeRaw(state, explicitPath) {
  const file = gatePath(explicitPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * 会话的**生效**状态：总开关开 且 该会话有未过期的开启覆盖。
 * @param {string|null} sessionId
 */
export function isStickerModeOn(sessionId = null, explicitPath) {
  const state = readRaw(explicitPath);
  if (!state.master) return false;
  if (!sessionId) return false;
  const hit = state.sessions[sessionId];
  return Boolean(hit && hit.enabled === true && Date.now() - Date.parse(hit.at) < SESSION_TTL_MS);
}

/** 完整状态（状态端点/工具展示用）。 */
export function readGate(sessionId = null, explicitPath) {
  const state = readRaw(explicitPath);
  const hit = sessionId ? state.sessions[sessionId] : undefined;
  return {
    master: state.master,
    /** 该会话的覆盖值；没有覆盖时为 null（= 不贴，跟随"无覆盖即关"的规则） */
    sessionOverride: hit ? hit.enabled : null,
    /** 该会话的生效值 */
    effective: isStickerModeOn(sessionId, explicitPath),
    sessions: Object.keys(state.sessions).length,
  };
}

/**
 * 写开关状态。
 * @param {boolean} enabled
 * @param {string} changedBy panel(UI) / tool(agent) / http
 * @param {string|null} sessionId 传了就写该会话的覆盖值；不传写总开关
 */
export function setStickerMode(enabled, changedBy = 'panel', sessionId = null, explicitPath) {
  const state = readRaw(explicitPath);
  if (sessionId) {
    state.sessions[sessionId] = { enabled: enabled === true, at: new Date().toISOString() };
    // 淘汰：过期条目直接删，然后超量时按时间删最旧的
    const now = Date.now();
    for (const [id, v] of Object.entries(state.sessions)) {
      if (now - Date.parse(v.at) > SESSION_TTL_MS) delete state.sessions[id];
    }
    const overflow = Object.keys(state.sessions).length - MAX_SESSION_ENTRIES;
    if (overflow > 0) {
      const oldest = Object.entries(state.sessions)
        .sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at))
        .slice(0, overflow);
      for (const [id] of oldest) delete state.sessions[id];
    }
  }
  else {
    state.master = enabled === true;
  }
  writeRaw(state, explicitPath);
  return readGate(sessionId, explicitPath);
}

/** 文件元数据（状态端点展示用）。 */
export function gateMeta(explicitPath) {
  const file = gatePath(explicitPath);
  try {
    return { file, mtime: statSync(file).mtime.toISOString() };
  } catch {
    return { file, mtime: null };
  }
}
