# Dexter 复现路线图（ROADMAP）

> 用 **Bun + TypeScript + LangChain** 从零复刻 dexter 的 harness 能力，分 13 个阶段推进，每阶段有可执行的验收 gate。
>
> 参考实现：`/Users/zyd/PycharmProjects/PI/dexter`（**只读对照**，不 fork、不复制代码）。
>
> **当前进度：P0 ✅ / P1 ✅ / P2 ✅** —— 一个能真跑的最小 agent（约 900 行 src + 200 行 scripts）。

---

## 0. 现在能做什么

```bash
bun install                                   # 装依赖
cp .env.example .env                          # 填一个 key
bun run start                                 # 交互式 REPL
bun run start "6*7 等于多少？用工具算"          # 一次性提问
bun run start --trace "6*7 等于多少"           # 附完整数据流日志
bun run accept                                # 阶段验收（typecheck + test + smoke）
```

能力边界：**会算数、会读项目内文件、会多轮调用工具**。
不会联网搜索、不记上下文、不会调用外部 API——那些属于 P4 / P8。

---

## 1. 依赖规则（硬约束）

```
        ┌──────────────┐
        │  index.ts    │  ← 唯一允许"组装"的地方
        └──────┬───────┘
     ┌─────────┼──────────┬─────────────┐
     ▼         ▼          ▼             ▼
  agent.ts  tools/*   model/llm.ts   config.ts
     │         │          │
     ▼         ▼          ▼
  types.ts   utils      providers
```

| 模块 | 可以依赖 | 决不允许依赖 |
|---|---|---|
| `index.ts` | agent、tools、model、config | — |
| `agent.ts` | `types`、LangChain 的 `BaseChatModel` / `StructuredToolInterface` **接口** | 具体工具实现、UI、gateway |
| `tools/*` | Node 内置、外部 SDK | agent、gateway、UI |
| `model/*` | provider SDK | 业务层任何模块 |

两条必须在 P3 之前守住的规则（参考仓库的两处坏依赖）：

1. **禁止 `agent ↔ tools` 循环。** agent 只接收 `StructuredToolInterface[]`，注册表在 `index.ts` 组装后注入。
2. **禁止 `tools → gateway`。** 工具不负责投递；上报走 `AgentEvent`，由进程边界的 gateway 订阅。

---

## 2. 阶段总览

| 阶段 | 主题 | 状态 | Gate |
|---|---|---|---|
| P0 | 地基（包管理、TS 配置、配置层、CLI 骨架） | ✅ | `acceptance.sh p0` |
| P1 | 模型层（前缀路由 + 懒加载 + 缺 key 提示） | ✅ | `acceptance.sh p1` |
| P2 | 最小 agent 闭环（主循环 + 事件流 + 2 个工具 + smoke） | ✅ | `acceptance.sh p2` |
| P3 | 工具执行加固（并发、超时、落盘、依赖检查） | ⬜ | `acceptance.sh p3` |
| P4 | 金融纵深（meta-tool + 细粒度数据工具） | ⬜ | `acceptance.sh p4` |
| P5 | 终端 UI（流式渲染、中断、排队） | ⬜ | `acceptance.sh p5` |
| P6 | 上下文治理（五层压缩防线） | ⬜ | `acceptance.sh p6` |
| P7 | 技能（SKILL.md 发现与单次执行） | ⬜ | `acceptance.sh p7` |
| P8 | 记忆（Markdown + SQLite + 混合检索） | ⬜ | `acceptance.sh p8` |
| P9 | 多 agent（orchestrator-worker） | ⬜ | `acceptance.sh p9` |
| P10 | 权限（bash allow/ask/deny） | ⬜ | `acceptance.sh p10` |
| P11 | 网关 + 定时（WhatsApp / webhook / cron） | ⬜ | `acceptance.sh p11` |
| P12 | 评测（rubric 评分 + 可复现运行） | ⬜ | `acceptance.sh p12` |

### 要复刻的关键参数

