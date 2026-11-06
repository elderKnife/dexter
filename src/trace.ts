/**
 * [可选调试模块] 打印 agent 与 LLM 的完整通信内容：请求、响应、工具执行、汇总统计。
 *
 * 开关：环境变量 DEXTER_TRACE=1，或命令行 --trace。
 * 输出走 stderr，不污染 stdout（答案仍然只从 stdout 出）。
 *
 * 设计目标是「可整体回撤」：
 *   1. 本文件是唯一新增文件，删除它即可；
 *   2. src/index.ts 里所有接入点都用 `// [TRACE]` 标注，搜一次就能找到（共 4 处）；
 *   3. 不改动 agent.ts / llm.ts / registry.ts 的任何逻辑；
 *   4. 未开启时所有导出函数都是空操作，零开销。
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AgentEvent } from './agent/types';

const paint = (code: string) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
const cyan = paint('36');
const dim = paint('2');

const WIDTH = 72;

/** 画一条带标题的分隔线，便于在长日志里定位。 */
function rule(title: string): string {
  const label = ` [TRACE] ${title} `;
  const left = Math.max(0, Math.floor((WIDTH - label.length) / 2));
  const right = Math.max(0, WIDTH - label.length - left);
  return cyan(`${'━'.repeat(left)}${label}${'━'.repeat(right)}`);
}

/** 键值对齐输出，所有字段都走这里，保证日志可扫读。 */
function kv(label: string, value: string): void {
  process.stderr.write(`${dim(label.padEnd(11))} ${value}\n`);
}

/** 多行内容缩进显示，避免日志左边界错乱。 */
function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

function truncate(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)} …（已截断 ${text.length - max} 字）` : text;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}

let enabled = false;
let context = { model: '?', tools: [] as string[], maxIterations: 0 };
let stats = { startedAt: 0, rounds: 0, modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 };

export function traceEnabled(): boolean {
  return enabled;
}

export function enableTrace(): void {
  enabled = true;
}

/** 由 index.ts 在启动时调用一次，记录模型名/工具名/预算，供日志头部使用。 */
export function configureTrace(ctx: { model: string; tools: string[]; maxIterations: number }): void {
  context = ctx;
}

/** 一轮提问开始：重置计数并打印头部。 */
export function startTrace(): void {
  if (!enabled) return;
  stats = { startedAt: Date.now(), rounds: 0, modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 };
  process.stderr.write(`\n${rule('回合开始')}\n`);
  kv('model', context.model);
  kv('maxRounds', String(context.maxIterations));
  kv('tools', context.tools.join(', ') || '(无)');
}

/** 一轮提问结束：打印统计，这是排查成本和轮次的主要依据。 */
export function endTrace(): void {
  if (!enabled) return;
  process.stderr.write(`${rule('回合结束')}\n`);
  kv('rounds', String(stats.rounds));
  kv('modelCalls', String(stats.modelCalls));
  kv('toolCalls', String(stats.toolCalls));
  kv('tokens', `in ${stats.inputTokens} / out ${stats.outputTokens}`);
  kv('elapsed', `${((Date.now() - stats.startedAt) / 1000).toFixed(1)}s`);
}

/** 汇总一条消息：角色 + 内容（+ 工具调用数量）。 */
function messageLine(message: BaseMessage, index: number): string {
  const calls = (message as unknown as { tool_calls?: unknown[] }).tool_calls ?? [];
  const suffix = calls.length > 0 ? `  [+${calls.length} tool_calls]` : '';
  return `[${index}] ${message.getType().padEnd(6)} ${truncate(contentText(message.content) || '(空)', 400)}${suffix}`;
}

/** 工具签名：名字 + 参数字段名，帮助确认「模型看到的 schema」到底长什么样。 */
function toolSignature(tool: StructuredToolInterface): string {
  const shape = (tool as unknown as { schema?: { shape?: Record<string, unknown> } }).schema?.shape;
  const params = shape ? Object.keys(shape) : [];
  return params.length > 0 ? `${tool.name}(${params.join(', ')})` : `${tool.name}()`;
}

function logRequest(messages: readonly BaseMessage[], tools?: readonly StructuredToolInterface[]): void {
  stats.modelCalls += 1;
  process.stderr.write(`${rule(`请求 #${stats.modelCalls} → LLM`)}\n`);
  kv('model', context.model);
  kv('messages', `${messages.length} 条`);
  messages.forEach((message, i) => {
    process.stderr.write(`${indent(messageLine(message, i + 1))}\n`);
  });
  if (tools && tools.length > 0) {
    kv('tools', `${tools.length} 个`);
    for (const tool of tools) process.stderr.write(`  · ${toolSignature(tool)}\n`);
  }
}

function logResponse(reply: unknown): void {
  const r = reply as {
    content?: unknown;
    tool_calls?: { name: string; args: unknown }[];
    usage_metadata?: { input_tokens?: number; output_tokens?: number };
  };
  process.stderr.write(`${rule('响应 ← LLM')}\n`);
  const text = contentText(r.content ?? '');
  kv('content', text ? truncate(text) : '(空)');
  const calls = r.tool_calls ?? [];
  kv('tool_calls', String(calls.length));
  for (const call of calls) process.stderr.write(`  · ${call.name} ${JSON.stringify(call.args)}\n`);
  if (r.usage_metadata) {
    stats.inputTokens += r.usage_metadata.input_tokens ?? 0;
    stats.outputTokens += r.usage_metadata.output_tokens ?? 0;
    kv('tokens', `in ${r.usage_metadata.input_tokens ?? 0} / out ${r.usage_metadata.output_tokens ?? 0}`);
  }
}

/**
 * 包装模型：拦截 invoke / bindTools，把双向通信打到日志。
 * 不改变任何行为——只是旁路记录，返回值原样透传。
 */
export function traceModel(model: BaseChatModel): BaseChatModel {
  const bind = typeof model.bindTools === 'function' ? model.bindTools.bind(model) : undefined;

  const wrapper: Record<string, unknown> = {
    invoke: async (messages: BaseMessage[]) => {
      logRequest(messages);
      const reply = await model.invoke(messages);
      logResponse(reply);
      return reply;
    },
  };

  if (bind) {
    wrapper.bindTools = (tools: StructuredToolInterface[]) => {
      const bound = bind(tools);
      return {
        invoke: async (messages: BaseMessage[]) => {
          logRequest(messages, tools);
          const reply = await bound.invoke(messages);
          logResponse(reply);
          return reply;
        },
      };
    };
  }

  return wrapper as unknown as BaseChatModel;
}

/** 把 agent 事件流也接进日志：工具参数/结果、最终答案、错误。 */
export function traceEvent(event: AgentEvent): void {
  if (!enabled) return;
  if (event.type === 'iteration') {
    stats.rounds = event.index;
  } else if (event.type === 'tool_start') {
    stats.toolCalls += 1;
    process.stderr.write(`${rule(`工具 ${event.name}`)}\n`);
    kv('args', JSON.stringify(event.args));
  } else if (event.type === 'tool_end') {
    kv('result', truncate(event.result, 1000));
    kv('elapsed', `${event.ms}ms`);
  } else if (event.type === 'answer') {
    kv('answer', truncate(event.text));
  } else if (event.type === 'error') {
    kv('error', event.message);
  }
}
