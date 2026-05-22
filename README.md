# Galgame 知识库 AI 助手

基于 **Next.js 16** + **LangGraph** + **RAG** 构建的 Galgame（视觉小说）领域 AI 问答应用。通过知识库检索与联网搜索相结合，为用户提供关于 Galgame 作品、角色、评价等信息的智能回答。

---

## 功能特性

### 🤖 AI 对话
- 基于 **DeepSeek (deepseek-v4-flash)** 的智能问答
- **LangGraph Agent** 驱动的多步推理与工具调用
- 多轮对话压缩：超过 6 轮自动压缩早期对话为摘要，节省 token
- 对话历史管理：侧边栏多对话切换、自动命名、删除

### 📚 RAG 知识库（Qdrant）
- **双路检索**：稠密向量（BAAI/bge-m3）+ 稀疏向量（自研 BM25）混合搜索
- **RRF 融合**：Reciprocal Rank Fusion 合并 dense + sparse 结果
- **Rerank 精排**：BAAI/bge-reranker-v2-m3 对候选结果二次排序
- **置信度阈值**：maxScore < 0.4 时不展示结果，避免噪声
- **按字段过滤**：支持 gameName、charName、type 等多字段精确过滤（含别名匹配）

### 🔍 Bangumi 联网搜索
- 通过 **Bangumi API (bgm.tv)** 实时搜索作品和角色信息
- **品牌别名展开**：自动将"柚子社"扩展为ゆずソフト / Yuzu-Soft 搜索
- **旗下作品检索**：知名品牌自动查询其代表作品
- **R18 内容支持**：通过 Puppeteer 浏览器自动化抓取 R18 条目
- **知识库回填**：用户可手动将搜索结果持久化到知识库

### 💬 对话记忆
- 每次对话的 QA 对自动存入 Qdrant `conversation_memory` collection
- 同会话内支持历史对话搜索（dense + sparse 混合检索）
- 对话删除时同步清理对应记忆点

### 🎨 前端体验
- 深色/浅色主题切换
- Markdown 渲染回复（支持 GFM）
- 知识库检索结果可折叠卡片展示
- Bangumi 搜索结果分类展示（角色/作品标签）
- 历史对话侧边栏
- 滚动导航（快速跳转到各轮对话）
- 响应式设计，支持移动端

### 🛠 知识库建设（ETL）
- 从外部数据源（MongoDB）读取游戏评论、角色信息等
- 智能分块：500 字符块大小 + 50 字符重叠
- 批量生成 embedding 并写入 Qdrant
- 去重机制

### 📊 评估体系
- **Quality Evaluation**：LLM-as-Judge 评估 Faithfulness + Answer Relevance
- **RAGAS Evaluation**：标准 RAGAS 指标评估
- **DeepEval**：集成 DeepEval 框架
- **断言测试**：Python 端断言验证

---

## 关键数据

| 指标 | 数值 |
|------|------|
| 知识库向量数 | **~50,000** 条高质量 Chunk（原始 50,000 条 → 去噪 51% → 精炼 49,367 条） |
| 覆盖游戏 | **193** 款 |
| 覆盖角色 | **770** 角色别名映射 |
| 别名系统 | **114** 游戏别名 + **770** 角色别名 |
| 搜索严格 Hit@3 | **98.7%**（Baseline 72.7% → +26pp） |
| 搜索 MRR | **0.909**（Baseline 0.680 → +0.229） |
| 检索管道 | Dense + Sparse 双路 → RRF 融合 → Rerank 精排 |
| 生成 Faithfulness | **98.3%**（LLM-as-Judge） |
| 评估 QA 对 | **150** 题（fact / opinion / comparison 三类） |

## 技术栈

| 类别 | 技术 |
|------|------|
| **框架** | Next.js 16 (App Router) + React 19 |
| **AI SDK** | Vercel AI SDK 6 + LangChain + LangGraph |
| **LLM** | DeepSeek (deepseek-v4-flash) |
| **向量库** | Qdrant (dense + sparse 双向量) |
| **Embedding** | BAAI/bge-m3 (via SiliconFlow) |
| **Reranker** | BAAI/bge-reranker-v2-m3 (via SiliconFlow) |
| **数据源** | Bangumi API + MongoDB |
| **爬虫** | Puppeteer |
| **样式** | Tailwind CSS 4 + Geist 字体 |
| **部署** | Docker + docker-compose + Nginx |
| **评估** | RAGAS, DeepEval, LLM-as-Judge |
| **包管理** | pnpm 11 |

---

## 快速开始

### 前置要求

- Node.js ≥ 22
- pnpm ≥ 11
- Docker & docker-compose（使用 Qdrant 时）
- **API Keys**（见下方配置）

### 1. 克隆并安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

创建 `.env` 文件：

```env
# DeepSeek API（AI 对话）
DEEPSEEK_API_KEY=sk-your-deepseek-api-key

# SiliconFlow API（Embedding + Rerank）
SILICONFLOW_API_KEY=sk-your-siliconflow-api-key

# Qdrant 配置
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=your-qdrant-api-key

# Bangumi API（可选，无 token 也可用，有 token 请求更稳定）
BANGUMI_API_TOKEN=your-bangumi-api-token
```

### 3. 启动 Qdrant

```bash
docker compose up qdrant -d
```

### 4. 运行开发服务器

```bash
pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000)。

### Docker 完整部署

```bash
docker compose up --build
```

应用运行在 `http://localhost:3039`。

