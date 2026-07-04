/**
 * StackChan 语音助手后端（配套 hardware-Arduino 固件）
 * ---------------------------------------------------
 * 链路：机器人 POST /chat（裸 PCM16 @16kHz 单声道）
 *   → 豆包流式语音识别（WebSocket，doubao.js）
 *   → OpenAI 对话模型生成回答（CHAT_MODEL，默认 gpt-5.4，按设备保留短对话历史，
 *     可调 Home Assistant MCP 工具控制智能家居）
 *   → 豆包音频生成 TTS（seed-audio-1.0，输出 PCM16 @24kHz 单声道）
 *   → 原样返回 PCM 字节，机器人用 M5.Speaker.playRaw 播放。
 *
 * 配置：同目录 .env（见 .env.example）。运行：npm install && npm start
 * 固件侧对应实现：hardware-Arduino/assistant.cpp
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import {
  haConnect,
  haEnabled,
  haToolsForOpenAI,
  haCallTool,
  haListMediaPlayers,
  haPlayMedia,
  haMediaPause,
  haMediaPlay,
  haCatalog,
} from './ha-mcp.js';
import { doubaoInit, doubaoTranscribe, doubaoSynthesize, doubaoSynthesizeStream } from './doubao.js';

// ── .env 加载（不覆盖已有环境变量，零依赖）─────────────────────────
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const CONFIG = {
  port: Number(process.env.PORT || 8300),
  apiKey: process.env.OPENAI_API_KEY || '',
  baseURL: process.env.OPENAI_BASE_URL || undefined, // 走代理/中转时设置
  chatModel: process.env.CHAT_MODEL || 'gpt-5.4-mini',
  // 推理力度。实测 gpt-5.4-mini 带工具时【默认档最快】（首字 ~590ms），
  // none 反而最慢（~1.4s）——留空 = 不传该参数，用默认档
  chatReasoningEffort: process.env.CHAT_REASONING_EFFORT || '',
  doubaoApiKey: process.env.DOUBAO_API_KEY || '',
  doubaoAppId: process.env.DOUBAO_APP_ID || '',           // 旧版控制台双凭据
  doubaoAccessToken: process.env.DOUBAO_ACCESS_TOKEN || '',
  doubaoAsrResourceId: process.env.DOUBAO_ASR_RESOURCE_ID || '', // 默认见 doubao.js
  doubaoTtsSpeaker: process.env.DOUBAO_TTS_SPEAKER || '',
  systemPrompt:
    process.env.SYSTEM_PROMPT ||
    '你是桌面机器人 StackChan，用中文口语回答，简短自然，一般不超过 80 字。' +
    '回答会被转成语音播报，不要使用列表、代码、表情符号等不适合朗读的格式。',
  haMcpUrl: process.env.HA_MCP_URL || '',
  haMcpTools: process.env.HA_MCP_TOOLS || '',
  promptText: process.env.PROMPT_TEXT || '我在听',
};

// 智能家居（Home Assistant MCP）启用时追加的指令
const HA_PROMPT =
  '你可以通过提供的工具控制用户家里的智能家居（Home Assistant）。' +
  '★优先直接从下方设备清单里取 entity_id 调 ha_call_service 执行，一步到位，' +
  '不要先调用搜索类工具确认——只有清单里找不到目标时才用 ha_search。' +
  '选实体时按设备类型对应的域取：空调=climate.、灯=light.、开关=switch.、窗帘=cover.，' +
  '不要拿同名的指示灯/子开关实体代替主实体。禁止编造 entity_id（如 climate.unknown）。' +
  '示例：用户说「书房空调24度」→ 在清单 [climate] 段找到名字含「书房空调」的条目，' +
  '直接调 ha_call_service {domain:"climate", service:"set_temperature", ' +
  'entity_id:"<清单中的id>", data:{"temperature":24}}，一步完成。' +
  '脚本/场景也在清单里（script./scene. 开头），用 script.turn_on / scene.turn_on 触发；' +
  '用户说"工作模式""派对模式"这类词时优先考虑是不是在叫某个脚本或场景。' +
  '执行完动作用一句话确认结果即可，不要念出 entity_id 这类技术标识。';

function systemPrompt() {
  if (!haEnabled()) return CONFIG.systemPrompt;
  const catalog = haCatalog();
  return (
    CONFIG.systemPrompt +
    HA_PROMPT +
    (catalog ? `\n\n家中设备清单（entity_id=名称@区域）：\n${catalog}` : '')
  );
}

if (!CONFIG.apiKey) {
  console.error('缺少 OPENAI_API_KEY（对话模型用）：复制 .env.example 为 .env 并填入密钥');
  process.exit(1);
}
if (!CONFIG.doubaoApiKey && !(CONFIG.doubaoAppId && CONFIG.doubaoAccessToken)) {
  console.error('缺少豆包凭据（语音识别/合成用），二选一填入 .env：');
  console.error('  新版控制台：DOUBAO_API_KEY（控制台 > API Key管理）');
  console.error('  旧版控制台：DOUBAO_APP_ID + DOUBAO_ACCESS_TOKEN（控制台应用管理的 APP ID 和 Access Token）');
  process.exit(1);
}
if (!CONFIG.doubaoTtsSpeaker) {
  console.warn('[tts] 未配置 DOUBAO_TTS_SPEAKER（音色ID）——不传 speaker 时豆包按「纯文本生成」' +
    '模式把文本当提示词，可能不是逐字朗读。请到火山引擎控制台音色列表选一个填入 .env');
}

const openai = new OpenAI({ apiKey: CONFIG.apiKey, baseURL: CONFIG.baseURL });
doubaoInit({
  apiKey: CONFIG.doubaoApiKey,
  appId: CONFIG.doubaoAppId,
  accessToken: CONFIG.doubaoAccessToken,
  asrResourceId: CONFIG.doubaoAsrResourceId,
  ttsResourceId: process.env.DOUBAO_TTS_RESOURCE_ID, // 默认 seed-tts-2.0，复刻音色用 seed-icl-2.0
  ttsSpeaker: CONFIG.doubaoTtsSpeaker,
  ttsLoudness: process.env.DOUBAO_TTS_LOUDNESS,
});

// 每台设备（按 X-Device-Id）保留最近几轮对话，重启即清空
const MAX_HISTORY_MESSAGES = 8;
const histories = new Map();
let promptAudioCache = null; // 唤醒提示音 PCM（懒生成）

// ── 播报输出配置（App 里选择，持久化到文件）──────────────────────
// mode: 'robot' = 机器人本体扬声器；'ha' = 推给 HA 的 media_player
const OUTPUT_CONFIG_FILE = path.join(ROOT, 'output-config.json');
let outputConfig = { mode: 'robot', entityId: '', name: '' };
try {
  outputConfig = { ...outputConfig, ...JSON.parse(fs.readFileSync(OUTPUT_CONFIG_FILE, 'utf8')) };
} catch { /* 首次运行没有配置文件 */ }
function saveOutputConfig() {
  fs.writeFileSync(OUTPUT_CONFIG_FILE, JSON.stringify(outputConfig, null, 2));
}

