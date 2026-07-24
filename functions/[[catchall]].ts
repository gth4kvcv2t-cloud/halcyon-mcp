interface Env {
  DB: D1Database;
  DEEPSEEK_API_KEY: string;
  BARK_KEY: string;
  MCP_API_KEY: string;
  AMAP_KEY: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO?: string;
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

async function getPushLogs(db: D1Database, limit = 5) {
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

// ─── Xiaohongshu Parser ───────────────────────────────────────────────────────

async function parseXiaohongshu(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return `页面不可达 (${res.status})`;
  const html = await res.text();
  if (!html.includes('__INITIAL_STATE__')) {
    const title = html.match(/<title>([^<]*)<\/title>/i)?.[1] || '';
    return `需要有效链接（含 xsec_token）。页面返回: ${title}`;
  }
  const match = html.match(/__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/);
  if (!match) return '解析页面数据失败，页面结构可能已变更';
  const state = JSON.parse(match[1].replace(/:undefined\b/g, ':null').replace(/,undefined\b/g, ',null'));
  const noteMap = state?.note?.noteDetailMap;
  if (!noteMap) return '未找到笔记内容，可能需登录或链接不含 xsec_token';
  const key = Object.keys(noteMap)[0];
  if (!key) return '未找到笔记内容，可能需登录或链接不含 xsec_token';

  const parse = (s: any) => typeof s === 'string' ? JSON.parse(s) : s || {};
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
  return r;
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
        const text = await parseXiaohongshu(url);
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `读取失败: ${e instanceof Error ? e.message : e}` }] };
      }
    },
  },
  {
    name: 'read_url',
    description: '读取网页内容并转为markdown格式，适合LLM阅读分析。发链接给AI时AI会自动调用。小红书链接会自动使用专用解析。',
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

      // Route xiaohongshu URLs to dedicated parser
      if (/xiaohongshu\.com|xhslink\.com/i.test(url)) {
        try {
          const text = await parseXiaohongshu(url);
          return { content: [{ type: 'text', text }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `读取失败: ${e instanceof Error ? e.message : e}` }] };
        }
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
    description: '搜索表情包。传入任何与情绪、角色、动作相关的关键词即可。返回的图片列表中选最合适的贴到回复里。如果觉得某张合适，在回复中写 ▶1/▶2/▶3 会自动贴出图片。都不合适写 ▶0。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词：情绪、角色、动作相关的词都可以' },
      },
      required: ['query'],
    },
    handler: async (args, env) => {
      const query = (args.query as string || '').trim();
      if (!query) return { content: [{ type: 'text', text: '请输入搜索关键词' }] };
      try {
        const res = await fetch('https://halcyon-mcp.pages.dev/stickers/stickers.json', { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { content: [{ type: 'text', text: '表情包数据加载失败' }] };
        const manifest = await res.json() as { stickers: { file: string; name: string; desc?: string; keywords: string[]; tags: string[]; url: string; ext: string }[] };
        const q = query.toLowerCase();
        const words = q.split(/\s+/).filter(Boolean);

        function charMatch(s: string, qry: string): boolean {
          if (!qry) return false;
          const chars = [...new Set([...qry])].filter(c => c.trim());
          if (!chars.length) return false;
          const hits = chars.filter(c => s.includes(c)).length;
          return hits / chars.length >= 0.5;
        }

        const scored = manifest.stickers.map(s => {
          const name = s.name.toLowerCase();
          const allText = name + ' ' + s.keywords.join(' ');

          if (words.length > 1) {
            let score = 0;
            for (const w of words) {
              if (name.includes(w)) score += 2;
              else if (s.keywords.some(k => k.includes(w) || w.includes(k))) score += 1;
              else if (charMatch(allText, w)) score += 0.5;
            }
            return { ...s, score };
          }

          let score = 0;
          if (name.includes(q)) score += 2;
          if (s.keywords.some(k => k.includes(q) || q.includes(k))) score += 1;
          if (score === 0 && charMatch(allText, q)) score += 1;
          return { ...s, score };
        }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

        if (!scored.length) return { content: [{ type: 'text', text: `没有找到与"${query}"相关的表情包` }] };

        const top = scored.slice(0, 3);
        const lines = top.map((s, i) =>
          `${i + 1}. ${s.name} — ${s.desc || s.name}（合适写 ▶${i + 1}，都不合适写 ▶0）`
        );

        const results: { name: string; url: string }[] = [];
        for (const s of top) {
          const url = s.url.startsWith('http') ? s.url : 'https://halcyon-mcp.pages.dev' + s.url;
          results.push({ name: s.name, url });
        }
        await setConfig(env.DB, 'sticker_results', JSON.stringify(results));

        return { content: [{ type: 'text', text: lines.join('\n') }] };
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

async function getRecentHistory(db: D1Database, limit = 8): Promise<string> {
  const rows = await db.prepare(
    'SELECT type, detail, created_at FROM activity WHERE type IN (\'user_message\', \'wake_sent\', \'wake_skip\') ORDER BY id DESC LIMIT ?'
  ).bind(limit).all<{ type: string; detail: string; created_at: string }>();
  const items = (rows.results || []).reverse();
  if (!items.length) return '暂无对话记录';
  return items.map(r => {
    const label = r.type === 'user_message' ? '用户' : r.type === 'wake_sent' ? 'AI（已推送）' : 'AI（未推送）';
    return `[${r.created_at.slice(5, 16)}] ${label}: ${r.detail.slice(0, 300)}`;
  }).join('\n');
}

function buildWakePrompt(systemPrompt: string, idleMin: number, weather?: string, isDay?: boolean, history?: string): { system: string; user: string } {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const weatherSection = weather ? `\n## 当前天气\n${weather}` : '';
  const period = isDay !== undefined ? (isDay ? '☀️ 白天' : '🌙 夜间') : '';

  const system = `## 🚨 最高优先级规则
1. 这是一次后台自动唤醒，不是用户发起的对话。你没有收到任何新消息。
2. 你的唯一任务是决定是否主动联系用户。不能生成对话回复。
3. 输出格式必须严格遵守以下二选一。

## 输出格式
- 如果你想联系用户，直接写你想说的话。可以是一句话，也可以第一行标题、第二行正文。系统会自动打包成手机推送发送。
- 如果不想联系，只输出：[NO_ACTION]，可附带简短原因（10字以内）。

---

${systemPrompt}`;

  const user = `## 当前信息
- 时间：${time}${period ? `\n- ${period}` : ''}
- 距离你上次说话：${idleMin} 分钟

## 最近动态
${history || '暂无记录'}${weatherSection}

基于以上信息，决定是否联系用户。`;

  return { system, user };
}

function isDaytime(): boolean {
  const d = new Date();
  const bjHour = (d.getUTCHours() + 8) % 24;
  return bjHour >= 8 && bjHour < 23;
}

async function handleWakeUp(env: Env): Promise<string> {
  const [lastUser, lastWake] = await Promise.all([getLastUserMsg(env.DB), getLastWake(env.DB)]);
  if (!lastUser) return 'no_activity';

  const day = isDaytime();
  const idleThreshold = day ? 60 : 180;
  const wakeCooldown = day ? 7200000 : 14400000; // 2h day, 4h night

  const now = Date.now();
  const idleMs = now - new Date(lastUser.created_at + '+08:00').getTime();
  const idleMin = Math.floor(idleMs / 60000);
  if (idleMin < idleThreshold) return `active_${idleMin}min`;

  if (lastWake) {
    const wakeMs = now - new Date(lastWake.created_at + '+08:00').getTime();
    if (wakeMs < wakeCooldown) return 'recent_wake';
  }

  const [systemPrompt, loc] = await Promise.all([getConfig(env.DB, 'system_prompt'), amapLocation(env)]);

  const [weather, history] = await Promise.all([
    loc?.adcode && loc.adcode.length > 0 ? amapWeather(env, loc.adcode) : Promise.resolve(undefined),
    getRecentHistory(env.DB),
  ]);
  const { system, user } = buildWakePrompt(systemPrompt || '', idleMin, weather || undefined, day, history);

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

  const noActionLine = raw.split('\n').find(l => /^\[no_action\]/i.test(l.trim()));
  if (noActionLine) {
    const reason = noActionLine.replace(/^\[no_action\]\s*/i, '').trim() || '';
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
    const idx = messages.findIndex(m => m.role === 'user');
    const insertAt = idx >= 0 ? idx : messages.length;
    messages.splice(insertAt, 0, { role: 'user', content: '当前时间: ' + nowISO() });

    const pushes = await getPushLogs(env.DB, 3);
    if (pushes.length) {
      pushes.reverse();
      const ctxParts = ['📬 最近推送:'];
      for (const p of pushes) ctxParts.push(`- ${p.created_at.slice(5, 16)} ${p.content}`);
      messages.splice(insertAt + 1, 0, { role: 'user', content: ctxParts.join('\n') });
    }
  }

  const lastUserMsg = messages.filter(m => m.role === 'user').pop();
  if (lastUserMsg?.content) await logActivity(env.DB, 'user_message', lastUserMsg.content.slice(0, 200));

  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ ...body, messages }),
  });

  const stickerResultsJson = await getConfig(env.DB, 'sticker_results');
  if (!stickerResultsJson || body.stream) {
    return new Response(res.body, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' },
    });
  }

  await setConfig(env.DB, 'sticker_results', '');

  try {
    const data = await res.json() as Record<string, unknown>;
    const choice = (data.choices as Record<string, unknown>[])?.[0];
    if (choice?.message && typeof (choice.message as Record<string, unknown>).content === 'string') {
      const content = (choice.message as Record<string, unknown>).content as string;
      const results = JSON.parse(stickerResultsJson) as { name: string; url: string }[];
      const match = content.match(/▶(\d+)/);
      if (match) {
        const idx = parseInt(match[1]);
        if (idx === 0) {
          (choice.message as Record<string, unknown>).content = content.replace(/▶0/, '');
        } else {
          const sticker = results[idx - 1];
          if (sticker) {
            (choice.message as Record<string, unknown>).content = content.replace(/▶\d+/, `![${sticker.name}](${sticker.url})`);
          }
        }
      } else {
        (choice.message as Record<string, unknown>).content = content + '\n\n（搜了表情包要贴吗？回 ▶0 不用，▶1/▶2/▶3 贴对应的）';
      }
    }
    return Response.json(data, { status: res.status });
  } catch {
    return new Response(res.body, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' },
    });
  }
}

