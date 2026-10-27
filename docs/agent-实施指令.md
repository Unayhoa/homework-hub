# Agent 实施指令（自定义平台接入）

> 用法：**按阶段整段复制给 agent**，一次只做一张卡。
> 每张卡都自包含：目标、改动点、约束、验收、交付。
> 方案依据见 `docs/自定义平台接入方案-v1.md`（同仓库）。

---

## 通用约束（每张卡都适用，不必重复抄）

```
项目：D:\WorkBuddy Files\2026-09-22-12-52-52\homework-hub
动手前必读：HANDOVER.md（含 8 条等价性铁律）、LESSONS.md。

必须遵守：
1. 先写会失败的复现测试，再改实现。不接受"读代码觉得没问题"作为证据。
2. 判据挂在真正的变量上：不是"能不能识别"，而是"启用后能不能一直正确同步"。
3. 识别/验证层只产出结构化对象，不产文案；文案只在 diagnostics / UI 层生成。
4. 前端不得自己拼提示词、不得自己判失败类型、不得自己派生平台 key/课程 id。
   这些都只有 core 一处真源。
5. 不给 AI 发任何它修不了的问题（会话、签名、网络），不发作业正文/个人信息/未脱敏 URL。
6. 只读。不得新增任何 POST 写入平台的能力，不执行 JS，不支持签名接口。
7. 不用全屏蒙版；等待状态走就地文字或底部状态条。
8. 不为了"全自动"而允许未经试抓就启用。

每次交付前必须跑通：
  npx tsc --noEmit
  npm test
  npm run demo
出包（沙箱里不要跑 npm run android:apk，它的 clean 会撞安全删除）：
  node node_modules/typescript/bin/tsc -p tsconfig.android.json > .tsc-android.log 2>&1
  node scripts/build-android.mjs
  node scripts/build-android.mjs --verify-only
  cd android && gradle assembleDebug --console=plain
  （tsc 退出码非 0 是预期的 TS2877，由 build-android 改写；以 --verify-only 为准）
然后：
  /d/Android/build-tools/*/aapt.exe dump badging android/app/build/outputs/apk/debug/app-debug.apk | head -1
  确认 versionCode/versionName 已递增，并解包 grep 本次新增的关键符号确实在包里。
  复制到 release/，release/ 只保留最近三版，更旧的删掉。

不要改 HANDOVER 里的红线（尤其 upcoming 的 365 天窗口、merge 幂等回填、课程 name 只读）。
改完在 HANDOVER.md / LESSONS.md 里补上这次定下的规则，并提交 git。
```

---

## 任务卡 P0-A：真机验证现有链路（不新增功能）

**目标**：确认 v0.2.8 的「采集 → 识别 → 试抓 → 启用 → 首同步」在真机上真的成立，
而不是只在单测里成立。任何后续扩展都建立在这个结论上。

**要做的事**：
1. 出 v0.2.8 包给用户（已完成可跳过），指导真机操作并收集结果。
2. 在代码里补一个**可导出**的诊断动作：把本次采集样本（脱敏后）落盘为样本包，
   路径 `samples/<platformHost>/<timestamp>.json`，结构见方案 §6。
   - 写入点：`apps/web/src/api.ts` 的 `/api/adapter/probe` 成功后；
   - 脱敏复用 `maskSecrets`，并剔除身份类响应（url 含 `user/info|profile|account`，
     或字段含 `phone|mobile|idcard|studentId|realName`）；
   - 浏览器/Android 端通过现有 store 或文件通道落盘，**不得**引入新的持久化后端。
3. 提供导出方式：账号页该平台项加「导出诊断样本」（复制到剪贴板即可），供用户回传。

**验收**：
- 真机结果：待办出现正确作业；课程页只有「舞蹈欣赏」；不再出现 `11430986`、`.mp4` 这类课程。
- 样本包能被 `analyzeSamples` 重新读出同样候选（写单测证明）。
- 样本包内不含作业标题正文、不含 token/sign、不含手机号/学号字段。

**不要做**：不要在这张卡改识别算法。先拿到真实现场。

---

## 任务卡 P1-A：错误码化，替代按文案分类

**背景**：`packages/core/src/engine/diagnostics.ts` 的 `classifyFailure` 现在靠正则匹配
`error.message`。文案一改，分类就静默漂移，而且漂移时没有提示。

**改动点**：
1. `packages/core/src/domain/errors.ts`：为自定义平台相关错误补标准 `code`：
   `AUTH_REQUIRED / SIGNATURE_REQUIRED / NETWORK / RATE_LIMITED /
   PARSE_EMPTY / SELECTOR_STALE / PROBE_EMPTY / COURSE_MISMATCH / UNKNOWN`。
   保留现有 `HubError` 的其它 code，不做全局替换。
