# dsh-deliberation-guard

一个独立的第三方 DeepSeek Harness 插件：**当某一步把整段预算都烧在纯推理上、既不输出正文也不发起工具调用时，自动替你做那件你手动在做的事——打断当前活动，然后把一句"别推演了，直接答"重新放到模型面前。**

它**不修改**你的 `reasoningEffort`，也**不修改** `contextWindow`。所有逻辑都在 agent 层：插件只观察模型已经吐出来的东西，然后决定要不要打断。

## 它做什么

监听进程内事件 `agent/assistant-stream`（载荷 `{ agent, frame }`），按 `(agent, turn, step)` 累计：

- 该步从 `start` 帧开始的耗时；
- 该步累计的推理字符数（`reasoning-delta` / `reasoning` 块的文本长度）；
- 该步是否已经出现过正文或工具调用。

当下面**全部**成立时，触发一次（每一步至多一次）：

1. `enabled` 为真；
2. 已耗时 ≥ `budgetMs`；
3. 累计推理字符数 ≥ `minReasoningChars`；
4. 该步还没有任何正文、也没有任何工具调用；
5. 不在冷却期内；
6. `includeSubagents` 为真，或者该 agent 不是子代理。

触发时的动作，顺序固定：

```js
agent.cancel({ kind: 'user' }, { keepInbox: true })  // 先中断当前活动，但保留队列里待办的消息
agent.steer(<nudge UserMessage>)                     // 再把提示词交给最近的一个步边界
```

`keepInbox: true` 是必须的：不带它时 `AgentLoop.cancel()` 会清空 inbox，自动打断就会**悄悄删掉你在模型思考期间排队的那条消息**（以及所有 next-turn 待办），并在会话记录里记为已取消。带上它，当前轮照样被中止（打断强度不变），而 `steer` 会因为活动已中止而被重新归类到 next-turn 并落下唤醒，提示词一样会送达。

随后进入冷却，避免刚打断完又立刻打断"回答问题的那一轮"。

## 安装

### 从 GitHub 安装

```
dsh plugin --profile web add "github:qiyemy0519-source/dsh-deliberation-guard"
```

### 从本地目录安装

适合要改源码的情况。先克隆本仓库，再把克隆下来的绝对路径填进命令（路径含空格时保留引号）：

```
git clone https://github.com/qiyemy0519-source/dsh-deliberation-guard
dsh plugin --profile web add "link:<克隆下来的绝对路径>"
```

**装完必须重启 Harness 才会加载。** 默认配置已经够用。

> `link:` 安装时 profile 的 `node_modules` 里只是指向本目录的软链，改源码不用重装，但仍需重启 Harness 才会重新加载。注意 pnpm 不解析被链接包的 peer 依赖，所以 `link:` 方式下 `@deepseek-ai/schemastery` 可能解析不到，`Config` 会是 `undefined` —— **功能不受影响**（默认值与校验在 `apply()` 里另有一份），但 **设置 → 插件** 里不会出现可编辑的配置表单，此时请直接改 `cordis.yml`。`github:` 安装没有这个问题。

> 对 `web` profile，`dsh plugin` 不强制要求先退出 Harness（文件锁只对 `desktop` profile 生效），但安装期间 Harness 仍在用旧的 `node_modules`，所以仍然要重启才生效。

## 配置

全部字段都可在 `cordis.yml` 或设置页覆盖；默认值写在插件自己的 `Config` 里（`cordis.patch.yml` 故意不带 `config:`，否则 DSH 首次保存设置时会把整段配置复制进用户配置，让每一项都显示为"已覆盖"）。

