# 拾日研究室

A股策略样本记录与10交易日观察网站。Cloudflare Worker + D1 + 原生 TypeScript / JavaScript；无常驻 Python 服务、无交易接口、无后台计划任务。

**当前是受限开发版本，尚未上线。** 已实现用户名密码登录、管理员 / 查看者权限、持久化策略样本、单笔和批量录入、CSV预览及字段映射、导出、日线刷新、详情、MA与成交量比较、策略等权统计、基础多股票日线研究、手机布局及主题。完整任务书仍有未交付项，见 `docs/ACCEPTANCE.md`。

## 本地开发

Node.js 24；依赖由 `package-lock.json` 固定。

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run password
# 将生成的管理员哈希写入 .dev.vars 的 ADMIN_PASSWORD_HASH，勿填原始密码。
# 如需查看者，再生成一个不同密码的哈希，填入 VIEWER_PASSWORD_HASH。
npm run db:local
npm run dev
```

没有管理员哈希时网站保持锁定，绝无默认生产密码。`.dev.vars` 仅用于本地；禁止提交。网站账号与 Cloudflare 账号完全独立。所有被授权账号看到同一个研究数据集；只有管理员能修改。

环境限制写入用户目录时，可设置 `XDG_CONFIG_HOME=/workspace/scratch/wrangler-config`。云任务已经隔离，沿用现有检出，不创建 Git worktree。

## 验证

```sh
npm test
npm run check
npm run build
npx playwright install chromium
npm run test:browser
```

浏览器测试需要已启动的本地服务和专用测试库。本地管理员测试密码 `local-test-admin-only`、查看者 `local-test-viewer-only`，必须先生成对应测试哈希；这些仅是测试夹具，不可用于生产。不要在已有用户数据的库执行测试。环境已有 Chromium 时可设置 `BROWSER_EXECUTABLE_PATH=/usr/bin/chromium`。截图路径当前面向云开发环境，见测试配置；不会部署截图。

## 免费 Cloudflare 部署

**只用网页部署的用户请先看 [网页部署步骤](docs/DEPLOY-WEB.md)**；下方命令行方法可选。网页部署必须先填写实际D1数据库ID，不能使用全零占位符。

使用自己注册的 Cloudflare 免费账号，无需买域名。免费额度、区域可达性和平台条款以 Cloudflare 当期为准；超出免费额度不可承诺持续服务。`workers.dev` 在部分网络可能不可达，须在实际访问网络验证。

在**你自己的电脑**安装 Node.js 24，下载 / 克隆源码，然后执行：

```sh
npm ci
npm run cloudflare:setup
```

脚本会打开 Cloudflare 官方 OAuth 登录页；授权给官方 Wrangler CLI。Cloudflare 密码、OAuth 凭证留在自己的电脑，不发到聊天。随后在终端无回显设置网站管理员和查看者密码（各至少12位）。脚本创建 D1、执行迁移、部署 Worker，并通过标准输入保存密码哈希。第一次部署在管理员哈希设置前保持锁定。网址仅以 Wrangler 成功输出为准，当前没有已确认的生产网址。

生成的 `wrangler.deploy.jsonc` 保存实际数据库ID，保留并备份。不要用仓库中的占位ID执行正式部署。若资源创建中断，脚本不会自动删除数据库；解决错误后沿用生成配置重试。若配置未成功记录资源ID，应在 Cloudflare 控制台找到原数据库并填入，不重复创建。

更新代码（保留原 Worker 名称、数据库ID、账号秘密）：

```sh
npm ci
npm test
npm run check
npx wrangler d1 export tracker --remote --output backup.sql --config wrangler.deploy.jsonc
npx wrangler d1 migrations apply tracker --remote --config wrangler.deploy.jsonc
npx wrangler deploy --config wrangler.deploy.jsonc
```

仅更改密码时，运行 `npm run password`，再运行 `npx wrangler secret put ADMIN_PASSWORD_HASH --config wrangler.deploy.jsonc`，在工具的秘密输入提示处粘贴哈希。修改环境密码不会撤销已有8小时会话；需即时撤销时在D1执行 `DELETE FROM sessions`。不要将密码哈希放进命令参数或提交Git。

## 数据与限制

- 日线与分时：东方财富 HTTP 接口，不复权，缓存5分钟，逐条刷新以限制并发。适配器不允许任意URL转发。
- 日线收盘确认：仅使用过去日期，或上海时间16:00后的当日日线。此缓冲不能代替供应商完整性保证。
- 分钟自动定价**暂停**：新浪与东财 / 腾讯存在分钟差异，东财昨日分钟开盘价为0。分钟图仅展示供应商分时，不作为P0。实际成交价可手动填；缺价时不生成收益。
- 公司行动尚未自动接通。管理员须在详情明确核对至某日期，该日期才进入价格统计。不能未核对就确认；不构成完整含分红总收益。
- 日历为新浪独立沪深日历，经AKShare于2026-10-16获取，2020—2026覆盖。尚未逐项与交易所核对；超过覆盖不推算周末。北交所暂只保存记录、显示行情，不计算D+n。
- 自动打开页面只为管理员刷新最近20条；其余可手动刷新。查看者只读，不发起写入或刷新。页面关闭后无自动同步。
- 证券输入暂要求交易所后缀；裸代码目录解析尚未实现。北交所代码市场验证、停牌判定、公司行动源尚待补齐。
- 股数只保存，不计算真实账户资金或已实现收益。跨策略重复独立计样本。
- 免费网页接口没有稳定性SLA；获取到数据不代表缓存或再分发许可。生产使用前需核实条款和部署环境可用性。当前不依赖付费数据。

## 安全与恢复

PBKDF2-SHA256 100000次，随机盐；会话随机256位，只保存令牌摘要，HttpOnly / SameSite=Strict / HTTPS Secure，8小时过期。服务端强制角色权限、同源写入、参数化SQL、登录限流和CSV公式注入防护。无分析日志记录持仓；禁止提交真实密钥或数据库。

升级前导出D1到受控位置，不在公开仓库保存。Cloudflare D1恢复 / Time Travel可用范围取决于账号方案，需在生产验证。导出恢复可先导入新数据库验证，再修改绑定；禁止以删库重建修复普通升级。代码回退采用 Cloudflare 已部署版本回退，**不会恢复数据库**。已执行的迁移只能通过兼容迁移或独立数据恢复处理。

主题：`public/tokens.css`。页面与交互：`public/`。指标与跟踪：`src/domain.ts`、`src/tracking.ts`。行情源：`src/market.ts`。新指标应有确定性测试，不能修改样本身份或原始定价依据。
