# AllTick / free-quote 只读评估 — 2026-10-28

用户提供的 `CTradeExchange/free-quote` 是 AllTick 行情 API 的文档和调用示例，不是可自建的交易所采集服务。原仓已迁移到 AllTick 新仓。本次只读检查代码和文档，没有配置 Token、购买套餐或运行示例；不代表真实接口验收。

| 需求 | 文档所能支持的判断 |
| --- | --- |
| 近期分钟 / 日线备用 | 支持 1 分钟、日 K；值得作为候选，实际权限与覆盖需验证。 |
| AMD / AMDL 指定日期分钟回补 | 股票不支持历史结束时间，单次最多最近 500 根，不能按日期翻页解决既有历史缺口。 |
| 批量收盘增量 | 批量 K 线每产品最多 2 根；免费批量最多 5 组，不适合长期历史回补。 |
| 完全免费 | 文档列免费 HTTP 合计 1,000 请求/日、K 线 10 秒一次；目标股票是否在免费范围仍需专用账号验证。 |
| 目标证券覆盖 | 仓库未明确 AMD、AMDL、北交所逐只覆盖；完整代码表是外链，不作覆盖承诺。 |
| 盘前盘后 / 复权 | 未核实全时段覆盖；K 线文档当前 `adjust_type` 仅支持 0。 |
| 交叉验证 | 未披露原始上游，暂不能算独立交叉源。 |

结论：保留为近期行情备用候选，不改变现有东财优先的 A 股采集，不替换已验证的 Longbridge 通道，也不以该仓库解决长历史分钟缺口。手动导入入口继续保留。

证据固定到审阅提交，避免后续文档更新混淆：

- [原仓 Python 请求 AllTick](https://github.com/CTradeExchange/free-quote/blob/7a9deff3057dfd6c444aae7fef0cabdea0912194/example/python/http_python_example.py#L17)
- [新仓 K 线时间、条数及复权限制](https://github.com/alltick/realtime-forex-crypto-stock-tick-finance-websocket-api/blob/74064c1bb1a010ad8d94a3a07f20aebd348ff245/http_interface/kline_query_cn.md#L75)
- [REST 相同限制](https://github.com/alltick/realtime-forex-crypto-stock-tick-finance-websocket-api/blob/74064c1bb1a010ad8d94a3a07f20aebd348ff245/rest_interface/kline_query_cn.md#L74)
- [免费配额与频率](https://github.com/alltick/realtime-forex-crypto-stock-tick-finance-websocket-api/blob/74064c1bb1a010ad8d94a3a07f20aebd348ff245/http_interface/interface_limitation_cn.md#L5)
- [批量每产品条数](https://github.com/alltick/realtime-forex-crypto-stock-tick-finance-websocket-api/blob/74064c1bb1a010ad8d94a3a07f20aebd348ff245/http_interface/batch_kline_query_cn.md#L86)

原仓未见 LICENSE；示例公开不等于软件许可或行情长期存储、网站展示、再分发授权。若后续接入，应使用 AllTick 专用凭据并核实免费计划和数据授权，不能复用其他服务商凭据。
