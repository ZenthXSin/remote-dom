# 使用 sessionKey 登录 Claude

1. 登录 Remote DOM 工作台，打开或恢复自己的浏览器。
2. 在「更多工具」中点击「使用 sessionKey 登录 Claude」。沉浸式全屏下，可从悬浮球选择「登录 Claude」。
3. 只粘贴自己的 Claude `sessionKey`（以 `sk-ant-sid` 开头），点击「应用并打开 Claude」。不要填写 API Key 或整行账号资料。
4. 工具会打开 Claude，请以远端网页显示的账号和页面状态确认登录结果。失效或被撤销的凭据需要重新获取。

操作会替换当前浏览器环境的 Claude 登录 Cookie；同一浏览器的标签页共享这一状态。其他用户和其他浏览器环境不受影响。

输入采用密码框，提交、取消或关闭时清空，不写入本地存储。凭据通过经过账户认证及来源校验的 POST 请求交给当前会话，只设置 `.claude.ai` 下的 `sessionKey` Cookie，使用 `Secure`、`HttpOnly`、`SameSite=Lax` 和 `/` 路径。仍使用当前浏览器的代理与目标访问策略，演示模式禁用该功能。

返回结果、网址和诊断日志不含凭据。启用浏览器持久化时，Cookie 随现有浏览器状态加密保存；如果保存失败，工作台会显示提示。服务端写入 Cookie 不代表 Claude 已认可该会话，页面未完成加载时也会单独提示。

测试使用合成凭据和本地模拟的 Claude 页面，不访问真实账号，也不包含真实 sessionKey。