| 参数 | 值 |
|---|---|
| 主 agent 最大轮次 | 10 |
| 工具总数（参考实现） | 18（有搜索/X key 时 20） |
| microcompact 触发 | 工具结果 > 8 条时清到保留 4 条；80k token |
| 全量 compact 阈值 | 上下文窗口 − 13k |
| 单工具结果落盘 | > 50k 字符 |
| 单轮结果预算 | 200k 字符 |
| 记忆 chunk / overlap / 召回 | 400 / 80 / 6 |
| 混合检索权重 | 向量 0.7 : 文本 0.3 |
| 记忆半衰期 / MMR λ | 30 天 / 0.7 |
| 子代理轮次 / 深度 / 并行 | 8 / 1 / 3 |

---

## 3. P0 ✅ 地基

**产出**：`package.json`、`tsconfig.json`、`.env.example`、`.gitignore`、`src/config.ts`、`src/index.ts`

**已完成**

- [x] Bun + ESM + strict TS（`moduleResolution: bundler`、`noUncheckedIndexedAccess`）
- [x] `config.ts` 收敛所有 `process.env` 读取，输出带类型/默认值/边界的 `Config`
- [x] `DEXTER_MODEL / TEMPERATURE / MAX_ITERATIONS / VERBOSE / TRACE`
- [x] CLI：`--help`、`--once`、`--model`、`--max-iterations`、`--verbose`、`--trace`、REPL
- [x] 缺 key 时报出**具体环境变量名 + 修复动作**

**验收**：`bash scripts/acceptance.sh p0` → 类型检查 + 单测 + `--help` 有输出。

---

## 4. P1 ✅ 模型层

**产出**：`src/model/llm.ts`

**已完成**

- [x] 前缀路由：`claude-*`→Anthropic、`gemini-*`→Google、`grok-*`→xAI、`deepseek-*`→DeepSeek、`openrouter/*`→OpenRouter、`ollama/*`→本地、其余→OpenAI
- [x] 三条构造路径（native SDK / OpenAI 兼容 / Ollama）
- [x] SDK 全部**动态 import**，没装的包不影响启动
- [x] `OPENAI_BASE_URL` 透传（代理网关场景）
- [x] `describeProviders()` 供 `--list-providers` 使用，不触网

**验收**：`bash scripts/acceptance.sh p1` → 路由表 7 行；缺 key 时报 `ANTHROPIC_API_KEY is not set`。

**坑**：OpenAI 兼容端点必须走 `configuration.baseURL`；OpenRouter 的模型名要去掉 `openrouter/` 前缀。

---

## 5. P2 ✅ 最小 agent 闭环

**产出**：`src/agent/types.ts`、`src/agent/agent.ts`、`src/tools/registry.ts`、`src/tools/registry.test.ts`、`scripts/smoke.ts`

**已完成**

- [x] 单一 `messages` 数组驱动，工具结果以 `ToolMessage` 回填
- [x] 硬轮次预算；耗尽后**解绑工具**再要一次答案
- [x] 工具异常降级成 `ERROR: ...` 观察，循环继续
- [x] 事件流 `iteration / tool_start / tool_end / answer / error`
- [x] 两个示范工具：`calculator`（拒绝非算术）、`read_file`（阻断路径逃逸）
- [x] `formatToolResult` → `{ data, sourceUrls }` 契约
- [x] 离线 smoke：脚本化假模型，10 条断言，无需 key/网络

**验收**：`bash scripts/acceptance.sh p2` → 8 单测 + 10 断言全绿。

**已知限制**（P3 处理）：工具串行执行、无超时、忽略 `invalid_tool_calls`、大整数精度失真。

---

## 6. P3 工具执行加固

**任务**

- [ ] `ToolContext` 扩展：`cwd`、`readOnly`、`timeoutMs`、`signal`
- [ ] 只读工具 `Promise.all` 并发，写类工具串行
- [ ] 单工具超时（默认 30s）+ `AbortSignal` 透传
- [ ] 结果 > 50k 字符落盘 `.dexter/scratchpad/`，只回摘要 + 路径
- [ ] `scripts/deps-check.ts`：扫 import，禁止 `agent→tools/registry`、`tools→agent|gateway`
- [ ] 修 `calculator` 大整数精度：改 `BigInt` 或 decimal，把 `test.todo` 变成正式断言
- [ ] 接住 `invalid_tool_calls`，回错误观察让模型重试
- [ ] 模型不支持 `bindTools` 时打告警（现在静默降级）

