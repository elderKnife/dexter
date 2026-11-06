/**
 * P0/P2 入口 —— CLI 参数解析 + 事件渲染 + REPL。
 *
 * 它是全项目唯一"组装"的地方：读配置、建模型、造工具，然后把三者交给 runAgent。
 * 层级：上层只依赖 runAgent 的事件流（AgentEvent），不认识工具，也不关心模型是谁。
 * P5 会把这里的渲染换成 pi-tui，其它逻辑不变。
 */
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { loadConfig } from './config';
import { createModel, describeProviders } from './model/llm';
import { createTools } from './tools/registry';
import { runAgent } from './agent/agent';
import type { AgentEvent } from './agent/types';
// [TRACE] 调试日志（可回撤）：删除本行 + src/trace.ts 即可
import {
  configureTrace,
  enableTrace,
  endTrace,
  startTrace,
  traceEnabled,
  traceEvent,
  traceModel,
} from './trace';

const paint = (code: string) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
const dim = paint('2');
const bold = paint('1');
const red = paint('31');

/** 单行化 + 截断，避免工具结果把终端刷屏。 */
function short(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function printHelp(): void {
  console.log(`${bold('dexter')} — minimal research agent (P0–P2)

  bun run start                       交互式 REPL
  bun run start "6*7 等于多少"         一次性提问
  bun run start --list-providers      查看 provider 路由表

  -m, --model <name>        覆盖 DEXTER_MODEL
      --max-iterations <n>  覆盖 DEXTER_MAX_ITERATIONS
  -q, --once <query>        单次提问后退出
  -v, --verbose             打印每一轮迭代
      --trace               打印与 LLM 的完整通信（调试用）
  -h, --help                显示本帮助`);
}

interface Cli {
  model?: string;
  maxIterations?: number;
  query?: string;
  listProviders: boolean;
  verbose: boolean;
  trace: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { listProviders: false, verbose: false, trace: false, help: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === '--model' || arg === '-m') cli.model = argv[++i];
    else if (arg === '--max-iterations') cli.maxIterations = Number(argv[++i]);
    else if (arg === '--once' || arg === '-q') cli.query = argv[++i];
    else if (arg === '--list-providers') cli.listProviders = true;
    else if (arg === '--verbose' || arg === '-v') cli.verbose = true;
    else if (arg === '--trace') cli.trace = true;
    else if (arg === '--help' || arg === '-h') cli.help = true;
    else positional.push(arg);
  }
  // 不带 --once 时，位置参数也当成一次提问（`bun run start "问题"`）
  if (!cli.query && positional.length > 0) cli.query = positional.join(' ');
  return cli;
}

/** 把事件翻译成终端输出：进度和工具调用走 stderr，答案走 stdout。 */
function render(event: AgentEvent, verbose: boolean): void {
  // [TRACE] 开日志时，工具调用由 trace 详细打印，这里跳过以免两套输出交错
  const tracing = traceEnabled();
  if (event.type === 'tool_start') {
    if (!tracing) process.stderr.write(dim(`  → ${event.name}(${short(JSON.stringify(event.args), 120)})\n`));
  } else if (event.type === 'tool_end') {
    if (tracing) return;
    const line = `  ← ${event.name} ${event.ok ? 'ok' : '失败'} ${event.ms}ms ${short(event.result, verbose ? 400 : 100)}\n`;
    process.stderr.write((event.ok ? dim : red)(line));
  } else if (event.type === 'answer') {
    stdout.write(`\n${event.text}\n\n`);
  } else if (event.type === 'error') {
    process.stderr.write(red(`  ✗ ${event.message}\n`));
  } else if (verbose) {
    process.stderr.write(dim(`  · 第 ${event.index}/${event.max} 轮\n`));
  }
}

/** 跑一次提问：只消费事件流，拿不到也不需要用 return 值。 */
async function ask(
  query: string,
  model: BaseChatModel,
  tools: StructuredToolInterface[],
  maxIterations: number,
  verbose: boolean,
): Promise<void> {
  startTrace(); // [TRACE]
  for await (const event of runAgent({ model, tools, query, maxIterations })) {
    render(event, verbose);
    traceEvent(event); // [TRACE]
  }
  endTrace(); // [TRACE]
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) return printHelp();

  if (cli.listProviders) {
    for (const p of describeProviders()) {
      console.log(`${p.id.padEnd(11)} ${p.prefix.padEnd(12)} ${p.envKey.padEnd(19)} ${p.ready ? 'ready' : 'missing key'}`);
    }
    return;
  }

  const config = loadConfig();
  const modelName = cli.model ?? config.model;
  const maxIterations = cli.maxIterations ?? config.maxIterations;
  const verbose = cli.verbose || config.verbose;

  let model: BaseChatModel;
  try {
    model = await createModel(modelName, { temperature: config.temperature });
  } catch (error) {
    console.error(red(`✗ ${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = 1;
    return;
  }

  const tools = createTools({ cwd: process.cwd() });

  // [TRACE] 开启调试日志：--trace 或 DEXTER_TRACE=1
  if (cli.trace || traceEnabled() || process.env.DEXTER_TRACE === '1') {
    enableTrace();
    configureTrace({ model: modelName, tools: tools.map((t) => t.name), maxIterations });
    model = traceModel(model);
  }

  // 一次性提问：跑完就退出，适合脚本和 CI
  if (cli.query) {
    await ask(cli.query, model, tools, maxIterations, verbose);
    return;
  }

  console.log(`${bold('dexter')} ${dim(`model=${modelName} tools=${tools.map((t) => t.name).join(',')}`)}`);
  console.log(dim('Ctrl+C 退出，/help 查看命令') + '\n');

  const rl = createInterface({ input: stdin, output: stdout });
  rl.on('SIGINT', () => {
    rl.close();
    process.exit(130);
  });

  for (;;) {
    let line: string;
    try {
      line = (await rl.question(bold('you › '))).trim();
    } catch {
      break; // stdin 关闭（Ctrl+D 或管道输入结束）
    }
    if (!line) continue;
    if (line === '/exit' || line === '/quit') break;
    if (line === '/help') {
      console.log(dim('  /exit  退出    /help  帮助'));
      continue;
    }
    await ask(line, model, tools, maxIterations, verbose);
  }
  rl.close();
}

await main();
