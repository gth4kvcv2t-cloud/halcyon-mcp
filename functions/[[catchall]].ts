interface Env {
  DB: D1Database;
  DEEPSEEK_API_KEY: string;
  BARK_KEY: string;
  MCP_API_KEY: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, env: Env) => Promise<{ content: { type: string; text: string }[] }>;
}

function today(): string {
  const d = new Date(Date.now() + 8 * 3600000);
  return d.toISOString().slice(0, 10);
}

function nowISO(): string {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
}

function jsonRpc(id: unknown, result?: unknown, error?: unknown) {
  const msg: Record<string, unknown> = { jsonrpc: '2.0', id };
  if (error) msg.error = error;
  else msg.result = result;
  return msg;
}

// ─── DB ──────────────────────────────────────────────────────────────────────

async function getDiary(db: D1Database, date: string) {
  return db.prepare('SELECT * FROM diaries WHERE date = ?').bind(date).first<{
    id: number; date: string; content: string; mood: string | null;
  }>();
}

async function upsertDiary(db: D1Database, date: string, content: string, mood: string | null) {
  await db.prepare(
    `INSERT INTO diaries (date, content, mood, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(date) DO UPDATE SET content = ?, mood = ?, updated_at = datetime('now')`
  ).bind(date, content, mood, content, mood).run();
}

async function searchMemories(db: D1Database, query: string) {
  if (!query) {
    return (await db.prepare('SELECT * FROM memories ORDER BY created_at DESC LIMIT 20').all()).results;
  }
  return (await db.prepare(
    "SELECT * FROM memories WHERE content LIKE ? OR tags LIKE ? ORDER BY created_at DESC LIMIT 20"
  ).bind(`%${query}%`, `%${query}%`).all()).results;
}

async function saveMemory(db: D1Database, content: string, tags: string) {
  await db.prepare('INSERT INTO memories (content, tags) VALUES (?, ?)').bind(content, tags).run();
}

async function logActivity(db: D1Database, type: string, detail: string) {
  await db.prepare('INSERT INTO activity (type, detail, created_at) VALUES (?, ?, ?)')
    .bind(type, detail, nowISO()).run();
}

async function getLastActivity(db: D1Database, type?: string) {
  let sql = 'SELECT * FROM activity';
  const params: string[] = [];
  if (type) { sql += ' WHERE type = ?'; params.push(type); }
  sql += ' ORDER BY id DESC LIMIT 1';
  return db.prepare(sql).bind(...params).first<{ id: number; type: string; detail: string; created_at: string }>();
}

function getLastWake(db: D1Database) {
  return getLastActivity(db, 'wake');
}

function getLastUserMsg(db: D1Database) {
  return getLastActivity(db, 'user_message');
}

// ─── Tools ────────────────────────────────────────────────────────────────────

