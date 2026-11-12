import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './store.js';
import { createStore } from './store.js';
import { createMailer, skipReason } from './mail.js';
import { installSessionListener, runAgentTurn } from './agent.js';
import { ackEmail, resultEmail } from './templates.js';

export const name = 'email-agent';
export const inject = ['webServer'];

const DEFAULTS = {
  enabled: true,
  mailUser: '',
  mailPassword: '',
  imapHost: 'imap.qq.com',
  imapPort: 993,
  smtpHost: 'smtp.qq.com',
  smtpPort: 465,
  allowSenders: [],
  workspacePath: '',
  agentPreset: 'standard',
  provider: '',
  model: '',
  pollIntervalMs: 30000,
  ackDelayMs: 45000,
  lookbackHours: 24,
  maxChars: 8000,
  maxToolSteps: 12,
  timeoutMs: 180000,
  agentName: 'DSH Agent',
  selfUrl: '',
};

const TEMPLATE = {
  mailUser: '',
  mailPassword: '',
  allowSenders: [],
  workspacePath: '',
};

function configFile() {
  return path.join(dataDir(), 'config.json');
}

/** 首次运行时写一份模板，用户照着填即可 */
function ensureConfigFile(log) {
  const file = configFile();
  if (fs.existsSync(file)) return;
  const body = {
    _说明: [
      '填下面四项后重启 DSH 即生效。',
      'mailPassword 是邮箱的授权码：QQ 邮箱 → 设置 → 账户 → 开启 IMAP/SMTP 服务 → 生成授权码。',
      'allowSenders 支持精确地址、*@域名.com、以及 * 表示所有人（慎用）。',
    ],
    enabled: true,
    ...TEMPLATE,
    agentPreset: 'standard',
    pollIntervalMs: 30000,
  };
  fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8');
  try {
    fs.writeFileSync(path.join(dataDir(), 'README.txt'), [
      'DSH 邮件助手',
      '',
      '配置文件：config.json（就在本目录）',
      '',
      '必填：',
      '  mailUser      你的邮箱地址，例如 123456@qq.com',
      '  mailPassword  邮箱授权码（16 位，不是登录密码）',
      '  allowSenders  允许给这个助手发任务的邮箱数组',
      '  workspacePath Agent 干活的工作目录（绝对路径）',
      '',
      '改完重启 DSH 生效。',
    ].join('\n'), 'utf8');
  } catch {
    /* 写说明失败不影响主流程 */
  }
  log(`首次运行，已生成配置模板：${file}`);
}

function loadConfig(ctx, pluginConfig) {
  let fromFile = {};
  const file = configFile();
  if (fs.existsSync(file)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error('[email-agent] config.json 解析失败，改用默认值:', err.message);
    }
  }
  const merged = { ...DEFAULTS, ...(pluginConfig ?? {}), ...fromFile };

  // 模型：优先配置，其次跟随 DSH 当前的默认模型
  if (!merged.provider || !merged.model) {
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
      if (selection?.provider && selection?.model) {
        merged.provider = merged.provider || selection.provider;
        merged.model = merged.model || selection.model;
        if (!merged.reasoningEffort && selection.reasoningEffort) merged.reasoningEffort = selection.reasoningEffort;
      }
    } catch {
      /* 拿不到就让后面报错 */
    }
  }

  if (Array.isArray(merged.allowSenders)) {
    merged.allowSenders = merged.allowSenders.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  } else {
    merged.allowSenders = [];
  }
  return merged;
}