// ── HA 播报的音频托管（内存，10 分钟过期）────────────────────────
const hostedAudio = new Map(); // id → { buf, mime, ts }
function hostAudio(buf, mime = 'audio/wav') {
  const now = Date.now();
  for (const [id, a] of hostedAudio) {
    if (now - a.ts > 10 * 60 * 1000) hostedAudio.delete(id);
  }
  const id = crypto.randomUUID();
  hostedAudio.set(id, { buf, mime, ts: now });
  return id;
}

/** 裸 PCM16 单声道 → WAV（时长可精确计算，音箱兼容性也好） */
function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// ── 推送到音箱 + 定时刹车 ─────────────────────────────────────────
// 实测（小米音箱）：repeat=all 且不支持 repeat_set/announce → 单曲无限循环。
// 对策：①WAV 尾部拼 SILENCE_PAD_MS 静音——循环重播的开头是无声区；
//      ②在「语音时长 + PAUSE_AFTER_MS」定时 media_pause。只要音箱拉流延迟
//      不超过 PAUSE_AFTER_MS，暂停必然切在静音里，用户听到的永远是完整一遍。
//      （曾只留 2.5s 余量：正片播完循环立刻重启，暂停切在第二遍中间）
const SILENCE_PAD_MS = 6000;
const PAUSE_AFTER_MS = 3000;
const speakerTimers = new Map(); // entityId → timeout
// 音箱是否处于「被我们防循环暂停」的状态。小米云把每次 URL 推送视作同一个媒体位，
// 在这个 paused 状态下 play_media 会被整个无视（回答推到了却不出声）——
// 必须先 media_play 唤醒（暂停点落在静音垫里，唤醒是无声的）再替换。
// 默认 true：server 重启后状态未知，按最坏情况走唤醒路径（若实际停在用户自己的
// 音乐上，代价只是那音乐闪 0.5s，远好于回答无声）。
const speakerPausedByUs = new Map(); // entityId → bool
const pausedByUs = entityId => speakerPausedByUs.get(entityId) ?? true;

