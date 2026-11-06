# HomeworkHub · 课业中枢

跨平台汇总自己的作业、考试信息 —— 学习通 / 雨课堂（含长江雨课堂）/ iSmart / PTA 拼题A。

**当前版本：1.0.0（首个开源版本）**

```
$ node apps/cli/src/main.ts demo
...
全部通过：83 通过 / 0 失败

$ npm test
...
tests 566 / pass 566 / fail 0
```

## 功能与验证状态

这个项目的平台接口来自真机抓包，不是平台官方 API；平台改版就可能失效。**有设计 ≠ 已验证**，下面按真实数据验证程度区分：

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 账号登录与保活 | ✅ 长期使用 | 应用内登录 + 会话保活；不接触明文密码 |
| 作业待办抓取 | ✅ 长期使用 | 学习通 / 雨课堂 / iSmart / PTA |
| 超星任务点抓取 | ✅ 长期使用 | 课程级 X/Y 与「现在可做 N 个」 |
| 按课程自定义筛选 | ✅ 长期使用 | 勾选参与同步，取消后保留历史记录 |
| 即将截止的提醒与通知 | ✅ 长期使用 | 三档提醒密度 + 每日汇总 |
| **任务点提醒（排期）** | ⚠️ 未经过真实数据验证 | 数据抓取已验证，但「提前量 / 工作量估算」还没有真实到期数据检验，可能偏早/偏晚 |
| **考试待办抓取（尤其超星）** | ⚠️ 高风险区域 | 历史上出现过考试列表/时间解析问题；数据不对先看同步日志 |

如果你只依赖某个未验证的能力做决定，请先核对平台原始页面。

---

## 为什么需要它

一个学期要开四五个教学平台，每个平台的作业和考试都藏在不同的入口里。
结果是：忘了交作业不是因为懒，是因为**根本没看到**。

现有工具都只解决了一半：课程表类 app（WakeUp、ClassIsland、小爱课程表）
管的是「周几第几节在哪上课」，而作业和考试散落在各平台的深层页面里，
没有统一的截止时间视图。

HomeworkHub 要做的是：把这些平台的作业与考试拉到一个列表里，
按截止时间排序，到点了提醒你。

---

## 「会不会影响我正常用这些平台？」

这是用这类工具时第一个该问的问题。答案：**能保证，但保证是有边界和前提的**，
而且本项目把它做成了**运行时强制、可被测试断言**的约束，不是一句宣传语。

### 三层强制机制

**① 只读守卫（HTTP 层强制）**

`packages/core/src/engine/read-only-guard.ts` 包在最外层传输管道上，
适配器**没有办法绕过**：

| 规则 | 内容 |
| --- | --- |
| Rule 1 | 默认只允许 `GET` / `HEAD` |
| Rule 2 | 任何非安全方法必须在适配器的 `readOnlyPolicy.allowPost` 里**逐条声明并写明用途** |
| Rule 3 | 兜底黑名单：`submit` / `handin` / `qiandao` / `mark-read` / `study-record` / `logout`… 命中即拒绝，**优先级高于白名单** |

Rule 2 的副作用正是它的价值所在 —— 想知道这个 app 一共会发多少个「写请求」？
把各适配器的 `allowPost` 读一遍即可，通常只有 1~3 行。这是可审计性。

默认黑名单里刻意包含了一些看着人畜无害的路径：`mark-read`（已读回执）、
`study-record` / `heartbeat`（学习时长上报）—— 这些才是最容易被忽视、
又最需要避免的：它们会污染你的学习行为数据。

**② 会话来源策略（不替你重新登录）**

会话带一个 `origin` 标记：

- `imported` —— 你从浏览器/客户端里复制出来的。
  **我们永远不会用账号密码去重新登录。** 因为「重新登录」会在服务端创建一个新会话，
  而多数平台是单点登录或会轮换 token —— 那会把你手机上正在用的那个会话顶下线，
  或者弹出「新设备登录」提示。
- `derived` —— 你用账号密码独立登录取的（我们会提示可能与官方客户端互踢）。

会话失效时的正确做法是**报错并把决定权交回给你**：
「请到浏览器里重新登录后把新的凭证粘贴过来 —— 我们不会替你重新登录」。

引擎自始至终不保存明文密码，所以它在物理上就没有「自动续期」这个能力。

