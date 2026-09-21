# dsh-remote-workspaces

**English TL;DR** — A DeepSeek Harness (DSH) plugin that adds a `remote-workspaces` panel to the
sidebar: another machine's workspaces, conversations and its whole web GUI, mapped onto
`127.0.0.1` on this machine. Read the other machine's conversations message by message, open its GUI
in a tab (or embedded in the panel), forward its ports into your local browser, and hand a task to
the agent running over there. Machines talk over an end-to-end encrypted N-node mesh — the public
relay in the middle only ever sees ciphertext. Zero npm dependencies. Chinese README follows.

给 DSH Web GUI 加一个 **remote-workspaces** 侧边栏：另一台电脑的工作区、对话和它**整个 GUI**，
都能映射到本机 `127.0.0.1` 上直接操作。两台（或更多）机器之间走一条端到端加密的 Mesh，
中间那台有公网 IP 的服务器只做盲转发，**只看得到密文**。

- 插件本机零 npm 依赖；`bin/mesh-relay.mjs` 也是零依赖，可以单独拷到服务器上跑
- 已在 DSH `0.1.5-rc.2` + Windows 上完整验证；**Linux/macOS 未测**（插件代码本身平台无关，
  但 `tools\*.ps1` 这套部署脚本是按 Windows 写的）

---

## 一、它实现了什么

| 需求 | 实现方式 |
|---|---|
| 侧边栏加 `remote-workspaces`，与本机 workspace 区分 | 官方插槽 `sidebar.panellist` + `main`（keyed）。总线一行 `remote-workspaces`，每台已配对机器各一行 `remote-workspaces: <名字>`，点开是独立主面板，不混进本机工作区列表 |
| 自动同步另一台的工作目录与对话 | 每台机器都通过 Mesh 暴露 `#api snapshot`，返回自己的工作区（标题、路径、会话数）与对话（标题、cwd、更新时间、是否运行中），本机按 `pollMs` 轮询缓存。「读对话」按钮把远端会话的**逐条消息**（谁说的、什么时间）拉过来显示，不用开第二个 GUI 窗口 |
| 在任何一台电脑上打开另一台的对话并在本机操作 | 对每个 peer 在本机 `127.0.0.1:<稳定端口>` 起一条**字节级 TCP 隧道**，直通对面 DSH 的 GUI 端口；浏览器打开就是完整的远端 GUI（可新标签页，也可面板内嵌） |
| 调用远程电脑的 agent 继续干活 | `agent.prompt` / `agent.create`：提示词经 Mesh 送到对面，对面 DSH 自己建会话、跑 agent 循环、写日志。面板里「派活」按工作区派，已有对话可「让远端继续」 |
| 调试部署在另一台的静态网页 | 端口转发：`远端端口 → 本机端口`，本机浏览器直接开 `http://127.0.0.1:<本机端口>`。静态站点、Vite dev server、任何 loopback 服务都行 |
| 多于两台电脑互联 | 每台机器一个节点 id，peer 是 N×N；中继按节点 id 交换虚拟电路，加机器不影响已有链路 |
| 通信安全、不泄露 | 见「安全模型」：公网中继只能看到密文，隧道目标、DSH launch token、对话内容全在 AEAD 信封里 |

---

## 二、架构

```
        ┌────────────┐        ┌────────────┐
        │  笔记本     │        │   台式机    │
        │  dsh web   │        │  dsh web   │
        │  + 本插件   │        │  + 本插件   │
        └─────┬──────┘        └──────┬─────┘
              │  ① 同一局域网：直连 TCP（可选，不经服务器）
              └──────────┬───────────┘
                         │
             ② 跨公网：两端都主动外连 wss://（443）
                         │
                 ┌───────▼────────┐
                 │  你的服务器      │
                 │  nginx :443     │
                 │  └ 盲转发中继    │  ← 只转发密文帧，看不到内容
                 │    127.0.0.1:8787│
                 └─────────────────┘
```

三条链路要分开理解：

