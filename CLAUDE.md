# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

StackChan-Arduino 是基于 M5Stack CoreS3 的桌面语音助手机器人，三个子项目协作：

| 目录 | 角色 | 技术栈 |
|------|------|--------|
| `hardware-Arduino/` | 机器人固件（单 sketch + 模块 .cpp） | Arduino（M5Stack 板包 3.x），M5Unified/M5StackChan，esp-sr |
| `assistant-server/` | 语音助手后端，跑在用户电脑上 | Node.js 22（ESM），openai + ws + @modelcontextprotocol/sdk |
| `app-RN/` | BLE 配网/配置手机 App | React Native 0.86，react-native-ble-plx |

交互链路：唤醒词（本地 WakeNet）→ 录音（能量 VAD）→ HTTP 传 server →
豆包流式识别 → OpenAI LLM（Responses API 流式，可调 Home Assistant MCP 工具）→
豆包流式合成 → 机器人边下边播，或经 HA media_player 推给外部音箱。

## hardware-Arduino/ — 固件

- **构建**：Arduino IDE，板 M5CoreS3，Partition Scheme 必须选「ESP SR 16M」，PSRAM 开，
  srmodels.bin 需按 `WAKEWORD-A-espsr.md` 重打为含 `wn9_hiwalle_tts2` 的版本（唤醒词「Hi 瓦力」）。
  依赖库：M5Unified、M5StackChan（库管理器安装）。无本机编译验证手段，改动后需用户在 IDE 编译。
- **文件**：`hardware-Arduino.ino`（UI/眼睛/触摸/主循环）、`wifi_ble.h/.cpp`（BLE 配网 + Wi-Fi
  状态机 + NVS）、`assistant.h/.cpp`（录音 VAD → HTTP → 流式播放）。
- **关键约束**：
  - 麦克风任务必须 `task_priority=15` 绑 core1（默认 prio2 会被舵机任务饿死→丢音→唤醒率暴跌）；
  - 麦/扬共享 I2S：播报前 `M5.Mic.end()→M5.Speaker.begin()`，播完切回；
  - wakeTask 与 assistant 用 `assistantBusy()`/`assistantAckPause()` 握手互斥使用麦克风；
  - esp-sr 接口有坏指针陷阱：WakeNet 的 `get_word_name()`/`clean()` 不要调用；
  - 板包 3.3.7 的 BLE 库底层是 NimBLE：不要手动 addDescriptor(BLE2902)，`getValue()` 返回 Arduino String。
- **VAD 三重防误触**（assistant.cpp 顶部常量可调）：自适应底噪阈值 constrain(底噪×2.5, 500, 900)、
  起音 6 块窗口中 4 块、有效语音 <250ms 丢弃；说完静音 2s 判停。
- 串口 `[计时]` 行输出全链路耗时分解，调优先看它。

## assistant-server/ — 后端

- **命令**：`npm install && npm start`（Node ≥22）。配置全在 `.env`（git-ignored）：
  `OPENAI_API_KEY`、`DOUBAO_APP_ID`+`DOUBAO_ACCESS_TOKEN`（或 `DOUBAO_API_KEY`）、
  `DOUBAO_TTS_SPEAKER` 必填；`HA_MCP_URL` 可选。**不要把真实密钥写进任何被提交的文件**。
- **文件**：`server.js`（HTTP 路由 + 对话管线 + 音箱推送）、`doubao.js`（豆包 ASR 二进制
  WebSocket 协议 + 流式 TTS）、`ha-mcp.js`（HA MCP 客户端 + 设备清单 + 工具白名单）。
- **接口**：`POST /chat`（裸 PCM16@16k 进，裸 PCM16@24k 流出，`Connection: close` 不用
  chunked——chunked 分块头会被固件当 PCM 播成哒哒声）；`GET /prompt`、`POST /prompt/play`、
  `GET /speakers`、`POST /output`、`GET /audio/<id>.wav`、`GET /health`、`GET /catalog`。
- **LLM**：用 Responses API（gpt-5.4-mini 在 chat/completions 上不允许工具+reasoning_effort
  并用）；工具是平铺格式；**设备清单**启动时预取进系统提示词（`haCatalog()`，域顺序=截断
  优先级，过滤 indicator_light）；`ha_call_service` 强制 `wait:false`（云设备状态确认会拖 8-10s）。
- **小米音箱实测规律（改音箱推送逻辑前必读）**：playing 时 play_media 可靠；
  被我们 media_pause 停在推送媒体位上时 play_media 被无视；media_play 恢复旧内容；
  repeat=all 关不掉（无 REPEAT_SET，miot play_loop_mode 属性不存在）、不支持 announce；
  state_updater=cloud → HA 状态/进度快照滞后，读到的可能是上一段媒体的残留，
  必须用 media_position_updated_at 对比推送时刻判新鲜度。
  所以 `pushToSpeaker` = 需要时先 media_play 唤醒（暂停点在静音垫内，无声）→500ms→
  play_media 替换；播完由 `brakeWhenSpeechDone` 轮询新鲜进度、确认正片播完才
  media_pause 防循环（拿不到新鲜进度退回挂钟定时兜底）。

## app-RN/ — 手机 App

- **命令**：`npm install`、`npm run android`（release APK：`cd android && ./gradlew assembleRelease`）、
  `npx tsc --noEmit`、`npm run lint`、`npm test`。BLE 必须真机。
- **文件**：`App.tsx`（全部 UI）、`src/ble/protocol.ts`（协议编解码）、`src/ble/StackChanBLE.ts`
  （ble-plx 封装，MTU 517，按 `\n` 重组通知）。
- 明文 HTTP 已放开（Android manifest `usesCleartextTraffic="true"`、iOS ATS 例外）——App
  直接调 server 的 HTTP 接口（音箱列表等）。

## 跨组件协议（改动必须同步）

1. **BLE 配网协议**只有两处定义：固件 `hardware-Arduino/wifi_ble.cpp` ↔ App
   `app-RN/src/ble/protocol.ts`（UTF-8 文本，`\x1F` 分隔字段、`\n` 结尾；服务 UUID
   `8e400001-f315-4f60-9fb8-838830daea50`；命令 SCAN/CONNECT/FORGET/STATUS/SERVER；
   STAT 消息第 6 字段为 serverUrl）。协议有 jest 单测（`app-RN/__tests__/protocol.test.ts`）。
2. **机器人 ↔ server 音频接口**：上行裸 PCM16LE@16kHz 单声道；下行裸 PCM16LE@24kHz 流
   （头 `X-Sample-Rate`、`X-Playback: remote` 表示已推外部音箱）。见 `assistant.cpp` 头注释。

## 通用注意事项

- 所有密钥只放 `.env`/`.env.example`（前者 git-ignored、后者只放占位符）；
- 涉及会让用户家中设备实际出声/动作的测试（音箱推送、控制家电），先征得用户同意，
  能用只读接口（ha_get_state 等）验证就不要出声。
