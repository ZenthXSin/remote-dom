# 内存优化记录（2026-10-15）

目标：单浏览器容器 200 MB 以内。**本轮尚未达到该目标，也不保证任意第三方网页的内存上限。**

## 实现

- 流式 DOM 更新复用未变化的节点记录，避免每次修改都保留另一份完整样式数据。
- 历史快照从 8 份减至 2 份。客户端落后更多版本时自动回退到完整快照，保持恢复正确性。
- 关闭会话时释放当前及历史快照。
- Chromium 禁用 GPU 加速和前进后退页面缓存，使用体积优先的 V8 策略；进程数量参数只是提示，不关闭站点隔离和沙箱。
- 多账户引擎镜像的 Node V8 老生代上限为 128 MiB、半空间为 2 MiB。这不是容器总内存上限，超大 DOM、IndexedDB 或并发页面仍可能触及 Node 堆上限；可按负载通过 NODE_OPTIONS 调整。

## 对照结果

在同一主机依次运行隔离测试容器，使用相同基础 Chromium 镜像、页面与 1 GiB 容器限制。每个场景采样 12 次，间隔 1 秒。指标为 memory.current 减去 inactive_file，与 Docker 工作集读数口径接近；不是进程 RSS 相加。

| 场景 | 原版中位数 / 峰值 | 优化版中位数 / 峰值 |
| --- | --- | --- |
| 内置简单页面 | 264 / 266 MiB | 251 / 252 MiB |
| 500 行文本、每 200 ms 更新末行 | 370 / 394 MiB | 292 / 341 MiB |

动态场景中位数下降约 21%。原始采样见 [memory-benchmark.json](memory-benchmark.json)。这只是短时合成负载对照，不代表 ChatGPT、Claude、媒体网站或多窗口的峰值，也不能替代长时间压力测试。

41 项单元测试及 16 项浏览器回归通过，覆盖输入、流式更新、跨源嵌入、资源、媒体、重连与状态保存恢复。额外强制垃圾回收的收益不明显，未应用于正式运行。

## 重现测试

在仓库根目录执行 npm ci、npm run build。使用 esbuild 将 scripts/benchmark-memory.ts 打包为 Node ESM（packages=external），然后复制到专用的引擎测试容器中运行。该容器需包含 dist、生产依赖和可运行沙箱的 Chromium；以非 root 用户运行，并加载 deploy/chromium-seccomp.json。脚本只打开内置测试页面，不访问用户账户或外部网站。

优化版 Node 参数为 --max-old-space-size=128 --max-semi-space-size=2；基线使用优化前源码和默认 Node 参数。不要在共享应用容器或宿主机直接比较 cgroup 总内存，它会包含同一 cgroup 中其他进程的开销。完整样例采样脚本位于 scripts/benchmark-memory.ts。
