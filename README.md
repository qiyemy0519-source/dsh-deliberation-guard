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

### 从 GitHub 安装（同事用这个）

**先完全退出 DeepSeek Harness。** Harness 运行时配置是锁住的，`dsh plugin` 写不进去；装完再重启。

```
dsh plugin --profile web add "github:qiyemy0519-source/dsh-deliberation-guard#v0.5.0"
```

`#v0.5.0` 是版本 tag，可用 tag 见仓库的 **Tags** 页面；不写 `#...` 时 pnpm 取默认分支的最新提交。桌面版把 `--profile web` 换成 `--profile desktop`；也可以在 **插件 → 添加插件** 里粘贴同一个地址。装完重启 Harness，输入框右侧会出现「长思考」开关和耐心预算下拉。

### 更新到新版本

Harness 不会自动更新第三方组合包，而且 pnpm 是按引用解析的：**版本号和引用都没变时，直接再 add 一次不会拉到新提交**。所以更新固定走「卸载 → 按目标 tag 安装 → 重启」：

```
dsh plugin --profile web remove dsh-deliberation-guard
dsh plugin --profile web add "github:qiyemy0519-source/dsh-deliberation-guard#<目标 tag>"
```

把 `#<目标 tag>` 换成要装的版本 tag（如 `v0.2.1`）或提交 SHA。**必须完全退出并重启 Harness** —— 客户端模块只在启动时加载，热重载不会换掉已加载的浏览器代码。

### 本地开发（`link:`）

```
dsh plugin --profile web add "link:D:\deepseek\deepseek-harness\.local-plugins\dsh-deliberation-guard"
```

`link:` 下 profile 的 `node_modules` 只是指向本目录的软链，改源码不用重装，但**必须重启 Harness** 才会重新加载。

重启后插件即生效，默认配置已经够用。若 profile 里能解析到 `@deepseek-ai/schemastery`，还可以在 **设置 → 插件** 里直接改这些字段（带中文说明与默认值）。

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

## 按会话的控制：`/guard`、长思考开关与耐心预算

上面的 `Config` 是**全局**默认值。除此之外，每个会话还可以有自己的覆盖，写在会话日志里，重启/分叉后照样重建：

- **长思考开关**：打开后，**这个会话永远不会被自动打断**（其余触发条件全部作废）。
- **耐心预算**：只覆盖这个会话的 `budgetMs`，也就是自动模式的耐心值。

输入框右侧（`conversation.input.right`）有一个按会话的控制：**一个胶囊里装两个设置** —— 左边「长思考」开关，右边「耐心预算」下拉。它读的是本会话的投影值，写的时候**只走 `/guard` 命令**——所以会话日志始终是唯一事实来源，界面显示的是命令落库后推回来的值，而不是本地猜测。下拉里的「默认」提交的是 `/guard budget default`（**清除**覆盖），不是把当前默认值写死：客户端拿不到 `Config.budgetMs`，写死一个数字会在别的部署里静默算错耐心值。子代理会话没有自己的输入框，因此整个控件不渲染。

### 外观

控件**不自己发明形态**：它用的就是宿主 composer 里那两个控件的同一套 chrome，规则逐条抄自宿主源码 —— chip 外观、hover、focus ring 来自模型选择器的 trigger（`ui-model-selection/src/client/ModelSelect.module.css` 的 `.trigger`），原生 select 的重置与自绘 chevron 来自 composer 的 `.select`（`ui-conversation/src/client/skeleton/InputBar.module.css`），选中态沿用宿主 `Pill.active`：

| 属性 | 取值（与宿主一致） |
| --- | --- |
| 尺寸 | `height: 28px` —— 与模型选择器、附件圆钮同一行高 |
| 圆角 | `var(--dsw-radius-sm)`（8px） |
| 底色 | 透明；只有 hover 才上 `--dsw-alias-interactive-bg-hover` |
| 字体 | 13px / 20px，weight 400（字体族由宿主全局 `button, select { font-family: inherit }` 提供） |
| 选中态 | `--dsw-alias-button-ghost-active-fill` + `inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border)`，文字转 `--dsw-alias-label-primary` |
| 焦点 | `0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))`，与模型选择器同一写法 |
| 禁用 | `opacity: 0.5; cursor: default` |
| 下拉 | `appearance: none` + 宿主同一张 chevron data-URI，`background-position: right 4px center` |
| 间距 | 行内 `gap: 12px`；在宿主的 `@container (max-width: 560px)` 下收成 8px |

