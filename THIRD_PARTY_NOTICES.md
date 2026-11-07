# 第三方项目声明（THIRD PARTY NOTICES）

本仓库（dsh-pet-agent-bridge）以 MIT 许可发布。它是以下开源项目的**二次开发成果**，遵守其 MIT 许可条款并保留原始版权声明。

## 1. PC2005-cloud/dsh-pet

- 仓库：https://github.com/PC2005-cloud/dsh-pet
- 使用版本：`0.4.5`
- 许可证：MIT License，Copyright (c) PC2005
- 本仓库与之的关系：
  - 桥接代码（`src/index.js`）为**独立编写**，作为伴随 bundle 与 dsh-pet 同进程运行，复用其公开扩展点（`petApi7340.memory.register`、`createSessionNotify`、`/state/work-status`）与 cordis 服务容器。
  - `patches/dsh-pet-0.4.5-chatwithpet.patch` 是一份**diff 补丁**，用于在 `chatWithPet` 入口插入 6 行拦截逻辑。补丁中包含少量上游源码上下文行，仅用于定位，不构成对上游整体源码的再分发。
  - **本仓库不包含、不重分发 dsh-pet 的任何完整源码或构建产物。** 使用者需自行从上游获取 dsh-pet（`npm i dsh-pet@0.4.5` 或按其文档安装），再应用本补丁。
  - 上游 `THIRD_PARTY_NOTICES.md` 在其自身分发时需一并保留；本仓库未打包上游产物，故不重复收录。

## 2. deepseek-ai/deepseek-harness（DeepSeek Harness）

- 仓库：https://github.com/deepseek-ai/deepseek-harness
- 使用版本：`0.2.2-rc.1`
- 许可证：MIT License，Copyright (c) DeepSeek
- 本仓库与之的关系：仅调用其公开 API（`sessionController`、`agents`、session 事件总线、cordis 服务注册），**不复制其源码、不修改其文件、不重分发**。使用者需自行安装 DSH。

## 3. 其他

- 本仓库不包含任何第三方模型权重、凭据或私有数据。
- 示例文档与测试产出（`docs/` 中的截图位置说明、任务示例）均为本项目自行编写。

## MIT 许可要点（合规说明）

MIT 允许使用、修改、再分发与商业使用，前提是**保留版权声明与许可声明**。因此：

1. 本仓库的 `LICENSE` 保留本项目版权（Aidhua）并附录上游版权声明；
2. 本文件明确列出上游项目、版本与许可；
3. 若你分发**包含 dsh-pet 源码/构建产物的整合包**（本仓库并未这样做），必须同时附上 dsh-pet 的 LICENSE 与其 THIRD_PARTY_NOTICES.md。
