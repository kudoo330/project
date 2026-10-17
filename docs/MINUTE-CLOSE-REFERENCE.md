# 分钟收盘买入参考价

用户将已录入样本的买入参考价从分钟open改为同标签1分钟close。继续采用东方财富优先，缺少时新浪补充；腾讯分时用于交叉比较。两源不一致时保留差异，按用户允许的主备来源选择参考价，不能标记为验证通过。源时间戳起止尚未独立验证，因此保留interval_boundary_verified=false，不能称为实际成交价。

管理员PATCH现有/api/records/:id，携带revision、reference_price、reference_reason和reference_source。后者需field=close、interval=1m、匹配的symbol与source_label及quotes列表，每个来源包含provider、price、url和fetched_at。服务端校验来源域名、股票、分钟标签及选定价格，计算cross_verified；保留前一参考价和证据及修改者，通过现有审计记录历史。实际成交价与原始买入时间、收盘行情不变。

表格标记“分钟收盘参考价”，未取得一致证据的标记“两源有差异”。无法匹配具体分钟时，不挪用其他分钟；已有人工指定价格作为例外保留并在验收报告中明确。