早先的版本自己加了一圈边框和一个胶囊底色 —— 宿主 composer 的控件根本不是那个形态（它们是透明的 ghost chip），那圈边框正是「看起来不像 DSH」的来源。

无障碍：开关是 `<button aria-pressed>`，下拉是带 `aria-label` 的原生 `<select>`。样式是作用域在 `.dg-` 下的一份样式表，随插件卸载移除；`design_audit` 对发货 CSS 实测 28 个元素零违规、字号单一 13px、浅色与深色下文字均通过 WCAG AA。

命令语法（`rawInput` 会原样记进 `command/run`，投影就是从这条记录回放出状态的）：

| 命令 | 作用 |
| --- | --- |
| `/guard` | 只报告当前覆盖（长思考状态 + 耐心预算），不改变任何东西 |
| `/guard long` | 在开/关之间切换长思考 |
| `/guard long on` / `/guard long off` | 显式打开/关闭长思考 |
| `/guard budget <毫秒>` | 把这个会话的耐心预算设为给定毫秒数（十进制整数；`0` 表示只要有推理就随时可打断） |
| `/guard budget fast\|normal\|slow\|patient` | 用预设名设置，分别是 `15000` / `45000` / `90000` / `120000` 毫秒 |
| `/guard budget default` | **只**清掉这个会话的预算覆盖，回到 `Config.budgetMs`；长思考状态不动 |
| `/guard reset` | 清掉这个会话的全部覆盖，回到 `Config` 的全局值 |

触发判定读的是本会话的投影状态：**`long` 为真时永不打断**；否则用 `budgetMs ?? Config.budgetMs` 作为耐心值，其余抑制规则（正文/工具调用、字数下限、冷却、子代理）不变。控制层不在宿主里时（没有 `commands` 或 `sessionProjections`），插件照旧按 `Config` 全局工作。

## 会打断什么、不会打断什么

**会打断：**

- 某一步长时间只输出推理，正文和工具调用都还没出现，且累计推理字符数够多；
- 顶层 agent（默认）；打开 `includeSubagents` 后也包括子代理。

**不会打断：**

- **已经出现正文或工具调用的步。** 只要该步出现过非空白正文、文本块、工具调用 delta、工具调用块，这一步就永远不会被这个插件打断——模型已经在做事了。**只有这两类证据会抑制打断**，其他可见块类型（见 D5）不算。
- **完全静默的步。** 判断是在收到流帧时做的；如果模型一个帧都不发（网络卡住、真死循环），插件没有任何触发点。那属于"卡死"而不是"话多"，不在本插件的范围内。
- **预算或字数不达标的步。**
- **打开了长思考的会话。** `/guard long` 之后，该会话的任何步都不会被这个插件打断，直到 `/guard long off` 或 `/guard reset`。
- **冷却期内的打断。**
- 子代理（`includeSubagents=false` 时，但见 D4：这不是硬保证）。
- **反复失败重试的步。** 每次模型 attempt 重新计时，因此"失败→重试"循环永远攒不满预算（见 D2）。
- 任何**没有**打开 `agent/assistant-stream` 事件的运行环境（例如完全没有 agent-loop 的宿主）。

## 工作原理与实现要点

