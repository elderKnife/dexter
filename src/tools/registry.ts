/**
 * P2 工具注册表 —— 目前只有两个示范工具，用来验证 agent 循环，不追求覆盖面。
 *
 * 三条规则（P3 扩展工具时继续遵守）：
 *   1. 工具是"工厂函数"，接收 ToolContext，不 import agent / UI，保证依赖方向单向。
 *   2. 所有工具统一返回 formatToolResult(...)，即 { data, sourceUrls } 的 JSON 字符串。
 *   3. 新增工具只改本文件，agent.ts 不需要任何改动。
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/** 工具执行时能拿到的环境信息；P3 会扩展 readOnly、timeout 等字段。 */
export interface ToolContext {
  cwd: string;
}

/** 统一的返回信封：模型看到的是数据 + 来源，UI 以后可以据此展示引用链接。 */
export function formatToolResult(data: unknown, sourceUrls: string[] = []): string {
  return JSON.stringify({ data, sourceUrls });
}




/** 只允许数字和四则运算符，从源头堵住代码注入。 */
const ARITHMETIC = /^[\d\s+\-*/().%]+$/;



/** 计算器：模型做算术时唯一正确的姿势，避免它"心算"出错。 */
function calculator(_ctx: ToolContext): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'calculator',
    description:
      'Evaluate exactly one arithmetic expression (+ - * / % and parentheses). Use it instead of doing math in your head.',
    schema: z.object({
      expression: z.string().describe('Arithmetic expression, e.g. "(1200 * 1.08) / 3"'),
    }),
    func: async ({ expression }) => {
      if (!ARITHMETIC.test(expression)) {
        throw new Error('only digits and the operators + - * / ( ) . % are allowed');
      }
      // 已经过白名单校验，这里不会执行任意语句
      const value = Number(Function(`"use strict"; return (${expression});`)());
      if (!Number.isFinite(value)) throw new Error(`expression is not a finite number: ${expression}`);
      return formatToolResult({ expression, value });
    },
  });
}



/** 读文件：限制在 cwd 内，并支持只读前 N 行，避免把整个大文件塞进上下文。 */
function readFileTool(ctx: ToolContext): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'read_file',
    description:
      'Read a UTF-8 text file from the working directory. Paths that escape it are rejected. Prefer narrow reads.',
    schema: z.object({
      path: z.string().describe('Path relative to the working directory'),
      maxLines: z
        .number()
        .int()
        .min(1)
        .max(400)
        .optional()
        .describe('How many leading lines to read (default 200)'),
    }),
    func: async ({ path: relative, maxLines = 200 }) => {
      const absolute = resolve(ctx.cwd, relative);
      // ../ 逃逸检查：解析后的绝对路径必须仍以 cwd 开头
      if (absolute !== ctx.cwd && !absolute.startsWith(ctx.cwd + sep)) {
        throw new Error(`path escapes the working directory: ${relative}`);
      }
      const text = await readFile(absolute, 'utf8');
      const lines = text.split('\n');
      return formatToolResult({
        path: relative,
        totalLines: lines.length,
        truncated: lines.length > maxLines,
        content: lines.slice(0, maxLines).join('\n'),
      });
    },
  });
}



/** 注册表：key 只用于内部索引，工具真正的名字在各自的 name 字段里。 */
export const TOOL_FACTORIES = { calculator, read_file: readFileTool } as const;



/** 组装入口：由 index.ts 调用，把工具实例注入 agent。 */
export function createTools(ctx: ToolContext): DynamicStructuredTool[] {
  return Object.values(TOOL_FACTORIES).map((factory) => factory(ctx));
}
