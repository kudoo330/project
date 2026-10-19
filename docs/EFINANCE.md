# Codex侧 efinance 日线辅助通道

已加入 efinance 0.5.9 Python工具，用于Codex手动批量查询及准备核验报价；Cloudflare Worker不运行Python，这不替换网站现有自动采集。efinance底层仍是东方财富，不能与东方财富直连算作两个独立来源。

## 安装与查询

```bash
cd /workspace/project
python -m venv /workspace/.venvs/efinance
PIP_CACHE_DIR=/workspace/scratch/pip-cache /workspace/.venvs/efinance/bin/python -m pip install -r requirements-efinance.txt
PYTHONDONTWRITEBYTECODE=1 /workspace/.venvs/efinance/bin/python -m unittest discover -s test -p 'test_efinance_quotes.py' -v
/workspace/.venvs/efinance/bin/python scripts/efinance_quotes.py --symbols 600802.SH 002626.SZ 920344.BJ --start 2026-10-19 --end 2026-10-19 --output /workspace/scratch/efinance-report.json --quotes-output /workspace/scratch/efinance-quotes.json
```

也可用 `--records-file /workspace/scratch/website-records.json` 替代 `--symbols`，读取管理员导出的本地记录并去重。最多500只、并发2只；默认只读，不需要管理员密码或API Key。文件必须在Git目录外，0600权限且拒绝覆盖。区间只允许已收盘交易日，最多31自然日；准备导入的每只报价最多11个日期。

工具强制 `klt=101`、`fqt=0`，验证返回代码和市场，北交所必须有明确市场分类证据。efinance原函数默认前复权，并在内部传入verify=False，因此本项目只对其日线调用使用受限传输层：强制TLS校验、固定HTTPS目的地、禁止重定向、连接5秒/读取15秒超时。不修改已安装库，也不允许库访问搜索、账户或交易接口。

每只报价与腾讯独立不复权日线按同日期收盘价严格比对；缺少第二来源或价格不同不进入可导入列表。保存版本、请求URL、响应SHA256和抓取时间；原始efinance主来源始终记为“东方财富”。来源缺数据不推断停牌，不生成买入价，不调整复权口径。

报告包含每只状态和错误，退出码0仅表示全部请求日期通过验证；部分或全部失败返回2，不伪装成成功。`--quotes-output`写出已有 `/api/import-closes` 接受的报价数组，但工具不登录、不写网站。需要补价时按用户指令由独立管理员流程备份、核对观察窗口后再导入。没有复权因子证据时该接口仍可能暂停收益，不能为了导入而捏造因子。

## 本次验证（2026-10-19）

- 独立虚拟环境安装、锁定依赖、pip check及重复安装通过。
- 5项离线测试通过，包括实际库对明确标注的模拟响应解析、TLS强制校验、市场代码验证、OHLC验证与双源分歧阻断。这些不是线上报价证据。
- 实际查询福建水泥、金达威、三元基因均收到东方财富HTTP 503：真实日线取数尚未通过，报告保留pending，可导入报价0条，网站写入0条。真实响应在工作区scratch，不提交Git。
- 不因503重复尝试相同请求或降低TLS校验；待上游/网络条件变化后用新报告路径重试。现有网站的新浪/腾讯补充路径继续运行。
