# Remote DOM

**源码公开，仅限非商业用途。禁止未经授权的商业使用。**

基于 TypeScript、Chromium 和 Playwright 的远程浏览器实验项目。远端运行网页脚本，本地浏览器接收 DOM 增量和资源并渲染页面，操作通过 WebSocket 转发到远端。

## 功能

- 中文账户面板、注册登录、管理员账户管理。
- 每账户独立浏览器容器及持久化状态。
- 用户自定义 HTTP/HTTPS 代理、管理员分配出口、账户私有代理和连通性测试。
- 页面导航、输入、上传下载、多窗口、查找和会话恢复。
- [使用自己的 sessionKey 登录 Claude](docs/claude-session-login.zh-CN.md)，支持全屏悬浮球入口。
- 图片、字体和媒体在用户浏览器中持久缓存，服务端按需转发。
- 移动设备参数模拟、修改远端视口尺寸以适配屏幕、沉浸式全屏和悬浮工具球。

## 本地演示

需要 Node.js 22+、npm、Docker 和 Docker Compose 插件。在仓库根目录执行：

```bash
npm ci
npm run build
docker compose -f deploy/compose.demo.yaml up -d --build
```

访问 http://localhost:4173 。演示网络隔离，只提供内置测试页面。停止演示：

```bash
docker compose -f deploy/compose.demo.yaml down
```

## 多账户服务器部署

需要 Linux Docker 主机、可用域名和 HTTPS 反向代理。控制服务通过 Docker socket 创建账户容器，因此应部署在专用受信任主机上；只读挂载 socket 并不会限制 Docker API 的管理权限。

```bash
cp deploy/server.env.example deploy/server.env
mkdir -p deploy/secrets
openssl rand -hex 24 > deploy/secrets/admin-password
chmod 600 deploy/secrets/admin-password
stat -c '%g' /var/run/docker.sock
```

编辑 `deploy/server.env`：设置 `BROWSER_DOMAIN` 为自己的域名，将 `DOCKER_GID` 设置为上一步的组 ID。管理员用户名默认 `admin`，首次启动密码为 `deploy/secrets/admin-password` 文件内容。请妥善保管该文件。

```bash
docker compose --env-file deploy/server.env -f deploy/compose.server.yaml --profile build build
docker compose --env-file deploy/server.env -f deploy/compose.server.yaml up -d control egress-proxy
```

按 `deploy/nginx.browser.conf.template` 配置域名及自己的 TLS 证书，将 HTTPS/WebSocket 转发到 `127.0.0.1:4174`。访问 `https://你的域名/account` 登录。镜像全部由源码构建，不依赖作者的私有镜像。

用户可在账户面板保存和测试自己的代理。私有代理按账户归属限制访问，不加入共享池。代理配置和账户数据存于控制服务卷中，浏览器数据存于独立账户卷中；这些数据、密码文件和部署环境文件不能提交到仓库。备份与恢复时应同时保留控制服务及账户卷。

## 开发与测试

```bash
npm ci
npm run typecheck
npm run build
npm test
```

`npm run test:e2e` 是完整浏览器测试，需要可运行沙箱 Chromium 的非 root 环境，以及 Chromium、OpenSSL、NSS `certutil` 和相应系统依赖。默认 Chromium 路径为 `/usr/bin/chromium`，可通过 `CHROMIUM_PATH` 修改。部分集成测试需要 Docker。端到端测试中的本地 CA 会在测试结束后清理。

目录：`src/control` 为账户和容器管理，`src/server` 为浏览器引擎，`src/remote` 为远端采集，`src/client` 为本地渲染与交互，`src/gateway` 为网关；`tests` 为单元、浏览器及集成测试。

资源缓存策略见 [客户端资源缓存](docs/client-resource-cache.zh-CN.md)。

内存优化与测量方法见 [性能记录](docs/performance.zh-CN.md)。当前尚未实现单容器始终低于 200 MB。

## 当前限制

这是实验性的开发运行器，不是经过安全审计的多租户生产平台。代码明确禁用 `ENGINE_MODE=production` 和 `NODE_ENV=production`；当前 Docker 隔离不等同于每会话虚拟机隔离。

DOM 重建不能保证与任意网站完全兼容。移动端全屏和布局仍有待真实设备验证；Android 模式是 Linux Chromium 的设备参数模拟，不是真实 Android 系统。网站的人机验证、登录与风控可能失败或循环，项目不保证通过验证；代理测试通过也不代表所有网站资源或 IPv6 目标都可达。

本仓库不包含线上账户、代理凭据、会话数据、个人运维脚本或部署证书。

## 许可证

原创代码采用 [PolyForm Noncommercial 1.0.0](LICENSE)，仅授权非商业用途。商业使用不在本许可证授权范围内；如需商用，须另行取得权利人的商业授权。本项目属于源码可用（source-available），不是 OSI 定义的开源项目。具体授权范围以英文许可证全文为准。

Chromium seccomp 配置来源及其 Apache-2.0 许可证见 [第三方说明](deploy/THIRD_PARTY.md)。依赖包保留各自许可证。
