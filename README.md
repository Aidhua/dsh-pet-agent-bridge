# dsh-pet Agent Bridge

> 让你的桌面宠物不只是会聊天——你说一句 `/task`，它就去把活真的干了。

给 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（0.4.5，MIT）加一层**任务桥接**：在宠物聊天窗里下命令，任务交给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（0.2.2-rc.1，MIT）的 Agent 真实执行——真的建文件、真的写文档、真的回报路径。

## 为什么做这个

桌宠通常停在"会说话"这一层：它认识你、会撒娇，但你让它干点活，它只能说"好的呀"，然后什么也没发生。反过来，DSH 里的 Agent 能干活，却是个冷冰冰的终端。

这个项目把两边接起来，并且解决了一个很容易被忽略的割裂：

- **聊天时认识你，干活时忘了你** —— 所以记忆只有一份存储（`pet-memory.json`），同时注入聊天 system 提示和每个任务的上下文前缀。你叫它记住"周报只写实际完成的工作"，它写周报时真的会照做。
- **任务状态看不见** —— 任务就是一个普通 DSH 会话，所以 dsh-pet 原生的 `createSessionNotify` 会自动把会话事件映射成宠物的思考/干活/完成状态。桥接**不画任何界面**。
- **取消不干净** —— 排队中的任务用 `updateQueue(remove)` 撤回，执行中的用 `session/cancel` 并等 `turn/end(aborted)` 确认，绝不留半成品。

## 架构

```
┌─────────────────────── DSH Host 进程 ───────────────────────┐
│                                                             │
│  dsh-pet 0.4.5                  dsh-pet-task-ctl (本仓库)     │
│  ┌──────────────────┐          ┌──────────────────────────┐  │
│  │ chatWithPet()    │          │ petTaskCtl 服务（命令路由）│  │
│  │  └ 6 行拦截补丁   │◄────────►│ Task Controller（状态机） │  │
│  │ createSessionNotify│         │ 长期记忆（一份存储双注入）│  │
│  └────────┬─────────┘          └───────┬──────────┬───────┘  │
│           │                            │          │          │
│           ▼                            ▼          ▼          │
│   宠物动画/气泡              sessionController   ctx.on(      │
│   (thinking/working/…)       create/prompt/     'session/    │
│                              cancel/updateQueue   event')     │
└─────────────────────────────────────────────────────────────┘
```

- **伴随 bundle 而非改上游构建产物**：复用同一 cordis ctx 与事件总线，加一行就装、删一行就卸。
- **不改 dsh-pet 一行代码**：靠 webServer 的「最长前缀优先 + 更深前缀」合法接管 `POST /dsh-pet-7340/chat`，命令自己答、其余原样放行。旧的文件补丁降级为兜底方案，见 `patches/`。

## 命令

在宠物聊天窗里输入：

| 命令 | 作用 |
|---|---|
| `/task <任务描述>` | 交给 DSH Agent 真实执行 |
| `/task status [任务号]` | 查看最近（或指定）任务 |
| `/task list` | 最近任务列表 |
| `/task cancel [任务号]` | 取消任务 |
| `/memory list \| add <内容> \| del <序号> \| clear` | 长期偏好记忆 |
| `/称呼 <名字>` | 设置它对你的称呼 |
| `/bridge` | 命令帮助 |

不以 `/` 开头的输入完全不拦截，原生陪伴聊天照旧。

## 快速开始

前置：已安装 DSH（0.2.2-rc.1 已测）与 dsh-pet 0.4.5。**不需要修改 dsh-pet 任何文件。**

```bash
# 1. dsh-pet（已有可跳过）
dsh plugin --profile desktop add dsh-pet@0.4.5

# 2. 桥接插件（直接从 GitHub 装）
dsh plugin --profile desktop add github:Aidhua/dsh-pet-agent-bridge

# 3. 确认 profile 的 bundles 里有它（多数情况插件命令会自动登记）
#    <DSH_HOME>/profiles/desktop/package.json → dsh.profile.bundles: [... "dsh-pet-task-ctl"]

# 4. 重启 DSH，在宠物聊天窗输入 /bridge
```

装完重启即可，不需要改动 dsh-pet 的任何文件。

打完重启就生效，dsh-pet 保持原样。

### 它是怎么做到不改上游的

DSH 的 webServer 在匹配路由时是**最长前缀优先**（`packages/host/webserver`：*Longest-prefix-wins*）。dsh-pet 把整个 `/dsh-pet-7340` 前缀抱走了，但我们可以合法注册一个**更深的前缀**，或者在它已注册的那条路由上换一层 handler：

```
POST /dsh-pet-7340/chat
   ├─ 文本以 "/" 开头  → 本插件处理（/task /memory /称呼 /bridge）
   └─ 其它（含图片）    → 原样交回 dsh-pet，连请求体都不碰
```

启动日志里会有一行确认：

```
[dsh-pet-task-ctl] chat door installed (POST /dsh-pet-7340/chat → bridge, no upstream patch)
```