2. `declarative-adapter.ts` / `DomAdapter`：抛出点全部带上上述 code，
   并附 `details.hint`（可选，给修复层用的结构化线索，如命中的路径、返回片段）。
3. `diagnostics.ts`：`buildFixPack` 改为**只按 code 分发**；
   `classifyFailure` 仅作为无 code 时的兜底，并在兜底时给 `UNKNOWN`。
   删除对 `sign|uuid` 这类 message 关键词的依赖（签名应由配置/响应结构判定，
   复用 `looksLikeNeedsSignature`，不要从错误文案里猜）。
4. `apps/web/src/api.ts` 的 `/api/adapter/fix`、`/api/adapter/probe`、`/api/adapter/enable`
   全部改传 code，不再传 message 字符串当类型。

**必须新增的测试**（`packages/core/test/diagnostics.test.ts` 扩充）：
- 每类 code 都能映射到正确的 `aiCanFix` 与动作数（≤2）。
- `AUTH_REQUIRED` / `SIGNATURE_REQUIRED` / `NETWORK` 下**不存在** copy 动作。
- 无 code 的错误一律 `UNKNOWN`，不得被误判为"AI 能修"。

**验收**：全测试绿；任何错误文案改动都不会改变分类结果（写一条测试证明）。

---

## 任务卡 P1-B：启用后首同步校验（L3）

**背景**：试抓只证明"那一刻能读"，不证明链路稳定。现在启用后若同步为空，是静默的。

**改动点**：
1. `sync-engine.ts`：同步结果里对**自定义平台**增加一组不变量检查（不是只对自定义平台写死分支，
   判据挂在"数据是否自洽"上）：
   - `fetched === 0` 但配置声明 `declaredTotal > 0` → 报 `PARSE_EMPTY`；
   - 任务全部缺标题或全部缺截止时间 → 记为 warning 并在同步消息里说明；
   - 本轮课程数 > 上一轮 2 倍且 > 3 → 记为 `COURSE_MISMATCH` 候选（只提示，不阻断）。
2. 失败时在账号的 `lastSyncMessage` 之外，额外存一份**结构化失败记录**
   （code + 相关样本引用 + 当前配置版本），供 `/api/adapter/fix` 直接取用，
   不要再靠"最近一次 failed 日志的 message"反推。
3. 前端：启用后的第一次同步若触发上述检查，显示对应 FixPack（复用现有渲染），
   不得只 toast 一句"同步失败"。

**验收**：
- 构造"试抓通过、同步为空"的样本，能复现并看到明确修复入口。
- 内置四平台的同步行为不变（全量测试 + demo 必须全绿）。

---

## 任务卡 P1-C：会话样本集 + 行为标记 + 增量回传

**背景**：现在只记录点回应用那一刻的请求，懒加载/翻页全部漏；重采还要从零开始。

**改动点**：
1. `android/app/src/main/assets/recorder.js`：
   - 记录 `actions`（进入作业列表、翻页、滚动到底、点详情），打标函数 `__hhMark(name, meta)`；
   - 自动给翻页/滚动打标，**不要求用户多点任何按钮**；
   - 每条请求保留时间戳与所属标记。
2. `BrowseActivity.java`：支持**多次回传并累加**（`returnCapture` 不再强制 finish；
   提供「继续采集」与「完成」两种出口，默认「完成」）。
3. `apps/web/public/app.js`：`analyzeCapture` 支持把多次回传合并成同一份会话样本集
   （按 `url + bodyHash` 去重，保留最新一份），**不要求用户重新登录**。
4. `probe.ts`：`analyzeSamples` 接受 `actions`，
   对"进入作业列表之后"的样本加权，并把命中哪条标记写进 `evidence`。

**验收**：
- 单测：同一平台先给一页、再给第二页样本，识别结果合并后作业数增加且不重复。
- 真机：翻页后再回传，待办条数增加；用户不需要重新登录。

**约束**：不要为翻页引入无限自动滚动；只利用用户已经做过的动作。

---

## 任务卡 P1-D：状态语义与脱敏增强

**改动点**：
1. `probe.ts` 新增 `summarizeStatusField(rows, key)`：输出某状态列的**全部取值**与出现次数。
2. `diagnostics.ts` 新增 `MAP_STATUS` 提示词（按方案 §4.2 的表），
   输入只有取值集合与样例，输出 `{values, usableForCompletion}`。
   校验：AI 返回的取值**必须全部来自材料**，多一个就拒绝并退回 `inferred`。
