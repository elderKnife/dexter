/**
 * P2 主循环 —— 思考 → 调工具 → 观察 → 再思考 → 回答。
 *
 * 刻意保持"无聊"：一个模型、一个 message 数组、一个硬轮次预算。
 * 上下文压缩（P6）、权限（P10）、子代理（P9）都挂在这条循环外围，不塞进来。
 *
 * 依赖边界：只 import 类型（BaseChatModel / StructuredToolInterface），
 * 不 import 任何具体工具或 UI——所以它是全项目最容易被测试的一层。
 */
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type AIMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AgentEvent } from './types';

/** 系统提示词只约束"行为方式"，不写业务知识——业务靠工具描述自己说明。 */
export const SYSTEM_PROMPT = `You are Dexter, a terse research agent.

Rules:
- Use tools whenever the answer depends on a fact, a number or a file; never invent data.
- Prefer one well-formed tool call over several speculative ones.
- If a tool fails, read the error and adapt once before giving up.
- Final answers are plain text: lead with the answer, then only the evidence that matters.`;

export interface RunOptions {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  query: string;
  /** 硬预算，默认 10；用完强制收口，不允许无限循环。 */
  maxIterations?: number;
  systemPrompt?: string;
}

/** 把任意异常压成一行可读文本（工具错误会原样回给模型，所以必须干净）。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** AIMessage.content 可能是字符串，也可能是 content block 数组，统一取出文本。 这是为了防止不同模型返回的aimessage不一样*/
function textOf(message: AIMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  return content
    .map((part) => (typeof part === 'string' ? part : 'text' in part ? part.text : ''))
    .join('');
}

type Invoke = (messages: BaseMessage[]) => Promise<AIMessage>;

/** `bindTools` 在 BaseChatModel 上是可选的，这里把两种调用方式收敛成一个函数。 */
function bindTools(model: BaseChatModel, tools: StructuredToolInterface[]): Invoke {
  if (typeof model.bindTools === 'function') {
    const bound = model.bindTools(tools);
    return async (messages) => (await bound.invoke(messages)) as AIMessage;
  }
  return async (messages) => (await model.invoke(messages)) as AIMessage;
}

/**
 * 跑一个回合：yield 事件流，return 最终文本（两者内容一致，方便 UI 和测试各取所需）。
 * 正常情况下由模型主动给出不含 tool_calls 的回答而结束；异常情况下由预算兜底结束。
 */
export async function* runAgent(options: RunOptions): AsyncGenerator<AgentEvent, string> {
  const { model, tools, query } = options;
  const maxIterations = options.maxIterations ?? 10;
  const messages: BaseMessage[] = [
    new SystemMessage(options.systemPrompt ?? SYSTEM_PROMPT),
    new HumanMessage(query),
  ];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const invoke = bindTools(model, tools);

  for (let index = 1; index <= maxIterations; index += 1) {
    yield { type: 'iteration', index, max: maxIterations };

    let reply: AIMessage;                             //调模型：失败就结束
    try {
      reply = await invoke(messages);
    } catch (error) {
      const message = errorText(error);
      yield { type: 'error', message };
      return message;
    }
    messages.push(reply);

    const calls = reply.tool_calls ?? [];       //判断：这是答案还是工具申请
    // 判据只看 tool_calls：模型没提工具就是给答案了，content 为空也一样
    if (calls.length === 0) {
      const text = textOf(reply);
      yield { type: 'answer', text };
      return text;
    }

    for (const call of calls) {
      const id = call.id ?? `call_${index}_${call.name}`;
      yield { type: 'tool_start', name: call.name, args: call.args as Record<string, unknown> };

      const startedAt = Date.now();
      let ok = true;
      let result: string;
      try {
        const tool = byName.get(call.name);
        if (!tool) throw new Error(`unknown tool "${call.name}"`);
        result = String(await tool.invoke(call.args));
      } catch (error) {
        // 工具失败不抛出：当成一条观察交还给模型，让它自己决定要不要换个做法
        ok = false;
        result = `ERROR: ${errorText(error)}`;
      }

      yield { type: 'tool_end', name: call.name, ok, result, ms: Date.now() - startedAt };
      messages.push(new ToolMessage({ content: result, tool_call_id: id, name: call.name }));
    }
  }

  // 预算耗尽：解绑工具再问最后一次，保证回合一定能收口
  messages.push(new HumanMessage('Tool budget exhausted. Answer now using only what you have.'));
  let text = '';
  try {
    text = textOf((await model.invoke(messages)) as AIMessage);
  } catch (error) {
    const message = errorText(error);
    yield { type: 'error', message };
    return message;
  }
  yield { type: 'answer', text };
  return text;
}