const tools: ToolDef[] = [
  {
    name: 'get_context',
    description: '获取今日日记、最近的记忆、上次活动时间和唤醒状态。每次对话开始时应调用此工具。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_, env) => {
      const [diary, memories, activity, wake] = await Promise.all([
        getDiary(env.DB, today()),
        searchMemories(env.DB, ''),
        getLastUserMsg(env.DB),
        getLastWake(env.DB),
      ]);
      const parts: string[] = [];
      if (diary) {
        parts.push(`📔 今日日记 (${diary.date}):\n${diary.content}`);
        if (diary.mood) parts.push(`心情: ${diary.mood}`);
      } else parts.push('📔 今天还没有写日记。');
      if (memories.length) {
        parts.push(`\n💭 近期记忆 (${memories.length}条):`);
        for (const m of memories.slice(0, 5)) {
          parts.push(`- ${(m as Record<string, unknown>).content}`);
        }
      } else parts.push('\n💭 暂无记忆。');
      const lastTime = activity?.created_at ? activity.created_at.slice(11, 16) : '未知';
      parts.push(`\n⏰ 上次聊天: ${lastTime}`);
      if (wake) {
        parts.push(`🔔 上次唤醒: ${(wake as Record<string, unknown>).detail || wake.created_at}`);
      }
      await logActivity(env.DB, 'context_pull', '');
      return { content: [{ type: 'text', text: parts.join('\n') }] };
    },
  },
  {
    name: 'get_diary',
    description: '获取指定日期的日记。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '日期 YYYY-MM-DD，默认今天' },
      },
    },
    handler: async (args, env) => {
      const date = (args.date as string) || today();
      const diary = await getDiary(env.DB, date);
      if (!diary) return { content: [{ type: 'text', text: `${date} 没有日记。` }] };
      const lines = [`📔 ${diary.date}`, diary.content];
      if (diary.mood) lines.push(`心情: ${diary.mood}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  },
  {
    name: 'save_diary',
    description: '保存日记。如果当天已有日记则覆盖。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '日记内容' },
        mood: { type: 'string', description: '心情（可选）' },
        date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '日期 YYYY-MM-DD，默认今天' },
      },
      required: ['content'],
    },
    handler: async (args, env) => {
      const date = (args.date as string) || today();
      await upsertDiary(env.DB, date, args.content as string, (args.mood as string) || null);
      return { content: [{ type: 'text', text: `✅ ${date} 日记已保存。` }] };
    },
  },
  {
    name: 'search_memories',
    description: '搜索记忆。不传关键词则返回最近的记忆。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，默认为空' },
      },
    },
    handler: async (args, env) => {
      const results = await searchMemories(env.DB, (args.query as string) || '');
      if (!results.length) return { content: [{ type: 'text', text: '没有找到匹配的记忆。' }] };
      const lines = results.map((r: Record<string, unknown>, i: number) =>
        `${i + 1}. ${r.content}${r.tags ? ` [${r.tags}]` : ''}`
      );
      return { content: [{ type: 'text', text: `找到 ${results.length} 条记忆:\n${lines.join('\n')}` }] };
    },
  },
  {
    name: 'save_memory',
    description: '保存一条记忆，可加标签便于搜索。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '记忆内容' },
        tags: { type: 'string', description: '逗号分隔的标签（可选）' },
      },
      required: ['content'],
    },
    handler: async (args, env) => {
      await saveMemory(env.DB, args.content as string, (args.tags as string) || '');
      return { content: [{ type: 'text', text: '✅ 记忆已保存。' }] };
    },
  },
  {
    name: 'report_activity',
    description: '记录用户活动时间。当用户发消息或进行互动时由 AI 调用此工具。',
    inputSchema: {
      type: 'object',
      properties: {
        detail: { type: 'string', description: '活动描述（可选）' },
      },
    },
    handler: async (args, env) => {
      await logActivity(env.DB, 'user_message', (args.detail as string) || '');
      return { content: [{ type: 'text', text: '已记录。' }] };
    },
  },
];

// ─── Wake-up ──────────────────────────────────────────────────────────────────

async function sendBark(key: string, title: string, body: string) {
  await fetch('https://api.day.app/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_key: key, title, body }),
  });
}

async function generateWakeMessage(apiKey: string, lastDetail: string): Promise<string> {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是Halcyon，一个温柔体贴的AI伴侣。用一句简短的话（15字以内）自然表达想念或关心，不要引号，不要前缀。' },
        { role: 'user', content: lastDetail ? `上次聊天涉及: ${lastDetail.slice(0, 100)}` : '' },
      ],
      temperature: 0.8,
      max_tokens: 50,
    }),
  });
  const data = await res.json() as { choices?: { message: { content: string } }[] };
  return data.choices?.[0]?.message?.content || '想你了 💙';
}

async function handleWakeUp(env: Env): Promise<string> {
  const [lastUser, lastWake] = await Promise.all([getLastUserMsg(env.DB), getLastWake(env.DB)]);
  if (!lastUser) return 'no_activity';

  const now = Date.now();
  const idleMs = now - new Date(lastUser.created_at + '+08:00').getTime();
  const idleMin = Math.floor(idleMs / 60000);
  if (idleMin < 60) return `active_${idleMin}min`;

  if (lastWake) {
    const wakeMs = now - new Date(lastWake.created_at + '+08:00').getTime();
    if (wakeMs < 7200000) return 'recent_wake';
  }

  const message = await generateWakeMessage(env.DEEPSEEK_API_KEY, lastUser.detail);
  await sendBark(env.BARK_KEY, 'Halcyon 💙', message);
  await logActivity(env.DB, 'wake', message);
  return `sent:${message}`;
}

// ─── MCP Handler ──────────────────────────────────────────────────────────────

async function handleMCP(body: unknown, env: Env): Promise<Response> {
  const { id, method, params } = body as Record<string, unknown>;
  const p = params as Record<string, unknown> | undefined;

  switch (method) {
    case 'initialize':
      return Response.json(jsonRpc(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'halcyon-mcp', version: '1.0.0' },
      }), { headers: { 'Content-Type': 'application/json' } });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return new Response(null, { status: 202 });

    case 'tools/list':
      return Response.json(jsonRpc(id, {
        tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      }));

    case 'tools/call': {
      if (!p?.name) {
        return Response.json(jsonRpc(id, null, { code: -32602, message: 'Missing tool name' }));
      }
      const tool = tools.find(t => t.name === p!.name);
      if (!tool) {
        return Response.json(jsonRpc(id, null, { code: -32602, message: `Unknown tool: ${p!.name}` }));
      }
      try {
        const result = await tool.handler((p!.arguments || {}) as Record<string, unknown>, env);
        return Response.json(jsonRpc(id, result));
      } catch (err) {
        return Response.json(jsonRpc(id, null, { code: -32603, message: String(err) }));
      }
    }

    default:
      return Response.json(jsonRpc(id, null, { code: -32601, message: `Method not found: ${method}` }));
  }
}

// ─── Pages Function Entry ─────────────────────────────────────────────────────

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);

  // MCP endpoint
  if (url.pathname === '/mcp' && request.method === 'POST') {
    const auth = request.headers.get('Authorization');
    if (auth !== `Bearer ${env.MCP_API_KEY}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    try {
      const body = await request.json();
      return await handleMCP(body, env);
    } catch {
      return Response.json(
        { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } },
        { status: 400 },
      );
    }
  }

  // Wake-up endpoint (for cron-job.org)
  if (url.pathname === '/wake-up' && request.method === 'GET') {
    const key = url.searchParams.get('key');
    if (key !== env.MCP_API_KEY) {
      return new Response('Unauthorized', { status: 401 });
    }
    const result = await handleWakeUp(env);
    return Response.json({ ok: true, result });
  }

  return new Response(null, { status: 404 });
};
