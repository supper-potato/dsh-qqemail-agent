const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const wrap = (title, inner) => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1f2328;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div style="padding:18px 22px;border-bottom:1px solid #eef0f3;font-size:13px;color:#6b7280;">${esc(title)}</div>
    <div style="padding:22px;font-size:15px;line-height:1.7;">${inner}</div>
    <div style="padding:14px 22px;border-top:1px solid #eef0f3;font-size:12px;color:#9aa1ab;">
      由 DeepSeek Harness 自动发送，直接回复本邮件即可继续。
    </div>
  </div>
</body></html>`;

export function ackEmail({ agentName, taskNo, text }) {
  const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  return wrap(
    `${agentName} · 任务 #${taskNo} 已收到`,
    `<p style="margin:0 0 12px;">收到你的任务，正在处理。</p>
     <blockquote style="margin:0;padding:12px 14px;background:#f6f7f9;border-left:3px solid #d0d5dd;border-radius:6px;color:#4b5563;font-size:14px;">${esc(preview)}</blockquote>
     <p style="margin:16px 0 0;color:#6b7280;font-size:14px;">完成后我会再发一封结果邮件。</p>`,
  );
}

export function resultEmail({ agentName, taskNo, seconds, replyText, workSummary = [], errorText = null }) {
  const body = String(replyText ?? '').trim() || '（Agent 没有返回内容）';
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

  const summary = workSummary.length
    ? `<div style="margin-top:22px;padding-top:16px;border-top:1px solid #eef0f3;">
         <div style="font-size:13px;color:#6b7280;margin-bottom:8px;">本次做了什么</div>
         <ul style="margin:0;padding-left:20px;font-size:14px;color:#374151;">
           ${workSummary.map((s) => `<li style="margin:4px 0;">${esc(typeof s === 'string' ? s : JSON.stringify(s))}</li>`).join('')}
         </ul>
       </div>`
    : '';

  const err = errorText
    ? `<div style="margin-top:18px;padding:12px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;color:#b42318;font-size:14px;">${esc(errorText)}</div>`
    : '';

  return wrap(`${agentName} · 任务 #${taskNo} 已完成 · 用时 ${seconds}s`, `${paragraphs}${err}${summary}`);
}