| 字段 | 类型 | 默认值 | 取舍 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 关掉后插件仍在监听但绝不打断。想临时停用而不卸载时用它。 |
| `budgetMs` | number ≥ 0 | `45000` | 单步纯思考的**墙钟**预算，从该 attempt 的 `start` 帧开始计时，因此**首 token 之前的静默也计入**（本机语料实测约占 2–3 秒的 45 秒预算）。**调小**会更早介入，代价是可能打断本来正要收敛的推理；**调大**更保守，代价是白等。设为 `0` 表示"只要有推理就随时可打断"。 |
| `minReasoningChars` | integer ≥ 0 | `2000` | 触发所需的累计推理字符下限，按 **UTF-16 code unit** 计数（即 JS 字符串的 `.length`，一个 emoji/生僻字算 2 个）。它把"想了两秒就动手"的正常步挡在外面。**调小**更容易触发；**调大**只在真正长篇推演时才介入。`0` 表示只看时间不看字数。 |
| `cooldownMs` | number ≥ 0 | `30000` | 两次打断之间的最小间隔。它的主要作用是**保护打断后的那一轮**：模型开始回答时不该被立刻再打断。`0` 表示每个 attempt 都独立判断、可以连续打断。 |
| `includeSubagents` | boolean | `false` | 默认只保护顶层 agent。子代理通常有父代理兜底，且子代理的推演往往是任务本身要求的，因此默认不动它。 |
| `nudge` | 非空字符串 | `跳过思考，直接用已知信息作答，不要再推演。` | 打断后注入的提示词。**这是模型唯一看到的新指令**，改它等于改行为；插件不会再加别的文字。 |

配置错误会在**加载时**直接抛错（类型不对、`budgetMs`/`cooldownMs`/`minReasoningChars` 为负、`nudge` 为空、config 不是对象），不会静默退回默认值。

## 会打断什么、不会打断什么

**会打断：**

- 某一步长时间只输出推理，正文和工具调用都还没出现，且累计推理字符数够多；
- 顶层 agent（默认）；打开 `includeSubagents` 后也包括子代理。

**不会打断：**

- **已经出现正文或工具调用的步。** 只要该步出现过非空白正文、文本块、工具调用 delta、工具调用块，这一步就永远不会被这个插件打断——模型已经在做事了。**只有这两类证据会抑制打断**，其他可见块类型（见 D5）不算。
- **完全静默的步。** 判断是在收到流帧时做的；如果模型一个帧都不发（网络卡住、真死循环），插件没有任何触发点。那属于"卡死"而不是"话多"，不在本插件的范围内。
- **预算或字数不达标的步。**
- **冷却期内的打断。**
- 子代理（`includeSubagents=false` 时，但见 D4：这不是硬保证）。
- **反复失败重试的步。** 每次模型 attempt 重新计时，因此"失败→重试"循环永远攒不满预算（见 D2）。
- 任何**没有**打开 `agent/assistant-stream` 事件的运行环境（例如完全没有 agent-loop 的宿主）。

## 工作原理与实现要点

- 纯 ESM、无构建步骤、函数式插件（具名导出 `name` / `inject` / `Config` / `apply`，没有 default export）。
- 唯一必需的运行时导入是 `node:crypto` 的 `randomUUID`。`@deepseek-ai/schemastery` 是**可选** peer：拿得到就用它声明带默认值和说明的 `Config`；拿不到 `Config` 就是 `undefined`，cordis 会把原始 config 直接交给 `apply`，而 `apply` 自己套用同一批默认值并做同一批校验。两条路径行为一致。
- 注入的提示词是一个**生产者自有的**消息源 `{ kind: 'deliberation-guard', form: 'notice', summary: ... }`，不是伪装成 `user`。这样会话记录里能看出是 harness 打断的，而不是某个人在说话。
- 监听器全部通过 `ctx.on('agent/assistant-stream', ...)` 注册：cordis 会在 fiber 卸载时自动注销，插件卸载后不留监听器；per-agent 状态放在 `WeakMap` 里，随 agent 一起回收。
- 监听器**永不向模型流抛异常**：`cancel()` 和 `steer()` 各自被单独包裹，`cancel()` 失败也仍然投递提示词，失败通过 `ctx.logger(...).warn` 报告（logger 不可用时退回 `console.warn`）。
- 子代理判定镜像 `@deepseek-ai/dsh-subagent/depth` 的 `delegationDepthOf`（不 import 它）：以持久化的 session header 为准且单调，运行时 `AgentOptions.subagentDepth` 只能加深不能变浅。

## 测试

不需要安装 DSH，也不需要任何依赖：

