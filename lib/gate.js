/**
 * 开关状态：~/.dsh/sticker-mode.json
 *
 * 刻意与 jev 的 gate 保持同一套约定：
 *   - 文件是唯一真相，Agent 可以直接 read 它来判断模式是否开启；
 *   - **每次判定都重新读文件、不做缓存**，这样在外部
 *     `echo '{"enabled":true}' > ~/.dsh/sticker-mode.json` 能立即生效；
 *   - 读失败 / 文件损坏一律按「关闭」处理（这个开关只是加表情，不是护栏，
 *     坏掉时静默降级成普通对话行为比乱贴图更合适）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export function gatePath(explicit) {
  return explicit || process.env.DSH_STICKER_MODE_PATH || join(homedir(), '.dsh', 'sticker-mode.json');
}

/**
 * 读取开关全量状态。
 * @returns {{enabled: boolean, changedAt: string|null, changedBy: string|null}}
 */
export function readGate(explicitPath) {
  const file = gatePath(explicitPath);
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return {
      enabled: raw?.enabled === true,
      changedAt: typeof raw?.changedAt === 'string' ? raw.changedAt : null,
      changedBy: typeof raw?.changedBy === 'string' ? raw.changedBy : null,
    };
  } catch {
    return { enabled: false, changedAt: null, changedBy: null };
  }
}

/** 便捷判定：表情包模式是否开启。 */
export function isStickerModeOn(explicitPath) {
  return readGate(explicitPath).enabled;
}

/**
 * 写入开关状态。
 * @param {boolean} enabled
 * @param {string} changedBy 谁改的：panel(UI) / tool(agent) / http
 */
export function setStickerMode(enabled, changedBy = 'panel', explicitPath) {
  const file = gatePath(explicitPath);
  const next = {
    enabled: enabled === true,
    changedAt: new Date().toISOString(),
    changedBy,
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
