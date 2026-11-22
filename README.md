# omp-wakeguard

OMP（oh-my-pi）的模型接口看门狗扩展，是 [pi-wakeguard](https://github.com/Xeltra233/pi-WakeGuard) 的 OMP 构建。接口不可达时把 PVP 的下一次重试**停泊**（park），用不带凭据的 GET 按固定节律探测；接口一恢复就只放行一次原生重试，随后休眠并继续保留监听。**默认关闭**。

探测、分类与状态机三个模块与 Pi 版为同逻辑独立构建，差异只在宿主表面（OMP 的事件名与 EventBus）；不跨目录共享源文件。

- 包名：`omp-wakeguard`（版本 `0.1.1`），`type: module`，扩展入口 `./src/index.ts`
- 宿主：`@oh-my-pi/pi-coding-agent`（`peerDependencies`：`>=18.4.1 <19.0.0`；开发依赖 18.4.1）
- 许可：MIT

---

## 加载即静默

扩展加载后状态为 `off`：不探测、不建 timer、不接管任何重试。只有用户显式 `/wakeguard on` 才启用，并且**立即探测一次**。未启用时 `request.wait` 不写入，PVP 走原逻辑。

---

## 三种状态

| 状态 | 含义 | 何时进入 |
| :--- | :--- | :--- |
| `off` | 默认态，完全静默 | 加载后；`/wakeguard off`；`session_shutdown` |
| `sleeping` | 已启用，无 timer、无停泊请求，监听仍在 | 探测成功恢复后；一次成功回合；模型/会话切换；abort 后无停泊请求 |
| `probing` | 已启用且持有 gate：可能是在途探测，**也包括两次探测之间按 interval 等待的时段**；按 interval 链式排下一次 | `/wakeguard on`；判定为 outage / unknown 后 |

恢复只有一条路径：探测判 `reachable` → 清 timer、回 `sleeping`、把所有停泊请求 `resolve(true)` 一次。同一会话再次故障会开新 gate 重新接管。

---

## 安装

> `omp-wakeguard` 尚未发布到 npm。可使用本地路径或已公开的 Git 源 `https://github.com/Xeltra233/omp-WakeGuard`。

### 方式 1：单次会话加载（最可靠，不写配置）

```bash
omp -e /path/to/omp-WakeGuard
# 或在项目根目录
omp -e .
```

### 方式 2：安装为插件

```bash
omp install /path/to/omp-WakeGuard              # 安装
omp plugin install ./omp-WakeGuard --dry-run    # 先看动作
```

本地安装用 `omp plugin install /path/to/omp-WakeGuard`（等价于 `omp plugin link`），卸载用 `omp plugin uninstall omp-wakeguard`；可用 `omp plugin install ./ --dry-run` 先查看动作。`<baseUrl>` 等探针设置只影响看门狗，不改变安装入口。

### 方式 3：Git 源安装与定向更新

```bash
omp install https://github.com/Xeltra233/omp-WakeGuard
omp install git:github.com/Xeltra233/omp-WakeGuard
omp plugin install https://github.com/Xeltra233/omp-WakeGuard --force  # 更新已登记的 Git 源
```

### 查看与卸载

```bash
omp plugin list                       # 列出已安装插件
omp plugin uninstall omp-wakeguard    # 卸载
omp plugin uninstall --dry-run omp-wakeguard
```

---

## 命令

| 命令 | 作用 |
| :--- | :--- |
| `/wakeguard`、`/wakeguard status` | 状态块：state / url（来源 derived·explicit·none）/ interval / timeout / 停泊数 / 最近失败类别 / 最近探测结果 |
| `/wakeguard on` | 启用并立即探测一次；已启用时只报告状态，不重复探测、不重启周期 |
| `/wakeguard off` | 停泊请求各自 `resolve(false)`、中止在途探测、清 timer 与状态栏，回 `off`，不会自动复活 |
| `/wakeguard check` | 主动探测一次，不改变启用状态；`off` 时也可用 |
| `/wakeguard url <url\|auto>` | 指定探针 URL；`auto` 按当前模型 `baseUrl` 推导 |
| `/wakeguard interval <10m\|600000\|30s>` | 探测间隔（默认 `600000`ms），下限 1000ms；超过定时器上限的值直接拒绝 |

状态栏文案：`wakeguard off` / `wakeguard sleeping` / `wakeguard probing (N parked)`。

### CLI flag

| Flag | 说明 |
| :--- | :--- |
| `--wakeguard-url <value>` | 探针 URL 初值；不启用看门狗 |
| `--wakeguard-interval <value>` | 探测间隔初值（默认 10m）；不启用看门狗 |

两个 flag 都已向 OMP 注册（未注册的 flag 会被宿主拒绝：`omp -e . --bogusflag=x` 退出码 2，`Error: unknown flag: --bogusflag`）。OMP 在扩展加载完成后才解析 CLI flag，因此本构建不在工厂里读值，而是在 `session_start` 里通过 `pi.getFlag` 应用：只应用**变化过**的值，所以运行期 `/wakeguard interval` / `/wakeguard url` 设的值能跨会话切换保留（此项跨会话行为本轮未验收）。不存在 `--wakeguard-off`：加载态本来就是 `off`。

---

## 探针

- 单次 `GET`，**不携带任何凭据**；自定义 URL 不会泄漏 token；
- 请求头固定 `accept: application/json`、`cache-control: no-store`、`user-agent: omp-wakeguard/0.1`；`redirect: "manual"`；
- 超时 8000ms（含响应体），正文最多读取 8192 个 JS 字符用于判定（`readBodyPreview` 上限，按 JS 字符串长度计，不等价于固定 8KB 字节）；
- 判定：

| 响应 | 判定 | 含义 |
| :--- | :--- | :--- |
| 任意状态码 + JSON 正文 | `reachable` | 接口在线。**401/403/429/503 的 JSON 错误体同样算在线** |
| HTML / 空正文的 5xx | `unreachable` | 网关、关站页 |
| HTML / 空正文的 2xx/3xx/4xx | `untrusted` | 门户、登录跳转、WAF 页；不算恢复 |
| 连接拒绝、超时、DNS 失败 | `unreachable` | 传输层故障 |

URL 推导：取模型 `baseUrl`，剥掉已知端点后缀（`/chat/completions`、`/responses`、`/messages`、`/completions`、`/embeddings`、`/images/generations`），保留版本段，再补 `/models`；anthropic/claude 类 API 缺版本段时补 `/v1`。显式 URL 优先；非 `http(s)` 或含凭据的 URL 被拒绝，查询串在状态输出中打码。

---

## 与 omp-unlimited-pvp 联动

频道为 **`omp-wakeguard:before-retry:v1`**（与 Pi 版的 `pi-wakeguard:before-retry:v1` 不同，两个宿主互不串线）。PVP 在每次原生重试前同步 `emit` 一个请求对象，字段为 `version: 1`、`errorMessage`、可选 `model`（`provider`/`id`/`api`/`baseUrl`）、`signal`、可选 `status`（本次失败 HTTP 响应状态码）、可选 `contentType`（本次失败响应的 content-type）、以及可选的 `wait`；监听方在回调内**同步**给 `wait` 赋值（`Promise<boolean>`），没有赋值即视为未安装。`status` / `contentType` 必须由 PVP 在失败的那次响应上就地取证、不得继承上一响应（见下方「响应元数据优先级」）。

- 无监听方，或看门狗为 `off` → `wait` 未赋值 → PVP 完全按原逻辑重试；
- 判定 **api**（有 HTTP 状态且响应为 JSON；含 400/401/403/429/503）→ 不探测、不 park，立即 `resolve(true)` 交回 PVP；
- 判定 **outage**（连接拒绝/重置、DNS、`stream disconnected`、HTML 网关 5xx 等）→ park 并开始探测；
- 判定 **unknown** → 只做一次 classification probe：可达则 `resolve(true)` 回 `sleeping`，不可达则转 `probing`；
- 单独的 `timeout` 字样不作为 outage 信号；
- `resolve(true)` → 同一 run 原生重试一次；`resolve(false)` → 仅取消本次 run，不关闭 PVP、不动模式与成功计数。
- 恢复后再次断站，即使错误文本完全相同，也重新停泊；同次失败的多个重试入口不会重复打开等待。

**OMP 的取消面**：`/pvp off`、用户 abort、会话切换/分叉/tree 切换、`session_shutdown`、提交新 prompt 都会使该 `signal` abort；看门狗据此取消停泊请求。PVP 侧用 epoch 递增丢弃过期 `wait`，迟到的 `resolve(true)` 不会复活旧 run。

**OMP 与 Pi 的事件差异**（本构建的实际接线）：`session_start` 绑定 UI 与模型、`before_provider_request` 同步实际请求模型并清空上一条响应元数据（`lastStatus`/`lastContentType`）、`after_provider_response` 记录**本次**响应的 status 与 content-type、`session_switch` 作为会话纪元边界（OMP 无 `model_select`）取消 gate、`turn_end` 观察失败/成功、`session_shutdown` 退订并 `dispose`。

**响应元数据优先级（按当前 src，不复用上一响应）**：分类时 `status = input.status ?? lastStatus`、`contentType = input.contentType ?? lastContentType`——即 PVP 在同一次失败响应上取证的字段优先，事件缓存的 `lastStatus`/`lastContentType` 只是无 PVP 时的兜底；有 PVP 时 PVP 传入的本次证据始终压过缓存值。`status` 与 `contentType` 必须来自**同一次 attempt 的同一个 HTTP Response**：结构化 JSON 的 401/403/429/503 判 `api`（供应商在应答，PVP 继续原生重试，不停泊）；content-type 虽写 `application/json` 但响应体预览是 HTML 的关站页，会被清掉 json 标记并继续 park 探测；**没有拿到本次 HTTP Response 时两者都缺省，绝不继承更早响应的 status/content-type**。`after_provider_response` 每次都会用当前响应覆盖缓存，`before_provider_request` 在下次请求前清空，真实模型切换（`bindModel` 判定改变）也会清空；重新绑定同一模型不清空，但下一次 `before_provider_request` 仍会清掉，因此不会把更早一次响应的 status/content-type 误当成当前失败的证据。

**没有 PVP 时**：看门狗在 `turn_end` 观察到 `stopReason === "error"` 的失败回合后自行进入探测，只观测与恢复，不阻塞回合。`stopReason === "aborted"` 只取消 gate、保持静默——用户主动停止不是接口证据，不能变成探测流量。

**OMP 原生回退**：已启用看门狗后，A 回退到 B、B 后续接口故障会自动唤醒，并探测 B 的地址；`status`、`check` 与重新 `on` 也使用实际请求模型。显式 `/wakeguard url <url>` 仍优先于模型推导。无需监听特定回退事件或手动切模型。配套 PVP 的 `/pvp on` 会临时禁用宿主原生回退；本回退链路适用于 PVP 关闭时，不改变该策略。看门狗仍默认关闭，需先 `/wakeguard on`。

---

## 默认值

| 项 | 默认值 |
| :--- | :--- |
| 加载状态 | `off` |
| 探测间隔 | `600000`ms（10 分钟），下限 1000ms |
| 探测超时 | `8000`ms |
| 探测方式 | 无凭据 `GET <baseUrl>/models` |

---

## 已验证（仅本工作流实际跑过的）

在真实 bundled OMP CLI **18.4.1** 与真实 `omp-unlimited-pvp` 上，以本地受控 HTTP fixture 完成：实际供应商响应与命令输入是 fixture，断言打在真实 `omp` 子进程上；不使用外部供应商或真实凭据。

| 项目 | 实测结果 |
| :--- | :--- |
| 默认间隔 | 未改间隔的默认启动：首次探测立即发出，距下一次 GET 约 **600025ms**（同源时间口径）；随后接口恢复、停泊请求一次释放、进程正常结束、端口关闭后拒绝连接，退出码 0 |
| 正式六场景 | 关站节律、失败恢复、JSON 401、JSON 503、停泊中执行 `/wakeguard off`、加载即 off 六场景整体 `PASS real OMP CLI + real PVP`，验收驱动退出码 0。代表性计数：节律场景 19 次 GET / 1 次对话（探测间隔按 1s 验证）、恢复 2 次 GET / 2 次对话、JSON 401 与 JSON 503 各 1 次 GET / 2 次对话；停泊中 off 后未重试（2 次 GET / 1 次对话），非 RPC 宿主退出 1 并报告既有 `event loop drained` 取消诊断，不代表请求成功；加载即 off 为 0 次 GET / 1 次对话，退出码 0 |
| JSON 供应商错误 | JSON 401 / 429 / 503 三场景分别通过：各 1 次探测、2 次对话、进程退出码 0、端口拒绝连接；JSON 5xx 按供应商错误交回 PVP 原生重试，不停泊 |
| HTML 网关 5xx | 503 + `text/html` 关站页被判 outage：探测 2 次、对话 2 次，停泊后恢复只放行一次重试，退出码 0、端口拒绝连接 |
| 命令 help / 安装入口 | `omp -e . --help` 退出码 0，自注册 flag 被宿主接受；`omp plugin install ./ --dry-run` 输出 `[dry-run] Would link ./` 且退出码 0；`omp plugin list` 与 `omp plugin uninstall <plugin>` 在隔离目录中退出码 0，卸载后列表为空 |
| 版本与设置句柄 | 实际 CLI 为 bundled `omp/18.4.1`，内置 API 为 `openai-completions`；真设置句柄来自 `session.settings` 当前会话实例与 `@oh-my-pi/pi-coding-agent/session/settings` 的 SDK 导出，不是源码 CLI 或 fake provider |
| 取消面 | 真 bundled CLI 上 `/pvp off`、abort、model switch、new session / `session_shutdown` 取消旧 gate 后均不复活 |
| 同回合与同会话再次关站 | 同文 HTML503 在一个回合内停泊两次，原请求最终 `completed`；同会话下一提示再关站后恢复 `completed`。三个 gate、GET 11 / POST 5，POST 状态为 503/503/200/503/200；每次当前用户提示仅一份 |
| 原子新提示替换 | 真 `abort_and_prompt`：OLD 为 `aborted`，NEW 独立停泊后自身 POST200、`prompt_result completed`，GET 6 / POST 3（503/503/200）；断站及完成后各跨两间隔无额外 POST。两张原生卡的驱动退出码为 0，RPC 子进程以 SIGTERM 善后并确认 PID 消失、端口拒连 |
| 无 PVP 独立观测 | 真正不加载 `omp-unlimited-pvp` 时，健康期保持静默（GET 1），真实失败回合后探测 GET 增至 3，恢复 GET 200 后 POST 不再增加；没有 PVP gate，不 park。宿主自身仍会按既有重试逻辑发请求并可能退避，不能据此声称零宿主重试 |
| 9 次 JSON 503 | 9 次 JSON 503 后第 10 次 POST 返回 200，`prompt_result` completed、`agentInvoked` / `sessionSettled` 为 true；10 次 POST 每次 1 条用户消息，稳定期 GET 不重复。该卡 startup 的 `/pvp on` 早于 live 绑定，宿主出现 0.5/1/2/4/8s 退避，不能作为零冷却证据 |
| 六键真设置 | 同一 live `session.settings` 上 `/pvp on` 后六项 `retry.*` 生效、`prov=runtime`，通知为 `PVP ON` 且误告警为 0；`/pvp off` 后六项同 scope 精确还原为 baseline（`retry.enabled=false/global`，其余 `undefined/default`），宿主进程与端口均已清理 |
| 原生回退后的备用接口故障（0.1.1） | 实际 `omp.exe` 18.4.1、PVP 不加载：A POST429 → 原生回退 B POST200 → 下一提示继续 B → B HTML503 自动探针与状态都指向 B；A 无新探针。B 恢复后跨两间隔无 GET、无失败提示重放；`check`、新提示、显式 URL 与 `url auto` 后重新启用均通过，驱动退出码 0，子进程与两个端口已释放 |

**未验证范围**：flags 跨会话切换尚未形成最终验收结论；真实外部供应商端点未验收；交互 TUI 状态栏外观未截图验收；npm 尚未发布。安装可使用本地路径或上述公开 Git 源，不依赖任何临时目录或内部验收入口。

---

## 本地开发

```bash
npm install           # 会写 package-lock.json（本仓库未入库）
npm run typecheck     # tsc --noEmit
npm run build         # tsc，输出 dist/
node test/omp-cli-wakeguard.mjs   # 端到端harness入口（见下）
node test/fallback-cli.mjs        # 真实 OMP 原生回退与备用接口故障回归
```

`test/omp-cli-wakeguard.mjs` 是真实 OMP CLI + 真实 `omp-unlimited-pvp` 的 harness 入口：只有供应商（本地 HTTP fixture）和命令输入是 fixture，断言都打在真实 `omp` 子进程上；它按 `omp-unlimited-pvp` 目录解析同名 SDK 副本，因此两个仓库需并列。

`npm run test:fallback` 默认启动本仓依赖中的 bundled OMP CLI，独立运行、不依赖 PVP 仓库。可用 `OMP_EXECUTABLE` 指定实际宿主可执行文件、`WAKEGUARD_EXTENSION` 指定待验收的安装入口、`WAKEGUARD_EVIDENCE_DIR` 指定本地证据目录；默认日志只写入被忽略的 `goal-1/evidence/`。只注册两个 loopback 供应商，使用隔离 agent 目录，不读取真实凭据、不修改用户回退设置；结束时清理临时目录、子进程与监听端口。

`package.json` 的 `scripts` 为 `build` / `typecheck` / `test:fallback`；`files` 为 `src` / `dist` / `README.md`，`omp.extensions` 与 `pi.extensions` 均指向 `./src/index.ts`。

---

## 许可

[MIT License](LICENSE)
