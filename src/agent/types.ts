/**
 * P2 事件契约 —— agent 运行过程中向外吐出的全部状态。
 *
 * agent 不直接打印、不直接发消息，只 yield 事件；由 UI（P5）、网关（P11）、测试各自消费。
 * 本文件刻意不 import 任何东西：它是整个项目里最底层、最不会变的契约。
 */

/** 一次工具调用开始。`args` 是模型给出的参数，尚未校验。 */
export interface ToolStartEvent {
  type: 'tool_start';
  name: string;
  args: Record<string, unknown>;
}

/** 一次工具调用结束。`ok=false` 时说明工具抛错，agent 会把 result 当作观察继续跑。 */
export interface ToolEndEvent {
  type: 'tool_end';
  name: string;
  ok: boolean;
  /** 工具返回的原始字符串（通常已是 JSON），失败时形如 "ERROR: ..."。 */
  result: string;
  ms: number;
}

/** 最终答案。一个回合只会有一次，收到它就是结束。 */
export interface AnswerEvent {
  type: 'answer';
  text: string;
}

/** 不可恢复的错误（多为模型调用失败）；此时回合直接结束。 */
export interface ErrorEvent {
  type: 'error';
  message: string;
}

/**
 * 判别联合：每个成员都带字面量 `type` 字段，switch 时 TypeScript 会自动收窄。
 * 用 `type` 而不是 `interface`，是因为它表达的是"多选一"，不是"同时具备"。
 */
export type AgentEvent =
  | { type: 'iteration'; index: number; max: number }
  | ToolStartEvent
  | ToolEndEvent
  | AnswerEvent
  | ErrorEvent;