```
node test/guard.test.mjs
```

覆盖：长纯推理恰好触发一次、`cancel` 先于 `steer`、且 `cancel` 带 `{ keepInbox: true }` 不丢排队消息；正文/工具调用出现后不触发；低于 `budgetMs` 或低于 `minReasoningChars` 不触发；`enabled=false` 不触发；`includeSubagents` 对子代理的取舍；冷却期抑制；新 attempt 重置证据；卸载后监听器消失；`cancel`/`steer` 抛错被吞掉并上报；畸形帧不抛错；配置错误在加载时报错；具名导出且无 default export。全部通过时退出码为 0，否则非 0。

## 卸载

```
dsh plugin --profile web remove dsh-deliberation-guard
```

（同样需要先完全退出 Harness。）

## 已知限制与未验证项

以下前六条经独立验证确认，属于设计取舍或已知近似，**当前版本不在代码里修**：

- **D2 — 预算按 attempt 重置，重试步永远不被保护。** 计时从每个 attempt 的 `start` 帧重新开始。因此一个"推理 → 请求失败 → 重试"的步，无论重试多少次，每一次都从头计预算，永远到不了 `budgetMs`。实测 5 次 attempt × 每次 40 秒纯推理，一次都没有触发。要保护这类步，需要把计时提升到 step 级别（跨 attempt 累计），当前不做。
- **D3 — 先烧满预算、然后才发起工具调用的步会被切断。** 这是墙钟预算的必然取舍：判断只能基于"到目前为止看到了什么"，而工具调用在预算耗尽前还没出现。**如果你的任务以"长时间思考后必然动手"为常态，就应该调大 `budgetMs`。**
- **D4 — 子代理判定是 `delegationDepthOf` 的近似，`includeSubagents: false` 不是硬保证。** 插件不 import `@deepseek-ai/dsh-subagent`，而是自己读 `session.header.delegationDepth` / `session.header.origin` / `options.subagentDepth`。在边界情形（例如 header 与运行时选项不一致，或未来新增子代理标记方式）下，判定可能与真正的 `delegationDepthOf` 不同。
- **D5 — 只有正文与工具调用会抑制打断，其他可见块类型不会。** 一个只产生非文本、非工具调用可见内容（`block-start`/`block-end` 的其他 `blockType`）的步，即使已经在向用户输出，也仍可能被判定为"纯推理"而打断。判定逻辑只认 `text` / `tool-call`。
- **预首 token 的静默会花掉预算。** `budgetMs` 是从 `start` 帧起的墙钟时间，包含等待模型吐出第一个 token 的时间；本机语料实测这部分约占 45 秒预算中的 2–3 秒。
- **`minReasoningChars` 按 UTF-16 code unit 计数**（JS 字符串 `.length`），一个 emoji 或增补平面字符算 2 个。

其余未验证项：

- **本插件只用单元测试验证过，没有在活的 DSH 安装上跑过。** 事件名、载荷结构、`cancel`/`steer` 的签名都是对着源码核对的（`packages/core/agent/src/runtime-types.ts`、`packages/core/agent-loop/src/agent.ts`、`packages/llm/llm/src/assistant-stream.ts`），但"打断后 `steer` 是否足以唤醒被中止的 driver 去开下一轮"这一步，只有真实运行才能确认。`cancel({kind:'user'}, {keepInbox:true})` 之后的重分类（steer 落到 next-turn 并落下唤醒）已对着 `agent.ts:154-161` 与 `:214-223` 核对过。若发现提示词停在 inbox 里没被消费，把投递方式换成 `agent.followup(...)` 即可（那与"用户在思考中途发消息"的手动路径完全一致），但这会偏离本插件的既定规格。
- 判断只在收到流帧时发生，因此没有定时器；完全静默的步不会被处理。
- 计时从 `start` 帧开始。如果插件是在某个 attempt **中途**才加载的，这个 attempt 会被忽略，从下一个 `start` 帧重新计时（此时无法知道该步真实的开始时刻）。
- `agent/assistant-stream` 是进程内事件：只在模型正在流式输出时可用，不覆盖非流式或纯离线的调用路径。
