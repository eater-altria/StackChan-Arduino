/**
 * doubao.js —— 火山引擎豆包语音：流式语音识别(ASR, WebSocket) + 音频生成(TTS, HTTP)
 * -------------------------------------------------------------------------------
 * 依据文档：
 * - ASR：《豆包语音·流式语音识别WebSocket》，用「流式输入模式」
 *   wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream
 *   （整段音频发完后返回结果，准确率比双向流式高，适合本项目录完整句再上传的模式）
 * - TTS：《豆包语音·单向流式语音合成HTTP》 POST /api/v3/tts/unidirectional，
 *   Resource-Id=seed-tts-2.0，文本一次给、音频分块流式返回（实测首块 ~350ms），
 *   pcm(s16le)@24kHz **单声道**（曾用的 seed-audio /tts/create 是双声道且非流式，已弃用）。
 *   响应体 = 连续 JSON 对象流，音频在 data 字段（base64），结束块 code=20000000。
 *
 * 鉴权（两种，自动选择）：
 * - 新版控制台：单头 X-Api-Key（DOUBAO_API_KEY）
 * - 旧版控制台：APP ID + Access Token 双头（DOUBAO_APP_ID + DOUBAO_ACCESS_TOKEN）。
 *   坑：两个接口的旧版头名不同——ASR 用 X-Api-App-Key，TTS 用 X-Api-App-Id。
 * 注意：TTS 不传 speaker（音色ID）时是「纯文本生成」模式，text_prompt 会被当成
 * 描述性提示词而非逐字朗读——逐字 TTS 必须配置 DOUBAO_TTS_SPEAKER。
 */
import crypto from 'node:crypto';
import WebSocket from 'ws';

const ASR_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
const TTS_STREAM_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

const ASR_TIMEOUT_MS = 15000;
const ASR_CHUNK_BYTES = 6400; // 200ms @ 16kHz s16le（文档建议单包 100~200ms）

const cfg = {
  apiKey: '',
  appId: '',
  accessToken: '',
  asrResourceId: 'volc.bigasr.sauc.duration', // 流式识别 1.0 小时版；2.0 用 volc.seedasr.sauc.duration
  ttsResourceId: 'seed-tts-2.0', // 复刻音色用 seed-icl-2.0
  ttsSpeaker: '',
  ttsLoudness: 0, // loudness_rate [-50,100]，100=2倍音量
};

export function doubaoInit({ apiKey, appId, accessToken, asrResourceId, ttsResourceId, ttsSpeaker, ttsLoudness }) {
  cfg.apiKey = apiKey || '';
  cfg.appId = appId || '';
  cfg.accessToken = accessToken || '';
  if (asrResourceId) cfg.asrResourceId = asrResourceId;
  if (ttsResourceId) cfg.ttsResourceId = ttsResourceId;
  cfg.ttsSpeaker = ttsSpeaker || '';
  cfg.ttsLoudness = Math.max(-50, Math.min(100, Number(ttsLoudness) || 0));
}

export function doubaoConfigured() {
  return !!cfg.apiKey || !!(cfg.appId && cfg.accessToken);
}

// 旧版双头优先（两者都填时按旧版走）；注意 ASR 与 TTS 的旧版头名不同
function asrAuthHeaders() {
  if (cfg.appId && cfg.accessToken) {
    return { 'X-Api-App-Key': cfg.appId, 'X-Api-Access-Key': cfg.accessToken };
  }
  return { 'X-Api-Key': cfg.apiKey };
}

function ttsAuthHeaders() {
  if (cfg.appId && cfg.accessToken) {
    return { 'X-Api-App-Id': cfg.appId, 'X-Api-Access-Key': cfg.accessToken };
  }
  return { 'X-Api-Key': cfg.apiKey };
}

// ── ASR 二进制帧协议 ───────────────────────────────────────────────
// header 4B: [ver(4)|headerSize(4)] [msgType(4)|flags(4)] [serialization(4)|compression(4)] [reserved]
// 之后 4B 大端 payload size + payload。本实现不压缩（compression=0，服务端会以相同方式响应）。
const MSG_FULL_REQ = 0b0001;
const MSG_AUDIO = 0b0010;
const MSG_FULL_RESP = 0b1001;
const MSG_ERROR = 0b1111;
const FLAG_LAST = 0b0010; // 最后一包（负包，无 sequence）
const SER_JSON = 0b0001;
const SER_RAW = 0b0000;