- **同一局域网**：不必经过服务器。把监听地址改成 `0.0.0.0`，对面填内网 IP + 端口即可直连。
- **跨公网**：两台机器都**主动外连**服务器 443，谁都不需要开入站端口，NAT 后面也能用。
- **服务器上**：nginx 把 `/__dsh-mesh/relay` 转给只监听回环的 `mesh-relay.mjs`；公网只多一个
  `location`，不新开端口。

---

## 三、安装（每台要互连的电脑都装）

要求：**DSH**（Harness）已装好、Node.js 18+。

1. 把本仓库放到一个固定位置，例如 `D:\scripts\dsh-remote-workspaces`。
2. 装进 DSH 的 profile：

   ```powershell
   dsh plugin --profile web add "link:D:\scripts\dsh-remote-workspaces"
   ```

3. 重启 `dsh web`。插件是 host 侧加载的，**必须重启进程**：

   ```powershell
   # 推荐用自带脚本：重启 → 验证插件真的加载了 → 没加载就自动摘掉插件重启（退出码 3）
   powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\activate.ps1
   # 只想看当前进程加载了没有（不动任何东西）：
   powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\activate.ps1 -Verify -Port 3080
   ```

   > 从**普通终端**跑，别从 Harness GUI 里跑——重启会连同 GUI 所在的进程树一起结束。

4. 打开 GUI，左侧应该出现 `remote-workspaces`。

首次启动会在 `$DSH_HOME\dsh-remote-workspaces\config.json` 自动生成节点身份、集群密钥与直连监听端口。

---

## 四、配对（两种方式）

### 方式一：配对码（推荐）

一台点「添加电脑 → 生成配对码」，把那一串粘到另一台的「接收并加入」。**一条码同时带过去节点 id、
集群密钥、中继地址与中继密钥**，粘一次两边就互相加好了。

> 配对码里含集群密钥，等于把这两台机器放进同一个私有网络，**不要外发**。

### 方式二：手动

在「添加电脑 → 方式二」里填对面节点 id（面板顶部「本机节点 …」能看到）、显示名、通道
（`局域网直连` / `公网中继`），直连再填地址与端口；集群密钥两边要一致。

> 默认只监听 `127.0.0.1`。要用局域网直连，把「设置」里的监听地址改成 `0.0.0.0`，并在对面填
> 本机内网 IP + 端口。端口被占用时插件会自动往后找一个可用端口并在日志里说明。

---

## 五、跨公网：把中继放到你的服务器上

### 服务器侧（Windows + nginx）

1. 服务器装 Node.js（18+ 即可，中继零依赖）。
2. 把本仓库拷到服务器，例如 `C:\dsh-remote-workspaces`。
3. **先看它打算怎么改，再让它改**（不改任何东西，只打印 diff）：

   ```powershell
   node C:\dsh-remote-workspaces\tools\deploy-relay.mjs plan --domain mesh.example.com
   ```

4. 满意了就执行。它会：备份 nginx.conf → 在**你指定域名那个 TLS `server` 块**里插入一段带标记的
   `location` → 跑 `nginx -t` → **测试通过才 reload** → 启动中继 → 探测公网健康地址：

   ```powershell
   node C:\dsh-remote-workspaces\tools\deploy-relay.mjs apply --domain mesh.example.com
   ```

   安全边界：只动那个 vhost 里的一段带标记区域，**其它 vhost 一个字节都不碰**；加的东西全部落在
   `/__dsh-mesh/relay` 前缀下（**健康检查也在前缀里**，不会占用你站点本来在用的 `/healthz`）；
   改之前先备份；`nginx -t` 失败会**立刻还原备份**；测试不过绝不 reload。

   ```powershell
   node ...\deploy-relay.mjs rollback --domain mesh.example.com   # 撤掉插入的块
   node ...\deploy-relay.mjs status   --domain mesh.example.com   # 看现状
   node ...\deploy-relay.mjs stop                                 # 停掉它启动的中继
   node ...\deploy-relay.mjs snippet                              # 只打印配置块，自己粘
   ```

   它会生成中继密钥写到 `relay-secret.txt` —— **两台电脑的「设置 → 中继密钥」要填同一个值**。

