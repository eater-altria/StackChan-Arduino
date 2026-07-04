# assistant-server — StackChan 语音助手后端（Node.js）

跑在**电脑**上的小型后端，配套 `hardware-Arduino/` 固件的语音助手功能：

```
机器人（唤醒→点头→录音 PCM16@16k）
   │ HTTP POST /chat（局域网明文）
   ▼
assistant-server（本项目）
   ├─ 豆包流式语音识别（火山引擎 WebSocket，流式输入模式，doubao.js）
   ├─ OpenAI 对话模型**流式**生成（Responses API；CHAT_MODEL 默认 gpt-5.4-mini
   │   低延迟版，要更高质量换 gpt-5.4；按设备保留最近 4 轮历史）
   └─ **按句送**豆包单向流式 TTS（seed-tts-2.0，句末标点即切、长句逗号提前切）
   │ 响应体 = 裸 PCM 流（Connection: close，不用 chunked——
   │          chunked 分块头会被固件当 PCM 播出哒哒声）
   ▼
机器人边下边播（M5.Speaker 三缓冲轮转 playRaw，句间空档提前刷出已有数据）
```

## 运行

```bash
cd assistant-server
npm install
cp .env.example .env   # 填入 OPENAI_API_KEY + DOUBAO_API_KEY + DOUBAO_TTS_SPEAKER
npm start
# → StackChan assistant-server 监听 :8300
```

豆包侧配置（火山引擎）：
- `DOUBAO_API_KEY`：控制台 > API Key管理（新版控制台单头鉴权）；
- `DOUBAO_TTS_SPEAKER`：**必填**，豆包语音合成模型 2.0 的音色 ID——不传 speaker 时
  `seed-audio-1.0` 按「纯文本生成」模式把文本当**提示词**而非逐字朗读；
- `DOUBAO_ASR_RESOURCE_ID`：默认 `volc.bigasr.sauc.duration`（流式识别 1.0 小时版），
  开通的是 2.0 就换 `volc.seedasr.sauc.duration`；
- `DOUBAO_TTS_RESOURCE_ID`：默认 `seed-tts-2.0`（语音合成大模型 2.0，需在控制台开通），
  用声音复刻音色换 `seed-icl-2.0`。

然后在**手机 App**（app-RN）连上机器人后，把「语音助手服务器」设为
`http://<电脑局域网IP>:8300`（Mac 查 IP：`ipconfig getifaddr en0`）。
电脑和机器人必须在**同一局域网**。

## 接口

- `GET /health` → `{ok:true, chatModel, homeAssistant}`：连通性检查。
- `GET /prompt`：唤醒提示音（`PROMPT_TEXT`，默认「我在听」）的 TTS 音频，
  首次请求生成后内存缓存；机器人开机预取、每次唤醒即刻播放。响应格式同 `/chat`。
- `POST /chat`：请求体为裸 PCM16LE @16kHz 单声道（≥0.5s，上限 4MB），
  请求头 `X-Device-Id` 区分设备（对话历史按它隔离）。
  响应 200 为 **chunked 流式** PCM16LE 音频（TTS 边合成边转发），头部
  `X-Sample-Rate: 24000`、`X-Transcript-B64`/`X-Reply-B64`（base64 识别文本与回答）；
  合成前失败返回 JSON `{error}`，流中途失败则直接截断（机器人按短音频丢弃）。

## 外部音箱播报（HA media_player，可选）

机器人本体（ESP32-S3）没有经典蓝牙，无法直连蓝牙音箱；播报改走 **Home Assistant
的 media_player**：整段回答合成 **WAV**（时长可精确计算）→ 本机托管
（`/audio/<id>.wav`，10 分钟过期）→ `media_player.play_media` 推给所选音箱 →
**按「音频时长 + 2.5s」定时发 `media_pause`**（实测小米音箱 repeat=all 且不支持
repeat_set/announce，单曲会无限循环，必须主动刹车）；机器人收到
`X-Playback: remote` 头即不本地播放。唤醒提示音「我在听」同样走音箱：机器人
唤醒后 `POST /prompt/play`，server 按当前输出配置决定推音箱（回 `remote:true`）
还是让机器人播本地缓存。

- `GET /speakers`：列出 HA 里的 media_player + 当前播报输出；
- `POST /output`：`{mode:'robot'}` 或 `{mode:'ha', entityId, name}`，持久化到
  `output-config.json`；
- `POST /prompt/play`：机器人唤醒时调用（见上）；
- 手机 App 的「播报设备」卡片就是调这些接口（手机与 server 需同一局域网）；
- 音频 URL 用本机局域网 IP 拼出，多网卡选错时用 `AUDIO_BASE_URL` 覆盖。

## 智能家居（Home Assistant MCP，可选）

`.env` 里配置 `HA_MCP_URL`（Home Assistant MCP 的 Streamable HTTP 地址）后，
server 会以 MCP 客户端连上它，把一组精选工具（`ha-mcp.js` 里的白名单，可用
`HA_MCP_TOOLS` 覆盖）暴露给对话模型做 function calling——对机器人说
「关掉客厅的灯」「空调开到 26 度」即可控制全屋设备。

- 模型会先用 `ha_search`/`ha_get_overview` 找到设备，再 `ha_call_service` 执行，
  单轮对话最多 6 轮工具调用；
- 启动日志出现 `[ha] 已连接 Home Assistant MCP` 即生效，`GET /health` 的
  `homeAssistant` 字段可确认；连不上只降级为纯问答，不影响其他功能；
- 工具调用的中间消息不进对话历史，只有用户问题与最终回答会被记住。

## 说明与限制

- **明文 HTTP、无鉴权**，只应在可信局域网里跑，不要暴露公网；
- 对话历史在内存里（重启清空），每设备保留最近 8 条消息；
- 回答风格由 `SYSTEM_PROMPT` 控制（默认：中文口语、不超过 80 字、无列表/代码）；
- 全部模型名可在 `.env` 覆盖，与固件无耦合——固件只认「PCM 进、PCM 出」。