**验收片段**

```bash
p3)
  baseline
  run bun run scripts/deps-check.ts
  run bun run smoke
  ;;
```

判定：新增工具只改 `registry.ts`；3 个 1s 只读工具总耗时 < 1.5s；超时用例返回错误观察而不是挂死；`987654321*123456789` 精确等于 `121932631112635269`。

---

## 7. P4 金融纵深

**任务**

- [ ] meta-tool：`get_financials` / `get_market_data`，schema 只有 `query`，内部二次路由
- [ ] 细粒度工具：报价、基本面、财报（10-K/10-Q/8-K）、内部人交易、股票筛选
- [ ] 统一 `{ data, sourceUrls }`，sourceUrls 必须可点开
- [ ] 缺 `FINANCIAL_DATASETS_API_KEY` 时降级到 `web_search` 并在回答里声明
- [ ] 缓存：同一 ticker 同一指标 5 分钟内复用

**验收片段**

```bash
p4)
  baseline
  run bun run scripts/acceptance/finance.ts
  ;;
```

判定：无 key 时报“缺哪个 key + 去哪申请 + 替代路径”；有 key 时同一 query 两次结构一致。

---

## 8. P5 终端 UI

**任务**

- [ ] 接入 `@mariozechner/pi-tui`，替换 `index.ts` 的 renderer
- [ ] 流式 token 渲染 + 工具卡片 + spinner（`invoke` → `stream`）
- [ ] Ctrl+C 中断当前 turn 但不退出进程；再按一次退出
- [ ] turn 执行中输入排队
- [ ] 80×24 终端不破版

**验收片段**

```bash
p5)
  baseline
  run bun run src/index.ts --ui-smoke
  ;;
```

判定：首 token < 1s；中断后无悬挂 promise；快照 diff 稳定。

---

## 9. P6 上下文治理（五层防线）

**任务**

- [ ] token 计数（近似：4 字符 ≈ 1 token，用量以 `usage_metadata` 校准）
- [ ] microcompact：工具结果 > 8 条时清到保留 4 条
- [ ] microcompact 字数触发：80k token
- [ ] 全量 compact：超过 `窗口 − 13k` 时摘要前文，保留系统提示 + 最近 4 条
- [ ] 超大结果落盘 50k 字符 + 单轮 200k 字符预算
- [ ] 被清理内容写 `.dexter/compaction.log`，可回放

**验收片段**

```bash
p6)
  baseline
  run bun run scripts/acceptance/compaction.ts
  ;;
```

判定：30 条工具消息压缩后长度 ≤ 阈值且最近 4 条完整；单轮超 200k 触发截断并留日志。

---

## 10. P7 技能

**任务**

- [ ] `gray-matter` 解析 `SKILL.md` frontmatter（`name`、`description`）
- [ ] 启动扫描 `src/skills/**/SKILL.md`，元数据进系统提示词
- [ ] `skill` 工具：调用即注入该 skill 的 body
- [ ] 每 query 每 skill 只执行一次
- [ ] 无 skills 目录时安静跳过

**验收片段**

```bash
p7)
  baseline
  run bun run scripts/acceptance/skills.ts
  ;;
```

---

## 11. P8 记忆

**任务**

- [ ] `.dexter/memory/*.md` 落盘 + SQLite 索引（`better-sqlite3`）
- [ ] chunk 400 / overlap 80；embedding 存 BLOB
- [ ] JS 内暴力余弦（数据量小，不引向量库）
- [ ] 混合打分 `0.7 × 向量 + 0.3 × 文本`
- [ ] 时间衰减：半衰期 30 天
- [ ] MMR λ=0.7，召回 6 条
- [ ] 写入去重（相似度 > 0.95 视为同一条）

**验收片段**

```bash
p8)
  baseline
  run bun run scripts/acceptance/memory.ts
  ;;
```

判定：写 3 条后检索命中；30 天权重约为初值一半；1 万条下召回 < 100ms。

---

## 12. P9 多 agent

**任务**

- [ ] orchestrator-worker：3 类子代理（研究 / 代码 / 校验）
- [ ] 子代理只读工具白名单
- [ ] 子代理 8 轮上限、深度 1
- [ ] 并行执行 + 结果汇总
- [ ] 子代理失败不拖垮主流程