function buildFrame(msgType, flags, serialization, payload) {
  const head = Buffer.from([0x11, (msgType << 4) | flags, serialization << 4, 0x00]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  return Buffer.concat([head, size, payload]);
}

/** 识别一段 PCM16LE @16kHz 单声道，返回文本（空串 = 没识别出内容） */
export function doubaoTranscribe(pcm, uid = 'stackchan') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ASR_URL, {
      headers: {
        ...asrAuthHeaders(),
        'X-Api-Resource-Id': cfg.asrResourceId,
        'X-Api-Request-Id': crypto.randomUUID(),
        'X-Api-Connect-Id': crypto.randomUUID(),
        'X-Api-Sequence': '-1',
      },
    });

    let settled = false;
    let text = '';
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* 已关闭 */ }
      err ? reject(err) : resolve(text.trim());
    };
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* 已关闭 */ }
      finish(new Error('豆包 ASR 超时'));
    }, ASR_TIMEOUT_MS);

    ws.on('open', () => {
      // 1) full client request：音频与识别参数（不指定 language → 默认中英文混合识别）
      const reqPayload = Buffer.from(JSON.stringify({
        user: { uid },
        audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
        request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true },
      }));
      ws.send(buildFrame(MSG_FULL_REQ, 0, SER_JSON, reqPayload));

      // 2) audio only request 分包发送，末包打 FLAG_LAST（负包）
      for (let off = 0; off < pcm.length; off += ASR_CHUNK_BYTES) {
        const end = Math.min(off + ASR_CHUNK_BYTES, pcm.length);
        const isLast = end >= pcm.length;
        ws.send(buildFrame(MSG_AUDIO, isLast ? FLAG_LAST : 0, SER_RAW, pcm.subarray(off, end)));
      }
    });

    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length < 8) return;
      const msgType = buf[1] >> 4;
      const flags = buf[1] & 0x0f;

      if (msgType === MSG_ERROR) {
        const code = buf.readUInt32BE(4);
        const msgSize = buf.readUInt32BE(8);
        const msg = buf.subarray(12, 12 + msgSize).toString('utf8');
        finish(new Error(`豆包 ASR 错误 ${code}: ${msg}`));
        return;
      }
      if (msgType !== MSG_FULL_RESP) return;

      let off = 4;
      if (flags & 0x01) off += 4; // 带 sequence number 时跳过 4 字节
      const size = buf.readUInt32BE(off);
      off += 4;
      try {
        const json = JSON.parse(buf.subarray(off, off + size).toString('utf8'));
        if (typeof json.result?.text === 'string') text = json.result.text;
      } catch { /* 中间包可能无有效 JSON，忽略 */ }
      if (flags & 0x02) finish(); // 末包标记 → 最终结果
    });

    ws.on('error', (e) => finish(new Error(`豆包 ASR 连接失败: ${e.message}`)));
    ws.on('close', () => finish(new Error('豆包 ASR 连接被关闭且未返回结果')));
  });
}

// ── TTS（单向流式）─────────────────────────────────────────────────
/**
 * 从累积的文本缓冲里切出完整的顶层 JSON 对象（响应流是连续 JSON 对象拼接）。
 * base64 音频里不含大括号，按括号深度扫描即可；返回 { objects, rest }。
 */
function extractJsonObjects(buf) {
  const objects = [];
  let depth = 0, start = -1, inStr = false, esc = false, consumed = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') { if (!depth) start = i; depth++; }
    else if (c === '}') {
      depth--;
      if (!depth && start >= 0) {
        try { objects.push(JSON.parse(buf.slice(start, i + 1))); } catch { /* 半截对象不该出现，忽略 */ }
        consumed = i + 1;
        start = -1;
      }
    }
  }
  return { objects, rest: buf.slice(consumed) };
}

/**
 * 流式合成：每拿到一块音频就回调 onChunk(Buffer)。
 * format='pcm'（默认，PCM16LE@24kHz 单声道，机器人用）或 'mp3'（HA 音箱播报用）。
 * 全部结束后 resolve；code 非 0/20000000 时 reject。
 */
export async function doubaoSynthesizeStream(text, onChunk, format = 'pcm') {
  const audioParams = { format, sample_rate: 24000 };
  if (cfg.ttsLoudness) audioParams.loudness_rate = cfg.ttsLoudness;

  const res = await fetch(TTS_STREAM_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...ttsAuthHeaders(),
      'X-Api-Resource-Id': cfg.ttsResourceId,
      'X-Api-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify({
      req_params: { text, speaker: cfg.ttsSpeaker, audio_params: audioParams },
    }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`豆包 TTS HTTP ${res.status} ${detail.slice(0, 200)}（logid=${res.headers.get('x-tt-logid') || '-'}）`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const { objects, rest } = extractJsonObjects(buf);
    buf = rest;
    for (const obj of objects) {
      if (obj.data) {
        onChunk(Buffer.from(obj.data, 'base64'));
      } else if (obj.code && obj.code !== 0 && obj.code !== 20000000) {
        reader.cancel().catch(() => {});
        throw new Error(`豆包 TTS 失败 code=${obj.code} ${obj.message || ''}（logid=${res.headers.get('x-tt-logid') || '-'}）`);
      }
      // data:null 的 sentence（时间戳）与结束块直接忽略
    }
  }
}

/** 整段合成（收集流式结果）——唤醒提示音/HA 播报等需要完整缓冲的场景用 */
export async function doubaoSynthesize(text, format = 'pcm') {
  const parts = [];
  await doubaoSynthesizeStream(text, chunk => parts.push(chunk), format);
  return Buffer.concat(parts);
}