**没看到这行**说明当前 DSH 版本的路由表结构变了——此时功能不会静默失败：原生聊天完全不受影响，`/task` 暂不可用，可退回到下面的「兼容兜底」。

### 兼容兜底（旧方案，通常用不到）

若路由表不可达（DSH 大版本变更），可以退回改 dsh-pet 文件的老办法，脚本自带校验/备份/幂等：

```bash
node node_modules/dsh-pet-task-ctl/scripts/patch-dsh-pet.mjs check    # 体检
node node_modules/dsh-pet-task-ctl/scripts/patch-dsh-pet.mjs apply    # 打补丁
node node_modules/dsh-pet-task-ctl/scripts/patch-dsh-pet.mjs revert   # 还原
```

> ⚠️ 打完补丁后，升级 dsh-pet 会让它静默失效（文件被覆盖）；改用新方案则**升级不受影响**。

> 完整逐步流程（含每一步该截什么图、写教程怎么引用）见 [`docs/手册-跑通流程.md`](docs/手册-跑通流程.md)。建议先在**隔离环境**（独立的 `DSH_HOME`）跑通，再接入日常环境。

> 完整逐步流程（含每一步该截什么图、写教程怎么引用）见 [`docs/手册-跑通流程.md`](docs/手册-跑通流程.md)。建议先在**隔离环境**（独立的 `DSH_HOME`）跑通，再接入日常环境。

## 已实测（桌面版 · 从零安装）

在一台 Windows 11 机器上按用户视角走过一遍：`dsh plugin add` 装 dsh-pet@0.4.5 与桥接插件 → 重启桌面版 → 22 项断言全通过。

| 检查项 | 结果 |
|---|---|
| dsh-pet 文件未被修改（sha256 = 0.4.5 原始产物） | ✅ |
| `/bridge` `/task status` `/memory list` `/称呼` `/memory add` | ✅ |
| 原生聊天不被干扰（非 `/` 开头走原流程） | ✅ |
| `/task` 受理 → 建文件 → 内容正确 | ✅ |
| `/task status` `/task list` 反映真实状态 | ✅ |
| 连续指令（同会话改写文件） | ✅ |
| `/task cancel` → 状态机到 `cancelled` | ✅ |
| 记忆落盘（称呼 + 偏好） | ✅ |

自测脚本：`python scripts/regression.py`（可用 `DSH_BRIDGE_HOST` / `DSH_BRIDGE_BASE` 指向你的实例）。

> 桌面版请从桌面/开始菜单快捷方式启动（Electron shell）。直接 exec 二进制可能因缺少 shell 上下文静默退出——与插件无关。

## 兼容性

| 组件 | 已验证版本 |
|---|---|
| DeepSeek Harness | 0.2.2-rc.1 |
| dsh-pet | 0.4.5 |
| OS | Windows 11（开发环境）；Linux/macOS 未实测 |

DSH API 依赖（均经源码核实行号，见 `docs/F4-架构与关键实现.md`）：`sessionController.create/prompt/cancel/updateQueue`、`agents.get(sid).inbox`、`ctx.on('session/event')`、`ctx.provide/ctx.get`、`petApi7340.memory.register`。

## 目录

```
index.js                  桥接 bundle（约 1.1k 行，零第三方依赖）
cordis.patch.yml          本插件的 bundle 定义（DSH 加载入口）
scripts/patch-dsh-pet.mjs 兼容兜底用的补丁工具（check/apply/revert）
patches/                  对 dsh-pet 0.4.5 的拦截补丁（diff，供人工核对或 git apply）
scripts/                  隔离环境启动脚本 + E2E 助手
docs/                     F1-F7 交付文档 + 跑通手册 + 技术研究报告
```

## 已知限制

- 每个宠物同时只跑一个在途任务（串行，保证状态机清晰）。
- 命令词为中文/英文混排（`/task` `/memory` `/称呼` `/owner` `/bridge`）。
- **命令必须在 DSH 主窗口的宠物对话面板里输入**（`Ctrl+Shift+L`）。桌面宠物那个悬浮小窗的输入框走的是 dsh-pet 的私有 IPC 管道（`dsh-pet-bridge://` → helper → stdio），不经过 HTTP，插件拦不到——这是上游设计，不是本插件的缺陷。悬浮窗里发的文字会被当成普通闲聊。
- 审批仍走 DSH 原生弹窗，桥接**不代答**——这是安全设计，不是缺陷。
- 默认走「路由接管」方案，不依赖任何 dsh-pet 文件改动；若某版 DSH 改了路由表结构，会退回文件补丁（脚本可一键 apply/revert）。

## 许可

本仓库代码 MIT，见 [LICENSE](LICENSE)。
二次开发基于 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT，Copyright (c) PC2005）与 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT，Copyright (c) DeepSeek）。
**本仓库不重分发上述项目源码**，只包含自行编写的桥接代码与一个补丁 diff。完整声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
