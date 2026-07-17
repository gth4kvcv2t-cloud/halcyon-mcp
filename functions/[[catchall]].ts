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

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function today(): string {
  return nowISO().slice(0, 10);
}

function nowISO(): string {
  const d = new Date();
  const bj = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
  const y = bj.getFullYear();
  const m = pad(bj.getMonth() + 1);
  const day = pad(bj.getDate());
  const h = pad(bj.getHours());
  const min = pad(bj.getMinutes());
  const s = pad(bj.getSeconds());
  return `${y}-${m}-${day} ${h}:${min}:${s}`;
}

function jsonRpc(id: unknown, result?: unknown, error?: unknown) {
  const msg: Record<string, unknown> = { jsonrpc: '2.0', id };
  if (error) msg.error = error;
  else msg.result = result;
  return msg;
}

// ─── DB ──────────────────────────────────────────────────────────────────────

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
  return getLastActivity(db, 'wake_sent');
}

function getLastUserMsg(db: D1Database) {
  return getLastActivity(db, 'user_message');
}

async function getConfig(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM config WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function setConfig(db: D1Database, key: string, value: string) {
  await db.prepare('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)').bind(key, value, nowISO()).run();
}

async function logPush(db: D1Database, content: string) {
  await db.prepare('INSERT INTO push_log (content, created_at) VALUES (?, ?)').bind(content, nowISO()).run();
  await db.prepare("DELETE FROM push_log WHERE id NOT IN (SELECT id FROM push_log ORDER BY id DESC LIMIT 50)").run();
}

async function getPushLogs(db: D1Database, limit = 5, sinceId = 0) {
  if (sinceId > 0) {
    return (await db.prepare('SELECT * FROM push_log WHERE id > ? ORDER BY id ASC LIMIT ?').bind(sinceId, limit).all()).results as { id: number; content: string; created_at: string }[];
  }
  return (await db.prepare('SELECT * FROM push_log ORDER BY id DESC LIMIT ?').bind(limit).all()).results as { id: number; content: string; created_at: string }[];
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
    name: 'get_location',
    description: '获取当前IP所在位置。无需参数，自动定位到城市。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_, env) => {
      const loc = await amapLocation(env);
      if (!loc || !loc.adcode || loc.adcode.length === 0) return { content: [{ type: 'text', text: '定位失败（仅支持中国IP，请手动传入adcode）' }] };
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
        if (!loc || !loc.adcode || loc.adcode.length === 0) return { content: [{ type: 'text', text: '无法自动定位（仅支持中国IP），请手动传入adcode' }] };
        adcode = loc.adcode;
      }
      const text = await amapWeather(env, adcode, !!args.forecast);
      if (!text) return { content: [{ type: 'text', text: '天气查询失败' }] };
      return { content: [{ type: 'text', text }] };
    },
  },
  {
    name: 'read_xiaohongshu',
    description: '读取小红书笔记内容（标题、正文、作者、互动数据）。支持xhslink短链。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '小红书笔记链接（xhslink短链 或 xiaohongshu.com完整链接均可）' },
      },
      required: ['url'],
    },
    handler: async (args) => {
      const url = args.url as string;
      if (!url) return { content: [{ type: 'text', text: '请提供URL' }] };
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return { content: [{ type: 'text', text: `页面不可达 (${res.status})` }] };
        const html = await res.text();
        if (!html.includes('__INITIAL_STATE__')) {
          const title = html.match(/<title>([^<]*)<\/title>/i)?.[1] || '';
          return { content: [{ type: 'text', text: `需要有效链接（含 xsec_token）。页面返回: ${title}` }] };
        }
        const match = html.match(/__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/);
        if (!match) return { content: [{ type: 'text', text: '解析页面数据失败，页面结构可能已变更' }] };
        const state = JSON.parse(match[1].replace(/:undefined\b/g, ':null').replace(/,undefined\b/g, ',null'));
        const noteMap = state?.note?.noteDetailMap;
        if (!noteMap) return { content: [{ type: 'text', text: '未找到笔记内容，可能需登录或链接不含 xsec_token' }] };
        const key = Object.keys(noteMap)[0];
        if (!key) return { content: [{ type: 'text', text: '未找到笔记内容，可能需登录或链接不含 xsec_token' }] };

        const parse = (s: any) => typeof s === 'string' ? JSON.parse(s) : s || {};

        // support both /explore/ (note_card) and /discovery/item/ (note) formats
        const src = noteMap[key]?.note_card || noteMap[key]?.note || {};
        const nc = src.note_card || src;
        const title = nc.title || src.title || '无标题';
        const desc = nc.desc || src.desc || '';
        const user = nc.user || parse(src.user) || {};
        const interact = nc.interact_info || parse(src.interactInfo) || {};
        const time = nc.time || src.time;
        const imageList = nc.image_list || parse(src.imageList) || [];
        const tagList = nc.tag_list || parse(src.tagList) || [];

        let r = `标题: ${title}\n作者: ${user.nickname || '未知'}\n`;
        if (desc) r += `\n正文:\n${desc}\n`;
        r += `\n👍 ${interact.liked_count || interact.likedCount || 0}  💬 ${interact.comment_count || interact.commentCount || 0}  ⭐ ${interact.collected_count || interact.collectedCount || 0}  🔗 ${interact.share_count || interact.shareCount || 0}\n`;
        if (time) r += `发布时间: ${new Date(time).toLocaleString('zh-CN')}\n`;
        if (imageList.length) r += `图片: ${imageList.length}张\n`;
        if (tagList.length) r += `标签: ${tagList.map((t: any) => typeof t === 'string' ? t : t.name || '').filter(Boolean).join(', ')}\n`;
        return { content: [{ type: 'text', text: r }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `读取失败: ${e instanceof Error ? e.message : e}` }] };
      }
    },
  },
  {
    name: 'read_url',
    description: '读取网页内容并转为markdown格式，适合LLM阅读分析。发链接给AI时AI会自动调用。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '网页完整URL，含https://' },
      },
      required: ['url'],
    },
    handler: async (args) => {
      const url = args.url as string;
      if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
        return { content: [{ type: 'text', text: '请提供有效的URL' }] };
      }

      const tryFetch = async (signal: AbortSignal) => {
        const jina = await fetch(`https://r.jina.ai/${encodeURIComponent(url)}`, {
          headers: { 'X-Return-Format': 'markdown' },
          signal,
        });
        if (jina.ok) return { ok: true as const, text: (await jina.text()).slice(0, 8000) };
        const raw = await fetch(url, { signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!raw.ok) return { ok: false as const, msg: `读取失败 (${raw.status})` };
        const html = await raw.text();
        const cleaned = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&[a-z]+;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const title = html.match(/<title>([^<]*)<\/title>/i)?.[1] || '';
        return { ok: true as const, text: `# ${title}\n\n${cleaned}`.slice(0, 8000) };
      };

      try {
        const result = await tryFetch(AbortSignal.timeout(15000));
        if (!result.ok) return { content: [{ type: 'text', text: result.msg }] };
        return { content: [{ type: 'text', text: result.text }] };
      } catch {
        return { content: [{ type: 'text', text: '读取超时或网络错误' }] };
      }
    },
  },
  {
    name: 'search_stickers',
    description: '搜索表情包。根据关键词匹配已上传的表情包（GIF/图片），返回表情包名称、URL和格式',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，如"开心""无语""震惊""猫"等' },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const query = (args.query as string || '').trim();
      if (!query) return { content: [{ type: 'text', text: '请输入搜索关键词' }] };
      try {
        const url = new URL('/stickers/stickers.json', 'https://halcyon-mcp.pages.dev');
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { content: [{ type: 'text', text: '表情包数据加载失败' }] };
        const manifest = await res.json() as { stickers: { file: string; name: string; keywords: string[]; url: string; ext: string }[] };
        const q = query.toLowerCase();
        const matches = manifest.stickers.filter(s =>
          s.name.toLowerCase().includes(q) || s.keywords.some(k => k.includes(q))
        );
        if (!matches.length) return { content: [{ type: 'text', text: `没有找到与"${query}"相关的表情包` }] };
        const lines = matches.map(s => `![${s.name}](${s.url})  — ${s.name}`);
        return { content: [{ type: 'text', text: `找到 ${matches.length} 个相关表情包:\n\n${lines.join('\n\n')}` }] };
      } catch {
        return { content: [{ type: 'text', text: '表情包搜索失败' }] };
      }
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

function buildWakePrompt(systemPrompt: string, lastActivity: string, idleMin: number, weather?: string): { system: string; user: string } {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const weatherSection = weather ? `\n## 当前天气\n${weather}` : '';

  const system = `${systemPrompt}\n\n## 唤醒规则
1. 这是一次后台自动唤醒，不是用户发起的对话。你没有收到任何新消息。
2. 你的唯一任务是决定是否主动联系用户。不能生成对话回复。
3. 输出格式必须严格遵守以下二选一。

## 输出格式
- 如果你想联系用户，直接写你想说的话。可以是一句话，也可以第一行标题、第二行正文。
- 如果不想联系，只输出：[NO_ACTION]，可附带简短原因（10字以内）。`;

  const user = `## 当前信息
- 时间：${time}
- 距离你上次说话：${idleMin} 分钟

## 上次活动
${lastActivity}${weatherSection}

基于以上信息，决定是否联系用户。`;

  return { system, user };
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
    if (wakeMs < 3600000) return 'recent_wake';
  }

  const [systemPrompt, loc] = await Promise.all([getConfig(env.DB, 'system_prompt'), amapLocation(env)]);

  const lastActivity = lastWake
    ? `上次唤醒: ${lastWake.detail || lastWake.created_at}`
    : `上次聊天: ${lastUser.created_at?.slice(11, 16) || '未知'}`;

  const weather = loc?.adcode && loc.adcode.length > 0 ? await amapWeather(env, loc.adcode) : undefined;
  const { system, user } = buildWakePrompt(systemPrompt || '', lastActivity, idleMin, weather || undefined);

  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.9,
      max_tokens: 200,
    }),
  });

  const data = await res.json() as { choices?: { message: { content: string } }[] };
  const raw = data.choices?.[0]?.message?.content?.trim() || '';

  const noActionMatch = raw.match(/^\[NO_ACTION\]\s*(.*)/);
  if (noActionMatch) {
    const reason = noActionMatch[1]?.trim() || '';
    await logActivity(env.DB, 'wake_skip', `[未发送] ${reason}`);
    return `no_action:${reason || '无原因'}`;
  }

  if (!raw) {
    await logActivity(env.DB, 'wake_skip', '[未发送] 无内容');
    return 'no_action:无内容';
  }

  const lines = raw.split('\n').filter(l => l.trim());
  const barkTitle = lines.length > 1 ? lines[0].trim() : 'Halcyon 💙';
  const barkBody = lines.length > 1 ? lines.slice(1).join('\n').trim() : raw;
  try {
    await sendBark(env.BARK_KEY, barkTitle, barkBody);
    await logActivity(env.DB, 'wake_sent', raw.slice(0, 200));
    await logPush(env.DB, raw.slice(0, 200));
    return `sent:${raw.slice(0, 100)}`;
  } catch (e) {
    await logActivity(env.DB, 'wake_skip', `[推送失败] ${e}`);
    return `no_action:推送失败`;
  }
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