/** PCM 尾部拼静音后包成 WAV（配合定时暂停消除循环重播） */
function wavWithSilencePad(pcm) {
  const pad = Buffer.alloc(Math.round((TTS_SAMPLE_RATE * 2 * SILENCE_PAD_MS) / 1000));
  return pcmToWav(Buffer.concat([pcm, pad]), TTS_SAMPLE_RATE);
}

function pushToSpeaker(entityId, url, speechMs, tag) {
  clearTimeout(speakerTimers.get(entityId));
  const needWake = pausedByUs(entityId);
  (async () => {
    if (needWake) {
      // 先唤醒再替换（顺序不能反！paused 时 play_media 会被小米云无视）。
      // 上次暂停点必然落在 6s 静音垫内，这 0.5s 的恢复播放是无声的
      await haMediaPlay(entityId);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await haPlayMedia(entityId, url); // playing 状态下替换媒体，实测可靠
    speakerPausedByUs.set(entityId, false);
  })().catch(e => console.error(`[${tag}] 推送音箱失败:`, e?.message || e));
  speakerTimers.set(
    entityId,
    setTimeout(() => {
      haMediaPause(entityId)
        .then(() => speakerPausedByUs.set(entityId, true))
        .catch(e => console.error(`[${tag}] 定时暂停失败:`, e?.message || e));
    }, speechMs + PAUSE_AFTER_MS + (needWake ? 500 : 0)),
  );
}
function lanIP() {
  if (process.env.AUDIO_BASE_URL) return null; // 用户显式指定了基地址
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}
function audioBaseUrl() {
  return process.env.AUDIO_BASE_URL || `http://${lanIP()}:${CONFIG.port}`;
}

const REC_SAMPLE_RATE = 16000; // 机器人录音采样率（固件约定）
const TTS_SAMPLE_RATE = 24000; // OpenAI TTS pcm 输出固定 24kHz 单声道

// ── 工具 ───────────────────────────────────────────────────────────
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error(`请求体超过 ${limitBytes} 字节`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const b64 = s => Buffer.from(s, 'utf8').toString('base64');

/** 把 chatStream 的 trace 拼成一行可读计时（LLM#1 800ms(首字600ms) → ha_call_service 300ms → …） */
const fmtTrace = trace =>
  trace
    .map(t =>
      t.kind === 'llm'
        ? `${t.label} ${t.ms}ms${t.firstDeltaMs ? `(首字${t.firstDeltaMs}ms)` : ''}`
        : `${t.label} ${t.ms}ms`,
    )
    .join(' → ');

// ── 三段流水线 ─────────────────────────────────────────────────────
async function transcribe(pcm, deviceId) {
  // 豆包流式识别（不指定 language → 中英文混合识别，doubao.js 里已开 ITN + 标点）
  const text = await doubaoTranscribe(pcm, deviceId);
  // 噪音防线：环境噪音偶尔也会被识别出无意义短句。
  // 默认要求结果含中文，否则按「没听清」处理（说英文的场景设 STT_ALLOW_NON_CHINESE=1 关闭）。
  if (text && !/[一-鿿]/.test(text) && !process.env.STT_ALLOW_NON_CHINESE) {
    console.warn(`[stt] 无中文字符，疑似噪音误识别，忽略: "${text}"`);
    return '';
  }
  return text;
}

const MAX_TOOL_ROUNDS = 6; // 单次对话最多几轮工具调用（查找→控制→确认足够了）

/**
 * 流式对话（Responses API）：文本增量实时回调 onText（供按句 TTS），工具轮照常执行。
 * 用 Responses API 而非 chat/completions——gpt-5.4-mini 在后者上不允许
 * 「工具 + reasoning_effort」同时使用，而 reasoning effort=none 是延迟优化的关键。
 * trace（可选数组）会被填入各轮 LLM / 各工具的耗时，供调用方打计时日志。
 * 返回完整回答文本（已写入该设备的对话历史）。
 */
async function chatStream(deviceId, userText, onText, trace = []) {
  const history = histories.get(deviceId) || [];
  // 工具调用的中间条目只留在本次请求里，不进长期历史（省 token）
  const input = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText },
  ];
  // Responses API 的工具描述是平铺格式（没有 function 包一层）
  const tools = haEnabled()
    ? haToolsForOpenAI().map(t => ({
        type: 'function',
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }))
    : undefined;

  let reply = '';
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const tRound = Date.now();
    let firstDeltaMs = 0;
    const stream = await openai.responses.create({
      model: CONFIG.chatModel,
      instructions: systemPrompt(),
      input,
      stream: true,
      ...(CONFIG.chatReasoningEffort ? { reasoning: { effort: CONFIG.chatReasoningEffort } } : {}),
      ...(tools ? { tools } : {}),
    });

    let completed = null;
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        if (!firstDeltaMs) firstDeltaMs = Date.now() - tRound;
        reply += event.delta;
        onText(event.delta); // 边生成边送出去切句合成
      } else if (event.type === 'response.completed') {
        completed = event.response;
      }
    }

    const calls = (completed?.output || []).filter(item => item.type === 'function_call');
    trace.push({
      kind: 'llm',
      label: `LLM#${round + 1}${calls.length ? `(发起${calls.length}个工具)` : '(回答)'}`,
      ms: Date.now() - tRound,
      firstDeltaMs,
    });
    if (!calls.length) break; // 没有工具调用 → 回答已全部流出

    input.push(...(completed?.output || [])); // 原样带回本轮输出（含 function_call 项）
    const outputs = await Promise.all(
      calls.map(async fc => {
        let args = {};
        try {
          args = JSON.parse(fc.arguments || '{}');
        } catch {
          /* 参数非法就传空对象，让工具报错给模型 */
        }
        const tTool = Date.now();
        const out = await haCallTool(fc.name, args);
        const ms = Date.now() - tTool;
        trace.push({ kind: 'tool', label: fc.name, ms });
        console.log(`[${deviceId}] 家居工具 ${fc.name} ${fc.arguments} → ${ms}ms`);
        return { type: 'function_call_output', call_id: fc.call_id, output: out };
      }),
    );
    input.push(...outputs); // 下一轮（模型看到工具结果继续说）
  }
  reply = reply.trim();
  if (!reply) {
    reply = '抱歉，这个操作没能完成，请再试一次。';
    onText(reply); // 兜底文案也要播出来
  }
  history.push({ role: 'user', content: userText }, { role: 'assistant', content: reply });
  histories.set(deviceId, history.slice(-MAX_HISTORY_MESSAGES));
  return reply;
}