3. `declarative-adapter.ts` 的 `mapStatus`：
   - 认不出的状态**不要**默认 `pending` + `platform`，要走 `inferred`；
   - 允许通过配置 `fields.status.values` 显式映射（已有），把 AI 校验后的结果写回该字段。
4. 脱敏：`maskSecrets` 之外，样本入库/入包前剔除身份类响应与字段
   （`phone|mobile|idcard|studentId|realName|nickName` 等），并加测试证明。

**验收**：
- 英文/数字状态（`status: 1`、`"done"`）能被正确映射；认不出的一律 `inferred`，
  且任务可被手动标完成（`canMarkCompleted === true`）。
- 给 AI 的材料里不含任何真实姓名/学号/手机号。

---

## 任务卡 P2-A：两段式多课程（谨慎做，做不到就明确退回）

**目标**：有干净课程表接口的平台，一次接入多门课；没有课程表接口的，**退回单课程锚点**，
不得为了"支持多课"把课程内容再拆成多门。

**改动点**：
1. 配置扩展（`AdapterConfig`）：
   - `courses.url` 已存在，补 `courses.tasksUrl`（含 `{courseId}` 占位）；
   - 声明 `scope: 'catalog' | 'single'`。`catalog` = 有课程表，逐课程拉任务。
2. `DeclarativeAdapter.fetchTasks`：当 `scope === 'catalog'` 且存在 `courses.tasksUrl` 时，
   按 `req.courses` 逐课程请求（复用现有 `quietCourseIds` / 排除清单，**不得**绕过），
   并把课程 ID 显式写入任务（走 `courseOfTask` 的显式 ID 分支）。
3. `probe.ts`：只有当**同时**识别出课程表接口与含 `{courseId}` 的任务接口时，
   才产出 `catalog`；否则保持 `single` 并在 `evidence` 里写明"只覆盖当前这门课"。
4. 课程归属仍按铁律：显式 ID > 课程表匹配 > 锚点 > 行内字段 > 兜底。

**验收**：
- 构造 2 门课的假平台：能正确归属、课程数为 2、无重复课程记录。
- 只有课程内容、没有课程表时，**绝不**产出 `catalog`（防回归"一门拆四门"）。
- 全量测试 + demo 全绿。

**停止条件**：若发现需要为逐课程请求新增签名/POST/复杂分页，立即停在 `single`，
在配置与 UI 里明确"仅支持当前课程"，不要硬做。

---

## 任务卡 P2-B：样本库驱动的识别器回归

**改动点**：
1. 新增 `packages/core/test/probe-samples.test.ts`：
   读取 `samples/**/*.json`，对每个样本包跑 `analyzeSamples`，
   与包内 `expect` 对比（taskCount / courseCount / courseName / 关键字段路径）。
2. `expect` 缺失的样本只跑"不抛异常 + 产出结构合法"，不强行断言条数。
3. 提供 `npm run probe:report`（`scripts/probe-report.mjs`）：
   输出每个样本的通过/失败与差异（从对变错的排在最前）。
4. 用户确认识别结果时回填 `expect`（UI 上只加一个"结果正确"确认，
   不做额外表单；不确认就不写 expect）。

**验收**：
- 至少 3 份真实样本包入库（含 1 份智慧树课内录制）。
- 故意把 TITLE_KEY 改坏，报告必须显示对应样本从通过变失败。

---

## 任务卡 P2-C：提示词版本化与输出形态样例

**改动点**：
1. `diagnostics.ts` 的提示词抽成 `prompts/*.ts`（每份一个文件，含 `id`、`version`、`text`、
   `outputSchema`、2 组"材料 → 期望输出"样例）。
2. 新增测试：对每份提示词的**典型 AI 输出形态**做解析断言——
   带解释文字、```json 包裹、字段缺失、裸引号、中文引号、多余取值。
   复用 `adapter-import.ts` 的 `extractJson` / `repairJson`，不要新写解析器。
3. UI 展示与复制内容保持"提示词 + 材料合一"，不增加用户需要分别发送的两段。

**验收**：
- 修改任一提示词文本后，样例测试仍能接住我们预期会遇到的输出形态；
  接不住就报错，而不是让它上线后用户才发现"粘回来没反应"。

---

## 最后：每次交付时必须同时给出的东西

1. 变更文件清单与一句话原因。
2. 新增/修改测试的列表，以及它们分别防的是什么回归。
3. 真机未验证的部分**明确标注**（不要写"已完成"）。
4. `HANDOVER.md` / `LESSONS.md` 中新增的判据（压缩成"在什么约束下 A 优于 B"）。
5. 版本号递增后的 APK 路径与包内符号核对结果。
