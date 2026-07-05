/**
 * ha-mcp.js —— Home Assistant MCP 桥接
 * ------------------------------------
 * 以 MCP 客户端连接用户的 Home Assistant MCP server（Streamable HTTP），
 * 把一组精选工具转成 OpenAI function-calling 的 tools 格式，供对话模型
 * 控制智能家居（「关掉客厅的灯」「空调开到 26 度」…）。
 *
 * 配置（.env）：
 *   HA_MCP_URL    MCP server 地址（不设则整个功能关闭，纯语音问答仍可用）
 *   HA_MCP_TOOLS  逗号分隔的工具白名单，默认见 DEFAULT_TOOLS
 *                 （HA MCP 有 100+ 工具，全暴露会撑爆每次请求的 token，只放常用的）
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_TOOLS = [
  'ha_search', // 按名称/区域找设备 → entity_id
  'ha_get_overview', // 全屋概览（有哪些区域/设备）
  'ha_get_state', // 查实体状态
  'ha_get_entity', // 实体详情
  'ha_call_service', // 执行控制（开关灯、空调…）
  'ha_bulk_control', // 批量控制
];

const CALL_TIMEOUT_MS = 20000;
const RESULT_MAX_CHARS = 4000; // 工具结果截断，防止撑爆上下文

let client = null;
let openaiTools = []; // OpenAI chat.completions 的 tools 参数

export function haToolsForOpenAI() {
  return openaiTools;
}

export function haEnabled() {
  return client !== null && openaiTools.length > 0;
}

/** 启动时调用；连不上只警告不致命（语音助手退化为纯问答） */
export async function haConnect(url, toolAllowlist) {
  if (!url) {
    console.log('[ha] 未配置 HA_MCP_URL，智能家居控制关闭');
    return;
  }
  const allow = new Set(
    (toolAllowlist || '').split(',').map(s => s.trim()).filter(Boolean).length
      ? toolAllowlist.split(',').map(s => s.trim())
      : DEFAULT_TOOLS,
  );
  try {
    client = new Client({ name: 'stackchan-assistant', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const { tools } = await client.listTools();
    openaiTools = tools
      .filter(t => allow.has(t.name))
      .map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: (t.description || '').slice(0, 300), // 全量 16KB schema 每轮重发，拖慢 TTFT
          parameters: trimSchemaDescriptions(t.inputSchema ?? { type: 'object', properties: {} }),
        },
      }));
    console.log(
      `[ha] 已连接 Home Assistant MCP，启用工具: ${openaiTools.map(t => t.function.name).join(', ')}`,
    );
    await refreshCatalog(); // 预取设备清单，模型免搜索直达控制
  } catch (e) {
    client = null;
    openaiTools = [];
    console.warn('[ha] 连接 MCP 失败（智能家居控制不可用）:', e?.message || e);
  }
}

/** 递归截断 JSON Schema 里的长 description（MCP 工具的参数说明动辄几百字） */
function trimSchemaDescriptions(node) {
  if (Array.isArray(node)) return node.map(trimSchemaDescriptions);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] =
        k === 'description' && typeof v === 'string' && v.length > 200
          ? v.slice(0, 200) + '…'
          : trimSchemaDescriptions(v);
    }
    return out;
  }
  return node;
}

// ── 设备清单（写进系统提示词，让模型免搜索直接拿 entity_id）────────
// 域顺序 = 截断优先级：高价值域在前，light/switch 数量大放最后
const CATALOG_DOMAINS = [
  'climate', 'fan', 'cover', 'media_player', 'script', 'scene',
  'vacuum', 'humidifier', 'lock', 'light', 'switch',
];
const CATALOG_TTL_MS = 10 * 60 * 1000;
const CATALOG_MAX_CHARS = Number(process.env.HA_CATALOG_MAX_CHARS) || 16000;
// 指示灯/信号灯类条目没人语音控制，还会教模型拿它冒充主设备，一律不进清单
const JUNK_RE = /indicator_light|指示灯/i;
let catalogText = '';
let catalogAt = 0;
let catalogRefreshing = false;

/** 取当前设备清单文本（过期时后台刷新，先用旧的，不阻塞对话） */
export function haCatalog() {
  if (client && Date.now() - catalogAt > CATALOG_TTL_MS) {
    refreshCatalog().catch(() => {});
  }
  return catalogText;
}

