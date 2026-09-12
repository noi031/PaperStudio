// 论文域 MCP server：暴露给 dsh agent 的工具。P2 最小集（search_papers/echo），
// P3 起扩展 get_paper/read_pdf/summarize。stdio 传输，由 dsh-mcp-client 拉起。
// 本文件既是库（被 agentHost patch 引用入口）也可独立运行（node mcpServer.js）。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/** arXiv API 检索（P2 直连，不经 DB；P3 并入 Search 页流水线）。 */
async function arxivSearch(query: string, limit: number): Promise<Array<Record<string, string>>> {
  const url = new URL('https://export.arxiv.org/api/query');
  url.searchParams.set('search_query', `all:${query}`);
  url.searchParams.set('start', '0');
  url.searchParams.set('max_results', String(Math.min(limit, 20)));
  const res = await fetch(url, { headers: { Accept: 'application/atom+xml' } });
  if (!res.ok) throw new Error(`arXiv HTTP ${res.status}`);
  const xml = await res.text();
  const items: Array<Record<string, string>> = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = m[1];
    const get = (tag: string) => entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? '';
    const id = get('id').replace(/^http:\/\//, 'https://');
    items.push({
      id,
      title: get('title').replace(/\s+/g, ' '),
      summary: get('summary').replace(/\s+/g, ' ').slice(0, 1000),
      published: get('published').slice(0, 10),
      authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)]
        .map((a) => a[1].trim())
        .join(', '),
    });
  }
  return items;
}

export function buildPaperServer(): McpServer {
  const server = new McpServer({ name: 'paper', version: '0.1.0' });

  server.tool(
    'search_papers',
    '检索论文（arXiv）。query 为关键词，limit 默认 5 最大 20。返回论文 id/title/摘要/作者/日期。',
    { query: z.string(), limit: z.number().int().min(1).max(20).optional() },
    async ({ query, limit }) => {
      try {
        const items = await arxivSearch(query, limit ?? 5);
        return {
          content: [
            {
              type: 'text',
              text: items.length
                ? items.map((p, i) => `${i + 1}. [${p.id}] ${p.title}\n   ${p.authors} (${p.published})\n   ${p.summary.slice(0, 200)}`).join('\n\n')
                : '未找到结果',
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `search_papers 失败：${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    'echo',
    '回显文本（连接自测用）。',
    { text: z.string() },
    async ({ text }) => ({ content: [{ type: 'text', text }] }),
  );

  return server;
}

/** 独立入口：dsh-mcp-client 以 stdio 拉起本进程时执行。 */
export async function runStdio(): Promise<void> {
  const server = buildPaperServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// 仅直接运行时（node mcpServer.js）才连接 stdio；被 import 时由调用方决定。
if (require.main === module) {
  void runStdio();
}
