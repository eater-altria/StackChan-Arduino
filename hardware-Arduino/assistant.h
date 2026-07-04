/*
  assistant.h —— 语音助手：录音 → 电脑端 assistant-server → 播放回答
  -------------------------------------------------------------------
  流程（唤醒即由 assistantTrigger() 启动，独立任务跑完全程。
  「我在听」提示音是开口时机的信号——用户听到它再说指令，配合 320ms 前滚
  缓冲不会漏字）：
  0. 先播唤醒提示音「我在听」（server /prompt 的 TTS，空闲时预取缓存在 PSRAM，
     未缓存到就跳过直接开录）；
  1. LISTEN：M5.Mic 连续录音（16kHz PCM16，PSRAM 缓冲），能量 VAD——
     开头估底噪自适应阈值、连续 ~160ms 超阈值才算开口、有效语音 <300ms
     按杂音丢弃（防磕碰/咳嗽误触发上传）；说话开始后静音 ≥2s 或录满 8s
     结束；5s 内没人说话则取消；
  2. THINK：HTTP POST 裸 PCM 到 <serverUrl>/chat（assistant-server 完成
     豆包转文字 → gpt-5.4 回答 → 豆包流式 TTS），响应为 chunked PCM16@24kHz 流；
  3. SPEAK：**边下边播**——首块音频到手即切扬声器（Mic.end→Speaker.begin），
     三缓冲轮转喂 playRaw（双排队槽），流结束播完切回麦克风。

  期间唤醒词检测必须暂停：wakeTask 每圈调 assistantAckPause() 汇报状态，
  忙时不碰麦克风（见 hardware-Arduino.ino）。
  服务器地址由手机 App 经 BLE 配置（wifi_ble 的 SERVER 命令，存 NVS）。
*/
#pragma once
#include <Arduino.h>

enum AssistantState {
    AS_IDLE,    // 空闲（唤醒检测运行中）
    AS_LISTEN,  // 正在听
    AS_THINK,   // 等 server 回答
    AS_SPEAK,   // 播放回答
    AS_ERROR,   // 出错（短暂展示后回 IDLE）
};

void           assistantSetup();          // setup() 里调，创建后台任务
// 唤醒词命中时立刻调（非阻塞）：后台提前完成 /prompt/play 协商——外部音箱模式下
// 提示音即刻开始推送，抢在正式流程前把拉流的 ~1.5s 走掉
void           assistantPrePrompt();
// 唤醒时调，开始一轮对话（非阻塞）。wakeAtMs 传唤醒词命中时的 millis()，
// 用于端到端耗时统计（串口 [计时] 行），传 0 则该段不计
void           assistantTrigger(uint32_t wakeAtMs = 0);
AssistantState assistantGetState();       // UI 查询状态
bool           assistantBusy();           // 忙 = 唤醒检测应暂停
void           assistantAckPause(bool paused);  // wakeTask 汇报"我已停止碰麦克风"