async function refreshCatalog() {
  if (catalogRefreshing || !client) return;
  catalogRefreshing = true;
  try {
    const listDomain = async (domain, limit, filter) => {
      try {
        const res = await client.callTool(
          { name: 'ha_search', arguments: { domain_filter: domain, limit } },
          undefined,
          { timeout: CALL_TIMEOUT_MS },
        );
        const json = JSON.parse((res.content || []).map(c => (c.type === 'text' ? c.text : '')).join(''));
        let ents = (json.entities || []).filter(
          e => !JUNK_RE.test(`${e.entity_id} ${e.friendly_name || ''}`),
        );
        if (filter) ents = ents.filter(filter);
        if (!ents.length) return '';
        const lines = ents.map(e => {
          const area = e.area_name || e.area || '';
          return `${e.entity_id}=${(e.friendly_name || '').replace(/\s+/g, ' ').trim()}${area ? '@' + area : ''}`;
        });
        return `[${domain}]\n${lines.join('\n')}`; // 按域分组加标题，便于模型检索
      } catch {
        return '';
      }
    };
    // sensor 域实体太多不能全放，只收温湿度等语音高频项
    const SENSOR_RE = /(temp|therm|humid|co2|pm25|pm2_5|illumina|lux|温度|湿度|光照)/i;
    const parts = await Promise.all([
      ...CATALOG_DOMAINS.map(domain => listDomain(domain, 100)),
      listDomain('sensor', 300, e => SENSOR_RE.test(`${e.entity_id} ${e.friendly_name || ''}`)),
    ]);
    const all = parts.filter(Boolean).join('\n');
    if (all.length > CATALOG_MAX_CHARS) {
      const cut = all.lastIndexOf('\n', CATALOG_MAX_CHARS); // 按整行截断
      catalogText = all.slice(0, cut) + '\n…(设备过多已截断，其余用 ha_search 查)';
      console.warn(`[ha] 设备清单超预算被截断（${all.length}→${CATALOG_MAX_CHARS} 字符），排序靠后的域可能缺失`);
    } else {
      catalogText = all;
    }
    catalogAt = Date.now();
    const domains = (catalogText.match(/^\[\w+\]$/gm) || []).join(' ');
    console.log(`[ha] 设备清单已刷新（${catalogText ? catalogText.split('\n').length : 0} 行，含 ${domains}）`);
  } finally {
    catalogRefreshing = false;
  }
}

/** 列出 HA 里的所有 media_player（外部音箱播报的候选设备） */
export async function haListMediaPlayers() {
  if (!client) throw new Error('Home Assistant 未连接');
  const res = await client.callTool({
    name: 'ha_search',
    arguments: { domain_filter: 'media_player' },
  });
  const text = (res.content || []).map(c => (c.type === 'text' ? c.text : '')).join('');
  const json = JSON.parse(text); // ha_search 出参为 JSON 文本（实测）
  if (!json.success) throw new Error(json.error?.message || 'ha_search 失败');
  return (json.entities || []).map(e => ({
    entity_id: e.entity_id,
    name: e.friendly_name || e.entity_id,
    state: e.state,
  }));
}

/** 让指定 media_player 播放一个音频 URL */
export async function haPlayMedia(entityId, url) {
  if (!client) throw new Error('Home Assistant 未连接');
  const res = await client.callTool({
    name: 'ha_call_service',
    arguments: {
      domain: 'media_player',
      service: 'play_media',
      entity_id: entityId,
      data: { media_content_id: url, media_content_type: 'music' },
      wait: false, // 不等音箱拉流缓冲完成（默认 true 会把整轮对话拖住十几秒）
    },
  });
  const text = (res.content || []).map(c => (c.type === 'text' ? c.text : '')).join('');
  if (res.isError) throw new Error(`play_media 失败: ${text.slice(0, 200)}`);
  return text;
}

/** 暂停指定 media_player（小米音箱 repeat=all 会无限循环单曲，播完一遍要主动刹车） */
export async function haMediaPause(entityId) {
  if (!client) throw new Error('Home Assistant 未连接');
  await client.callTool({
    name: 'ha_call_service',
    arguments: { domain: 'media_player', service: 'media_pause', entity_id: entityId, wait: false },
  });
}

/** 恢复播放。实测小米音箱处于 paused 时收到 play_media 只换媒体不开播，必须补这一脚 */
export async function haMediaPlay(entityId) {
  if (!client) throw new Error('Home Assistant 未连接');
  await client.callTool({
    name: 'ha_call_service',
    arguments: { domain: 'media_player', service: 'media_play', entity_id: entityId, wait: false },
  });
}

/**
 * 读 media_player 播放进度（精准刹车用）。
 * 返回 { state, positionMs, durationMs, updatedAt }，字段拿不到时为 null。
 */
export async function haGetPlayback(entityId) {
  if (!client) throw new Error('Home Assistant 未连接');
  const res = await client.callTool({
    name: 'ha_get_state',
    arguments: {
      entity_id: entityId,
      fields: ['state', 'attributes'],
      attribute_keys: ['media_position', 'media_duration', 'media_position_updated_at'],
    },
  });
  const text = (res.content || []).map(c => (c.type === 'text' ? c.text : '')).join('');
  if (res.isError) throw new Error(`ha_get_state 失败: ${text.slice(0, 200)}`);
  const data = JSON.parse(text)?.data || {};
  const attrs = data.attributes || {};
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    state: data.state ?? null,
    positionMs: num(attrs.media_position) !== null ? attrs.media_position * 1000 : null,
    durationMs: num(attrs.media_duration) !== null ? attrs.media_duration * 1000 : null,
    updatedAt: attrs.media_position_updated_at ? Date.parse(attrs.media_position_updated_at) : null,
  };
}

/** 执行一次工具调用，返回给模型的文本结果（出错也返回文本，让模型能向用户解释） */
export async function haCallTool(name, args) {
  if (!client) {
    return 'Home Assistant 未连接';
  }
  if (name === 'ha_call_service') {
    // ★强制不等状态确认：云端设备（小米空调等）的状态回报可拖 8~10s，
    // 语音场景播报的是「已执行」，不需要等实测（模型自己会传 wait:true）
    args = { ...args, wait: false };
  }
  try {
    const res = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );
    const text = (res.content || [])
      .map(c => (c.type === 'text' ? c.text : `[${c.type}]`))
      .join('\n');
    const out = text || JSON.stringify(res);
    return out.length > RESULT_MAX_CHARS ? out.slice(0, RESULT_MAX_CHARS) + '…(截断)' : out;
  } catch (e) {
    return `工具调用失败: ${e?.message || e}`;
  }
}