**③ 风控友好的节奏（比你自己刷手机还温和）**

- 每个平台一个全局共享的令牌桶，多账号共用配额
- 课程列表 12 小时 TTL 缓存，不是每次都拉
- 429 时把 `Retry-After` 回灌限流器（后续请求自动降速），而不是只 sleep 这一次
- 全抖动指数退避，避免多账号齐步重试形成新尖峰
- 401/403 不重试（重试也不会变好，只会浪费请求额度、加剧风控）

### 这条承诺是可验证的

`demo` 的第 14 个场景就是专门验证它的：

```
【场景 14】 只读守卫与登录态隔离 —— 证明我们不会影响你正常使用平台
   平台收到的请求      19 次  {"POST":2,"GET":17}
   ✓ 除登录外，平台只收到过 GET 请求
   ✓ 提交类 POST 被拦截（WRITE_BLOCKED）
   ✓ 危险端点从未真正收到请求  submitCount=0
   ✓ 把动作藏进 query 参数同样被拦截
   ✓ 正常 GET 查询不受影响  status=200
   ✓ 会话已标记为 imported（用户自己提供的）
   ✓ 没有产生任何新的登录请求（不会把你顶下线）
   ✓ 提示语明确告知「不会替你重新登录」
```

假教学平台里放了一个「危险端点」诱饵（`POST /submit`）。
测试会主动去尝试提交它，然后断言它被拦下、且服务端从未收到过这个请求 ——
**一个从没被尝试过的保护措施，等于没有保护措施。**

### 做不到的部分（诚实交代）

1. **无法 100% 保证零影响。** 平台的风控是黑盒且持续变化。我们能做的是「最小侵入」
   （低频 + 只读 + 复用你自己的会话），但不能承诺零影响。如果平台把
   「同一 cookie 在不同 UA/IP 下并发请求」判为异常，我们无法预知。
2. **会话失效是必然的。** 你在手机上点了退出、或平台策略性地轮换 token，
   导入的会话就失效了。这时会提示你重新粘贴 —— 这是设计，不是缺陷。
3. **不要和我们同时高频使用官方客户端。** 部分学校禁止账号共享，
   同时高频使用理论上存在被判定为异常的风险，这点需要你自己评估。

### 一个更"零影响"的形态（已实现，不止是备选）

上面三层机制把影响压到最低，但严格说仍是「少发请求」。往下还有两级，
本项目已经把这两级做成了**可用的命令** —— 关键洞察是：
**它们都实现为 `HttpClient` 的替身，所以任何适配器零改动就能换载体。**

#### 路线矩阵：按对登录态的影响排序

| 路线 | 对登录态的影响 | 向平台发请求 | 凭据是否过手 | 平台覆盖 | 状态 |
| --- | --- | --- | --- | --- | --- |
| **HAR 回放** | **零**（字面意义零请求） | **0 次** | 否（默认脱敏） | 全部 | ✅ 已实现 |
| **CDP 附着** | 零（借用你自己的浏览器） | 有，但身份 100% 是你 | **否**（HttpOnly 对页面 JS 不可见） | 全部（需同源标签页） | ✅ 已实现 |
| 共享会话（粘贴 cookie） | 低（只读，不续期） | 有（低频） | 是（你粘贴的） | 全部 | ✅ 已实现 |
| 独立登录 | 中（可能与官方客户端互踢） | 有 | 是（密码） | 视平台而定 | ✅ 已实现 |
| 浏览器扩展 | 零 | 来自用户浏览的页面 | 否 | 单平台 | 规划中 |

#### `record` → `import-har`：字面意义的零请求

```bash
# ① 录制一轮（也可以直接用浏览器 DevTools 导出 HAR）
node apps/cli/src/main.ts record chaoxing 你的账号 你的密码 --out capture.har

# ② 之后任何时候离线回放 —— 平台甚至可以完全不在线
node apps/cli/src/main.ts import-har chaoxing capture.har
```

录制文件**默认脱敏且不可关闭**：Cookie / Authorization / csrf 全部剥掉。
因为回放只需要响应体，凭证留在文件里等于把账号密码写进一个会被随手转发的 JSON。

局限（必须说清）：回放是**快照**，看到的是录制那一刻的数据，
看不到老师今天新布置的作业。所以它是「导入」路线，不是「持续同步」路线。

