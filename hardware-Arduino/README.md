# hardware-Arduino

StackChan 的 **Arduino 版固件**，从零开发，与 ESP-IDF 版的 `firmware/` 完全独立、互不依赖。

> 目标：用 Arduino + M5Unified/M5GFX 逐步实现 StackChan 的功能。本目录是全新起点，不复用 `firmware/`（那是基于 ESP-IDF + xiaozhi-esp32 的出厂固件，无法迁移到 Arduino）。

## 硬件

- **M5Stack CoreS3**（ESP32-S3，屏幕 320×240）

## Arduino IDE 环境

| 项目 | 要求 |
|------|------|
| 开发板管理器 | M5Stack 板卡包 ≥ **3.2.2** |
| 开发板选择 | **M5CoreS3** |
| 库 | **M5Unified ≥ 0.2.11**（会自动带入 M5GFX ≥ 0.2.18） |

安装步骤：
1. Arduino IDE → 偏好设置 → 附加开发板管理器网址，加入 M5Stack 的板卡 URL（参见 M5Stack 官方文档）。
2. 开发板管理器搜索安装 **M5Stack**（≥3.2.2），开发板选 **M5CoreS3**。
3. 库管理器搜索安装 **M5Unified**。

## 编译与上传

用 Arduino IDE **打开本文件夹**（`hardware-Arduino/hardware-Arduino.ino`），选好开发板与端口后点击「上传」即可。

## 当前功能

`hardware-Arduino.ino` + `wifi_ble.h/.cpp`：
- 上电舵机原点校准（loading 动画），随后字符画眼睛 idle 随机眨眼；
- esp-sr **WakeNet** 唤醒词「**Hi 瓦力**」(`wn9_hiwalle_tts2`，官方训练模型，免调阈值)，
  听到后眨眼、随即进入语音对话；
- **BLE Wi-Fi 配网**：开机广播 `StackChan-XXXX`，配套手机 App（**`../app-RN/`**，React Native）
  连上后可让机器人扫描 Wi-Fi、下发密码联网；凭据存 NVS，开机自动重连；
  **语音助手服务器地址**也由 App 经 BLE 配置（SERVER 命令）；
- **屏幕右滑** → Wi-Fi 信息页（状态/SSID/IP/信号/MAC/服务器/BLE 状态，每秒刷新），**左滑返回**眼睛；
- **语音助手**（`assistant.h/.cpp` + **`../assistant-server/`**）：唤醒后播提示音
  「我在听」（server `/prompt` 的 TTS，空闲时预取缓存），然后倾听（能量 VAD 三重防误触：
  自适应底噪阈值 / 起音确认 ~160ms / 有效语音 <300ms 丢弃；说完静音 2s 截止 / 最长 8s /
  5s 没人说话取消），录音 POST 给电脑端 server
  （OpenAI 转文字 → gpt-5.4 回答（可调 Home Assistant 工具控制家居）→ TTS），
  返回的 PCM16@24k 用扬声器播报；屏幕底部显示 listening/thinking/speaking 状态。

技术要点：
- 等宽字体 `Font0` 保证字符画对齐；不透明背景文字重绘实现**零闪烁**；Wi-Fi 页用
  M5Canvas 离屏整页绘制（efontCN_16 中文字体）。
- 麦/扬声器共享 I2S，`setup()` 先 `M5.Speaker.end()` 再 `M5.Mic.begin()`；M5.Mic 单声道 16kHz
  直接喂 WakeNet `detect()`（无 AFE）。**麦克风任务必须抬高优先级**（`task_priority=15` 绑 core1），
  否则被舵机 motion_task 饿死丢音、识别率暴跌。
- 必须 `#include <ESP_SR.h>`（触发 srmodels.bin 烧录）+ 选「ESP SR 16M」分区方案 + PSRAM 开，
  且 srmodels.bin 需按 [WAKEWORD-A-espsr.md](WAKEWORD-A-espsr.md) 重打为含 `wn9_hiwalle_tts2` 的版本。
- BLE 用板包自带库（3.3.7 底层为 NimBLE，零额外库）；BLE 回调只入队命令，Wi-Fi 扫描/连接
  全部在 loop 里非阻塞状态机处理。协议（`\x1F` 分隔字段、`\n` 结尾）与
  `app-RN/src/ble/protocol.ts` 必须同步。
- 麦/扬共享 I2S：播报前 `M5.Mic.end()→M5.Speaker.begin()`，播完反向切回；助手工作期间
  wakeTask 暂停碰麦克风（`assistantBusy()`/`assistantAckPause()` 握手），录音/回答缓冲都在 PSRAM。

## 路线图

- [x] 阶段 1：字符画眨眼眼睛
- [x] 阶段 2：麦克风采集 + 音量阈值验证
- [x] 阶段 3：本地唤醒词 —— **WakeNet 预置模型「Hi 瓦力」**（`wn9_hiwalle_tts2`，
      重打 srmodels.bin 步骤见 [WAKEWORD-A-espsr.md](WAKEWORD-A-espsr.md)）
- [x] 舵机头部运动（开机原点校准，M5StackChan 库；唤醒点头已按需求移除）
- [x] WiFi / 联网能力（BLE 配网，配套 **`../app-RN/`** 手机 App；右滑看 Wi-Fi 信息）
- [x] 语音助手（唤醒→倾听→电脑端 **`../assistant-server/`**（OpenAI）→扬声器播报）
- [~] 触摸交互（已有滑动切页；摸头等手势待做）
- [ ] 表情切换（开心 / 惊讶 / 困）

## 工具 / 子工程

- [`tools/sr_model_check/`](tools/sr_model_check/) —— esp-sr `model` 分区诊断（WAKEWORD-A 步骤 1），独立 sketch，列出 flash 里现有的 esp-sr 模型。
