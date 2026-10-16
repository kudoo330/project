# Codex管理员访问

用户明确授权Codex以管理员身份读写测试网站。环境配置：普通变量TRACKER_ADMIN_USERNAME（默认admin），安全密钥TRACKER_ADMIN_PASSWORD，凭据目标域名仅project.kudoo330.workers.dev。密码填写现有网站管理员登录密码，不是Cloudflare密码，也不是PBKDF2哈希；不发到聊天、不写Git。

脚本使用HTTPS POST /api/login，Origin为网站源，username在JSON中，密码通过X-Tracker-Admin-Password请求头由Codex代理注入。该凭据通道仅对管理员账号生效，使用原有密码哈希校验、登录限流、会话权限和Origin保护，没有绕过登录。普通浏览器登录继续使用JSON密码。会话只在脚本进程内存中保存，执行后退出登录，网络中断导致注销失败时按原8小时失效。

```sh
python scripts/admin-website.py
python scripts/admin-website.py --output /workspace/scratch/website-records.json
python scripts/admin-website.py --path /api/close-sync --output /workspace/scratch/website-sync.json
python scripts/admin-website.py --path /api/refresh --method POST --body-file /workspace/scratch/refresh-ids.json
```

默认只读。写操作必须显式提供方法、路径、JSON文件，按用户要求执行；读取与写入权限均为管理员，不把只读密钥升级为管理员凭据。不将用户名密码、Cookie或授权头打印或保存，不跟随重定向，API路径固定同站。敏感生成接口的响应不保存，真实数据只放Git外。

导入使用/api/import-reviewed，request_id与rows需明确；修改和删除仍携带revision，刷新最多8个ID，使用既有规则与审计。

Codex配置草稿保存不等于凭据已填入或环境已发布。需要用户在安全配置输入现有网站密码，保存并发布后再检查真实线上登录和数据。不得以本地测试或Git推送成功声称已获得线上管理员访问。
