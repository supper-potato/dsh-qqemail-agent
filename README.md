# dsh-email-agent

在 DeepSeek Harness 里绑定一个邮箱：别人发邮件过来，Agent 干活，然后回信。

**装完填自己的邮箱就能用**，不需要额外部署任何服务。

## 装完之后做什么

1. 装好插件，重启 DSH
2. 打开配置文件（插件会在第一次运行后生成它）：

   ```
   %USERPROFILE%\.dsh\email-agent\config.json
   ```

3. 填四项：

   ```json
   {
     "enabled": true,
     "mailUser": "123456@qq.com",
     "mailPassword": "邮箱授权码",
     "allowSenders": ["允许发任务的邮箱@example.com"],
     "workspacePath": "C:\\你的\\工作目录"
   }
   ```

4. 重启 DSH，日志里出现「已启动」和「邮箱连接正常」就好了

## 拿授权码

**QQ 邮箱**：网页版 → 设置 → 账户 → 开启 IMAP/SMTP 服务 → 按提示发短信 → 得到 16 位授权码。

**163 邮箱**：设置 → POP3/SMTP/IMAP → 开启 → 客户端授权密码。

注意是**授权码**，不是你的登录密码。

## 配置项

| 字段 | 说明 | 默认 |
|---|---|---|
| `enabled` | 总开关 | `true` |
| `mailUser` | 收件邮箱地址 | 必填 |
| `mailPassword` | 授权码 | 必填 |
| `allowSenders` | 谁可以下任务；支持 `*@域名.com` 和 `*` | 空（谁都不理） |
| `workspacePath` | Agent 的工作目录 | DSH 当前目录 |
| `agentPreset` | 用哪套预设（决定工具集） | `standard` |
| `provider` / `model` | 用哪个模型；留空则跟随 DSH 当前默认模型 | 跟随 |
| `pollIntervalMs` | 轮询间隔 | `30000` |
| `ackDelayMs` | 超过多久先回「已收到」 | `45000` |
| `lookbackHours` | 首次启动往回看多久 | `24` |

`imapHost` / `smtpHost` 默认是 QQ 的，用 163 的话改一下域名即可。

## 用起来是什么样

- 发一封邮件 → 30 秒内被处理 → 收到回信
- 任务超过 45 秒没跑完 → 先收到一封「已收到」，完成后收到结果
- 回复里带「本次做了什么」（调用了哪些工具）
- 同一串邮件算同一个任务，任务号会递增
- 自己发的邮件、`no-reply`、自动回复、群发邮件都会被忽略

## 安全须知

- **白名单是唯一防线。** `allowSenders` 之外的人发信一律不处理
- **邮件正文是不可信输入。** 提示词里做了约束，但那是软性的，不是技术隔离
- **白名单里的人能指挥 Agent 执行命令。** 它有你给它的全部工具权限，只加信得过的人
- 不要填 `"*"`，除非你清楚这意味着任何人都能让它在你电脑上干活

## 排查

| 现象 | 原因 |
|---|---|
| 日志没有「已启动」 | `enabled` 是 false，或者 `mailUser` / `mailPassword` 没填 |
| 「邮箱连接失败」 | 授权码错、没开 IMAP 服务、或网络不通 |
| 收到邮件但没反应 | 发件人不在 `allowSenders` 里 |
| 「Agent 没有输出」 | `provider` / `model` 和宿主不匹配，或预设挂载失败 |
| 「agentPresets 挂载失败」 | `agentPreset` 填了不存在的预设 id |

日志在 DSH 的宿主控制台里，前缀是 `[email-agent]`。

## License

MIT