5. `plan` 报「No `server` block … serves <域名>」说明你的 vhost 在别的 include 文件里：用
   `--conf <那个文件>` 指过去，或直接用 `snippet` 打印出来自己粘（手动方案见
   `docs/nginx-relay.conf`，独立子域模板见 `docs/nginx-vhost-example.conf`）。
6. 该子域的 DNS 记录如果是 Cloudflare，要设成 **DNS only（灰云）**，橙云会挡 WebSocket。

### ⚠️ 证书必须发「整条链」

这条容易踩：**nginx 只发叶证书、不带中间证书时，浏览器和 curl 能正常访问，但 Node 会拒绝**
——Node 不会像浏览器那样去 AIA 补中间证书，而插件的 `wss://` 客户端就是 Node。先自查：

```powershell
node tools\deploy-relay.mjs chain --domain mesh.example.com
# 期望： certificates  2 sent by the server  …  node trust  OK
# 如果： certificates  1 sent by the server  …  node trust  REFUSED (UNABLE_TO_VERIFY_LEAF_SIGNATURE)
#   -> 把 ssl_certificate 指向整条链的文件（Certify The Web 里形如 *-fullchain.pem 的那个），
#      nginx -t && nginx -s reload 之后重跑。
```

修好之前，插件侧有两个临时口子：「设置 → 自签证书的 CA 文件路径」指向中间证书，或勾
「不校验证书」（会在日志里留警告）。`apply` 探测失败时也会自动提示这一条。

### 两台电脑侧

「remote-workspaces → 设置」里填：

- **中继 WebSocket 地址**：`wss://<你的域名>/__dsh-mesh/relay`
- **中继密钥**：服务器上 `relay-secret.txt` 那串

保存后会自动重连；每台机器的 peer 通道选「公网中继」即可，不管笔记本在哪个网络。

### 中继看到什么

节点 id、电路 id、帧长度、时间。**看不到**内容、隧道目标、DSH launch token——那些都在两台机器之间
的 AEAD 信封里。

---

## 六、日常用法

- **打开远端 GUI**：卡片上「打开远程 GUI」→ 新标签页；「在此处打开」→ 面板内嵌 iframe。
  首次带 token 的 URL 会换出 cookie 并跳回干净的 `/`，端口固定、cookie 长期有效；
  **重启之后也不用重新点**（GUI 代理会持久化并自动恢复）。若浏览器拦截了新标签页，面板会把地址
  贴出来并尝试复制，不会按了没反应。
- **读远端对话内容**：对话那行「读对话」→ 面板里直接列出逐条消息（你/远端、时间），最多 40 条。
- **派活给远端 agent**：工作区那行「派活」→ 写要求 → 发送；远端**在那个工作区里**新建对话并跑 agent。
- **让远端继续已有对话**：对话那行「让远端继续」→ 写补充 → 发送，提示词进入那个已有会话。
- **调试远端网页**：把远端端口映射到本机 → 列表里点「打开」。对面那个端口没服务在监听时，本机
  看到的是一张 **502 说明页**（而不是空白或连接被重置），会告诉你具体地址和失败原因。
- **全部刷新**：立刻重新拉一遍所有 peer 的清单。

---

## 七、安全模型

**密钥**：每台机器一枚 X25519 身份密钥对 + 一个所有机器共享的 32 字节集群密钥（配对码携带）。
两者都存在 `$DSH_HOME\dsh-remote-workspaces\config.json`。

**握手**（每次建链跑一次，三条消息）：会话密钥由四段 ECDH 与集群密钥一起派生——
`ee`（临时×临时，前向保密）、`ss`（静态×静态，身份认证）、`es`/`se`（临时×静态，抗密钥泄露伪装），
再 HKDF-SHA256 出**两个方向独立的 AES-256-GCM 密钥**，各方向单调递增的计数器做 nonce；记录被重排
或重放会被拒绝。集群密钥不对、HELLO 被篡改、nonce 重放都有对应自检用例。

