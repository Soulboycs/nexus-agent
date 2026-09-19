# 🚀 NEXUS AGENT

> **Next-Generation Desktop AI Coding Agent & Cloud Gateway**  
> 1:1 技术架构深度对齐 Claude Code (`cc-haha`)，基于 **Bun**、**Electron** 与 **React 19** 驱动的生产级自主编程智能体工作台。

[![CI/CD Push-to-Deploy](https://img.shields.io/badge/CI%2FCD-Push--to--Deploy-brightgreen)](https://github.com/Soulboycs/nexus-agent)
[![Release](https://img.shields.io/badge/Release-v0.1.0--production-orange)](https://github.com/Soulboycs/nexus-agent)
[![Runtime](https://img.shields.io/badge/Runtime-Bun%201.4.2%20%7C%20Node%2022-blue)](https://bun.sh)
[![Architecture](https://img.shields.io/badge/Architecture-1%3A1%20Claude%20Code-purple)](docs/需求规格.md)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

---

## 🌟 核心特性与架构亮点

### 1. 1:1 进程拓扑对齐 (Dual Runtime)
- **Electron Main (Node.js 原生宿主)**: 负责跨平台窗口管理、系统级 IPC 与后台 Sidecar 进程生命周期。
- **Chromium Renderer (React 19 + Tailwind + xterm.js)**: 现代化终端工作台，支持 Thinking 深度折叠流、工具调用动态卡片、带行号高亮 Diff、人机确认弹窗与嵌入式终端。
- **Local Server Sidecar (基于 `Bun.serve`)**: 高性能 HTTP/WS 本地网关，负责 `/health` 探针、基于 `bun:sqlite` 的会话持久化与 `/ws/:sessionId` 实时全双工事件总线。
- **Agent Core / CLI 引擎**: 淘汰递归的 `AsyncGenerator` 状态机与智能工具编排。

### 2. 核心技术创新
- **非递归流式状态机 (`src/agent/core/query.ts`)**: 基于 `AsyncGenerator` 的 `while(true)` 状态流转机制，根除深层递归爆栈风险，支持边流式生成边执行工具与级联 Abort。
- **工具并发编排器 (`src/agent/core/ToolOrchestrator.ts`)**:
  - **只读操作并发**：自动批处理文件读取、代码搜索与探测，并发上限可达 10 路。
  - **写入操作隔离**：写入与破坏性操作强制串行执行，前置人机确认（HITL）审批拦截。
- **自动化 Push-to-Deploy 流水线**:
  - 无论本地代码推送到 GitHub `main` 分支还是云端触发，GitHub Webhook 在 8 秒内自动驱动服务器拉取、编译与服务平滑重载。

---

## 📂 项目结构概览

```text
nexus-agent/
├── bin/
│   └── agent-cli                  # 独立终端命令行启动脚本
├── src/
│   ├── agent/core/
│   │   ├── query.ts               # AsyncGenerator 核心状态机
│   │   ├── ToolOrchestrator.ts    # 读写批处理与并发隔离调度器
│   │   └── StreamingToolExecutor.ts # 边流边执行与级联中断
│   ├── server/
│   │   ├── index.ts               # Bun.serve HTTP、WebSocket 与 Webhook 网关
│   │   ├── services/db.ts         # bun:sqlite 存储引擎
│   │   └── ws/events.ts           # 1:1 对齐的 WebSocket 事件契约
│   ├── main/                      # Electron 主进程与 Agent 引擎实现
│   └── renderer/                  # React 19 + Tailwind 桌面界面
├── scripts/
│   ├── deploy.py                  # 一键自动化部署脚本
│   ├── setup_git_mirror.py        # 国内服务器 GitHub 镜像加速
│   └── webhook-deploy.sh          # 生产级隔离式自动热重载
├── docs/                          # 规范驱动工程 (Spec + TDD) 完备审计文档
│   ├── 需求规格.md                # 架构需求与契约定义
│   ├── 契约-*.md                  # 状态机与网关接口契约
│   ├── 测试矩阵.md                # 自动化测试矩阵
│   └── 证据链.md                # 真实执行证据链记录
└── tests/                         # Bun 单元测试与集成测试套件
```

---

## ⚡ 快速启动指南

### 1. 独立终端 CLI 交互
无需启动图形界面，直接在终端中唤起交互式编程助手：
```powershell
bun run bin/agent-cli
# 或单次执行任务指令:
bun run bin/agent-cli "分析当前项目的架构设计"
```

### 2. Electron 桌面端工作台
```powershell
npm run dev
```

### 3. 生产构建打包
```powershell
npm run build
```

---

## 🌐 云端生产服务与健康探针

本项目已部署在生产云主机，具备实时健康监测与全自动热重载能力：

- **服务健康探针 (带实时 Git Commit 指纹)**:  
  👉 **[http://117.72.101.76/health](http://117.72.101.76/health)**
- **会话持久化接口 (SQLite)**:  
  👉 **[http://117.72.101.76/api/sessions](http://117.72.101.76/api/sessions)**
- **实时双向 WebSocket 网关**:  
  `ws://117.72.101.76/ws/:sessionId`

---

## 🔄 持续交付 (Push-to-Deploy)

只需将代码提交并推送到 GitHub `main` 分支：
```bash
git add .
git commit -m "feat: your feature"
git push origin main
```
GitHub Webhook 将即时通知云服务器，**10 秒内全自动完成代码同步、依赖安装、服务重启与公网健康自检**。

---

## 📜 规范驱动工程产物索引

严格遵循 `evidence-driven-engineering` 质量标准：
- [📋 需求与非目标: `docs/需求规格.md`](docs/需求规格.md)
- [🗺️ TDD 分阶段路线图: `docs/计划.md`](docs/计划.md)
- [📑 状态机与编排契约: `docs/契约-Agent编排器与query状态机.md`](docs/契约-Agent编排器与query状态机.md)
- [📑 服务端与 WebSocket 契约: `docs/契约-服务端网关与会话持久化.md`](docs/契约-服务端网关与会话持久化.md)
- [📊 高价值测试矩阵: `docs/测试矩阵.md`](docs/测试矩阵.md)
- [🔍 测试真实性与质量审计: `docs/测试质量审计.md`](docs/测试质量审计.md)
- [🧾 真实命令执行审计: `docs/证据链.md`](docs/证据链.md)
