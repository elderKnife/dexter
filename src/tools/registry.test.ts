/**
 * P2 工具测试 —— 只覆盖三件事：返回信封、参数校验、边界防护。
 *
 * 每个工具都配"正常路径 + 攻击路径"两类用例，这是后面加工具时的模板：
 * 能算对的算对，能拦住的拦住，剩下交给集成测试。
 */
import { describe, expect, test } from 'bun:test';
import { createTools, formatToolResult } from './registry';

const tools = createTools({ cwd: process.cwd() });
const calculator = tools.find((tool) => tool.name === 'calculator')!;
const readFile = tools.find((tool) => tool.name === 'read_file')!;

describe('registry', () => {
  test('产出两个工具，名字唯一', () => {
    expect(tools).toHaveLength(2);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
  });
});

describe('formatToolResult', () => {
  test('固定 { data, sourceUrls } 信封', () => {
    expect(JSON.parse(formatToolResult({ a: 1 }, ['https://example.com']))).toEqual({
      data: { a: 1 },
      sourceUrls: ['https://example.com'],
    });
  });

  test('省略来源时给空数组而不是省略字段', () => {
    expect(JSON.parse(formatToolResult(42)).sourceUrls).toEqual([]);
  });
});

describe('calculator', () => {
  test('算出正确结果', async () => {
    const out = JSON.parse(await calculator.invoke({ expression: '(1200*1.08)/3' }));
    expect(out.data.value).toBeCloseTo(432);
    expect(out.data.expression).toBe('(1200*1.08)/3');
  });

  test('拒绝非算术输入（代码注入）', async () => {
    await expect(calculator.invoke({ expression: '1;process.exit(1)' })).rejects.toThrow(/allowed/);
  });

  test('拒绝字段名写错的调用', async () => {
    await expect(calculator.invoke({ expr: '1+1' })).rejects.toThrow(/did not match expected schema/);
  });
});

describe('read_file', () => {
  test('读取 cwd 内的文件并按行截断', async () => {
    const out = JSON.parse(await readFile.invoke({ path: 'package.json', maxLines: 3 }));
    expect(out.data.totalLines).toBeGreaterThan(3);
    expect(out.data.truncated).toBe(true);
    expect(out.data.content).toContain('"name"');
  });

  test('拦截 ../ 路径逃逸', async () => {
    await expect(readFile.invoke({ path: '../../etc/passwd' })).rejects.toThrow(/escapes/);
  });
});

// 已知缺陷：JS Number 超过 2^53 会失真（987654321×123456789 应为 …269，实得 …260）。
// P3 改成 BigInt / decimal 后，把这个 todo 变成正式断言。
test.todo('大整数运算需要精确结果（P3 修复）');