**不泄露的东西**：单条链路只有密文；中继只转发带 `{from, to, circuitId}` 头的密文帧；隧道目标
（`127.0.0.1:5173` 这类）在加密载荷里；DSH 的 launch token 也在里面。

**链路活跃性**：mesh socket 与到中继的 socket 都开 TCP keepalive（空闲 30s 起探测），避免"笔记本
睡一觉回来"时半死连接一直显示已连接；发不出去的帧会**立刻**报错并把链路判死重连，不静默挂 15 秒。

**本机侧**：浏览器的 `remote-workspaces` 请求走一条 loopback 保护的自注册路由，校验来源 socket、
`Host`、`Origin`，并要求一个**每进程随机 boot token**（由 index 注入 `__DSH_REMOTE_WORKSPACES__`）；
隧道目标只允许 `#api` 或回环地址（SSRF 白名单），peer 无法让本机去连任意主机。

**已知取舍**：中继目前是单点，没有多中继/自动选路。

---

## 八、诊断

每台机器卡片上有「诊断」按钮，它**逐段真探测并计时**：

本机配置 → 中继 → 加密链路 → 远端 Mesh API（往返毫秒数）→ 远端清单 → 远端 `dsh web` 端口
（真的去连一次）→ 本机 GUI 代理 → 每条端口转发的远端目标。

**从上往下第一个 ✘ 就是断在哪一段。** 例：中继、链路、远端 API 全 ✔，但「远端 dsh web 端口」✘
→ 对面那台的 `dsh web` 没在跑；链路就 ✘ → 那台机器离线或密钥不对。

日志：`$DSH_HOME\dsh-remote-workspaces\plugin.log`（Harness 自己的 logger 可能被级别过滤，
所以插件也落盘一份）。

---

## 九、自检与测试

全部**不需要第二台机器**（`tools\selftest.mjs` 一次跑完 5 套，共 **52 项**）：

```powershell
node tools\selftest.mjs
node test\crypto.test.mjs        #  8 项：握手、集群认证、AEAD 方向/重放/重排
node test\mesh.test.mjs          # 13 项：真 socket、HTTP 隧道、并发、4MB 载荷、
                                 #        端口没监听会被明确拒绝、中继密文不透明、
                                 #        SSRF 拒绝、peer 掉线不崩进程
node test\relay-tls.test.mjs     #  7 项：wss:// 走 TLS 反向代理、证书真的被校验（不信任就拒）、
                                 #        自签口子可用、中继进程重启后自动恢复、无 unhandled rejection
node test\nginx-edit.test.mjs    # 11 项：vhost 选择、插入位置、幂等、逐字节回滚、CRLF、
                                 #        拒绝猜测、注释里的花括号不误导解析
node test\deploy-relay.test.mjs  # 13 项：plan 不改文件、apply 后 nginx -t 通过才 reload、
                                 #        nginx 拒绝的配置自动还原、探测撞上 reload 竞态会重试、
                                 #        chain 能识破只发叶证书的服务器、rollback、stop
```

`tls` 套需要 `openssl` 签一张本地证书，找不到就报 **SKIP**（不算通过）。`deploy` 套用
`test/fixtures/nginx.cmd` 这个像真 nginx 一样校验花括号的替身，以及一对**一次性的 localhost
测试证书**（`test/fixtures/localhost-test-*.pem`，只为本地测试、保护不了任何东西，详见
`test/fixtures/README.md`）。

**验收你自己线上的中继**（不用登录服务器）：

```powershell
node tools\deploy-relay.mjs chain --domain mesh.example.com          # 期望 2 张证书 + node trust OK
$env:DSH_MESH_RELAY_URL = 'wss://mesh.example.com/__dsh-mesh/relay'
node test\relay-tls.test.mjs                                         # 期望 6 checks passed, 1 skipped
```