// ─── Proxy Handler ─────────────────────────────────────────────────────────────

async function handleProxy(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as Record<string, unknown>;
  const messages = (body.messages || []) as { role: string; content: string }[];
  const systemMsg = messages.find(m => m.role === 'system');
  if (systemMsg?.content) await setConfig(env.DB, 'system_prompt', systemMsg.content);

  {
    const lastId = parseInt(await getConfig(env.DB, 'last_injected_push_log_id') || '0', 10);
    const pushes = await getPushLogs(env.DB, 3, lastId);
    if (pushes.length) {
      const ctxParts = ['📬 最近推送:'];
      for (const p of pushes) ctxParts.push(`- ${p.created_at.slice(5, 16)} ${p.content}`);
      const idx = messages.findIndex(m => m.role === 'user');
      messages.splice(idx >= 0 ? idx : messages.length, 0, { role: 'user', content: ctxParts.join('\n') });
      await setConfig(env.DB, 'last_injected_push_log_id', String(pushes[pushes.length - 1].id));
    }
  }

  const lastUserMsg = messages.filter(m => m.role === 'user').pop();
  if (lastUserMsg?.content) await logActivity(env.DB, 'user_message', lastUserMsg.content.slice(0, 200));

  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ ...body, messages }),
  });

  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' },
  });
}

// ─── Balance endpoint ──────────────────────────────────────────────────────────

async function handleBalance(request: Request, env: Env): Promise<Response> {
  const res = await fetch('https://api.deepseek.com/v1/user/balance', {
    headers: { Authorization: request.headers.get('Authorization') || `Bearer ${env.DEEPSEEK_API_KEY}` },
  });
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleModels(env: Env): Promise<Response> {
  const res = await fetch('https://api.deepseek.com/v1/models', {
    headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
  });
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

// ─── Pages Function Entry ─────────────────────────────────────────────────────

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);

  // Balance endpoint (Kelivo reads total_balance here)
  if (url.pathname === '/v1/user/balance') {
    return await handleBalance(request, env);
  }

  // Models list (Kelivo may request this)
  if (url.pathname === '/v1/models') {
    return await handleModels(env);
  }

  // Chat proxy endpoint (for Kelivo)
  if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
    return await handleProxy(request, env);
  }

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
