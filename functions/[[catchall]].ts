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

async function getWakeConfig(db: D1Database) {
  const rows = await db.prepare("SELECT key, value FROM config WHERE key LIKE 'wake_%'").all();
  const cfg: Record<string, string> = {};
  for (const row of (rows.results || []) as { key: string; value: string }[]) {
    cfg[row.key] = row.value;
  }
  return {
    enabled: cfg.wake_enabled !== 'false',
    dayStart: parseInt(cfg.wake_day_start || '8'),
    dayEnd: parseInt(cfg.wake_day_end || '23'),
    idleDay: parseInt(cfg.wake_idle_day || '60'),
    idleNight: parseInt(cfg.wake_idle_night || '180'),
    cooldown: parseInt(cfg.wake_cooldown || '240') * 60000,
  };
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

function isDaytime(hour: number): boolean {
  return false; // placeholder — actual check in handleWakeUp
}

async function handleWakeUp(env: Env): Promise<string> {
  const [lastUser, lastWake, wc] = await Promise.all([getLastUserMsg(env.DB), getLastWake(env.DB), getWakeConfig(env.DB)]);
  if (!lastUser) return 'no_activity';
  if (!wc.enabled) return 'wake_disabled';

  const bjHour = (new Date().getUTCHours() + 8) % 24;
  const day = bjHour >= wc.dayStart && bjHour < wc.dayEnd;
  const idleThreshold = day ? wc.idleDay : wc.idleNight;

  const now = Date.now();
  const idleMs = now - new Date(lastUser.created_at + '+08:00').getTime();
  const idleMin = Math.floor(idleMs / 60000);
  if (idleMin < idleThreshold) return `active_${idleMin}min`;

  if (lastWake) {
    const wakeMs = now - new Date(lastWake.created_at + '+08:00').getTime();
    if (wakeMs < wc.cooldown) return 'recent_wake';
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

// ─── Settings / Push Log API ───────────────────────────────────────────────────

async function handleGetSettings(env: Env): Promise<Response> {
  const wc = await getWakeConfig(env.DB);
  return Response.json({
    wake_enabled: wc.enabled,
    wake_day_start: wc.dayStart,
    wake_day_end: wc.dayEnd,
    wake_idle_day: wc.idleDay,
    wake_idle_night: wc.idleNight,
    wake_cooldown: Math.floor(wc.cooldown / 60000),
  });
}

async function handleSaveSettings(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as Record<string, unknown>;
    const pairs: [string, string][] = [
      ['wake_enabled', String(body.wake_enabled ?? true)],
      ['wake_day_start', String(body.wake_day_start ?? 8)],
      ['wake_day_end', String(body.wake_day_end ?? 23)],
      ['wake_idle_day', String(body.wake_idle_day ?? 60)],
      ['wake_idle_night', String(body.wake_idle_night ?? 180)],
      ['wake_cooldown', String(body.wake_cooldown ?? 240)],
    ];
    const stmt = env.DB.prepare('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)');
    for (const [k, v] of pairs) {
      await stmt.bind(k, v, nowISO()).run();
    }
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

async function handleListPushLogs(env: Env): Promise<Response> {
  const rows = await env.DB.prepare('SELECT id, content, created_at FROM push_log ORDER BY id DESC LIMIT 50').all();
  return Response.json((rows.results || []) as { id: number; content: string; created_at: string }[]);
}

async function handleDeletePushLog(request: Request, env: Env): Promise<Response> {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ error: 'missing id' }, { status: 400 });
  await env.DB.prepare('DELETE FROM push_log WHERE id = ?').bind(parseInt(id)).run();
  return Response.json({ ok: true });
}

async function handleClearPushLogs(env: Env): Promise<Response> {
  await env.DB.prepare('DELETE FROM push_log').run();
  return Response.json({ ok: true });
}

// ─── Admin Page ────────────────────────────────────────────────────────────────

function adminPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>halcyon 管理</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f5f5f5;padding:20px;color:#333;max-width:560px;margin:0 auto}
.card{background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
h2{font-size:18px;margin-bottom:16px;display:flex;align-items:center;gap:6px}
label{display:block;font-size:14px;font-weight:600;margin:10px 0 4px}
.inline{display:flex;align-items:center;gap:8px}
.inline label{margin:0}
input,textarea,select{width:100%;padding:10px;font-size:16px;border:1px solid #ddd;border-radius:8px;outline:0}
input:focus,textarea:focus{border-color:#007aff}
input[type=number]{width:80px}
input[type=checkbox]{width:18px;height:18px}
textarea{height:60px;resize:vertical}
.btn{width:100%;padding:12px;font-size:15px;font-weight:600;color:#fff;background:#007aff;border:none;border-radius:8px;cursor:pointer;margin-top:12px}
.btn:disabled{opacity:.5}
.btn:hover:not(:disabled){background:#0056cc}
.btn-danger{background:#ff3b30}
.btn-danger:hover:not(:disabled){background:#cc2f26}
.btn-sm{padding:6px 12px;font-size:13px;width:auto;margin:0}
.msg{padding:10px;border-radius:8px;margin:10px 0;display:none;font-size:14px}
.msg.ok{background:#d4edda;color:#155724;display:block}
.msg.err{background:#f8d7da;color:#721c24;display:block}
.row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #eee;font-size:14px}
.row:last-child{border:none}
.row .time{color:#999;font-size:12px;flex-shrink:0;margin-right:8px}
.row .text{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0 8px}
.hint{font-size:12px;color:#999;margin-top:4px}
.preview{margin:12px 0;text-align:center;display:none}
.preview img{max-width:200px;max-height:200px;border-radius:8px;border:1px solid #eee}
.loading{text-align:center;color:#999;padding:20px}
</style>
</head>
<body>

<div class="card">
<h2>📳 推送设置</h2>
<div id="settingsMsg" class="msg"></div>
<form id="settingsForm">
<div class="inline">
  <input type="checkbox" id="wake_enabled" checked>
  <label for="wake_enabled">启用自动唤醒</label>
</div>
<label>白天时段</label>
<div class="inline">
  <input type="number" id="wake_day_start" min="0" max="23"> 点 —
  <input type="number" id="wake_day_end" min="0" max="23"> 点
</div>
<label>白天空闲阈值（分钟，不说话多久后允许唤醒）</label>
<input type="number" id="wake_idle_day" min="1" max="1440">
<label>夜间空闲阈值（分钟）</label>
<input type="number" id="wake_idle_night" min="1" max="1440">
<label>推送冷却（分钟，推完后多久内不再推）</label>
<input type="number" id="wake_cooldown" min="1" max="1440">
<div class="hint">cron-job.org 检查间隔建议设为 10 分钟</div>
<button type="submit" class="btn" id="settingsBtn">保存设置</button>
</form>
</div>

<div class="card">
<h2>📋 推送记录 <button class="btn-sm btn-danger" id="clearAllBtn" onclick="clearAll()">清空全部</button></h2>
<div id="pushLogsMsg" class="msg"></div>
<div id="pushLogsList"><div class="loading">加载中...</div></div>
</div>

<div class="card">
<h2>📋 表情包</h2>
<div id="stickerListMsg" class="msg"></div>
<div id="stickerList"><div class="loading">加载中...</div></div>
</div>

<div class="card">
<h2>📎 添加表情包</h2>
<div id="stickerMsg" class="msg"></div>
<form id="stickerForm">
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
<button type="submit" class="btn" id="stickerBtn">提交</button>
</form>
</div>

<script>
// ── Settings ──
let settingsLoaded = false;
fetch('/api/settings').then(r=>r.json()).then(d=>{
  document.getElementById('wake_enabled').checked = d.wake_enabled !== false;
  document.getElementById('wake_day_start').value = d.wake_day_start;
  document.getElementById('wake_day_end').value = d.wake_day_end;
  document.getElementById('wake_idle_day').value = d.wake_idle_day;
  document.getElementById('wake_idle_night').value = d.wake_idle_night;
  document.getElementById('wake_cooldown').value = d.wake_cooldown;
  settingsLoaded = true;
});

document.getElementById('settingsForm').onsubmit = async e => {
  e.preventDefault();
  if (!settingsLoaded) return;
  const btn = document.getElementById('settingsBtn');
  btn.disabled = true; btn.textContent = '保存中...';
  try {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        wake_enabled: document.getElementById('wake_enabled').checked,
        wake_day_start: parseInt(document.getElementById('wake_day_start').value),
        wake_day_end: parseInt(document.getElementById('wake_day_end').value),
        wake_idle_day: parseInt(document.getElementById('wake_idle_day').value),
        wake_idle_night: parseInt(document.getElementById('wake_idle_night').value),
        wake_cooldown: parseInt(document.getElementById('wake_cooldown').value),
      }),
    });
    const d = await r.json();
    showMsg('settingsMsg', d.ok ? '✅ 已保存' : '❌ '+d.error, d.ok ? 'ok' : 'err');
  } catch(e) { showMsg('settingsMsg', '❌ 网络错误', 'err'); }
  finally { btn.disabled = false; btn.textContent = '保存设置'; }
};

// ── Push Logs ──
function loadPushLogs() {
  fetch('/api/push-logs').then(r=>r.json()).then(rows => {
    const list = document.getElementById('pushLogsList');
    if (!rows.length) { list.innerHTML = '<div class="hint" style="text-align:center">暂无记录</div>'; return; }
    list.innerHTML = rows.map(r =>
      '<div class="row">' +
      '<span class="time">'+r.created_at.slice(5,16)+'</span>' +
      '<span class="text">'+esc(r.content.slice(0,50))+'</span>' +
      '<button class="btn-sm btn-danger" onclick="delLog('+r.id+')">删</button>' +
      '</div>'
    ).join('');
  }).catch(() => {
    document.getElementById('pushLogsList').innerHTML = '<div class="hint" style="text-align:center">加载失败</div>';
  });
}
loadPushLogs();

function delLog(id) {
  if (!confirm('删除这条推送记录？')) return;
  fetch('/api/push-log?id='+id, {method:'DELETE'}).then(r=>r.json()).then(d => {
    if (d.ok) loadPushLogs();
    else showMsg('pushLogsMsg', '❌ 删除失败', 'err');
  });
}

function clearAll() {
  if (!confirm('确定清空全部推送记录？此操作不可撤销。')) return;
  fetch('/api/push-logs', {method:'DELETE'}).then(r=>r.json()).then(d => {
    if (d.ok) { loadPushLogs(); showMsg('pushLogsMsg', '✅ 已清空', 'ok'); }
    else showMsg('pushLogsMsg', '❌ 清空失败', 'err');
  });
}

// ── Stickers ──
function loadStickers() {
  fetch('/api/stickers').then(r=>r.json()).then(list => {
    const el = document.getElementById('stickerList');
    if (!list.length) { el.innerHTML = '<div class="hint" style="text-align:center">暂无表情包</div>'; return; }
    el.innerHTML = list.map((s,i) =>
      '<div class="row">' +
      '<span style="flex-shrink:0;margin-right:8px;width:28px;height:28px;border-radius:4px;overflow:hidden;background:#eee">' +
      '<img src="'+(s.url||'')+'" style="width:28px;height:28px;object-fit:cover" onerror="this.style.display=\\'none\\'">' +
      '</span>' +
      '<span class="text">'+esc(s.name||s.file)+'</span>' +
      '<button class="btn-sm btn-danger" onclick="delSticker(\\''+esc(s.file)+'\\')">删</button>' +
      '</div>'
    ).join('');
  }).catch(() => {
    document.getElementById('stickerList').innerHTML = '<div class="hint" style="text-align:center">加载失败</div>';
  });
}
loadStickers();

function delSticker(file) {
  if (!confirm('删除这张表情包？注意：删除后需要等 Cloudflare Pages 重新部署才能生效。')) return;
  fetch('/api/sticker?file='+encodeURIComponent(file), {method:'DELETE'}).then(r=>r.json()).then(d => {
    if (d.ok) { loadStickers(); showMsg('stickerListMsg', '✅ 已删除，等待部署', 'ok'); }
    else showMsg('stickerListMsg', '❌ '+d.error, 'err');
  });
}

// ── Stickers Upload ──
const file=document.getElementById('file'),preview=document.getElementById('preview'),
previewImg=document.getElementById('previewImg');
file.onchange=()=>{
  const f=file.files[0];if(!f)return;
  const r=new FileReader();
  r.onload=e=>{previewImg.src=e.target.result;preview.style.display='block'};
  r.readAsDataURL(f);
};

document.getElementById('stickerForm').onsubmit=async e=>{
  e.preventDefault();
  const f=file.files[0],name=document.getElementById('name').value.trim(),
  kw=document.getElementById('keywords').value.trim();
  if(!f||!name||!kw){showMsg('stickerMsg','请填写完整','err');return}
  const btn=document.getElementById('stickerBtn');
  btn.disabled=true;btn.textContent='上传中...';
  const resized=await resizeImage(f,200);
  if(!resized){showMsg('stickerMsg','图片处理失败','err');btn.disabled=false;btn.textContent='提交';return}
  const fd=new FormData();
  fd.append('file',resized,f.name);
  fd.append('name',name);
  fd.append('desc',document.getElementById('desc').value.trim());
  fd.append('keywords',kw);
  try{
    const r=await fetch('/api/upload-sticker',{method:'POST',body:fd});
    const d=await r.json();
    if(r.ok){showMsg('stickerMsg','✅ 已提交！等待部署（约1分钟）','ok');document.getElementById('stickerForm').reset();preview.style.display='none'}
    else showMsg('stickerMsg','❌ '+d.error,'err');
  }catch(e){showMsg('stickerMsg','❌ 网络错误','err')}
  finally{btn.disabled=false;btn.textContent='提交'}
};

function resizeImage(file,maxW){
  return new Promise(res=>{
    const img=new Image();
    img.onload=()=>{
      let w=img.width,h=img.height;
      if(w>maxW){h=h*maxW/w;w=maxW}
      const c=document.createElement('canvas');
      c.width=w;c.height=h;
      c.getContext('2d').drawImage(img,0,0,w,h);
      c.toBlob(b=>res(b),file.type,0.85);
    };
    img.onerror=()=>res(null);
    img.src=URL.createObjectURL(file);
  });
}

function showMsg(id,t,type){
  const el=document.getElementById(id);
  el.textContent=t;el.className='msg '+type;el.style.display='block';
  setTimeout(()=>el.style.display='none',3000);
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
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

// ─── Sticker List / Delete ────────────────────────────────────────────────────

async function handleListStickers(env: Env): Promise<Response> {
  const ghToken = env.GITHUB_TOKEN;
  if (!ghToken) return Response.json({ error: 'GITHUB_TOKEN not configured' }, { status: 500 });
  const repo = env.GITHUB_REPO || 'gth4kvcv2t-cloud/halcyon-mcp';
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/public/stickers/stickers.json`, {
    headers: { Authorization: `Bearer ${ghToken}` },
  });
  if (!res.ok) return Response.json({ error: '读取 stickers.json 失败: ' + (await res.text()) }, { status: 500 });
  const data = await res.json() as { content: string; sha: string };
  const manifest = JSON.parse(atob(data.content));
  return Response.json(manifest.stickers || []);
}

async function handleDeleteSticker(request: Request, env: Env): Promise<Response> {
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
    const fileParam = new URL(request.url).searchParams.get('file');
    if (!fileParam) return Response.json({ error: '缺少 file 参数' }, { status: 400 });
    const filename = decodeURIComponent(fileParam);

    // Read stickers.json from GitHub
    const stickersRes = await gh(`contents/public/stickers/stickers.json`);
    if (!stickersRes.ok) {
      return Response.json({ error: '读取 stickers.json 失败: ' + (await stickersRes.text()) }, { status: 500 });
    }
    const stickersData = await stickersRes.json() as { content: string; sha: string };
    const manifest: { stickers: any[] } = JSON.parse(atob(stickersData.content));
    const oldLen = manifest.stickers.length;
    manifest.stickers = manifest.stickers.filter((s: any) => s.file !== filename);
    if (manifest.stickers.length === oldLen) {
      return Response.json({ error: `未找到表情包: ${filename}` }, { status: 404 });
    }

    // Create blob for updated stickers.json
    const stickersJsonStr = JSON.stringify(manifest, null, 2);
    const stickersB64 = btoa(stickersJsonStr);
    const stBlob = await gh('git/blobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: stickersB64, encoding: 'base64' }),
    });
    if (!stBlob.ok) return Response.json({ error: '创建 stickers.json blob 失败' }, { status: 500 });
    const stBlobData = await stBlob.json() as { sha: string };

    // Get latest commit and tree
    const refRes = await gh('git/refs/heads/main');
    if (!refRes.ok) return Response.json({ error: '读取分支失败' }, { status: 500 });
    const refData = await refRes.json() as { object: { sha: string } };
    const latestSha = refData.object.sha;

    const commitRes = await gh(`git/commits/${latestSha}`);
    const commitData = await commitRes.json() as { tree: { sha: string } };
    const baseTreeSha = commitData.tree.sha;

    // Create tree: include updated stickers.json, EXCLUDE the image file to delete it
    const treeRes = await gh('git/trees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: [
          { path: 'public/stickers/stickers.json', mode: '100644', type: 'blob', sha: stBlobData.sha },
        ],
      }),
    });
    if (!treeRes.ok) return Response.json({ error: '创建 tree 失败' }, { status: 500 });
    const treeData = await treeRes.json() as { sha: string };

    // Create commit
    const name = manifest.stickers.find(s => s.file === filename)?.name || filename;
    const newCommit = await gh('git/commits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `delete sticker: ${name}`,
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

    return Response.json({ ok: true, name });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// ─── Cookie Auth ──────────────────────────────────────────────────────────────

async function signSession(secret: string): Promise<string> {
  const exp = Date.now() + 86400000; // 24h
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const payload = btoa(JSON.stringify({ exp }));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
  const sigB64 = btoa(String.fromCharCode(...sig));
  return payload + '.' + sigB64;
}

async function verifySession(session: string, secret: string): Promise<boolean> {
  const parts = session.split('.');
  if (parts.length !== 2) return false;
  try {
    const payload = JSON.parse(atob(parts[0]));
    if (Date.now() > payload.exp) return false;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sig = new Uint8Array([...atob(parts[1])].map(c => c.charCodeAt(0)));
    return await crypto.subtle.verify('HMAC', key, sig, encoder.encode(parts[0]));
  } catch { return false; }
}

function getCookie(name: string, cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function loginPage(error?: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>halcyon 管理 - 登录</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#fff;border-radius:12px;padding:30px;max-width:360px;width:100%;box-shadow:0 2px 8px rgba(0,0,0,.1)}
h1{font-size:20px;margin-bottom:20px;text-align:center}
input{width:100%;padding:12px;font-size:16px;border:1px solid #ddd;border-radius:8px;outline:0;margin-bottom:12px}
input:focus{border-color:#007aff}
.btn{width:100%;padding:13px;font-size:16px;font-weight:600;color:#fff;background:#007aff;border:none;border-radius:8px;cursor:pointer}
.btn:hover{background:#0056cc}
.err{color:#ff3b30;font-size:14px;text-align:center;margin-bottom:12px}
</style>
</head>
<body>
<div class="card">
<h1>halcyon 管理</h1>
${error ? `<div class="err">${error}</div>` : ''}
<form method="post" action="/admin">
<input type="password" name="password" placeholder="请输入管理员密码" autofocus required>
<button type="submit" class="btn">登录</button>
</form>
</div>
</body>
</html>`;
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

  // Admin routes require cookie session
  const isAdminRoute = url.pathname === '/admin' || url.pathname === '/api/settings' || url.pathname === '/api/push-logs' || url.pathname === '/api/push-log' || url.pathname === '/api/stickers' || url.pathname === '/api/sticker' || url.pathname === '/api/upload-sticker';

  // Admin login
  if (url.pathname === '/admin' && request.method === 'POST') {
    try {
      const fd = await request.formData();
      const password = fd.get('password') as string;
      if (password !== env.MCP_API_KEY) {
        return new Response(loginPage('密码错误'), {
          status: 401,
          headers: { 'Content-Type': 'text/html;charset=utf-8' },
        });
      }
      const session = await signSession(env.MCP_API_KEY);
      return new Response(adminPage(), {
        headers: {
          'Content-Type': 'text/html;charset=utf-8',
          'Set-Cookie': `admin_session=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`,
        },
      });
    } catch {
      return new Response(loginPage('请求错误'), {
        status: 400,
        headers: { 'Content-Type': 'text/html;charset=utf-8' },
      });
    }
  }

  // Session check for admin routes
  if (isAdminRoute) {
    const cookie = getCookie('admin_session', request.headers.get('Cookie'));
    const valid = cookie ? await verifySession(cookie, env.MCP_API_KEY) : false;
    if (!valid) {
      if (url.pathname === '/admin') {
        return new Response(loginPage(), {
          headers: { 'Content-Type': 'text/html;charset=utf-8' },
        });
      }
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // Admin page
  if (url.pathname === '/admin' && request.method === 'GET') {
    return new Response(adminPage(), {
      headers: { 'Content-Type': 'text/html;charset=utf-8' },
    });
  }

  // Settings API
  if (url.pathname === '/api/settings') {
    if (request.method === 'GET') return await handleGetSettings(env);
    if (request.method === 'POST') return await handleSaveSettings(request, env);
  }

  // Push logs API
  if (url.pathname === '/api/push-logs') {
    if (request.method === 'GET') return await handleListPushLogs(env);
    if (request.method === 'DELETE') return await handleClearPushLogs(env);
  }
  if (url.pathname === '/api/push-log' && request.method === 'DELETE') {
    return await handleDeletePushLog(request, env);
  }

  // Upload sticker
  if (url.pathname === '/api/upload-sticker' && request.method === 'POST') {
    return await handleAdminUpload(request, env);
  }

  // Sticker list / delete
  if (url.pathname === '/api/stickers' && request.method === 'GET') {
    return await handleListStickers(env);
  }
  if (url.pathname === '/api/sticker' && request.method === 'DELETE') {
    return await handleDeleteSticker(request, env);
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