export function apply(ctx, pluginConfig = {}) {
// 同时写控制台和文件，方便用户在 DSH 外排查
  const logFile = path.join(dataDir(), 'agent.log');
  const log = (...args) => {
    const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
    console.log('[email-agent]', line);
    try {
      fs.appendFileSync(logFile, line + '\n', 'utf8');
    } catch {
      /* ignore */
    }
  };

  ensureConfigFile(log);
  const cfg = loadConfig(ctx, pluginConfig);

  if (cfg.enabled === false) {
    log('未启用。在 config.json 里把 enabled 设为 true 并填好邮箱后重启 DSH。');
    return;
  }
  if (!cfg.mailUser || !cfg.mailPassword) {
    log(`还没填邮箱。编辑 ${configFile()} 里的 mailUser 和 mailPassword，然后重启 DSH。`);
    return;
  }
  if (!cfg.workspacePath) {
    log('警告：workspacePath 为空，Agent 会工作在 DSH 的当前目录，可能看不到你的项目。');
  }
  if (!cfg.allowSenders.length) {
    log('警告：allowSenders 为空，任何人的邮件都不会被处理。');
  }
  if (!cfg.provider || !cfg.model) {
    log('错误：拿不到模型配置。请在 config.json 里填 provider 和 model，或在 DSH 里选择一个默认模型。');
    return;
  }

  const store = createStore();
  const mailer = createMailer(cfg, log);
  const offEvents = installSessionListener(ctx);

  let running = false;

  async function handleMessage(msg) {
    const key = msg.internetMessageId || msg.id;
    if (store.isProcessed(key)) return;

    store.markProcessed(key, { subject: msg.subject, from: msg.from });
    const thread = store.getThread(msg.conversationId);
    const taskNo = (thread?.taskNo ?? 0) + 1;
    store.setThread(msg.conversationId, { taskNo, subject: msg.subject });

    log(`▶ 任务 #${taskNo} ← ${msg.from} | ${msg.subject}`);

    let acked = false;
    const ackTimer = setTimeout(async () => {
      acked = true;
      try {
        await mailer.replyTo(msg, ackEmail({ agentName: cfg.agentName, taskNo, text: msg.text }));
        log(`  已发送 ACK（#${taskNo}）`);
      } catch (err) {
        log(`  ACK 发送失败: ${err.message}`);
      }
    }, cfg.ackDelayMs);

    const started = Date.now();
    let result = { replyText: '', workSummary: [] };
    let failure = null;

    try {
      result = await runAgentTurn(ctx, { cfg, msg, model: { provider: cfg.provider, model: cfg.model, reasoningEffort: cfg.reasoningEffort }, log });
    } catch (err) {
      failure = `Agent 执行失败：${err.message}`;
      log(`  ${failure}`);
    } finally {
      clearTimeout(ackTimer);
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    try {
      await mailer.replyTo(
        msg,
        resultEmail({ agentName: cfg.agentName, taskNo, seconds, replyText: result.replyText, workSummary: result.workSummary, errorText: failure }),
      );
      await mailer.markRead(msg);
      log(`✓ 任务 #${taskNo} 已回复（${seconds}s${acked ? '，含 ACK' : ''}）`);
    } catch (err) {
      log(`  结果邮件发送失败: ${err.message}`);
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const since = store.getLastPoll() ?? new Date(Date.now() - cfg.lookbackHours * 3600_000).toISOString();
      const messages = await mailer.listInbox(since);
      let newest = since;
      for (const msg of messages) {
        if (msg.receivedAt && msg.receivedAt > newest) newest = msg.receivedAt;
        const reason = skipReason(msg, cfg);
        if (reason) {
          log(`⤵ 跳过（${reason}）| ${msg.subject}`);
          continue;
        }
        if (store.isProcessed(msg.internetMessageId)) continue;
        try {
          await handleMessage(msg);
        } catch (err) {
          log(`处理邮件失败: ${err.message}`);
        }
      }
      if (newest !== since) store.setLastPoll(newest);
    } catch (err) {
      log(`轮询失败: ${err.message}`);
    } finally {
      running = false;
    }
  }

  log(`已启动：${cfg.mailUser}，每 ${Math.round(cfg.pollIntervalMs / 1000)} 秒轮询，模型 ${cfg.provider}/${cfg.model}`);

  mailer
    .verify()
    .then((info) => log(`邮箱连接正常：${JSON.stringify(info)}`))
    .catch((err) => log(`邮箱连接失败：${err.message}`));

  const kickoff = setTimeout(tick, 5000);
  const interval = setInterval(tick, cfg.pollIntervalMs);

  ctx.effect(() => () => {
    clearTimeout(kickoff);
    clearInterval(interval);
    offEvents?.();
  });
}
