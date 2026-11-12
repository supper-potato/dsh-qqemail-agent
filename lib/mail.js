import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 去掉回复里引用的历史，否则第二轮开始滚雪球 */
export function stripQuoted(text) {
  const markers = [
    /^-{2,}\s*Original Message\s*-{2,}/im,
    /^-{2,}\s*原始邮件\s*-{2,}/im,
    /^发件人[:：]/im,
    /^From:\s/im,
    /^On .+ wrote:$/im,
    /^在.*写道[:：]$/im,
    /^>{1,}\s?/m,
  ];
  let cut = text.length;
  for (const re of markers) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).trim();
}

function headerOf(parsed, name) {
  const v = parsed.headers?.get?.(name);
  return v === undefined || v === null ? null : String(v).trim().toLowerCase();
}

function toMessage(uid, parsed) {
  const fromValue = parsed.from?.value?.[0] ?? {};
  const from = String(fromValue.address ?? '').toLowerCase();
  const refs = [].concat(parsed.references ?? []).map(String);
  const messageId = parsed.messageId ? String(parsed.messageId) : `uid:${uid}`;
  const rawText = String(parsed.text ?? '') || htmlToText(parsed.html ?? '');
  return {
    uid,
    id: `uid:${uid}`,
    conversationId: refs[0] ?? (parsed.inReplyTo ? String(parsed.inReplyTo) : messageId),
    internetMessageId: messageId,
    subject: parsed.subject ?? '(无主题)',
    from,
    fromName: fromValue.name ?? from,
    receivedAt: (parsed.date ?? new Date()).toISOString(),
    text: stripQuoted(rawText),
    references: refs,
    inReplyTo: parsed.inReplyTo ? String(parsed.inReplyTo) : null,
    autoSubmitted: headerOf(parsed, 'auto-submitted'),
    precedence: headerOf(parsed, 'precedence'),
  };
}

/** 该不该处理这封邮件；返回 null 表示处理 */
export function skipReason(msg, cfg) {
  if (!msg?.id) return '缺少 id';
  if (!msg.from) return '没有发件地址';
  if (msg.from === String(cfg.mailUser).toLowerCase()) return '自己发出的（防回环）';
  if (/^(no-?reply|do-?not-?reply|postmaster|mailer-daemon)@/i.test(msg.from)) return '系统邮箱';

  const auto = String(msg.autoSubmitted ?? '');
  if (auto && !auto.startsWith('no')) return `自动回复（${auto}）`;
  const prec = String(msg.precedence ?? '');
  if (['bulk', 'junk', 'list'].includes(prec)) return `群发（${prec}）`;

  if (!msg.text || msg.text.length < 2) return '正文为空';

  const rules = cfg.allowSenders ?? [];
  const allowed = rules.some((r) => {
    if (r === '*') return true;
    if (r.startsWith('*@')) return msg.from.endsWith(r.slice(1).toLowerCase());
    return r === msg.from;
  });
  if (!allowed) return `不在白名单: ${msg.from}`;
  return null;
}

export function createMailer(cfg, log) {
  const imapOptions = {
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: cfg.imapPort === 993,
    auth: { user: cfg.mailUser, pass: cfg.mailPassword },
    logger: false,
  };

  let transport = null;
  const getTransport = () => {
    if (!transport) {
      transport = nodemailer.createTransport({
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        secure: cfg.smtpPort === 465,
        auth: { user: cfg.mailUser, pass: cfg.mailPassword },
        connectionTimeout: 20000,
        greetingTimeout: 20000,
        socketTimeout: 60000,
      });
    }
    return transport;
  };

  async function withClient(fn) {
    const client = new ImapFlow(imapOptions);
    await client.connect();
    try {
      return await fn(client);
    } finally {
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }
  }

  return {
    async verify() {
      return withClient(async (c) => ({ user: c.username, mailboxes: (await c.list()).length }));
    },

    async listInbox(sinceIso) {
      const since = new Date(sinceIso);
      if (Number.isNaN(since.getTime())) since.setDate(since.getDate() - 1);
      since.setDate(since.getDate() - 1); // QQ 的 SEARCH 只到天，多放一天靠去重兜底

      return withClient(async (client) => {
        const lock = await client.getMailboxLock('INBOX');
        const out = [];
        try {
          const uids = await client.search({ since }, { uid: true });
          if (!uids?.length) return [];
          for await (const item of client.fetch(uids.slice(-50), { uid: true, source: true }, { uid: true })) {
            if (!item.source) continue;
            try {
              out.push(toMessage(item.uid, await simpleParser(item.source)));
            } catch (err) {
              log(`解析 UID ${item.uid} 失败: ${err.message}`);
            }
          }
        } finally {
          lock.release();
        }
        return out;
      });
    },

    async replyTo(msg, html) {
      const subject = /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`;
      const references = [...(msg.references ?? []), msg.internetMessageId].filter(Boolean).join(' ');
      await getTransport().sendMail({
        from: cfg.mailUser,
        to: msg.from,
        subject,
        html,
        inReplyTo: msg.internetMessageId ?? undefined,
        references: references || undefined,
      });
    },

    async markRead(msg) {
      if (!msg.uid) return;
      try {
        await withClient(async (client) => {
          const lock = await client.getMailboxLock('INBOX');
          try {
            await client.messageFlagsAdd({ uid: String(msg.uid) }, ['\\Seen'], { uid: true });
          } finally {
            lock.release();
          }
        });
      } catch (err) {
        log(`标记已读失败: ${err.message}`);
      }
    },
  };
}
