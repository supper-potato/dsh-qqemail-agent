import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** DSH 家目录：优先环境变量，否则 ~/.dsh */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : path.join(os.homedir(), '.dsh');
}

export function dataDir() {
  const dir = path.join(dshHome(), 'email-agent');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 简单的 JSON 状态：已处理邮件、线程到会话的映射、水位线。
 * 单用户场景够用，也不引入依赖。
 */
export function createStore() {
  const file = path.join(dataDir(), 'state.json');
  let data = { processed: {}, threads: {}, lastPollAt: null };
  if (fs.existsSync(file)) {
    try {
      data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      /* 损坏就重来，最多重复处理一轮 */
    }
  }

  const flush = () => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  };

  return {
    isProcessed: (id) => Boolean(data.processed[id]),
    markProcessed(id, extra = {}) {
      data.processed[id] = { at: Date.now(), ...extra };
      // 只保留最近 2000 条，防止无限增长
      const keys = Object.keys(data.processed);
      if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete data.processed[k];
      flush();
    },
    getThread: (key) => data.threads[key],
    setThread(key, patch) {
      data.threads[key] = { ...(data.threads[key] ?? {}), ...patch, updatedAt: Date.now() };
      flush();
      return data.threads[key];
    },
    getLastPoll: () => data.lastPollAt,
    setLastPoll(iso) {
      data.lastPollAt = iso;
      flush();
    },
  };
}
