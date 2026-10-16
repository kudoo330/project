# Cloudflare网页部署

无需本机Node.js或命令行。使用已连接GitHub的Workers Builds项目`project`。

1. Cloudflare账号控制台 → 存储和数据库（Storage & databases）→ D1 SQL Database → 创建数据库，名称`tracker`。
2. 将数据库详情的Database ID填入`wrangler.jsonc`的`database_id`，替换全零占位符。ID是资源标识，不是密码，可提供给开发者。不要提供API Token、账号密码或密钥。
3. Worker `project` → 设置 → 构建（Builds）：构建命令`npm run build`；部署命令`npm run deploy`。该命令先执行版本化数据库迁移，再部署。首次为空库；已有库升级前先在D1控制台导出备份。
4. 构建使用的Cloudflare自动部署令牌需要对该账号的D1有编辑权限。若出现D1权限错误，仅给构建令牌增加所需权限，不把令牌粘贴到聊天、GitHub或源码。
5. 重试部署最新master提交。成功后Worker设置 → 变量和机密（Variables and Secrets）：设置`ADMIN_PASSWORD_HASH`和`VIEWER_PASSWORD_HASH`为Secret，设置`VIEWER_USERNAME=viewer`为普通变量。`ADMIN_USERNAME=admin`已在配置中。
6. 打开自己已部署网站的`/password-tool`页面，在浏览器本机生成密码哈希（没有任何网络提交），将结果分别填入以上Secret。该页面不会替你修改Cloudflare设置。也可用仓库`npm run password`生成。不使用第三方生成器，不在聊天中发送密码或哈希。未配置管理员密码前保持锁定，不允许匿名查看记录。
7. 实际部署网址以Cloudflare显示的成功结果为准。验证未登录拦截、管理员与只读账号、保存后重登及行情可达性；部署成功不能代替这些检查。

Cloudflare控制台菜单名称可能随语言与版本变化。当前没有账号控制权，实际资源创建、权限和发布结果需用户在控制台完成。