- 纯 ESM、无构建步骤、函数式插件（具名导出 `name` / `inject` / `Config` / `apply`，没有 default export）。
- 唯一必需的运行时导入是 `node:crypto` 的 `randomUUID`。`@deepseek-ai/schemastery` 是**可选** peer：拿得到就用它声明带默认值和说明的 `Config`；拿不到 `Config` 就是 `undefined`，cordis 会把原始 config 直接交给 `apply`，而 `apply` 自己套用同一批默认值并做同一批校验。两条路径行为一致。
- 按会话的控制层是**可选子插件**：`apply` 里用 `ctx.inject(['commands', 'sessionProjections'], …)` 注册 `/guard` 命令与 `deliberationGuard` 投影，所以缺任何一个注册表都只是退化成「只有全局 `Config`」，而不是加载失败。命令和投影都挂在这个子 fiber 上，插件卸载时一起注销。
- 投影状态是 `{ long: boolean, budgetMs: number | null }`，**纯函数折叠** `command/run` 记录：只看 `name === 'guard'` 的事件，别的命令和别的事件都返回同一个引用（`Object.is` 不变，不产生下游工作）。持久化状态在重放前由投影自带的校验器检查，坏值直接报错而不是当成合法状态。
- `stateSchema` / `viewSchema` 用插件自己写的最小校验对象（只有 `.parse`），**不 import `zod`**：`link:` 安装的插件目录解析不到工作区依赖，为此把 `zod` 变成硬依赖不划算。投影注册表在运行时只调用 `.parse`。
- 浏览器半侧是 `client.js`，同样无构建步骤，用 `window.__ModuleLoader__.load({ id, factory })` 注册懒工厂；React 从模块表拿。它只读本会话投影、只提交 `/guard` 命令行，不碰 `ctx.remote`，也不读别的插件的 DOM 或样式。槽位工厂**永不抛异常**：拿不到会话绑定就返回一个恒为 `undefined` 的惰性 observable，界面显示宿主默认值。
- 注入的提示词是一个**生产者自有的**消息源 `{ kind: 'deliberation-guard', form: 'notice', summary: ... }`，不是伪装成 `user`。这样会话记录里能看出是 harness 打断的，而不是某个人在说话。
- 监听器全部通过 `ctx.on('agent/assistant-stream', ...)` 注册：cordis 会在 fiber 卸载时自动注销，插件卸载后不留监听器；per-agent 状态放在 `WeakMap` 里，随 agent 一起回收。
- 监听器**永不向模型流抛异常**：`cancel()` 和 `steer()` 各自被单独包裹，`cancel()` 失败也仍然投递提示词，失败通过 `ctx.logger(...).warn` 报告（logger 不可用时退回 `console.warn`）。
- 子代理判定镜像 `@deepseek-ai/dsh-subagent/depth` 的 `delegationDepthOf`（不 import 它）：以持久化的 session header 为准且单调，运行时 `AgentOptions.subagentDepth` 只能加深不能变浅。

## 测试

不需要安装 DSH，也不需要任何依赖：

```
node test/guard.test.mjs
```

覆盖：长纯推理恰好触发一次、`cancel` 先于 `steer`、且 `cancel` 带 `{ keepInbox: true }` 不丢排队消息；正文/工具调用出现后不触发；低于 `budgetMs` 或低于 `minReasoningChars` 不触发；`enabled=false` 不触发；`includeSubagents` 对子代理的取舍；冷却期抑制；新 attempt 重置证据；卸载后监听器消失；`cancel`/`steer` 抛错被吞掉并上报；畸形帧不抛错；配置错误在加载时报错；具名导出且无 default export。

按会话的控制同样用纯 `node` 验证：可选层按名字请求、投影键/版本/初始状态/线视图、`command/run` 折叠的每条分支（切换、显式开关、毫秒预算、预设名、`budget default` 只清预算不动长思考、`reset`、未知参数、别人的命令、非命令事件都保持同一引用）、十进制以外的写法（`1e3`/`0x10`/`-0`/`1_000`/`45000ms`/`-1`）一律拒绝、校验器接受与拒绝、命令处理器的成功与报错文本、**状态行报的是配置的默认值而不是 schema 默认值**、**投影感知的触发判定**（长思考永不打断、会话预算覆盖全局、`0` 预算立即触发）、会话无法折叠时退回全局预算、投影注册被拒时仍按全局预算工作并上报、命令注册失败时投影不被读取且两层分别上报，以及 `client.js` 的加载器 id、槽位注册选项、locale 字典、槽位工厂不抛异常、组件在长思考开/关/投影未到达/无写入通道四种情况下的渲染、`默认` 行提交的是清除指令、源码里没有重复的宿主默认常量、子代理与异常会话都不渲染控件。全部通过时退出码为 0，否则非 0。

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

