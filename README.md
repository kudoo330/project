# 拾日研究室

A股策略样本记录与10交易日观察网站。Cloudflare Worker + D1 + 原生 TypeScript / JavaScript；无常驻 Python 服务、无交易接口。用户已授权北京时间16点后独立后台补齐收盘价。

**A 股版本已在 Cloudflare 上线，仍有未交付功能。** 已实现用户名密码登录、管理员 / 查看者权限、持久化策略样本、单笔和批量录入、CSV预览及字段映射、导出、日线刷新、详情、MA与成交量比较、策略等权统计、基础多股票日线研究、手机布局及主题。完整任务书仍有未交付项，见 `docs/ACCEPTANCE.md`。

新增 [AMD / AMDL K线研究](docs/AMD-RESEARCH.md)：独立管理员图表、1m/5m/15m/30m/60m/日线、手工买卖标记、研究分组和明细导入导出。行情通过[手动导入](docs/MANUAL-MARKET-DATA.md)保存并显示缺口；不声称全历史数据或正式自动回测已接通。普通用户只能访问股价对比，原A股记录和AMD研究API均由服务端隔离。`/users`可开通指定账户，部署不创建虚构账户。是否已生产发布以最新验收记录为准。候选源见[AllTick评估](docs/ALLTICK-REVIEW.md)。

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

没有管理员哈希时网站保持锁定，绝无默认生产密码。`.dev.vars` 仅用于本地；禁止提交。网站账号与 Cloudflare 账号完全独立。管理员共享研究数据集；普通用户只访问股价对比，不能读取个人买入记录、研究标记、研究行情或导出。可以继续使用环境配置的查看者，或从管理员用户管理页面开通指定账号。

环境限制写入用户目录时，可设置 `XDG_CONFIG_HOME=/workspace/scratch/wrangler-config`。云任务已经隔离，沿用现有检出，不创建 Git worktree。

## 验证

下面早期测试数字和阻碍是初版历史记录；当前结果以 [验收记录](docs/ACCEPTANCE.md) 和实际工具输出为准。已部署站点为 https://project.kudoo330.workers.dev ，GitHub `master` 触发原Cloudflare项目构建。

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

- 各策略独立的分析范围已实现：全部样本、每买入日期最早N条、指定时间之前，支持组合；见[详细规则](docs/ANALYSIS-SCOPE.md)。不改变原始样本、记录看板或导出。
- 收盘价自动补齐：北京时间16:05起每分钟查漏至23:55，每轮最多8只、并行2只，失败间隔10分钟重试；采集D0及D+1至D+10的收盘价，并用东财与腾讯逐日交叉核对，不要求打开网页。运行记录见数据与设置；见[后台同步说明](docs/CLOSE-SYNC.md)。

- 日线与分时：东方财富 HTTP 接口，不复权，普通查询缓存5分钟，收盘自动任务强制请求新数据，逐条刷新以限制并发。适配器不允许任意URL转发。
- 日线收盘确认：仅使用过去日期，或上海时间16:00后的当日日线。此缓冲不能代替供应商完整性保证。
- 分钟自动定价**暂停**：新浪与东财 / 腾讯存在分钟差异，东财昨日分钟开盘价为0。分钟图仅展示供应商分时，不作为P0。实际成交价可手动填；缺价时不生成收益。
- 观察期内公司行动：用新浪因子及腾讯前复权日线交叉检查，调整计算用历史价及P0，D+10后冻结。保留原价、因子证据与快照；来源异常时暂停收益。详见[规则与限制](docs/CORPORATE-ACTIONS.md)，不构成完整含分红总收益。
- 日历为新浪独立沪深日历，经AKShare于2026-10-16获取，2020—2026覆盖。尚未逐项与交易所核对；超过覆盖不推算周末。北交所按用户2026-10-19确认与沪深使用相同交易日历，支持D0至D+10。
- 打开页面只为管理员刷新最近20条；其余可手动刷新。查看者只读。页面关闭后，已部署Cron仍自动补收盘数据；分析范围不限制行情更新范围。
- 证券输入暂要求交易所后缀；裸代码目录解析尚未实现。北交所代码市场验证、停牌判定、公司行动源尚待补齐。
- 股数只保存，不计算真实账户资金或已实现收益。跨策略重复独立计样本。
- 免费网页接口没有稳定性SLA；获取到数据不代表缓存或再分发许可。生产使用前需核实条款和部署环境可用性。当前不依赖付费数据。

## 安全与恢复

PBKDF2-SHA256 100000次，随机盐；会话随机256位，只保存令牌摘要，HttpOnly / SameSite=Strict / HTTPS Secure，8小时过期。服务端强制角色权限、同源写入、参数化SQL和CSV公式注入防护。按用户2026-10-28要求取消登录失败后的15分钟锁定，错误凭据仍拒绝登录。无分析日志记录持仓；禁止提交真实密钥或数据库。

升级前导出D1到受控位置，不在公开仓库保存。Cloudflare D1恢复 / Time Travel可用范围取决于账号方案，需在生产验证。导出恢复可先导入新数据库验证，再修改绑定；禁止以删库重建修复普通升级。代码回退采用 Cloudflare 已部署版本回退，**不会恢复数据库**。已执行的迁移只能通过兼容迁移或独立数据恢复处理。

主题：`public/tokens.css`。页面与交互：`public/`。指标与跟踪：`src/domain.ts`、`src/tracking.ts`。行情源：`src/market.ts`。新指标应有确定性测试，不能修改样本身份或原始定价依据。

- Codex侧新增[efinance日线辅助查询](docs/EFINANCE.md)：批量不复权日线，经腾讯独立核对后准备导入文件；不替换Worker自动采集，不视为独立于东方财富的来源。
