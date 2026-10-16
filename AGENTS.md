# 开发约定

- 使用现有检出；云任务已隔离，不自行创建 Git worktree。
- 原 Sites 项目 `appgprj_6ad190954ea881918fb10efd77a8434f` 未恢复。本仓库走用户授权的 Cloudflare 替代方案；不得声称复用 Sites ID 或旧网址。
- 网站本身必须要求登录；管理员编辑、查看者只读，共享一个研究数据集。不引入交易或计划任务。
- 运行 `npm ci`、`npm run db:local`、`npm run dev`。生产配置 `wrangler.deploy.jsonc` 与密钥必须由拥有账号者安全配置，不提交。
- D0为买入日，D+1—D+10使用独立市场日历，停牌不能挪动日序。未核实北交所日历时禁止输出D+n。
- 实际成交价优先；分钟源口径未解决前不得自动生成P0，不得用日线、最近价或前分钟收盘代替。
- 公司行动核对日期之后不计收益；缺失、未来与盘中不计有效分母。策略样本等权，跨策略重复保留。
- 保留原始时间、输入、行情、来源、人工覆盖历史；修改样本不连带其他样本。
- UI使用textContent / DOM API处理输入，禁止拼接不可信HTML。所有写API做角色与Origin校验，参数化SQL，导出防公式注入。
- 本地 `.dev.vars`、`.wrangler`、SQLite、备份、真实数据不得提交。迁移受版本控制，升级前备份。
- 必须运行 `npm test`、`npm run check`、`npm run build`；影响交互或权限运行Playwright，记录实际结果。测试数据不写成真实持仓或部署证据。
- Worker生产网络验证、数据库迁移、授权测试与部署成功是不同证据；未通过不能宣称完成。
- 主题变量在 `public/tokens.css`，行情适配器在 `src/market.ts`，定价与统计在 `src/domain.ts` / `src/tracking.ts`，权限在 `src/auth.ts`。
