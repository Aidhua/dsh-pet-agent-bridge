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
- **对 dsh-pet 的唯一改动是 6 行拦截块**（软查找 `petTaskCtl`，查不到就走原生流程——天然灰度开关）。补丁见 `patches/`。

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

前置：已安装 DSH（0.2.2-rc.1 已测）与 dsh-pet 0.4.5。

```bash
# 1. 取本仓库
git clone https://github.com/Aidhua/dsh-pet-agent-bridge.git
cd dsh-pet-agent-bridge

# 2. 把 bundle 放进你的 DSH profile
cp -r src <你的 DSH_HOME>/profiles/<profile>/node_modules/dsh-pet-task-ctl

# 3. 在 profile 的 package.json 里登记（bundles + dependencies 各加一条）
#    "dsh-pet-task-ctl": "file:./node_modules/dsh-pet-task-ctl"

# 4. 给 dsh-pet 打拦截补丁
cd <你的 DSH_HOME>/profiles/<profile>/node_modules/dsh-pet
git apply ../../../../dsh-pet-agent-bridge/patches/dsh-pet-0.4.5-chatwithpet.patch

# 5. 启动并验证
dsh --profile <profile> --no-open --port 39190
#    打开 http://127.0.0.1:39190/?token=... 在宠物聊天窗输入 /bridge
```

> 完整逐步流程（含每一步该截什么图、写教程怎么引用）见 [`docs/手册-跑通流程.md`](docs/手册-跑通流程.md)。建议先在**隔离环境**（独立的 `DSH_HOME`）跑通，再接入日常环境。

## 兼容性

| 组件 | 已验证版本 |
|---|---|
| DeepSeek Harness | 0.2.2-rc.1 |
| dsh-pet | 0.4.5 |
| OS | Windows 11（开发环境）；Linux/macOS 未实测 |

DSH API 依赖（均经源码核实行号，见 `docs/F4-架构与关键实现.md`）：`sessionController.create/prompt/cancel/updateQueue`、`agents.get(sid).inbox`、`ctx.on('session/event')`、`ctx.provide/ctx.get`、`petApi7340.memory.register`。

## 目录

```
src/                      桥接 bundle 源码（index.js 约 950 行，零第三方依赖）
patches/                  对 dsh-pet 0.4.5 的拦截补丁
scripts/                  测试助手与启动脚本
docs/                     F1-F7 交付文档 + 跑通手册 + 技术研究报告
```

## 已知限制

- 每个宠物同时只跑一个在途任务（串行，保证状态机清晰）。
- 命令词为中文/英文混排（`/task` `/memory` `/称呼` `/owner` `/bridge`）。
- 审批仍走 DSH 原生弹窗，桥接**不代答**——这是安全设计，不是缺陷。
- 仅 `0.4.5` 的 dsh-pet 打过补丁验证；升级上游后需重新核对 `chatWithPet` 位置。

## 许可

本仓库代码 MIT，见 [LICENSE](LICENSE)。
二次开发基于 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT，Copyright (c) PC2005）与 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT，Copyright (c) DeepSeek）。
**本仓库不重分发上述项目源码**，只包含自行编写的桥接代码与一个补丁 diff。完整声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
