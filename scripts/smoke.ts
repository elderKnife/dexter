/**
 * P2 离线验收（smoke test）—— 用假模型驱动真实 runAgent，验证主循环的四条路径。
 *
 * 为什么不用真模型：不花钱、不联网、毫秒级、断言稳定，而且能精确模拟
 * "模型永远想调工具" 这类真实环境里几乎不会出现的病态行为。
 *
 * 运行：bun run smoke        通过则退出码 0，失败为 1（可直接进 CI）。
 * 只验证流程结构，不验证回答质量——后者属于 P12 的评测。
 */
import { AIMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { runAgent } from '../src/agent/agent';
import type { AgentEvent } from '../src/agent/types';
import { createTools } from '../src/tools/registry';

const tools = createTools({ cwd: process.cwd() });

/** 构造一条"我要调用工具"的模型回复。 */
function toolCall(name: string, args: Record<string, unknown>): AIMessage {
  return new AIMessage({ content: '', tool_calls: [{ type: 'tool_call', id: `call_${name}`, name, args }] });
}

/**
 * 假模型：按脚本依次返回预设回复，脚本用完后返回最终答案。
 * `loop: true` 时永远重复最后一条回复——用来模拟"模型无限要求调工具"。
 * 只需要 bindTools 和 invoke 两个方法，就满足 agent 的依赖。
 */
function fakeModel(
  replies: AIMessage[],
  finalAnswer = '脚本结束',
  options: { loop?: boolean } = {},
): BaseChatModel {
  let turn = 0;
  return {
    bindTools: () => ({
      invoke: async () => {
        const index = options.loop ? Math.min(turn, replies.length - 1) : turn;
        turn += 1;
        return replies[index] ?? new AIMessage(finalAnswer);
      },
    }),
    invoke: async () => new AIMessage(finalAnswer),
  } as unknown as BaseChatModel;
}

/** 跑一个回合，收集全部事件和最终答案。 */
async function collect(model: BaseChatModel, query: string, maxIterations?: number) {
  const events: AgentEvent[] = [];
  let answer = '';
  for await (const event of runAgent({ model, tools, query, maxIterations })) {
    events.push(event);
    if (event.type === 'answer') answer = event.text;
  }
  return { events, answer };
}

let passed = 0;
const failures: string[] = [];

/** 断言辅助：失败不中断，最后统一汇总。 */
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ① 正常链路：工具调用 → 工具结果 → 最终答案
{
  const model = fakeModel([toolCall('calculator', { expression: '6*7' })], '42');
  const { events, answer } = await collect(model, '6*7 等于多少？');

  const kinds = events.map((e) => e.type);
  check('事件顺序正确（每轮都会先发 iteration）', kinds.join(',') === 'iteration,tool_start,tool_end,iteration,answer', kinds.join(','));
  check('answer 只出现一次', kinds.filter((k) => k === 'answer').length === 1);

  const toolEnd = events.find((e) => e.type === 'tool_end');
  check('工具执行成功', toolEnd?.type === 'tool_end' && toolEnd.ok);
  check('工具结果含正确数值', toolEnd?.type === 'tool_end' && toolEnd.result.includes('"value":42'));
  check('最终答案透传', answer === '42', answer);
}

// ② 预算耗尽：模型永远想调工具，循环必须自己收口
{
  const model = fakeModel([toolCall('calculator', { expression: '1+1' })], '预算用尽', { loop: true });
  const { events, answer } = await collect(model, '无限循环', 2);

  const toolCalls = events.filter((e) => e.type === 'tool_start').length;
  check('跑满预算后停止', toolCalls === 2, `实际调用 ${toolCalls} 次`);
  check('兜底仍给出答案', answer === '预算用尽', answer);
}

// ③ 未知工具：降级为错误观察，循环不崩
{
  const model = fakeModel([toolCall('不存在的工具', {})], '已恢复');
  const { events, answer } = await collect(model, '调个幽灵工具', 3);

  const toolEnd = events.find((e) => e.type === 'tool_end');
  check('未知工具标记为失败', toolEnd?.type === 'tool_end' && !toolEnd.ok);
  check('失败后循环继续', answer === '已恢复', answer);
}

// ④ 工具自身的防御：注入输入必须被拒绝
{
  const calculator = tools.find((t) => t.name === 'calculator')!;
  let rejected = false;
  try {
    await calculator.invoke({ expression: '1;process.exit(1)' });
  } catch {
    rejected = true;
  }
  check('calculator 拒绝非算术输入', rejected);
}

// 汇总
console.log('');
if (failures.length === 0) {
  console.log(`P2 gate: PASS（${passed} 项断言）`);
  process.exit(0);
}
console.log(`P2 gate: FAIL（${failures.length} 项失败：${failures.join('；')}）`);
process.exit(1);