---

## 项目结构

```
my-ai-app-demo/
├── src/
│   ├── app/
│   │   ├── page.tsx              # 主聊天页面（包含完整 UI 逻辑）
│   │   ├── layout.tsx            # 根布局
│   │   ├── globals.css           # 全局样式
│   │   ├── components/
│   │   │   ├── Sidebar.tsx       # 对话历史侧边栏
│   │   │   └── ScrollIndicator.tsx  # 滚动导航指示器
│   │   ├── hooks/
│   │   │   └── useConversations.ts  # 多对话管理 hook
│   │   └── api/
│   │       ├── chat/route.ts     # 对话 API（LangGraph Agent）
│   │       ├── backfill/route.ts # 知识库回填 API
│   │       └── health/route.ts   # 健康检查
│   └── lib/
│       ├── ai/
│       │   ├── langgraph/
│       │   │   ├── graph.ts      # LangGraph 状态图定义
│       │   │   ├── nodes.ts      # Agent/Respond 节点 + System Prompt
│       │   │   ├── tools.ts      # Tool 定义（检索/搜索/消歧）
│       │   │   └── memory.ts     # LangGraph 检查点持久化
│       │   ├── embedding.ts      # Embedding 生成（SiliconFlow）
│       │   ├── sparse-embedding.ts # 轻量 BM25 稀疏向量
│       │   ├── reranker.ts       # Rerank 精排
│       │   ├── memory.ts         # 对话记忆存/取
│       │   ├── backfill.ts       # Bangumi 数据回填知识库
│       │   ├── bangumi-browser.ts # Puppeteer 浏览器管理
│       │   ├── bangumi-parser.ts # Bangumi 页面解析
│       │   └── name-aliases.ts   # 品牌/作品别名映射
│       ├── qdrant.ts             # Qdrant 客户端（搜索/写入/管理）
│       └── models/
│           └── resource.ts       # MongoDB Resource 模型
├── scripts/
│   ├── etl/
│   │   ├── process.ts            # 数据 ETL：MongoDB → chunk → Qdrant
│   │   ├── load-to-qdrant.ts     # 直接加载数据到 Qdrant
│   │   └── load-cache-to-db.ts   # 缓存数据写入 MongoDB
│   ├── eval/
│   │   ├── evaluate-generation.ts # Faithfulness + Answer Relevance 评估
│   │   ├── qa-pairs.ts           # 评估 QA 对定义
│   │   ├── RAGAS/
│   │   │   └── run.ts            # RAGAS 评估
│   │   ├── DeepEval/
│   │   │   └── run.ts            # DeepEval 评估
│   │   └── query/                # 查询样本分析脚本
│   ├── lib/
│   │   └── name-aliases.ts       # ETL 侧别名工具
│   └── rank-parser.ts            # Bangumi 排行榜解析
├── docker-compose.yml            # Qdrant + Next.js 编排
├── Dockerfile                    # 多阶段构建
├── nginx.conf                    # Nginx 反向代理配置
└── next.config.ts                # Next.js 配置
```

---

## 架构设计

### Agent 工作流程

```
用户输入 → [Agent 节点] → 有 tool_calls? → [Tool 节点] → [Agent 节点]... → [结束]
                │                       │
                ↓                       ↓
           直接回复              工具数 ≥ 5 → [兜底节点]
```

- **Agent 节点**：基于 System Prompt + 对话历史，决定回复或调用工具
- **Tool 节点**：执行工具调用，返回结果到 Agent 继续推理
- **Respond 节点**：工具调用次数 ≥ 5 时的兜底回复
- **路由逻辑**：router() 根据是否含有 tool_calls 决定下一步

### RAG 检索管道

```
用户问题 → Embedding (bge-m3) ──→ Dense Search (Qdrant) ──→ RRF 融合 ──→ Rerank ──→ 结果
                                └─→ Sparse Search (BM25) ──↗
```

### 工具清单

| 工具 | 用途 |
|------|------|
| `getInformation` | 从 Qdrant 知识库检索信息，支持批量 & 过滤 |
| `rewriteQuery` | 将口语化问题改写为检索友好的关键词 |
| `searchWeb` | 搜索 Bangumi 获取最新/冷门信息 |
| `disambiguateEntity` | 模糊指代时反问用户确认 |
| `searchConversationMemory` | 搜索当前对话的历史记忆 |

---

## API 路由

| 路径 | 方法 | 用途 |
|------|------|------|
| `/api/chat` | POST | 对话请求（流式响应） |
| `/api/backfill` | POST | 将 Bangumi 数据回填到知识库 |
| `/api/chat/save-memory` | POST | 保存对话记忆 |
| `/api/chat/delete-memory` | POST | 删除对话记忆 |
| `/api/health` | GET | 健康检查 |

---

## 评估

```bash
# 生成质量评估（Faithfulness + Answer Relevance）
pnpm eval:gen

# RAGAS 评估
pnpm eval:ragas

# DeepEval 评估
pnpm eval:deepeval

# 断言测试
pnpm eval:assert

# 全量评估
pnpm eval:full
```

---

## 部署

### Docker Compose（推荐）

```bash
docker compose up --build -d
```

应用运行在 `http://localhost:3039`，Qdrant 运行在 internal `:6333`。

### Nginx 反向代理

参考 `nginx.conf` 配置反向代理、静态资源托管、API 转发。
