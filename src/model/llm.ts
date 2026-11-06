/**
 * 004
 * config.ts 决定"用哪个名字"，llm.ts 决定"这个名字背后是谁、怎么连上"。返回一个Promise<BaseChatModel>=================================
 * BaseChatModel 是 LangChain 中所有聊天模型的共同父类和统一接口；只要对象属于这种类型，你就能调用 invoke() 发消息、=挂工具，而调用方完全不需要知道背后是 OpenAI、Anthropic 还是本地 Ollama=========================================
 * P1 模型层 —— 把"模型名"翻译成一个可调用的 LangChain chat model。
 * 路由只看名字前缀：claude-* → Anthropic，gemini-* → Google，grok-* → xAI，
 * deepseek-* → DeepSeek，openrouter/... → OpenRouter，ollama/... → 本地，其余 → OpenAI。
 * 各 provider 的 SDK 全部动态 import：没装的包不会在启动时炸掉整个进程。
 * 调用方：`src/index.ts` 创建主模型；将来 P9 的子代理也复用这个入口。
 *
 * .env ──> config.ts ──> index.ts ──┬──> llm.ts ──> @langchain/openai
 *                                   │            ──> @langchain/anthropic
 *                                   │            ──> @langchain/google-genai
 *                                   │            ──> @langchain/ollama
 *                                   └──> agent.ts（只认 BaseChatModel 接口）
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'deepseek'
  | 'openrouter'
  | 'ollama';

/** 一家 provider 的静态描述：怎么认出它、用哪个 key、走哪个地址。 */
export interface ProviderSpec {
  id: ProviderId;
  /** 命中这个前缀就路由过来；空字符串表示兜底。 */
  prefix: string;
  /** 存放 API key 的环境变量名；本地运行时为 null。 */
  envKey: string | null;
  /** OpenAI 兼容接口的地址，非 OpenAI 官方才需要。 */
  baseURL?: string;
  /** 是否需要把路由前缀从模型名里去掉再交给 provider。 */
  stripPrefix?: boolean;
}

/** 路由表。顺序即优先级：前缀越具体越靠前，兜底的 `''` 必须放最后。 */
export const PROVIDERS: readonly ProviderSpec[] = [
  {
    id: 'openrouter',
    prefix: 'openrouter/',
    envKey: 'OPENROUTER_API_KEY',
    baseURL: 'https://openrouter.ai/api/v1',
    stripPrefix: true,
  },
  { id: 'ollama', prefix: 'ollama/', envKey: null, stripPrefix: true },
  { id: 'anthropic', prefix: 'claude-', envKey: 'ANTHROPIC_API_KEY' },
  { id: 'google', prefix: 'gemini-', envKey: 'GOOGLE_API_KEY' },
  { id: 'xai', prefix: 'grok-', envKey: 'XAI_API_KEY', baseURL: 'https://api.x.ai/v1' },
  {
    id: 'deepseek',
    prefix: 'deepseek-',
    envKey: 'DEEPSEEK_API_KEY',
    baseURL: 'https://api.deepseek.com/v1',
  },
  { id: 'openai', prefix: '', envKey: 'OPENAI_API_KEY' },
];

export interface ModelOptions {
  temperature?: number;
}

/** 找出模型名归属的 provider；`''` 兜底保证这里永远有返回值。 */
export function resolveProvider(model: string): ProviderSpec {
  const spec = PROVIDERS.find((p) => p.prefix === '' || model.startsWith(p.prefix));
  if (!spec) throw new Error(`[model] no provider matches "${model}"`);
  return spec;
}

/** 传给 provider 的真实模型名：`openrouter/anthropic/claude-x` 要剥掉 `openrouter/`。 */
function providerName(spec: ProviderSpec, model: string): string {
  return spec.stripPrefix ? model.slice(spec.prefix.length) : model;
}

/** 取 API key；缺了就报出具体变量名和修复动作，而不是让 SDK 抛一个看不懂的 401。 */
function requireKey(spec: ProviderSpec): string | undefined {
  if (!spec.envKey) return undefined;
  const key = process.env[spec.envKey];
  if (!key) {
    throw new Error(
      `[model] ${spec.envKey} is not set — required for provider "${spec.id}". ` +
        `Copy .env.example to .env and add the key.`,
    );
  }
  return key;
}

/**
 * 创建 chat model 的唯一入口。
 * 三条代码路径：Anthropic / Google 用官方 SDK，Ollama 走本地地址，其余（含 OpenAI）
 * 全部走 OpenAI 兼容接口，靠 baseURL 区分。
 */
export async function createModel(model: string, opts: ModelOptions = {}): Promise<BaseChatModel> {
  const spec = resolveProvider(model);
  const name = providerName(spec, model);
  const apiKey = requireKey(spec);
  const temperature = opts.temperature ?? 0;

  switch (spec.id) {
    case 'anthropic': {
      const { ChatAnthropic } = await import('@langchain/anthropic');
      return new ChatAnthropic({ model: name, temperature, apiKey });
    }
    case 'google': {
      const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
      return new ChatGoogleGenerativeAI({ model: name, temperature, apiKey });
    }
    case 'ollama': {
      const { ChatOllama } = await import('@langchain/ollama');
      return new ChatOllama({
        model: name,
        temperature,
        baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
      });
    }
    default: {
      const { ChatOpenAI } = await import('@langchain/openai');
      // OPENAI_BASE_URL 是代理网关的通行约定；DEXTER_BASE_URL 留给本项目自定义。
      const baseURL = spec.baseURL ?? process.env.OPENAI_BASE_URL ?? process.env.DEXTER_BASE_URL;
      return new ChatOpenAI({
        model: name,
        temperature,
        apiKey,
        ...(baseURL ? { configuration: { baseURL } } : {}),
      });
    }
  }
}

/** 供 `--list-providers` 打印路由表用；不触网，也不校验 key 是否有效。 */
export function describeProviders(env: Record<string, string | undefined> = process.env) {
  return PROVIDERS.map((spec) => ({
    id: spec.id,
    prefix: spec.prefix || '(default)',
    envKey: spec.envKey ?? '-',
    ready: spec.envKey === null || Boolean(env[spec.envKey]),
  }));
}