**跨两个真 DSH 的端到端**（配对 → 同步清单 → GUI 代理 → 派活，共 11 项）：

```powershell
# 两个实例各自的插件 boot token（不用开浏览器）：
node tools\read-boot-token.mjs --port 3098 --launch-token <A 的启动 token>
node tools\e2e-two-node.mjs --a-port 3098 --a-token <A> --b-port 3097 --b-token <B>
```

---

## 十、目录结构

```
dsh-remote-workspaces/
  package.json            dsh.bundle.patch + dsh.client 声明（零 dependencies）
  cordis.patch.yml        把插件行插进 web profile
  lib/index.js            host 半区：配置、Mesh、隧道、GUI 代理、端口转发、/remote-workspaces 路由
  lib/client.js           browser 半区：侧边栏条目 + 主面板（懒加载 CJS bundle）
  lib/core/crypto.js      X25519 / HKDF / AES-256-GCM 与握手
  lib/core/link.js        握手 + 长度前缀 + AEAD 帧
  lib/core/mux.js         一条链路上的多路复用流
  lib/core/transport.js   直连 TCP 与中继虚拟电路
  lib/core/relay-wire.js  中继线格式
  lib/core/ws.js          精简 RFC6455（只为中继承载）
  lib/core/mesh.js        Mesh：身份、peer、流、入站策略
  lib/core/util.js        目标校验、类型、工具
  bin/mesh-relay.mjs      服务器端中继（零依赖，可单独部署）
  test/*.test.mjs         52 项自检（5 套）
  test/fixtures/          替身 nginx + 真实风格的 nginx.conf + 一次性测试证书
  tools/selftest.mjs      一次跑完所有自检
  tools/e2e-two-node.mjs  跨两个真 DSH 的端到端联调（配对→同步→代理→派活）
  tools/read-boot-token.mjs   不打开浏览器读出插件 boot token（给上面的 e2e 用）
  tools/deploy-relay.mjs  中继部署：plan/apply/chain/status/rollback/stop/snippet
  tools/nginx-edit.mjs    nginx 配置纯函数（被部署脚本和自检共用）
  tools/activate.ps1      安全重启 + 验证 + 失败自动回滚（Windows）
  tools/install-autostart.ps1  计划任务 dsh-web / dsh-mesh-relay（Windows）
  tools/make-twin-home.ps1     隔离的第二 DSH home，用于本地双机联调
  tools/read-session.mjs  解 zstd 多帧会话日志
  tools/mesh-peer.mjs     模拟一台远端机器（serve/probe/prompt/conversation）
  docs/nginx-relay.conf          nginx 片段（手动方案）
  docs/nginx-vhost-example.conf  给中继准备的独立子域 vhost 示例（含证书链的坑）
```

---

## 十一、限制与未做的部分

- **会话深链**：DSH 客户端没有会话 URL 路由，所以点对话不能直接跳到远端那个会话；用「读对话」
  在面板里看内容，或「打开远程 GUI」去找它。
- **面板只显示最近 40 条消息**（可调 `limit`），要看全部就开远端 GUI。
- **`listenHost` 默认 `127.0.0.1`**：局域网直连要显式改成 `0.0.0.0`（有意为之，避免默认暴露）。
- **中继是单点**，没做多中继/自动选路。
- **不做文件镜像**：设计上是实时直连（不做本地镜像，所以不会漂移）；要离线镜像应该另做一个
  同步层，而不是塞进隧道里。
- **握手标签里带插件名**（`dsh-remote-workspaces/link/v1` 等），所以**两端必须跑同一个版本**：
  旧版本节点不认新帧，隧道会等到超时。
- **平台**：插件本体与 CLI 工具平台无关；`tools\*.ps1` 与 nginx 部署路径按 Windows 写、也只在
  Windows 上实测过，Linux/macOS 欢迎 PR。

---

## 十二、许可证

MIT，见 `LICENSE`。安全问题请按 `SECURITY.md` 私下报告。