demo 场景 15 验证了这条路线：**先录制，然后把平台真的关掉，再回放** ——
同步依然成功，且拉到的任务与真实同步完全一致（0 新增、全部命中）。

#### `attach`：借用你已登录的浏览器（凭据不过手）

```bash
# 浏览器快捷方式加 --remote-debugging-port=9222 启动，登录平台，保持标签页开着
node apps/cli/src/main.ts attach chaoxing --port 9222
```

请求是在你自己的浏览器标签页里发出的，用浏览器自己的会话：

- 我们**不创建任何新会话** —— 不会有「新设备登录」提示，不会顶掉任何客户端
- **凭据不过手** —— cookie 由浏览器自动附带，而 HttpOnly cookie 对页面 JS 不可见，
  所以我们连读都读不到，更不可能存
- 能到达的接口范围 = 那个页面自己能到达的范围（CORS 决定），
  所以 `pickTargetForOrigin()` 会按请求的 origin 自动挑标签页，挑不到就显式报错

这也是 iSmart 这类「客户端是套壳 Chromium」的平台唯一现实的只读路径 ——
社区的 iSmartAuto 就是这么发现客户端可以加 `--remote-debugging-port` 的。
区别在于：他们用它提交答案，我们只用它读取作业。

#### 一个踩出来的坑：离线路径必须显式圈定范围

`import-har` 最初实现时调的是 `syncAll()`（不带参数），
结果引擎把库里**所有账号**都同步了一遍 —— 包括挂着真实会话的账号，
于是「零网络请求」的承诺被一行代码悄悄破坏了。

所以两条离线命令都强制传 `accountIds: [account.id]`，
并在代码里留了注释说明为什么。**默认行为是全局的，而全局行为对离线场景是危险的。**

---

## 跑成 App（真机验证入口）

现在有三种跑法，按"离真实 App 有多远"排序：

### ① Android APK（推荐，已可直接安装）

```bash
npm install            # 只为拿 typescript
npm run android:apk    # 生成前端资源 + 打 APK
# 产物：release/homework-hub-1.0.0-debug.apk（约 860 KB）
adb install -r release/homework-hub-1.0.0-debug.apk
```

也可以用 Android Studio 打开 `android/` 目录直接 Run。
**真机排查、预期行为、常见问题看 [`docs/安卓版说明.md`](docs/安卓版说明.md)。**

手机端的登录方式与桌面不同：**在应用内的 WebView 里打开平台官网正常登录**，
cookie 进系统的 CookieManager，我们的 JS 读不到、也拿不到密码。
这是手机上最安全的接入方式，不用手动复制任何凭证。

WebView 里有三个必须替换的 Node 依赖（这也是为什么要有 `packages/web-kit`）：

| 桌面端 | 手机端 | 说明 |
| --- | --- | --- |
| `JsonFileStore`（node:fs） | `PersistentStore` | MemoryStore 快照 + localStorage |
| `EncryptedVault`（node:crypto） | `WebCryptoVault` | 仍是 AES-256-GCM，只是换成 WebCrypto |
| `FetchHttpClient` | `BridgeHttpClient` | 走原生网络栈，绕开 CORS |

引擎、适配器、合并、提醒、只读守卫一行都不用改 —— 这也是当初把存储/加密/HTTP
都做成端口的原因。

### ② 本地 Web App（开发时最方便）

```bash
node apps/web/src/server.ts
# 打开 http://127.0.0.1:7777/
```

界面是移动端优先的：待办（按 逾期 / 24 小时 / 三天 / 更晚 分组）、账号管理、
变更记录、同步日志，右上角一键同步。零新依赖、零构建。

**手机浏览器访问**（不用装 APK）：

```bash
node apps/web/src/server.ts --lan
# 会打印类似：http://192.168.x.x:7777/?token=AbC123xyz
```

`--lan` 会监听局域网并强制要求访问令牌（每次启动重新生成）。

开发时想连本地假平台（不碰真实账号）：

```bash
node scripts/mock-server.ts &
HH_MOCK_URL=http://127.0.0.1:8792 node apps/web/src/server.ts
```

### ③ 离线数据导入（零影响，已实现）

在「账号」页 → 零影响路线 → 上传 DevTools 导出的 HAR 文件。
全程不发一个网络请求。

### ④ 桌面原生壳（下一步）