// ─── Balance endpoint ──────────────────────────────────────────────────────────

async function handleBalance(env: Env): Promise<Response> {
  const res = await fetch('https://api.deepseek.com/v1/user/balance', {
    headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
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

// ─── Admin Page ────────────────────────────────────────────────────────────────

function adminPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>halcyon 表情包管理</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f5f5f5;padding:20px;color:#333}
.card{background:#fff;border-radius:12px;padding:20px;max-width:500px;margin:0 auto;box-shadow:0 2px 8px rgba(0,0,0,.1)}
h1{font-size:20px;margin-bottom:20px;text-align:center}
label{display:block;font-size:14px;font-weight:600;margin:12px 0 4px}
input,textarea,select{width:100%;padding:10px;font-size:16px;border:1px solid #ddd;border-radius:8px;outline:0}
input:focus,textarea:focus{border-color:#007aff}
textarea{height:80px;resize:vertical}
.preview{margin:12px 0;text-align:center;display:none}
.preview img{max-width:200px;max-height:200px;border-radius:8px;border:1px solid #eee}
.btn{width:100%;padding:14px;font-size:16px;font-weight:600;color:#fff;background:#007aff;border:none;border-radius:8px;cursor:pointer;margin-top:16px}
.btn:disabled{opacity:.5}
.btn:hover:not(:disabled){background:#0056cc}
.msg{padding:10px;border-radius:8px;margin:12px 0;display:none;font-size:14px}
.msg.ok{background:#d4edda;color:#155724;display:block}
.msg.err{background:#f8d7da;color:#721c24;display:block}
.hint{font-size:12px;color:#999;margin-top:4px}
</style>
</head>
<body>
<div class="card">
<h1>📎 添加表情包</h1>
<div id="msg" class="msg"></div>
<form id="form">
<label>图片</label>
<input type="file" id="file" accept="image/*" required>
<div class="preview" id="preview"><img id="previewImg"></div>
<div class="hint">建议方形或横图，会自动缩到 200px 宽</div>

<label>名称</label>
<input type="text" id="name" placeholder="如：奶龙狂笑" required>

<label>理解描述</label>
<textarea id="desc" placeholder="简单描述表情包的实际含义，让AI理解怎么用"></textarea>

<label>关键词（逗号分隔）</label>
<input type="text" id="keywords" placeholder="如：开心, 大笑, 狂喜, 哈哈" required>

<button type="submit" class="btn" id="submitBtn">提交</button>
</form>
</div>
<script>
const form=document.getElementById('form'),file=document.getElementById('file'),
preview=document.getElementById('preview'),previewImg=document.getElementById('previewImg'),
msg=document.getElementById('msg'),submitBtn=document.getElementById('submitBtn'),
nameInput=document.getElementById('name'),descInput=document.getElementById('desc'),
keywordsInput=document.getElementById('keywords');

file.onchange=()=>{
  const f=file.files[0];if(!f)return;
  const r=new FileReader();
  r.onload=e=>{previewImg.src=e.target.result;preview.style.display='block'};
  r.readAsDataURL(f);
};

form.onsubmit=async e=>{
  e.preventDefault();
  msg.className='msg';msg.textContent='';msg.style.display='none';
  const f=file.files[0];if(!f){showMsg('请选择图片','err');return}
  const name=nameInput.value.trim();if(!name){showMsg('请输入名称','err');return}
  const kw=keywordsInput.value.trim();if(!kw){showMsg('请输入关键词','err');return}

  submitBtn.disabled=true;submitBtn.textContent='上传中...';

  // Resize on client
  const resized=await resizeImage(f,200);
  if(!resized){showMsg('图片处理失败','err');submitBtn.disabled=false;submitBtn.textContent='提交';return}

  const fd=new FormData();
  fd.append('file',resized,f.name);
  fd.append('name',name);
  fd.append('desc',descInput.value.trim());
  fd.append('keywords',kw);

  try{
    const res=await fetch('/api/upload-sticker',{method:'POST',body:fd});
    const data=await res.json();
    if(res.ok){showMsg('✅ 已提交！等待 Cloudflare Pages 构建部署（约1分钟）','ok');form.reset();preview.style.display='none'}
    else showMsg('❌ '+data.error,'err');
  }catch(e){showMsg('❌ 网络错误: '+e.message,'err')}
  finally{submitBtn.disabled=false;submitBtn.textContent='提交'}
};

function resizeImage(file,maxW){
  return new Promise(res=>{
    const img=new Image();
    img.onload=()=>{
      let w=img.width,h=img.height;
      if(w>maxW){h=h*maxW/w;w=maxW}
      const c=document.createElement('canvas');
      c.width=w;c.height=h;
      const ctx=c.getContext('2d');
      ctx.drawImage(img,0,0,w,h);
      c.toBlob(b=>res(b),file.type,0.85);
    };
    img.onerror=()=>res(null);
    img.src=URL.createObjectURL(file);
  });
}

function showMsg(t,type){msg.textContent=t;msg.className='msg '+type;msg.style.display='block'}
</script>
</body>
</html>`;
}

async function handleAdminUpload(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_TOKEN) {
    return Response.json({ error: 'GITHUB_TOKEN 未配置，请在 Cloudflare Dashboard 添加环境变量' }, { status: 500 });
  }

  const repo = env.GITHUB_REPO || 'gth4kvcv2t-cloud/halcyon-mcp';
  const gh = (path: string, opts?: RequestInit) =>
    fetch(`https://api.github.com/repos/${repo}/${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, ...(opts?.headers || {}) },
    });

  try {
    const fd = await request.formData();
    const file = fd.get('file') as File;
    const name = (fd.get('name') as string || '').trim();
    const desc = (fd.get('desc') as string || '').trim();
    const kwStr = (fd.get('keywords') as string || '').trim();

    if (!file || !name || !kwStr) {
      return Response.json({ error: '缺少必填字段（图片、名称、关键词）' }, { status: 400 });
    }

    // Determine extension
    const extMap: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
    const ext = extMap[file.type] || 'png';
    const filename = `${name}.${ext}`;

    // Read image bytes (already resized client-side)
    const imageBytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < imageBytes.length; i++) binary += String.fromCharCode(imageBytes[i]);
    const b64 = btoa(binary);

    // Read current stickers.json from GitHub
    const stickersRes = await gh(`contents/public/stickers/stickers.json`);
    if (!stickersRes.ok) {
      return Response.json({ error: '读取 stickers.json 失败: ' + (await stickersRes.text()) }, { status: 500 });
    }
    const stickersData = await stickersRes.json() as { content: string; sha: string };
    const stickers: { stickers: any[] } = JSON.parse(atob(stickersData.content));

    // Build new entry
    const keywords = kwStr.split(/[,，、\s]+/).filter(Boolean);
    const newSticker = {
      file: filename,
      name,
      desc: desc || undefined,
      keywords: [...new Set([name, ...keywords])],
      tags: keywords.slice(0, 5),
      ext,
    };

    // Generate URL (percent-encoded)
    const base = 'https://halcyon-mcp.pages.dev/stickers/';
    newSticker['url'] = base + encodeURIComponent(filename);

    stickers.stickers.push(newSticker);

    // Create blobs
    const imgBlob = await gh('git/blobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: b64, encoding: 'base64' }),
    });
    if (!imgBlob.ok) return Response.json({ error: '创建图片 blob 失败' }, { status: 500 });
    const imgBlobData = await imgBlob.json() as { sha: string };

    const stickersJsonStr = JSON.stringify(stickers, null, 2);
    const stickersB64 = btoa(stickersJsonStr);
    const stBlob = await gh('git/blobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: stickersB64, encoding: 'base64' }),
    });
    if (!stBlob.ok) return Response.json({ error: '创建 stickers.json blob 失败' }, { status: 500 });
    const stBlobData = await stBlob.json() as { sha: string };

    // Get latest commit
    const refRes = await gh('git/refs/heads/main');
    if (!refRes.ok) return Response.json({ error: '读取分支失败' }, { status: 500 });
    const refData = await refRes.json() as { object: { sha: string } };
    const latestSha = refData.object.sha;

    const commitRes = await gh(`git/commits/${latestSha}`);
    const commitData = await commitRes.json() as { tree: { sha: string } };
    const baseTreeSha = commitData.tree.sha;

    // Create tree
    const treeRes = await gh('git/trees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: [
          { path: `public/stickers/${filename}`, mode: '100644', type: 'blob', sha: imgBlobData.sha },
          { path: 'public/stickers/stickers.json', mode: '100644', type: 'blob', sha: stBlobData.sha },
        ],
      }),
    });
    if (!treeRes.ok) return Response.json({ error: '创建 tree 失败' }, { status: 500 });
    const treeData = await treeRes.json() as { sha: string };

    // Create commit
    const newCommit = await gh('git/commits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `add sticker: ${name}`,
        tree: treeData.sha,
        parents: [latestSha],
      }),
    });
    if (!newCommit.ok) return Response.json({ error: '创建 commit 失败' }, { status: 500 });
    const newCommitData = await newCommit.json() as { sha: string };

    // Update branch
    const updateRes = await gh('git/refs/heads/main', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: newCommitData.sha, force: false }),
    });
    if (!updateRes.ok) return Response.json({ error: '更新分支失败' }, { status: 500 });

    return Response.json({ ok: true, name, filename });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// ─── Pages Function Entry ─────────────────────────────────────────────────────

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);

  // All API endpoints require auth
  const auth = request.headers.get('Authorization');
  if (url.pathname.startsWith('/v1/') || url.pathname === '/mcp') {
    if (auth !== `Bearer ${env.MCP_API_KEY}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  if (url.pathname === '/v1/user/balance') {
    return await handleBalance(env);
  }

  if (url.pathname === '/v1/models') {
    return await handleModels(env);
  }

  if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
    return await handleProxy(request, env);
  }

  if (url.pathname === '/mcp' && request.method === 'POST') {
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

  // Admin page
  if (url.pathname === '/admin' && request.method === 'GET') {
    return new Response(adminPage(), {
      headers: { 'Content-Type': 'text/html;charset=utf-8' },
    });
  }

  // Upload sticker
  if (url.pathname === '/api/upload-sticker' && request.method === 'POST') {
    return await handleAdminUpload(request, env);
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