**验收片段**

```bash
p9)
  baseline
  run bun run scripts/acceptance/subagents.ts
  ;;
```

---

## 13. P10 权限

**任务**

- [ ] bash 命令解析：拆管道/重定向/子命令，分类 `allow` / `ask` / `deny`
- [ ] 危险模式：`rm -rf /`、`curl … | sh`、`git push --force`、写 `~/.ssh`、`sudo`
- [ ] 无 TTY 时 `ask` 直接 deny（fail closed）
- [ ] 判定写审计日志
- [ ] fixture ≥ 20 条

**验收片段**

```bash
p10)
  baseline
  run bun test src/permissions
  run bun run scripts/acceptance/permissions.ts
  ;;
```

---

## 14. P11 网关 + 定时

**任务**

- [ ] 先做 HTTP webhook 抽象，再接 WhatsApp（Baileys）
- [ ] gateway 只依赖 `runAgent` + 事件流，不 import 具体工具
- [ ] `croner` 定时任务 + heartbeat
- [ ] 消息去重、失败重试、重启不丢任务
- [ ] 会话隔离：不同 chat 不同 scratchpad

**验收片段**

```bash
p11)
  baseline
  run bun run scripts/acceptance/gateway.ts
  ;;
```

---

## 15. P12 评测

**任务**

- [ ] 任务集：金融问答 / 工具选择 / 拒答 / 多步推理，各 ≥ 5 条
- [ ] rubric 评分（0–3 分维度加权），不是字符串匹配
- [ ] 固定 seed + temperature=0
- [ ] 报告落 `.dexter/evals/<run-id>/`：分数分布、失败用例、token 成本
- [ ] 与上次 run 的差值表

**验收片段**

```bash
p12)
  baseline
  run bun run src/evals/run.ts --sample 10
  ;;
```

---

## 16. 当前代码地图

| 文件 | 行数 | 职责 |
|---|---:|---|
| `src/config.ts` | 49 | env → `Config`，含夹逼与默认值 |
| `src/model/llm.ts` | 142 | provider 路由 + 懒加载构造 |
| `src/agent/types.ts` | 46 | `AgentEvent` 判别联合 |
| `src/agent/agent.ts` | 133 | 主循环、工具执行、预算兜底 |
| `src/tools/registry.ts` | 99 | 工具工厂 + `formatToolResult` |
| `src/tools/registry.test.ts` | 65 | 工具单测（8 例） |
| `src/index.ts` | 186 | CLI 解析、事件渲染、REPL |
| `src/trace.ts` | 189 | **可选**调试日志（可整体回撤） |
| `scripts/smoke.ts` | 125 | P2 离线验收（10 断言） |
| `scripts/acceptance.sh` | 80 | 阶段 gate |

---

## 17. 已知缺陷与待办

| 问题 | 影响 | 计划 |
|---|---|---|
| `calculator` 超过 2^53 失真 | 大数算错（金融数字常见） | P3 改 BigInt / decimal |
| 忽略 `invalid_tool_calls` | 模型参数非法时会静默丢一次调用 | P3 |
| 无 `bindTools` 时静默降级 | agent 悄悄失去工具能力 | P3 加告警 |
| 无跨轮记忆 | 第二次提问不记得第一次 | P8 |
| 无上下文压缩 | 长会话会爆窗口 | P6 |
| 工具串行执行 | 多工具场景慢 | P3 |
| 无重试 | 网络抖动直接失败 | P3 |
| 延迟高（10–20s/次） | 网关 + 模型推理 | 观察，必要时换 fast model |

---

## 18. 每阶段的固定动作

1. **先写验收**：在 `scripts/acceptance/` 加用例，先红。
2. **再写实现**：只改本阶段该改的目录；跨层需求先更新本文档。
3. **跑 gate**：`bash scripts/acceptance.sh p<N>`，绿了才算完。
4. **收尾**：勾选本文档、更新第 16 节行数、跑一次 `all` 防回归。

> 铁律：**gate 不绿不进入下一阶段。** 压缩和权限这两层一旦带病，后面所有阶段都会返工。