/** 把流式文本切成可送 TTS 的句子：句末标点立刻切；超长子句在逗号处提前切 */
function makeSentenceSplitter(emit) {
  let buf = '';
  const findSplit = s => {
    for (let i = 0; i < s.length; i++) {
      if ('。！？!?…\n'.includes(s[i])) return i;
      if (i >= 40 && '，,；;、'.includes(s[i])) return i;
    }
    return -1;
  };
  return {
    feed(piece) {
      buf += piece;
      let idx;
      while ((idx = findSplit(buf)) >= 0) {
        const s = buf.slice(0, idx + 1).trim();
        buf = buf.slice(idx + 1);
        if (s.replace(/[。！？!?…，,；;、\s]/g, '').length) emit(s);
      }
    },
    flush() {
      const s = buf.trim();
      buf = '';
      if (s.replace(/[。！？!?…，,；;、\s]/g, '').length) emit(s);
    },
  };
}

async function synthesize(text) {
  // 豆包单向流式 TTS（seed-tts-2.0）收集成完整缓冲，pcm(s16le)@24kHz 单声道
  return doubaoSynthesize(text);
}

// ── HTTP 服务 ──────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, chatModel: CONFIG.chatModel, homeAssistant: haEnabled() }));
    return;
  }

  // 调试：查看当前注入提示词的设备清单
  if (req.method === 'GET' && req.url === '/catalog') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(haCatalog() || '(清单为空)');
    return;
  }

  // ── 播报设备管理（手机 App 直接调用，与机器人无关）──────────────
  if (req.method === 'GET' && req.url === '/speakers') {
    try {
      const speakers = haEnabled() ? await haListMediaPlayers() : [];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ current: outputConfig, speakers }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/output') {
    try {
      const body = JSON.parse((await readBody(req, 4096)).toString('utf8'));
      if (body.mode === 'ha' && !body.entityId) throw new Error('缺少 entityId');
      outputConfig = {
        mode: body.mode === 'ha' ? 'ha' : 'robot',
        entityId: body.entityId || '',
        name: body.name || '',
      };
      saveOutputConfig();
      console.log(`[output] 播报输出 → ${outputConfig.mode === 'ha' ? `${outputConfig.name}(${outputConfig.entityId})` : '机器人本体'}`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, current: outputConfig }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
    return;
  }

  // HA 播报音频托管（media_player 从这里拉流）
  if (req.method === 'GET' && req.url?.startsWith('/audio/')) {
    const id = req.url.slice('/audio/'.length).replace(/\.(mp3|wav)$/, '');
    const a = hostedAudio.get(id);
    if (!a) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': a.mime, 'Content-Length': a.buf.length });
    res.end(a.buf);
    return;
  }

  // 唤醒提示音走外部音箱：机器人唤醒后调用；App 里选了音箱则推给音箱并告知
  // 机器人跳过本地播放（{"remote":true}），否则机器人播本地缓存
  if (req.method === 'POST' && req.url === '/prompt/play') {
    const tp = Date.now();
    try {
      if (outputConfig.mode === 'ha' && outputConfig.entityId && haEnabled()) {
        if (!promptAudioCache) {
          promptAudioCache = await synthesize(CONFIG.promptText);
        }
        const url = `${audioBaseUrl()}/audio/${hostAudio(wavWithSilencePad(promptAudioCache))}.wav`;
        const durMs = Math.round((promptAudioCache.length / 2 / TTS_SAMPLE_RATE) * 1000);
        pushToSpeaker(outputConfig.entityId, url, durMs, 'prompt');
        console.log(`[prompt] 计时 提示音推送发起 ${Date.now() - tp}ms（音箱拉流出声另需~1s）`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"remote":true}');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"remote":false}');
      }
    } catch (e) {
      console.error('[prompt] 推送音箱失败:', e?.message || e);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"remote":false}'); // 出错让机器人回退本地提示音
    }
    return;
  }

  // 唤醒提示音（「我在听」）：首次请求时 TTS 一次，之后直接回内存缓存。
  // 机器人开机后预取并缓存在 PSRAM，每次唤醒即刻播放。
  if (req.method === 'GET' && req.url === '/prompt') {
    try {
      if (!promptAudioCache) {
        promptAudioCache = await synthesize(CONFIG.promptText);
        console.log(`[prompt] 已生成提示音「${CONFIG.promptText}」 ` +
          `${(promptAudioCache.length / 2 / TTS_SAMPLE_RATE).toFixed(1)}s（speaker=${CONFIG.doubaoTtsSpeaker || '未配置'}）`);
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': promptAudioCache.length,
        'X-Sample-Rate': String(TTS_SAMPLE_RATE),
      });
      res.end(promptAudioCache);
    } catch (e) {
      console.error('[prompt] 生成失败:', e?.message || e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/chat') {
    const t0 = Date.now();
    const deviceId = String(req.headers['x-device-id'] || 'default');
    try {
      const pcm = await readBody(req, 4 * 1024 * 1024);
      if (pcm.length < REC_SAMPLE_RATE) {
        // 不足 0.5 秒的音频当无效输入
        throw new Error(`录音太短（${pcm.length} 字节）`);
      }
      console.log(`[${deviceId}] 收到录音 ${(pcm.length / 2 / REC_SAMPLE_RATE).toFixed(1)}s`);

      const transcript = await transcribe(pcm, deviceId);
      const t1 = Date.now();
      console.log(`[${deviceId}] 听到: ${transcript || '(空)'} (${t1 - t0}ms)`);

      // ── 外部音箱播报分支：整段回答 → WAV → 托管 → 推给 HA media_player ──
      if (outputConfig.mode === 'ha' && outputConfig.entityId && haEnabled()) {
        const trace = [];
        const tChat = Date.now();
        const reply = transcript
          ? await chatStream(deviceId, transcript, () => {}, trace)
          : '我没有听清，请再说一遍。';
        const chatMs = Date.now() - tChat;
        const tTts = Date.now();
        const pcmOut = await doubaoSynthesize(reply); // pcm → 时长可精确计算
        const ttsMs = Date.now() - tTts;
        const durMs = Math.round((pcmOut.length / 2 / TTS_SAMPLE_RATE) * 1000);
        const url = `${audioBaseUrl()}/audio/${hostAudio(wavWithSilencePad(pcmOut))}.wav`;
        const tPush = Date.now();
        // 即发即走：不等音箱开始播放就先放机器人回 idle；播完一遍定时刹车防循环
        pushToSpeaker(outputConfig.entityId, url, durMs, deviceId);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': 0,
          'X-Playback': 'remote', // 机器人看到这个标记就不本地播放
          'X-Transcript-B64': b64(transcript),
        });
        res.end();
        console.log(
          `[${deviceId}] 回答: ${reply}\n` +
            `[${deviceId}] 已推送到 ${outputConfig.name || outputConfig.entityId}（${(durMs / 1000).toFixed(1)}s wav）\n` +
            `[${deviceId}] 计时 STT ${t1 - t0}ms → [${fmtTrace(trace) || '无LLM'}] 共${chatMs}ms → TTS ${ttsMs}ms → 发起推送 ${Date.now() - tPush}ms → server合计 ${Date.now() - t0}ms（音箱拉流出声另需~1s）`,
        );
        return;
      }

      // ★裸流响应（Connection: close，不用 chunked）——固件 getStreamPtr() 读的是
      // 原始 TCP 字节，chunked 的分块长度行会被当成 PCM 播出「哒哒」声
      res.useChunkedEncodingByDefault = false;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'X-Sample-Rate': String(TTS_SAMPLE_RATE),
        'X-Transcript-B64': b64(transcript),
        Connection: 'close',
      });

      // LLM 流式输出 → 切句 → 按句 TTS（串行链保证音频顺序）→ 直写响应
      let audioBytes = 0;
      let firstAudioMs = 0;   // 距 STT 完成（t1）
      let firstSentMs = 0;    // 首句成句时刻（距 t1）
      let ttsMsTotal = 0;
      let ttsChain = Promise.resolve();
      const speak = sentence => {
        if (!firstSentMs) firstSentMs = Date.now() - t1;
        ttsChain = ttsChain
          .then(async () => {
            const tTts = Date.now();
            await doubaoSynthesizeStream(sentence, chunk => {
              if (!firstAudioMs) firstAudioMs = Date.now() - t1;
              audioBytes += chunk.length;
              res.write(chunk);
            });
            ttsMsTotal += Date.now() - tTts;
          })
          .catch(e => console.error(`[${deviceId}] 单句合成失败:`, e?.message || e));
      };
      const splitter = makeSentenceSplitter(speak);

      const trace = [];
      let reply;
      if (transcript) {
        reply = await chatStream(deviceId, transcript, piece => splitter.feed(piece), trace);
      } else {
        reply = '我没有听清，请再说一遍。';
        splitter.feed(reply);
      }
      splitter.flush();
      await ttsChain; // 等最后一句的音频写完
      res.end();

      const t3 = Date.now();
      console.log(
        `[${deviceId}] 回答: ${reply}\n` +
          `[${deviceId}] 语音 ${(audioBytes / 2 / TTS_SAMPLE_RATE).toFixed(1)}s\n` +
          `[${deviceId}] 计时 STT ${t1 - t0}ms → [${fmtTrace(trace) || '无LLM'}] → ` +
          `首句成句 +${firstSentMs}ms → 首块音频下发 +${firstAudioMs}ms（均距STT完成） → ` +
          `TTS合成累计 ${ttsMsTotal}ms → server合计 ${t3 - t0}ms`,
      );
    } catch (e) {
      console.error(`[${deviceId}] 出错:`, e?.message || e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e?.message || e) }));
      } else {
        res.end(); // 头已发出（TTS 中途失败），只能截断流，机器人侧按短音频丢弃
      }
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

await haConnect(CONFIG.haMcpUrl, CONFIG.haMcpTools); // 失败不致命，退化为纯问答

server.listen(CONFIG.port, () => {
  console.log(`StackChan assistant-server 监听 :${CONFIG.port}`);
  console.log(`模型: STT=豆包流式识别  CHAT=${CONFIG.chatModel}  TTS=豆包流式合成seed-tts-2.0(${CONFIG.doubaoTtsSpeaker || '未配置音色!'})`);
  console.log('手机 App 里把服务器地址设为 http://<本机局域网IP>:' + CONFIG.port);
});