server + UI 这两层就是为被包裹准备的：Tauri 2 把 `apps/web/public` 当前端，
Rust 侧起一个 sidecar 跑 `server.ts` 或移植 core 即可。

### Web App 的 API（给想做壳层的人）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 一次拿全：账号 + 分组待办 + 平台清单 + 最近提醒 |
| GET | `/api/tasks?days=N` | 待办列表 |
| POST | `/api/sync` | 同步全部账号（并发请求会被合并成同一个） |
| POST | `/api/login` | 账号密码登录，或粘贴 cookie / 浏览器内登录（后两者不发请求） |
| POST | `/api/import-har` | HAR 回放（零网络请求） |
| POST | `/api/attach` | CDP 附着（借你已登录的浏览器，仅电脑） |
| GET | `/api/changes` `/api/log` `/api/platforms` | 变更 / 日志 / 平台能力矩阵 |

同一份 API 实现（`apps/web/src/api.ts`）同时跑在 Node HTTP 与 Android WebView 里。

---

## 30 秒跑起来

只依赖 Node 22.18+（用它的原生 TypeScript 支持，**零构建步骤、零运行时依赖**）。

```bash
cd homework-hub

# 端到端能力验证：启动一个会「使坏」的假教学平台，
# 复现改版、限流、会话失效、任务增删改，逐条断言引擎的处理是否正确
node apps/cli/src/main.ts demo

# 单元测试（566 项）
npm test

# 查看支持的平台与能力矩阵
node apps/cli/src/main.ts platforms

# 本地 Web App（开发入口）
node apps/web/src/server.ts

# 打 Android APK（需要 JDK 17 + Android SDK）
npm run android:apk
```

Windows 下如果中文输出乱码，用辅助脚本（会处理 UTF-8 与控制台编码）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run.ps1 demo
```

---

## 目录结构

```
packages/core/            跨平台聚合核心（不依赖任何 UI 框架）
  src/domain/             纯数据模型与规则，零 IO
    deadline.ts           截止时间归一化（本项目最脏的一层）
    task.ts               统一任务模型
    ids.ts                稳定主键与内容指纹
    errors.ts             错误分类（决定 UI 该怎么提示）
    time.ts               Clock 抽象，让「临界时刻」可测
  src/ports/              抽象契约：适配器 / 存储 / 保险箱 / HTTP / 签名 / 限流
  src/engine/             编排逻辑
    sync-engine.ts        同步主流程（逐账号错误隔离）
    merge.ts              幂等合并、变更检测、防误删
    reminder.ts           提醒窗口与去重
    read-only-guard.ts    只读守卫（强制拦截一切写请求）
    session-http.ts       会话感知的 HTTP 封装
    http-pipeline.ts      限流 + 退避重试 + 统计
  src/infra/              具体实现
    encrypted-vault.ts    AES-256-GCM 会话保险箱
    json-store.ts         单文件存储（原子写、损坏自备份）
    fetch-http.ts         HTTP 客户端（手动跟随重定向以保留 Set-Cookie）
    recording-http.ts     HAR 录制（脱敏导出）
    har-replay-http.ts    HAR 回放（零网络请求的传输替身）
    cdp-http.ts           CDP 附着（借用已登录的浏览器）
    token-bucket.ts       令牌桶限流
    subprocess-signer.ts  Native 签名桥（进程外调用）
    html.ts               HTML 提取 + 改版检测

packages/adapters/        平台适配器 + 统一注册表（index.ts）
  chaoxing/ yuketang/ ismart/   experimental，待真实账号校准
  mock/                   会「使坏」的假教学平台 —— 端到端验证与适配器参考实现

