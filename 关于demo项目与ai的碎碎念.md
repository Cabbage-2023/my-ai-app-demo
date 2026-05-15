# 项目预期

## 所以最后能做出什么？

一个能用的 Chat 页面：

1. **你问** —— "推荐一个有黑长直女主的galgame"
2. **AI 检索** —— RAG 从 MongoDB 里找到对应的角色数据
3. **AI 精确回答** —— "根据 Bangumi 数据，推荐你《XXX》，女主角 XXX 是黑长直，简介是……"
4. **AI 展示** —— 角色卡片（头像、名字、简介、出处）
5. **AI 记住** —— 你说"我喜欢萌系的"，下次推荐时会考虑这一点

## 中流大厂 AI 项目的"及格线"和"优秀线"

| 维度 | 及格 | 优秀 |
|---|---|---|
| 核心功能 | RAG 能跑通，能回答问题 | RAG + Tool Calling 协同工作，分清楚各自职责 |
| 前端表现 | 简单消息列表 | 结构化卡片展示不同类型数据 |
| 用户体验 | 能对话 | loading 状态、错误重试、空数据提示齐全 |
| 工程质量 | 能跑不报错 | TypeScript 类型严谨、模块划分清晰 |
| 深度理解 | 知道 RAG 是检索+生成 | 能说清 embedding 原理、为什么用向量搜索、tool calling 的触发时机 |
| 面试表现 | 能演示 | 能讲"我为什么这么设计" |

---

# 2026-05-15 进度

## 已完成

- ✅ RAG 核心链路打通：addResource（写入）+ getInformation（检索）+ Tool Calling 协同
- ✅ 硅基流动 embedding 接入（BAAI/bge-m3，1024 维，免费 2000 万 tokens）
- ✅ MongoDB Atlas 连接 + Resource 数据模型（通用 metadata）
- ✅ 向量搜索索引（vector_index，cosine 相似度）
- ✅ 前端渲染：tool 调用状态、检索结果卡片、空结果提示
- ✅ 完整存→查流程跑通：发 JSON→AI 自主入库→提问→向量检索→AI 整合回答

## RAG 深度增强计划（4 个 Phase）

从基础 RAG 闭环继续深挖，展示工程判断力。按依赖关系分阶段推进：

### Phase 1：分块 + 去重（Foundation）
- **分块策略**：中文感知递归分割器（`\n\n` → `\n` → `。` → `！？` → `，`），默认 300 字符 + 10% 重叠
- **Resource Schema 增强**：加 `parentId`、`chunkIndex`、`totalChunks` 追踪分块溯源
- **addResource 改造**：存入时自动分块 → 批量生成 embedding → 批量 `insertMany`
- **去重写入**：按 `metadata.name` 查重，已存在则跳过

### Phase 2：自查询检索（Self-Querying）
- **Vector Index 加 filter**：Atlas 索引添加 `metadata.type`、`metadata.tags` 过滤字段
- **getInformation 加 filters**：AI 从"有哪些黑长直角色"自动提取 `{ tags: ["黑长直"] }` 传入 `$vectorSearch.filter`

### Phase 3：查询重写 + 重排序（Query Transformation & Reranking）
- **rewriteQuery tool**：独立 tool，AI 搜前先调用优化搜索词（LLM 调 LLM，展示 compound-AI 架构）
- **硅基流动 Reranker**：`POST /v1/rerank`（`BAAI/bge-reranker-v2-m3`），$vectorSearch top 10 → rerank → top 3

### Phase 4：混合搜索（Hybrid Search）
- **MongoDB $text 索引**：`db.resources.createIndex({ content: "text" })`
- **双通道检索**：`$vectorSearch`（语义）+ `$text`（关键词）并行 → RRF 加权合并
- **降级策略**：中文分词效果不佳时退回纯向量搜索

## 技术栈

Next.js App Router + Vercel AI SDK + DeepSeek + Mongoose + MongoDB Atlas Vector Search + 硅基流动（embedding）+ TailwindCSS

---

# 心得体会 1 — 对 RAG 项目的认知转变

## 最初以为的难点

RAG 技术本身：chunking、reranker、hybrid search、query transformation——以为这些是项目的核心价值，也是面试中要展示的"深度"。

## 实际上的难点

数据收集 + 评估。RAG 技术部分（chunking/reranker/hybrid search）Vercel AI SDK 和 SiliconFlow 已经帮你抽象掉了，核心检索逻辑也就几十行代码。

## "全是调 API"的焦虑

一开始担心项目全是 API 调用，没有技术含量。但后来想清楚了岗位定位：

| AI 算法岗（我不面） | 前端 / 全栈 AI 工程岗（我的目标） |
|---|---|
| 模型训练 | 不需要 |
| 调 API 不屑 | **本质工作** |
| 面试看论文/模型 | 面试看**用现有工具搭系统 + 做产品落地** |

对于前端 AI 岗，"调 API" 不是缺点，是你的本职工作。前端 AI 工程师的价值是：知道调哪个 API、为什么调这个不调那个、怎么在浏览器里把 AI 结果呈现出最好的 UX。

## 所以不是你调的 API 是你做的

| 不是你调的 API | 是你做的 |
|---|---|
| embedding → SiliconFlow API | 爬虫 + 数据清洗 |
| reranker → SiliconFlow API | 数据质量分析 + 整理策略 |
| LLM → DeepSeek API | 评估脚本 + 对比实验 |
| MongoDB Atlas（数据库） | RAG 流程设计（分块策略、检索策略） |
| Vercel AI SDK（流式渲染） | 前端 UX（引用溯源、Token 可视化） |
|  | README 里的决策论证 |

## 面试官真正看的三件事

1. 给你一个场景，你能不能用现有工具搭出一个能用的系统
2. 出了问题，你能不能用数据定位是数据的问题还是检索策略的问题
3. 你能不能说清楚为什么这么搭、不那么搭

前两条靠爬虫 + 评估脚本证明。第三条靠 README 里的决策论证。

## 评估脚本是最重要的拼图

没有评估，我做了六个功能但说不清楚每个带来了什么提升。面试官会觉得我在堆 API。

有了评估，我可以直接甩数据：

> 基于 30 条 QA 对的对比实验：
> 
> | 方案 | Hit Rate@3 | MRR |
> |---|---|---|
> | 纯向量搜索 | 0.63 | 0.45 |
> | +Reranker | 0.77 | 0.58 |
> | +Hybrid Search | 0.83 | 0.64 |
> | +Query Rewrite | 0.87 | 0.68 |
> 
> Reranker 提升了 14 个点的命中率，而 Hybrid Search 边际收益只有 6 个点且需要维护 text index。如果赶时间我会优先上 Reranker。

这让我从"我会调 API"变成"我知道我的选择是对的"。

## 总结

项目的技术栈（API 调用）是确定的、简单的、不需要纠结的。真正拉开差距的地方是：

1. 数据质量（爬虫 + 清洗）——决定了 RAG 的天花板
2. 评估（对比实验 + 指标）——证明了 RAG 的地板在哪里
3. README（选型辩护 + 效果数据）——把思考和结果展现出来

RAG 技术本身反而不是差异点。上一个人也能调 SiliconFlow 的 embedding，但他不一定爬了数据、跑了评估、写清楚了为什么这样做。
