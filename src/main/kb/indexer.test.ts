import { describe, test, expect } from 'vitest';
import { chunkMarkdown, chunkExcel, containsTriggerWord } from './indexer';

describe('chunkMarkdown', () => {
  test('splits long text into chunks with overlap', async () => {
    const text = Array(200).fill('这是一段测试内容。').join('\n');
    const chunks = await chunkMarkdown(text);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.trim().length).toBeGreaterThan(0));
  });

  test('returns single chunk for short text', async () => {
    const text = '这是一段很短的文字。';
    const chunks = await chunkMarkdown(text);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe(text);
  });
});

describe('chunkExcel', () => {
  test('prepends header to each chunk', () => {
    const rows = [
      ['姓名', '部门', '金额'],
      ['张三', '财务处', '5000'],
      ['李四', '人事处', '6000'],
      ['王五', '技术部', '7000'],
    ];
    const chunks = chunkExcel(rows, 'Sheet1', 2);
    expect(chunks.length).toBe(2);
    chunks.forEach((c) => expect(c).toContain('姓名'));
    expect(chunks[0]).toContain('张三');
    expect(chunks[0]).toContain('李四');
    expect(chunks[1]).toContain('王五');
  });

  test('handles empty sheet', () => {
    const chunks = chunkExcel([], 'Sheet1', 10);
    expect(chunks).toEqual([]);
  });

  test('handles sheet with only header', () => {
    const rows = [['姓名', '部门']];
    const chunks = chunkExcel(rows, 'Sheet1', 10);
    expect(chunks).toEqual([]);
  });
});

describe('containsTriggerWord', () => {
  test('detects default trigger word', () => {
    expect(containsTriggerWord('查一下知识库里有没有这个政策', ['知识库'])).toBe(true);
  });

  test('returns false when no trigger word', () => {
    expect(containsTriggerWord('帮我写一封邮件', ['知识库'])).toBe(false);
  });

  test('supports multiple trigger words', () => {
    expect(containsTriggerWord('查文档库里的内容', ['知识库', '文档库'])).toBe(true);
  });

  test('case insensitive for English trigger words', () => {
    expect(containsTriggerWord('search the KB for this', ['kb'])).toBe(true);
  });
});
