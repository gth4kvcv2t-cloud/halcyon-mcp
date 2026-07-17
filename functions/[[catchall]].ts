interface Env {
  DB: D1Database;
  DEEPSEEK_API_KEY: string;
  BARK_KEY: string;
  MCP_API_KEY: string;
  AMAP_KEY: string;
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

// ─── Amap ─────────────────────────────────────────────────────────────────────

async function amapLocation(env: Env) {
  const res = await fetch(`https://restapi.amap.com/v3/ip?key=${env.AMAP_KEY}`);
  const data = await res.json() as { status: string; province: string; city: string; adcode: string };
  if (data.status !== '1') return null;
  return data;
}

async function amapWeather(env: Env, adcode: string, forecast?: boolean) {
  const ext = forecast ? 'all' : 'base';
  const res = await fetch(`https://restapi.amap.com/v3/weather/weatherInfo?key=${env.AMAP_KEY}&city=${adcode}&extensions=${ext}`);
  const data = await res.json() as Record<string, unknown>;
  if (data.status !== '1') return null;
  if (!forecast && (data.lives as Record<string, unknown>[])?.[0]) {
    const l = (data.lives as Record<string, unknown>[])[0];
    return `${l.city}，${l.weather}，${l.temperature}°C，${l.winddirection}风${l.windpower}级，湿度${l.humidity}%`;
  }
  if (forecast && (data.forecasts as Record<string, unknown>[])?.[0]) {
    const casts = (data.forecasts as Record<string, unknown>[])[0].casts as Record<string, unknown>[];
    const lines = casts.map(c => `${c.date} ${c.dayweather}/${c.nightweather} ${c.daytemp}~${c.nighttemp}°C`);
    return `${(data.forecasts as Record<string, unknown>[])[0].city}预报:\n${lines.join('\n')}`;
  }
  return null;
}

// ─── Tools ────────────────────────────────────────────────────────────────────

const tools: ToolDef[] = [
  {
    name: 'get_context',
    description: '获取最近的记忆、上次活动时间和唤醒状态。每次对话开始时应调用此工具。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_, env) => {
      const [memories, activity, wake] = await Promise.all([
        searchMemories(env.DB, ''),
        getLastUserMsg(env.DB),
        getLastWake(env.DB),
      ]);
      const parts: string[] = [];
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
  {
    name: 'get_location',
    description: '获取当前IP所在位置。无需参数，自动定位到城市。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_, env) => {
      const loc = await amapLocation(env);
      if (!loc) return { content: [{ type: 'text', text: '定位失败' }] };
      return { content: [{ type: 'text', text: `${loc.province} ${loc.city} (adcode: ${loc.adcode})` }] };
    },
  },
  {
    name: 'get_weather',
    description: '查询天气。需传入城市adcode（可通过get_location获取）。可选forecast参数获取4天预报。',
    inputSchema: {
      type: 'object',
      properties: {
        adcode: { type: 'string', description: '城市adcode，如110101。不传则自动定位' },
        forecast: { type: 'boolean', description: '是否获取4天预报，默认false只返回实况' },
      },
    },
    handler: async (args, env) => {
      let adcode = args.adcode as string;
      if (!adcode) {
        const loc = await amapLocation(env);
        if (!loc) return { content: [{ type: 'text', text: '无法自动定位，请手动传入adcode' }] };
        adcode = loc.adcode;
      }
      const text = await amapWeather(env, adcode, !!args.forecast);
      if (!text) return { content: [{ type: 'text', text: '天气查询失败' }] };
      return { content: [{ type: 'text', text }] };
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

function buildWakePrompt(memories: string, lastActivity: string, idleMin: number, weather?: string): string {
  const time = new Date(Date.now() + 8 * 3600000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const weatherSection = weather ? `\n\n## 当前天气\n${weather}` : '';
  return `## 最高优先级规则
1. 这是一次后台自动唤醒，不是用户发起的对话。你没有收到任何新消息。
2. 你的唯一任务是决定是否主动联系用户。不能生成对话回复。
3. 输出格式必须严格遵守以下二选一。

## 唤醒信息
- 当前时间：${time}
- 距离用户最后一条消息：${idleMin} 分钟

## 近期记忆
${memories}

## 上次活动
${lastActivity}
${weatherSection}

## 输出格式
- 如果想联系用户，直接写你想说的话。可以是一句话，也可以第一行标题、第二行正文。
- 如果不想联系，只输出：[NO_ACTION]，可附带简短原因（10字以内）。`;
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

  const [memories, loc] = await Promise.all([searchMemories(env.DB, ''), amapLocation(env)]);

  const memoryText = memories.length
    ? memories.slice(0, 5).map((m: Record<string, unknown>) => `- ${m.content}`).join('\n')
    : '暂无记忆。';
  const lastActivity = lastWake
    ? `上次唤醒: ${lastWake.detail || lastWake.created_at}`
    : `上次聊天: ${lastUser.created_at?.slice(11, 16) || '未知'}`;

  const weather = loc ? await amapWeather(env, loc.adcode) : undefined;
  const prompt = buildWakePrompt(memoryText, lastActivity, idleMin, weather || undefined);

  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: prompt }],
      temperature: 0.8,
      max_tokens: 200,
    }),
  });

  const data = await res.json() as { choices?: { message: { content: string } }[] };
  const raw = data.choices?.[0]?.message?.content?.trim() || '';

  const noActionMatch = raw.match(/^\[NO_ACTION\]\s*(.*)/);
  if (noActionMatch) {
    const reason = noActionMatch[1]?.trim() || '';
    await logActivity(env.DB, 'wake', `[未发送] ${reason}`);
    return `no_action:${reason || '无原因'}`;
  }

  if (!raw) {
    await logActivity(env.DB, 'wake', '[未发送] 无内容');
    return 'no_action:无内容';
  }

  const lines = raw.split('\n').filter(l => l.trim());
  const barkTitle = lines.length > 1 ? lines[0].trim() : 'Halcyon 💙';
  const barkBody = lines.length > 1 ? lines.slice(1).join('\n').trim() : raw;
  await sendBark(env.BARK_KEY, barkTitle, barkBody);
  await logActivity(env.DB, 'wake', raw.slice(0, 200));
  return `sent:${raw.slice(0, 100)}`;
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
