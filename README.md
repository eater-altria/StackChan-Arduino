# StackChan-Arduino — 桌面语音助手机器人

基于 **M5Stack CoreS3** 的 StackChan 桌面机器人，Arduino 从零实现：本地唤醒词、
云端语音对话（豆包语音 + OpenAI）、Home Assistant 智能家居控制、手机 App 蓝牙配网。

```
「Hi 瓦力」→ 机器人/音箱:「我在听」→ 「书房空调24度」→ 空调被调节 → 音箱播报「已调到24度」
```

## 架构

```
┌─────────────┐  BLE 配网/配置   ┌─────────────┐
│  app-RN     │ ───────────────► │ 机器人固件   │  M5Stack CoreS3
│  手机App    │                  │ hardware-   │  esp-sr WakeNet 本地唤醒
│ (React      │      HTTP        │ Arduino     │  能量VAD录音 / 边下边播
│  Native)    │ ──────┐          └──────┬──────┘
└─────────────┘       │            HTTP │ PCM16@16k 上行 / PCM16@24k 流式下行
                      ▼                 ▼
               ┌──────────────────────────────┐
               │ assistant-server（电脑上跑）   │
               │  豆包流式识别 (WebSocket)      │
               │  gpt-5.4-mini (Responses API) │──► Home Assistant MCP
               │  豆包流式合成 (seed-tts-2.0)   │    （控制全屋设备/触发脚本）
               └──────────────┬───────────────┘
                              │ play_media（可选）
                              ▼
                     HA 里的音箱（小米音箱等）
```

| 目录 | 角色 | 技术栈 |
|------|------|--------|
| [`hardware-Arduino/`](hardware-Arduino/) | 机器人固件 | Arduino（M5Stack 板包 3.x），M5Unified/M5StackChan，esp-sr |
| [`assistant-server/`](assistant-server/) | 语音助手后端（跑在电脑上） | Node.js 22（ESM），openai + ws + MCP SDK |
| [`app-RN/`](app-RN/) | 配网/配置手机 App | React Native 0.86，react-native-ble-plx |

## 硬件清单

- **M5Stack CoreS3**（ESP32-S3，16MB Flash，带 PSRAM）
- **StackChan 底座**（2 个串行总线舵机：yaw=ID1 / pitch=ID2，仅开机归位用）
- 局域网内一台常开电脑（跑 assistant-server；开发机即可）
- 可选：**Home Assistant** 实例 + 接入 HA 的音箱（外部播报与家居控制用）

## 复现步骤

### 第 1 步：烧录固件（`hardware-Arduino/`）

1. Arduino IDE 装 **M5Stack 板卡包 ≥3.2.2**，库管理器装 **M5Unified ≥0.2.11** 和 **M5StackChan**；
2. 关键：按 [`hardware-Arduino/WAKEWORD-A-espsr.md`](hardware-Arduino/WAKEWORD-A-espsr.md)
   用 esp-sr v2.3.1 重打 **srmodels.bin**（选唤醒词模型 `wn9_hiwalle_tts2`「Hi 瓦力」），
   替换板包 `tools/esp32s3-libs/<版本>/esp_sr/srmodels.bin`（先备份原文件）；
3. IDE 设置：开发板 **M5CoreS3**、Partition Scheme **「ESP SR 16M (3MB APP/7MB SPIFFS/2.9MB MODEL)」**、
   PSRAM 启用、Flash 16MB、USB CDC On Boot Enabled；
4. 打开 `hardware-Arduino/hardware-Arduino.ino` 烧录。串口 115200 应看到
   `[wake] 唤醒词=Hi 瓦力` 与 `[ble] 广播中：StackChan-XXXX`。

### 第 2 步：启动后端（`assistant-server/`）

```bash
cd assistant-server
npm install
cp .env.example .env
# .env 必填三项：
#   OPENAI_API_KEY        —— OpenAI（对话模型，默认 gpt-5.4-mini）
#   DOUBAO_APP_ID + DOUBAO_ACCESS_TOKEN（火山引擎·语音技术控制台·应用管理；
#     或新版控制台用 DOUBAO_API_KEY 单项）——需开通「流式语音识别大模型」和
#     「语音合成大模型2.0」两个服务
#   DOUBAO_TTS_SPEAKER    —— TTS 音色 ID（火山控制台音色库选取，必填）
# 可选：HA_MCP_URL —— Home Assistant MCP 地址（配置后可语音控制家居/外部音箱播报）
npm start
# → StackChan assistant-server 监听 :8300
```

电脑局域网 IP 查询：`ipconfig getifaddr en0`（macOS）。机器人、电脑、手机须在**同一局域网**。

### 第 3 步：手机 App 配网（`app-RN/`）

```bash
cd app-RN
npm install
npm run android          # 或 iOS：cd ios && bundle exec pod install && cd .. && npm run ios
# BLE 必须真机运行，模拟器无蓝牙
```

App 流程：扫描附近的机器人 → 连接 → 让机器人扫 Wi-Fi → 选网络输密码 →
「语音助手服务器」填 `http://<电脑IP>:8300` → （可选）「播报设备」选一个 HA 音箱。
所有配置存在机器人 NVS / server 本地，断电不丢。

### 第 4 步：对话

喊 **「Hi 瓦力」** → 听到「我在听」后说话（说完停顿 2 秒自动结束）→ 机器人或所选音箱播报回答。
配置了 HA 的话可以直接说「打开书房灯」「空调 24 度」「打开工作模式」（触发 HA 脚本/场景）。
机器人屏幕**右滑**查看 Wi-Fi/服务器/蓝牙状态，左滑返回。

## 调优速查

| 参数 | 位置 | 默认 | 说明 |
|------|------|------|------|
| `RMS_SPEECH` | 固件 assistant.cpp | 500 | 说话判定阈值，漏识别调低/误触发调高 |
| `SILENCE_END_MS` | 固件 assistant.cpp | 2000 | 说完多久算结束，改小响应更快 |
| `SPEAK_VOLUME` | 固件 assistant.cpp | 240 | 本体扬声器音量 0~255 |
| `PROMPT_TEXT` | server .env | 我在听 | 唤醒提示音文本 |
| `CHAT_MODEL` | server .env | gpt-5.4-mini | 换 gpt-5.4 质量更高但更慢 |
| `DOUBAO_TTS_LOUDNESS` | server .env | 0 | TTS 响度增益 [-50,100] |

排障入口：机器人串口的 `[计时]` 行 + server 的 `计时` 行覆盖全链路各阶段耗时；
`GET /health` 查服务状态，`GET /catalog` 查注入模型的设备清单。

## 已知边界

- ESP32-S3 无经典蓝牙，**无法直连蓝牙音箱**——外部播报走 HA media_player 实现；
- server 明文 HTTP、无鉴权，只应在可信局域网使用；
- 小米音箱作播报设备时的循环/暂停怪癖已在 server 内处理（详见 `assistant-server/README.md`）。

各子项目细节见各自目录内 README。
