# 用Python理解研迹

先看一条链：用户提问 → 路由限定范围 → 组装上下文 → 模型提出动作 → 工具执行 → 校验提交 → 观察回到模型 → 交付。

## 建议阅读顺序

1. **app.py**：查找messages路由，看HTTP请求如何交给research.start。SSE只更新页面状态。
2. **agent/application.py**：看start、execute、stop。创建run、连接模型和工具、管理生命周期，不自己实现金融分析。
3. **agent/loop.py**：找唯一的while True。编号注释标明构造输入、问模型、解析、行动、回写观察五步。模型返回tool_call时，工具还未执行。
4. **tools/registry.py**：list返回说明书，invoke按名称调用实现。Schema是参数结构，loader是延迟加载入口，category和source_mode限制能力范围。
5. **tools/execution.py**：Workspace像草稿纸。工具先改副本，Verifier同意后通过SessionStore提交，失败不会留下有效卡片。
6. **tools/document_analysis.py**：从build_worksheet沿批次提取、引文核对、名称归并读到底稿；再看research/metrics.py为何不能把人数/ARPU相减当单季数据。
7. **reports/service.py**：已选内容→writeReport受限工具集→同一个AgentLoop→审阅→版本守卫。revise只返回建议，accept_revision才写正式稿。
8. **trace/session_store.py**：步骤记录与模型账本分开。一项工具可能内部多次请求模型，轮次数不等于请求数。

上述路径都相对于backend/yanji/。Python公共方法、关键判断和模块边界附有中文说明。

## Node → Python对应

| 原Node文件 | Python位置 |
|---|---|
| server/index.mjs | app.py |
| agent/agent-loop.mjs | agent/loop.py |
| agent/research-agent.mjs | agent/application.py |
| tools/tool-registry.mjs | tools/registry.py |
| context/context-assembler.mjs | context/assembler.py |
| llm/client.mjs + model-service.mjs | llm/model.py |
| tools/documents/* | tools/documents.py + document_analysis.py |
| tools/financial/* | tools/finance.py |
| research/operating-*.mjs | research/metrics.py |
| research/result-committer.mjs | tools/execution.py |
| reports/writer.mjs | reports/service.py |
| trace/sqlite-session-store.mjs | trace/session_store.py |

## 容易混淆的概念

- async/await：等待网络时让出执行机会，其他对话和停止按钮还能响应；不代表自动创建了多Agent。
- dict：类似JavaScript对象。对外JSON继续camelCase，Python函数用snake_case，避免改命名破坏前端。
- run：一次后台执行，不是整个对话；一个对话可以有多次run。
- trajectory：本次决策和观察的工作轨迹；trace是持久化记录；checkpoint是最新快照。
- memory provider：召回允许使用的历史。长期provider当前为空，SQLite保存对话不是模型学习。
- 工具描述：告诉模型能做什么；实现为Python函数，模型不能执行任意代码。
- Skill：仓库自有任务说明，约束同一个Agent的目标与交付，不是增加模型。

项目未引入HelloAgents SDK，保留LLM、Tools、Memory、Loop的职责分工。Python后端不通过subprocess或Node代执行业务。
