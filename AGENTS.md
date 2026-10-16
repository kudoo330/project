# 开发约定

- 使用现有检出；云任务已隔离，不自行创建 Git worktree。
- 原 Sites 项目 `appgprj_6ad190954ea881918fb10efd77a8434f` 未恢复。本仓库走用户授权的 Cloudflare 替代方案；不得声称复用 Sites ID 或旧网址。
- 网站本身必须要求登录；管理员编辑、查看者只读，共享一个研究数据集。不引入交易。用户现已授权北京时间16点后的收盘价自动补齐；仅允许该用途的Cloudflare Cron，不创建通知或交易任务。收盘采集D0当日及D+1至D+10，D0不占后续十日，逐日用东方财富与腾讯交叉核对，冲突或缺第二来源不采纳；旧历史记录不删除。
- 运行 `npm ci`、`npm run db:local`、`npm run dev`。生产配置 `wrangler.deploy.jsonc` 与密钥必须由拥有账号者安全配置，不提交。
- D0为买入日，D+1—D+10使用独立市场日历，停牌不能挪动日序。未核实北交所日历时禁止输出D+n。
- 实际成交价优先。用户已授权核验导入分钟open参考价：东方财富优先、缺少时新浪补充，不因价差阻断；人工补价保留证据。参考价不填实际成交价，分钟起止未核实需标暂估。12:59:xx按用户规则修正为13:00:01并保留原始时间。不得用日线、最近价或前分钟收盘代替。
- 公司行动核对日期之后不计收益；缺失、未来与盘中不计有效分母。策略样本等权，跨策略重复保留。
- 保留原始时间、输入、行情、来源、人工覆盖历史；修改样本不连带其他样本。
- 用户新增观察期内除权要求：原价不覆盖，计算价和P0同比例转换；因子交叉核对失败阻断收益。D+10收盘快照冻结，已结束记录不采用新公司行动。详见docs/CORPORATE-ACTIONS.md。
- UI使用textContent / DOM API处理输入，禁止拼接不可信HTML。所有写API做角色与Origin校验，参数化SQL，导出防公式注入。
- 本地 `.dev.vars`、`.wrangler`、SQLite、备份、真实数据不得提交。迁移受版本控制，升级前备份。
- 必须运行 `npm test`、`npm run check`、`npm run build`；影响交互或权限运行Playwright，记录实际结果。测试数据不写成真实持仓或部署证据。
- Worker生产网络验证、数据库迁移、授权测试与部署成功是不同证据；未通过不能宣称完成。
- 主题变量在 `public/tokens.css`，行情适配器在 `src/market.ts`，定价与统计在 `src/domain.ts` / `src/tracking.ts`，权限在 `src/auth.ts`。

- 用户已授权从Codex读取线上记录。使用7天可撤销只读密钥TRACKER_READ_TOKEN，仅通过HTTPS请求头发往project.kudoo330.workers.dev，禁止聊天索取、打印或提交。不得把只读密钥升级为写权限，详见docs/CODEX-READ-ACCESS.md。

- 用户现已明确授权Codex管理员访问，使用TRACKER_ADMIN_USERNAME与安全密钥TRACKER_ADMIN_PASSWORD通过现有登录获取临时会话。只读密钥仍不具有写权限。管理员会话可以按用户指令读取、导入、修改、删除与刷新；不得打印凭据或将会话保存到文件。详见docs/CODEX-ADMIN-ACCESS.md。
