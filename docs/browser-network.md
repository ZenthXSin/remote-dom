# 浏览器网络与窗口模式


账号工作容器使用 `BROWSER_HEADLESS=0`，由引擎启动仅监听本机 Unix socket 的 Xvfb。前端仍是 DOM 镜像，不开放 VNC。独立运行器默认保留 headless，可用 `BROWSER_HEADLESS=1` 显式选择。

HTTP/HTTPS 代理模式在代理边界检查目标地址，不再在页面内替换 WebSocket 或用 Playwright 拦截每个 HTTP 请求。Chromium 自行处理缓存、CORS 预检和 Service Worker。只允许内置测试站的精确端口绕过代理，其他回环地址也必须经过地址检查。

`MANAGED_EGRESS_POLICY=1` 仅由控制器为使用专属受控中继的隔离账号容器设置；该中继必须检查公网地址且仅允许 80/443。此选项不能用于任意第三方代理。服务器默认出口和独立 HTTP 代理运行器仍通过会话内的地址检查代理。SOCKS 运行器暂保留原有浏览器请求拦截。

验证覆盖原生 WebSocket、真实 CORS 预检、回环地址阻断、安卓触摸及浏览器状态恢复。2026-10-16 的正式 DOM 验收通过引擎输入/点击通道提交完整邮箱，Claude 的登录方式查询和邮件发送均返回 200，页面进入验证码步骤。验证范围到此步骤，最终账号认证由用户完成。
