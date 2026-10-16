# 从Codex读取网站数据

部署更新后，管理员在网站“数据与设置 → Codex只读访问”生成密钥。仅显示一次，7天有效；重新生成立即使旧密钥失效，“撤销只读授权”立即撤销。只读查看者不能创建或撤销。

在Codex关联环境设置中将密钥填入安全项TRACKER_READ_TOKEN（不是普通变量，也不要发到聊天），目标域名仅project.kudoo330.workers.dev。保存并发布环境后，重新连接运行环境。网络白名单必须包含同一域名；白名单草稿保存不等于当前运行网络已放通。

在/workspace/project运行：

```sh
python scripts/read-website.py
python scripts/read-website.py --status
python scripts/read-website.py --output /workspace/scratch/website-records.json
```

脚本使用HTTPS与X-Tracker-Read-Token请求头，不把凭据放URL，不跟随重定向，不输出密钥。默认只输出记录数、不同股票数与策略计数。可选输出保存真实数据，不提交Git。

服务端只存SHA256哈希；密钥仅允许GET /api/readonly/records和GET /api/readonly/close-sync，不能成为登录会话或访问任何写接口。每次查询实时校验过期和撤销，响应no-store。查询参数中的token不被接受。记录接口目前最多5000条，返回limit以便检查截断。

0004_read_access.sql仅创建授权表；代码兼容性初始化允许既有部署无需人工执行SQL。未配置、失效、过期、轮换或撤销密钥返回401；只读路径写请求返回405。代理隧道403与网站401需要分别诊断。不能以本地测试通过或Git推送成功声称已经读取线上数据。

连通性诊断：加入域名后，默认Python User-Agent触发HTTP403、error code 1010；设置明确客户端User-Agent ResearchJournal-Codex/0.5后，生产接口返回预期401（未携带授权）。这证明当前网络可达，但不证明功能已部署或已取得读权限。