按会话的控制层另有这些取舍：

- **状态从 `command/run` 的 `rawInput` 重放，不是携带完整状态的领域事件。** 投影遵循的是纯函数折叠：有序日志 + 同一套解析规则必然得到同一个状态，所以回放/分叉是确定性的；但整个值事件规则要求"携带状态的日志事件写完整状态"，这里的状态是从命令行文本重新解析的。**改动 `/guard` 语法时必须保证旧参数仍然解析成同样的状态，否则要升 `stateVersion`**，否则旧会话重放出的含义会悄悄变化。
- **每次改动都在会话日志里留下一对命令节点。** `/guard long`、`/guard budget …`、`/guard reset` 各自会写 `command/run` + `command/done`。频繁切换会在长会话里累积可见的命令记录；这是"日志即事实来源"的必然代价，不是可以忽略的噪声。
- **客户端的读路径依赖宿主对未知投影键的当前行为。** 客户端的 `ProjectionValueStore` 是 key-agnostic 的：宿主推过来的任何键它都存，`faceOf('deliberationGuard')` 因此能拿到值。这依赖宿主当下"未在 `SessionProjectionMap` 声明的键照样推送"的行为；未来 DSH 版本若对未知键收紧，客户端的读路径可能失效。**宿主侧的守卫不受影响**——它直接读投影 handle 的 `stateOf(session)`，不经过线视图。
- **长思考只让这个插件闭嘴。** 它不阻止手动打断，也不改模型的 `reasoningEffort` 或上下文窗口；别的守卫/插件该怎么工作还怎么工作。
- **投影注册是异步的，存在一个极短的窗口。** `apply` 先发起投影注册，拿到 handle 后才注册命令。在这个窗口内到达的流帧读不到按会话覆盖，会按全局 `budgetMs` 判定；窗口内提交的 `/guard` 命令仍然会被折叠正常回放（折叠是纯函数，与命令何时注册无关），因此状态本身不会丢。
- **客户端在投影到达之前显示宿主默认值。** 客户端无法区分"宿主没提供这个投影"和"投影还在路上"，所以两种情况都渲染长思考关闭 + 默认预算；没有可用的写入通道（`submit` 不是函数）时整个控件渲染成 `null`。

其余未验证项：

- **按会话控制的浏览器半侧没有在活的 DSH 安装上跑过。** `client.js` 只对着 mock 验证过：加载器 id、槽位注册选项（`conversation.input.right`）、locale 字典、槽位工厂在会话未物化时不抛异常、组件四种状态的渲染。真实的 `conversation.input.right` 槽位渲染、`hooks` 绑定、`/guard` 命令提交回执，以及 `dsh.client` 清单能否让 `link:` 安装的 `client.js` 被 `/plugins` 正常提供，都只有真实运行才能确认。

- **本插件只用单元测试验证过，没有在活的 DSH 安装上跑过。** 事件名、载荷结构、`cancel`/`steer` 的签名都是对着源码核对的（`packages/core/agent/src/runtime-types.ts`、`packages/core/agent-loop/src/agent.ts`、`packages/llm/llm/src/assistant-stream.ts`），但"打断后 `steer` 是否足以唤醒被中止的 driver 去开下一轮"这一步，只有真实运行才能确认。`cancel({kind:'user'}, {keepInbox:true})` 之后的重分类（steer 落到 next-turn 并落下唤醒）已对着 `agent.ts:154-161` 与 `:214-223` 核对过。若发现提示词停在 inbox 里没被消费，把投递方式换成 `agent.followup(...)` 即可（那与"用户在思考中途发消息"的手动路径完全一致），但这会偏离本插件的既定规格。
- 判断只在收到流帧时发生，因此没有定时器；完全静默的步不会被处理。
- 计时从 `start` 帧开始。如果插件是在某个 attempt **中途**才加载的，这个 attempt 会被忽略，从下一个 `start` 帧重新计时（此时无法知道该步真实的开始时刻）。
- `agent/assistant-stream` 是进程内事件：只在模型正在流式输出时可用，不覆盖非流式或纯离线的调用路径。
