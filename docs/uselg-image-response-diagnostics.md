# USELG 图片响应诊断

这组诊断用于区分 USELG 图片调用的等待位置，不改变 Route、轮询、重试、计费或结果持久化语义。每一次 `generate`、`status`、`result` HTTP 调用都有独立 `callId`，并携带 `clientRequestId` 和已知的 `taskId`，因此并发 slot 不需要依赖时间顺序关联。

## 配置

```dotenv
IMAGE_RESPONSE_DIAGNOSTICS=basic
IMAGE_RESPONSE_DIAGNOSTICS_SLOW_MS=10000
```

- `off`：关闭新增诊断日志。
- `basic`：默认值；记录阶段、耗时、状态、长度和安全的结构摘要。
- `detailed`：额外记录最多 16 个顶层字段名，以及最多 12 个图片候选的字段路径、类型和长度。仍不记录响应体、Base64、图片 URL、提示词、请求头或密钥。
- `IMAGE_RESPONSE_DIAGNOSTICS_SLOW_MS`：达到该总耗时后，在解析完成事件中附带内存、进程 uptime 和全局事件循环延迟窗口。失败和超时始终附带该快照。

进程只创建一个 `monitorEventLoopDelay` 采样器，每 10 秒滚动一次，定时器已 `unref`，进程退出时会清理。

## 事件与判断方法

日志前缀为 `[image_response_diagnostic]`，事件按一次调用依次出现：

1. `request_started`
2. `response_headers`
3. `response_body_complete`
4. `response_parse_complete`
5. `image_extract_complete`

失败时另有 `request_failed` 或 `request_timeout`，其中 `failedStage` 是 `waiting_headers`、`reading_body`、`parsing` 或表示非 2xx 响应已完整解析的 `complete`。

关键字段：

- `headersWaitMs`：发起请求到收到响应头。
- `bodyReadMs`：收到响应头后到解码后的完整文本可用。
- `parseMs`：JSON/SSE/文本解析耗时。
- `extractMs`：图片、任务状态、assets 和 result URL 的本地提取耗时。
- `declaredContentLength`：渠道响应头声明值，可能为空或不可靠。
- `decodedBodyBytes` / `bodyStringLength`：Node 解码后的响应大小。
- `wireBodyBytes`：当前 Fetch API 不暴露可靠的压缩前传输字节数，因此固定为 `null`，不可据此推断网络流量。
- `addressSource`：`legacy_default`、`adapter`、`execution_config`、`upstream`、`upstream_updated` 或 `default`。
- `targetHost` / `targetPathTemplate`：仅保留 host、path 和 query key；所有 query value 都替换成 `<redacted>`。

示例（字段已脱敏）：

```text
[image_response_diagnostic] {
  event: 'response_headers',
  callId: '...', clientRequestId: '...:slot:2', taskId: 'imgtask_...',
  phase: 'status', attempt: 10, headersWaitMs: 269801.412,
  httpStatus: 200, contentType: 'application/json'
}
[image_response_diagnostic] {
  event: 'response_body_complete', callId: '...', bodyReadMs: 12.844,
  decodedBodyBytes: 1832, wireBodyBytes: null
}
[image_response_diagnostic] {
  event: 'response_parse_complete', callId: '...', parseMs: 0.214,
  parseType: 'json', topLevelType: 'object'
}
```

如果 `response_headers` 本身很晚，延迟在响应头之前；如果响应头很快但 `response_body_complete` 很晚，延迟在响应体传输/结束；如果 `parseMs` 或 `extractMs` 很大，才有本地 CPU 路径证据。`AbortSignal` 可以中止异步 Fetch/读流，但 JavaScript 同步解析或提取一旦占用主线程，`Promise.race` 和定时器不能抢占它，事件循环延迟必须结合阶段日志判断。

## 只读排查命令

按客户端请求或 task 查看相邻日志（对象日志可能跨多行，所以保留上下文）：

```bash
docker compose logs --since=30m api worker | grep -F -A 24 -B 3 ':slot:2'
docker compose logs --since=30m api worker | grep -F -A 24 -B 3 'imgtask_xxx'
docker compose logs --since=30m api worker | grep -F -A 20 '[image_response_diagnostic]'
```

核对正在运行的镜像、容器内源码 revision 和 Node 版本：

```bash
docker compose images api worker
docker inspect --format '{{.Config.Image}} {{.Image}}' "$(docker compose ps -q api)"
docker inspect --format '{{.Config.Image}} {{.Image}}' "$(docker compose ps -q worker)"
docker compose exec -T api sh -lc 'printf "sourceRevision="; cat /app/source-revision; printf "\nnodeVersion="; node --version'
docker compose exec -T worker sh -lc 'printf "sourceRevision="; cat /app/source-revision; printf "\nnodeVersion="; node --version'
```

镜像构建工作流使用 `SOURCE_REV=${{ github.sha }}`；运行镜像会将该值保存在 `/app/source-revision`。如果本地或旧镜像没有提供 build arg，日志会明确显示 `local` 或 `unknown`，不得据此猜测部署版本。

## 本地基准

```bash
npm run benchmark:image-response
```

基准中的 2、8、16 MB 指合成响应内 Base64 字符串的字符长度（ASCII 下也等于解码后 JSON 文本中的字节量级，不代表压缩后的网络传输量）。单任务处理一份响应；双任务通过 `Promise.all` 同时就绪，但其中的同步解析/提取仍会按 Node 单线程语义依次占用事件循环。分别输出 JSON 解析、图片提取、总耗时及定时器延迟。最后启动一个故意不结束的子进程，由父进程 watchdog 终止，保证异常基准本身不会无限挂起。它只衡量本机同步解析/提取成本，不能代替生产网络阶段数据，也不能单独证明生产事故根因。