apps/cli/                 命令行入口 + demo
apps/web/                 本地 Web App（真机验证入口：server + 移动端优先的 UI）
docs/                     调研、设计说明，以及 demo 的完整输出留档
```

分层依赖严格单向：`infra → engine → ports → domain`。
换掉任何一层实现（比如把 JSON 存储换成 SQLite、把 fetch 换成 Tauri 的 HTTP 插件）
都不需要改其他层。

---

## 命令

| 命令 | 说明 |
| --- | --- |
| `demo` | 端到端能力验证（推荐先看这个） |
| `platforms` | 列出适配器与能力矩阵 |
| `login <platform> <user> <pwd>` | 登录并登记账号 |
| `sync [--dry-run]` | 同步全部账号 |
| `list [--days N] [--all]` | 查看待办 |
| `changes [--days N]` | 查看作业变更（改期、出新分） |
| `log [--limit N]` | 查看同步日志 |
| `vault` | 检查会话保险箱状态 |

环境变量：`HH_HOME`（数据目录，默认 `~/.homework-hub`）、
`HH_LOG`（日志级别）、`HH_TRACE=1`（打印每个 HTTP 请求，含 cookie，仅调试用）、
`HH_KEEP=1`（demo 结束后保留临时目录）。

---

## ⚠️ 关于真实平台适配器

`chaoxing` / `yuketang` / `ismart` 三个适配器的**接口路径来自社区开源项目的公开信息**，
作者没有用真实账号逐条验证过。平台在持续改版，你很可能需要按实际情况修正。

设计上为此做了三件事：

1. **端点集中在文件顶部的一张表**（`ChaoxingEndpoints` / `YuketangEndpoints` /
   `SmartEndpoints`），改路径不用碰逻辑；标注了 `TODO(verify)` 的是最需要确认的。
2. **改版时响亮失败**。解析不到预期字段就抛 `SCHEMA_DRIFT`，绝不静默返回空数组 ——
   静默返回空意味着用户以为作业做完了，这是本类应用最严重的故障模式。
3. **降级而不是瘫痪**。iSmart 需要原生库生成的 `ut` 签名，没有签名组件时
   适配器明确拒绝并提示，而不是发出一个必然失败的请求。

建议的自测顺序（以超星为例）：

```bash
# 1. 先用「手动粘贴 Cookie」登录（绕过图形验证码）
node apps/cli/src/main.ts login chaoxing 你的账号 你的密码

# 2. 开着 debug 日志观察每个请求的真实返回，逐个修正解析
HH_LOG=debug HH_TRACE=1 node apps/cli/src/main.ts sync --dry-run
```

### 合规声明

本项目**只读取**作业与考试信息，不包含任何提交答案、自动签到、刷课、
绕过考试的功能，也不会读取或存储明文密码（只保存平台下发的会话凭证，且加密落盘）。

请遵守所在学校的学术规范与平台用户协议。作者不对任何滥用后果负责。

---

## 参与贡献

- 提交 issue 时请说明：平台、页面版本/时间、期望行为、实际行为，以及（如可能）同步日志片段。
- 不要提交包含 Cookie / Token / 学号 / 姓名 / 手机号的 HAR 原文；需要时先脱敏。
- 平台接口全部来自真机抓包。改动解析器时，请附上对应的真实响应片段（脱敏后）或样本包。
- 提交前至少跑：`npx tsc --noEmit`、`npm test`、`npm run demo`。

## License

[MIT](./LICENSE) © 2026 HomeworkHub contributors

本项目只读取作业与考试信息，不包含提交答案、自动签到、刷课、绕过考试等功能；
请遵守所在学校的学术规范与平台用户协议。

## 发布清单（开源维护者）

1. 修改 `android/app/build.gradle.kts` 与 `package.json` 的版本号；
2. `npm test && npm run demo && npx tsc --noEmit`；
3. `npm run android:sync && cd android && gradle assembleDebug`；
4. 把 APK 放到 GitHub Releases（`release/` 默认不提交到仓库）；
5. `git tag -a v<version> -m "HomeworkHub <version>" && git push --tags`。

---

## 使用本项目前值得知道的三个技术坑

这三条是实际写代码时踩出来的，不是纸上推演，详见 `docs/设计说明.md`：

1. **「还剩 3 天」这类相对截止时间必须有锚点。**
   否则每次看它都是「还剩 3 天」，任务永远到不了期，提醒永远不触发。
   → 首次观测时锚定成绝对时刻，且只在倒计时变大（真改期）时才重新锚定。

2. **主键必须包含账号维度。**
   同一个平台可以挂多个账号，而平台内 ID 只在平台内部唯一。
   漏掉账号会让两个账号的 `work_88001` 互相覆盖。
   → `platformId + hash(accountId) + platformTaskId`。

3. **删除判定必须能容忍上游抖动。**
   分页请求失败、临时风控都会让某一轮「少看到」任务，立刻删库会让作业一闪一闪。
   → 连续缺席 N 轮才软删除；数据不完整时整轮禁用删除判定。
