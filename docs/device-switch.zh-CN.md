# 工作台切换设备

全屏点击悬浮球 → **切换设备**，也可在“更多工具”中打开。支持 Windows、Android（Pixel 7）、macOS、iPad、iPhone、Linux，以及恢复默认设备档案。切换使用 Chromium 设备模拟调整页面 UA、触控、屏幕和像素比例；页面视口继续按工作台实际尺寸适配。

切换会刷新当前网页，请先保存尚未提交的内容。同一浏览器上下文中的 Cookie、localStorage 和 sessionStorage 保留；其他已打开的远端窗口需刷新网页。启用环境保存时，设备选择随环境加密保存并在恢复时重新应用。网站可能根据设备变化要求重新登录。

这些选项不更换容器操作系统或浏览器内核，macOS/iPad/iPhone 模式仍运行 Chromium，并非真实 Safari；Worker、Client Hints 等环境信号也不保证等同于真实设备。
