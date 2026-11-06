/**
 * 003
 * P0 配置层 —— 把 `.env` / `process.env` 里的字符串转成带类型、带默认值、带边界的 `Config`。
 * 全项目只有这里读 `process.env`：其他模块通过参数接收配置，测试时不用改真实环境变量。
 * 调用方：`src/index.ts` 启动时调用一次。Bun 会自动加载 `.env`，无需 dotenv。
 */

export interface Config {
  model: string;
  temperature: number;
  maxIterations: number;
  verbose: boolean;
}

/** 与参考实现保持一致，可用 DEXTER_MODEL 覆盖。 */
export const DEFAULT_MODEL = 'gpt-6-astra';

type Env = Record<string, string | undefined>;

/** 夹逼到 [min, max]，防止极端配置把循环规模放大到不可控。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 环境变量 → 数字，非法输入回落默认值。
 * 不用 `Number(raw) || fallback`：`0` 是合法值，会被 `||` 误判成"没配"。
 */
function number(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 环境变量 → 布尔：只有 '1' 或 'true'（不区分大小写）为真。 */
function flag(raw: string | undefined): boolean {
  return raw === '1' || raw?.toLowerCase() === 'true';
}

/** 读取配置的唯一入口；`env` 可注入，测试时传假对象即可。 */
export function loadConfig(env: Env = process.env): Config {
  return {
    model: env.DEXTER_MODEL?.trim() || DEFAULT_MODEL,
    temperature: clamp(number(env.DEXTER_TEMPERATURE, 0.2), 0, 2),
    // 轮次硬上限 25：agent 跑飞一次就是真金白银
    maxIterations: Math.trunc(clamp(number(env.DEXTER_MAX_ITERATIONS, 10), 1, 25)),
    verbose: flag(env.DEXTER_VERBOSE),
  };
}
