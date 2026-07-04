/*
  StackChan · Arduino 版（从零开发）
  -----------------------------------
  硬件：M5Stack CoreS3 + StackChan 底座（2 个串行总线舵机：yaw=ID1, pitch=ID2）
  依赖：M5StackChan（含 M5Unified）+ 板载 esp-sr

  功能：
  - 上电：回到原点(goHome)，校准期间屏幕显示 loading 效果；
  - 校准完成后展示眼睛，idle 随机眨眼；
  - esp-sr **WakeNet** 唤醒词「Hi 瓦力」(wn9_hiwalle_tts2，官方训练模型)；
  - 听到「Hi 瓦力」→ 眨一下眼，随即进入语音对话；
  - **BLE Wi-Fi 配网**（wifi_ble.cpp）：手机 App(app-RN) 连 BLE 帮机器人扫 Wi-Fi、
    下发密码联网，凭据存 NVS 开机自动重连；服务器地址也由 App 经 BLE 配置；
  - **屏幕右滑** → Wi-Fi 信息页（状态/SSID/IP/信号/MAC/服务器/BLE），左滑返回眼睛；
  - **语音助手**（assistant.cpp + ../assistant-server）：唤醒即倾听 → 录音传
    电脑端 server（豆包转文字 → gpt-5.4-mini 回答 → 豆包流式 TTS）→ 扬声器/HA 音箱播报。

  说明：从 MultiNet(命令词,自定义但识别率低) 换成 WakeNet(专门训练的唤醒词,稳)。
  WakeNet 自带调好的阈值，无需手动调 threshold。唤醒词固定为模型自带的那个。

  === 上传前设置（Arduino IDE 工具菜单）===
  - 开发板：M5CoreS3
  - Partition Scheme：「ESP SR 16M (3MB APP/7MB SPIFFS/2.9MB MODEL)」 ★必须
  - PSRAM：保持默认(启用)，勿 Disabled
  - USB CDC On Boot：Enabled
  - Flash Size：16MB
  - 并且 srmodels.bin 已替换为含 wn9_hiwalle_tts2 的版本
*/

#include <M5StackChan.h>   // 含 M5Unified；其 begin() 内部会调 M5.begin()
#include <ESP_SR.h>        // 触发 srmodels.bin 烧录 + 链接 esp-sr
#include "wifi_ble.h"      // BLE 配网 + Wi-Fi 状态（wifi_ble.cpp）
#include "assistant.h"     // 语音助手：录音→server→播放（assistant.cpp）
extern "C" {
  #include "model_path.h"     // esp_srmodel_init / esp_srmodel_filter / srmodel_list_t
  #include "esp_wn_iface.h"   // esp_wn_iface_t / wakenet_state_t / det_mode_t
  #include "esp_wn_models.h"  // esp_wn_handle_from_name / ESP_WN_PREFIX
}

// ── 字符画眼睛 ─────────────────────────────────────────────────────
const char* EYE_OPEN[5]   = {" ____ ", "|    |", "| () |", "|    |", "|____|"};
const char* EYE_CLOSED[5] = {"      ", "      ", " ____ ", "|____|", "      "};
const int   EYE_ROWS = 5;
const char* EYE_GAP  = "   ";
const int   TEXT_SIZE = 3;
const int   CHAR_W    = 6 * TEXT_SIZE;
const int   CHAR_H    = 8 * TEXT_SIZE;
int gridX = 0, gridY = 0;

enum Frame { F_OPEN, F_CLOSED };
Frame         currentFrame = F_OPEN;
bool          eyesOpen     = true;
unsigned long nextBlinkAt  = 0;

// ── 页面（右滑看 Wi-Fi 信息，左滑回眼睛）──────────────────────────
enum Screen { SCR_EYES, SCR_WIFI };
Screen        currentScreen  = SCR_EYES;
unsigned long wifiPageDrawnAt = 0;
const int     SWIPE_MIN_DX   = 60;   // flick 水平位移阈值(px)
M5Canvas      wifiCanvas(&M5.Display);  // 整页离屏绘制，刷新不闪烁

// ── 唤醒词（esp-sr WakeNet，免阈值调参）────────────────────────────
const det_mode_t WAKE_DET_MODE = DET_MODE_95;  // 95=较敏感(对齐 xiaozhi)；乱触发就改回 DET_MODE_90
const esp_wn_iface_t* g_wn      = nullptr;
model_iface_data_t*   g_wn_data = nullptr;
int                   g_chunk   = 0;
int16_t*              g_buf     = nullptr;
volatile bool         g_wakeFlag = false;

// ── 语音助手联动 ───────────────────────────────────────────────────
unsigned long  lastWakeAt       = 0;      // 唤醒词命中时刻（传给 assistant 做耗时统计）
AssistantState lastAssistState  = AS_IDLE;

// ── 绘制 ───────────────────────────────────────────────────────────
void drawEyes(Frame f) {
    const char** eye = (f == F_CLOSED) ? EYE_CLOSED : EYE_OPEN;
    for (int r = 0; r < EYE_ROWS; r++) {
        M5.Display.setCursor(gridX, gridY + r * CHAR_H);
        M5.Display.print(eye[r]);
        M5.Display.print(EYE_GAP);
        M5.Display.print(eye[r]);
    }
}

void triggerWakeBlink() {
    eyesOpen     = false;
    currentFrame = F_CLOSED;
    drawEyes(F_CLOSED);
    nextBlinkAt  = millis() + 180;
}

// 开机原点校准：显示 loading 旋转动画，同时 goHome，转到位/超时后返回
void bootCalibrate() {
    auto& d = M5.Display;
    d.fillScreen(TFT_BLACK);
    d.setTextColor(TFT_CYAN, TFT_BLACK);
    d.setTextSize(2);
    d.setCursor((d.width() - 7 * 12) / 2, d.height() / 2 + 24);
    d.print("LOADING");

    M5StackChan.Motion.goHome(600);

    const char SP[4] = {'|', '/', '-', '\\'};
    int spx = d.width() / 2 - 9;
    int spy = d.height() / 2 - 40;
    int frame = 0;
    unsigned long t0 = millis();
    while ((millis() - t0 < 1500 || M5StackChan.Motion.isMoving()) && millis() - t0 < 4000) {
        M5StackChan.update();
        // 舵机上电自检期间可能丢首条指令（moveWithSpeed 只发一次），~1s/2s 处重发兜底
        if (frame == 8 || frame == 16) M5StackChan.Motion.goHome(600);
        d.setTextSize(3);
        d.setCursor(spx, spy);
        d.print(SP[frame++ % 4]);
        delay(120);
    }
    Serial.printf("[boot] 归位%s（耗时 %lums）\n",
                  M5StackChan.Motion.isMoving() ? "超时未完成" : "完成",
                  millis() - t0);
}

// 屏幕底部的助手状态提示（眼睛页；Font0 仅 ASCII）。等宽覆盖，无需清屏
void drawAssistStatus(AssistantState st) {
    const char* txt;
    switch (st) {
        case AS_LISTEN: txt = "  listening...  "; break;
        case AS_THINK:  txt = "  thinking...   "; break;
        case AS_SPEAK:  txt = "  speaking...   "; break;
        case AS_ERROR:  txt = "  server error  "; break;
        default:        txt = "                "; break;
    }
    auto& d = M5.Display;
    d.setTextSize(2);
    d.setCursor((d.width() - 16 * 12) / 2, d.height() - 24);  // 16 字符 × 12px
    d.print(txt);
    d.setTextSize(TEXT_SIZE);
}

// ── Wi-Fi 信息页（右滑进入，左滑返回）──────────────────────────────
void drawWifiScreen() {
    wifiPageDrawnAt = millis();
    WifiInfo info = wifiBleGetInfo();

    auto& c = wifiCanvas;
    if (!c.width()) {  // 首次进入才建 sprite（PSRAM，约 150KB）
        c.setColorDepth(16);
        c.createSprite(M5.Display.width(), M5.Display.height());
    }
    c.fillSprite(TFT_BLACK);
    c.setFont(&fonts::efontCN_16);  // 中文字体（Font0 无中文字形）

    c.setTextSize(2);
    c.setTextColor(TFT_CYAN, TFT_BLACK);
    c.setCursor(12, 8);
    c.print("Wi-Fi 信息");
    c.drawFastHLine(0, 44, c.width(), TFT_DARKGREY);

    // 状态行颜色 + 中文
    const char* stText = "未连接";
    uint16_t    stColor = TFT_LIGHTGREY;
    if      (info.state == "CONNECTED")  { stText = "已连接";   stColor = TFT_GREEN;  }
    else if (info.state == "CONNECTING") { stText = "连接中..."; stColor = TFT_YELLOW; }
    else if (info.state == "FAIL")       { stText = "连接失败"; stColor = TFT_RED;    }

    c.setTextSize(1);
    int y = 52, dy = 23;  // 7 行内容 + 底部提示，压缩行距
    auto row = [&](const char* label, const String& value, uint16_t color = TFT_WHITE) {
        c.setTextColor(TFT_DARKGREY, TFT_BLACK);
        c.setCursor(12, y);
        c.print(label);
        c.setTextColor(color, TFT_BLACK);
        c.setCursor(76, y);
        c.print(value);
        y += dy;
    };
    row("状态", stText, stColor);
    row("SSID", info.ssid.length() ? info.ssid : String("-"));
    row("IP",   info.ip.length()   ? info.ip   : String("-"));
    row("信号", (info.state == "CONNECTED") ? String(info.rssi) + " dBm" : String("-"));
    row("MAC",  info.mac);
    row("服务", info.serverUrl.length() ? info.serverUrl : String("- (App里配置)"));
    row("蓝牙", info.bleName + (info.bleConnected ? " (App已连接)" : " (广播中)"),
        info.bleConnected ? TFT_GREEN : TFT_WHITE);

    c.setTextColor(TFT_DARKGREY, TFT_BLACK);
    c.setCursor(12, 218);
    c.print("← 左滑返回    手机App可蓝牙配网");
    c.pushSprite(0, 0);
}

void enterWifiScreen() {
    currentScreen = SCR_WIFI;
    drawWifiScreen();
}

void exitWifiScreen() {
    currentScreen = SCR_EYES;
    wifiCanvas.deleteSprite();          // 归还 PSRAM
    M5.Display.setFont(&fonts::Font0);  // 恢复眼睛页字体
    M5.Display.setTextColor(TFT_CYAN, TFT_BLACK);
    M5.Display.setTextSize(TEXT_SIZE);
    M5.Display.fillScreen(TFT_BLACK);
    eyesOpen     = true;
    currentFrame = F_OPEN;
    drawEyes(F_OPEN);
    drawAssistStatus(lastAssistState);  // 助手状态提示随眼睛页恢复
    nextBlinkAt = millis() + random(2000, 5000);
}

// ── 唤醒识别任务（core 0 连续录音 + WakeNet detect）────────────────
void wakeTask(void*) {
    for (;;) {
        if (assistantBusy()) {           // 助手在录音/播放，让出麦克风
            assistantAckPause(true);
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        assistantAckPause(false);
        if (!g_wn || !g_buf) { vTaskDelay(pdMS_TO_TICKS(200)); continue; }
        if (!M5.Mic.record(g_buf, g_chunk, 16000)) { vTaskDelay(1); continue; }
        while (M5.Mic.isRecording()) vTaskDelay(1);

        wakenet_state_t st = g_wn->detect(g_wn_data, g_buf);
        if (st == WAKENET_DETECTED) {
            Serial.println(">>> Hi 瓦力! 唤醒");
            g_wakeFlag = true;
            // 不调 clean()——xiaozhi 也不调，且该函数在 wn9l 上疑似坏指针会崩
            // 冷却 800ms 防同句重复触发；助手随即接管麦克风，
            // assistantBusy() 为真后本任务自动暂停
            vTaskDelay(pdMS_TO_TICKS(800));
        }
    }
}

void wakenetSetup() {
    srmodel_list_t* models = esp_srmodel_init("model");
    if (!models || models->num <= 0) {
        Serial.println("[wake] 无 model 分区 → 请选『ESP SR 16M』分区方案。眼睛仅 idle 眨眼。");
        return;
    }
    char* wn = esp_srmodel_filter(models, ESP_WN_PREFIX, NULL);  // 取 WakeNet 模型
    if (!wn) {
        Serial.println("[wake] model 分区无 WakeNet 模型 → 需重打 srmodels.bin(选 Hi 瓦力)。眼睛仅 idle 眨眼。");
        return;
    }
    Serial.printf("[wake] 使用 WakeNet: %s\n", wn);

    g_wn      = esp_wn_handle_from_name(wn);
    g_wn_data = g_wn->create(wn, WAKE_DET_MODE);
    g_chunk   = g_wn->get_samp_chunksize(g_wn_data);
    g_buf     = (int16_t*)heap_caps_malloc(g_chunk * sizeof(int16_t), MALLOC_CAP_DEFAULT);
    // 注意：get_word_name(g_wn_data,1) 在此模型上返回坏指针会崩溃，故不调用
    Serial.printf("[wake] 唤醒词=Hi 瓦力 chunk=%d，就绪，喊「Hi 瓦力」试试。\n", g_chunk);

    xTaskCreatePinnedToCore(wakeTask, "wake", 32768, nullptr, 5, nullptr, 0);
}

void setup() {
    M5StackChan.begin();         // 内部已调 M5.begin() + 舵机/触摸/IO(自动上舵机电源)
    Serial.begin(115200);

    // 麦克风必须在 M5StackChan.begin() 之后配置
    M5.Speaker.end();
    auto mic_cfg = M5.Mic.config();
    mic_cfg.sample_rate      = 16000;
    mic_cfg.dma_buf_count    = 16;   // 加大缓冲，吸收抖动
    // ★关键：M5Unified 麦克风任务默认 priority=2，会被舵机 motion_task(prio10) 饿死→丢音→识别差
    mic_cfg.task_priority    = 15;   // 抬到 motion_task 之上，保证 DMA 连续处理
    mic_cfg.task_pinned_core = 1;    // 绑 core1（wake 任务在 core0）
    M5.Mic.config(mic_cfg);
    M5.Mic.begin();

    M5.Display.setRotation(1);
    M5.Display.setFont(&fonts::Font0);
    M5.Display.setTextColor(TFT_CYAN, TFT_BLACK);
    const int lineChars = 6 + 3 + 6;
    gridX = (M5.Display.width()  - lineChars * CHAR_W) / 2;
    gridY = (M5.Display.height() - EYE_ROWS  * CHAR_H) / 2;

    bootCalibrate();             // 开机：原点校准 + loading

    M5.Display.fillScreen(TFT_BLACK);
    M5.Display.setTextSize(TEXT_SIZE);
    randomSeed(micros());
    drawEyes(F_OPEN);
    nextBlinkAt = millis() + random(2000, 5000);

    wakenetSetup();
    wifiBleSetup();              // BLE 配网广播 + 自动重连已保存的 Wi-Fi
    assistantSetup();            // 语音助手任务（需 App 先配置服务器地址）
}

void loop() {
    M5StackChan.update();        // = M5.update() + 触摸；舵机移动由后台任务驱动
    unsigned long now = millis();

    wifiBleLoop();               // BLE 命令 / Wi-Fi 扫描·连接状态机（非阻塞）

    // 滑动手势：眼睛页右滑 → Wi-Fi 信息页；Wi-Fi 页左滑 → 返回
    auto t = M5.Touch.getDetail();
    if (t.wasFlicked()) {
        int dx = t.distanceX(), dy = t.distanceY();
        if (abs(dx) >= SWIPE_MIN_DX && abs(dx) > 2 * abs(dy)) {
            if      (currentScreen == SCR_EYES && dx > 0) enterWifiScreen();
            else if (currentScreen == SCR_WIFI && dx < 0) exitWifiScreen();
        }
    }

    if (g_wakeFlag) {            // 听到「Hi 瓦力」
        g_wakeFlag = false;
        lastWakeAt = now;        // 计时起点
        if (currentScreen == SCR_EYES) triggerWakeBlink();  // 眨一下眼
        assistantPrePrompt();    // 立即预推提示音（音箱拉流并行）
        assistantTrigger(lastWakeAt);  // 立刻进入「我在听」→倾听（不再点头）
    }

    AssistantState as = assistantGetState();            // 底部状态提示
    if (as != lastAssistState) {
        lastAssistState = as;
        if (currentScreen == SCR_EYES) drawAssistStatus(as);
    }

    if (currentScreen == SCR_EYES) {
        if (now >= nextBlinkAt) {    // idle 随机眨眼
            eyesOpen = !eyesOpen;
            Frame f = eyesOpen ? F_OPEN : F_CLOSED;
            if (f != currentFrame) { drawEyes(f); currentFrame = f; }
            nextBlinkAt = now + (eyesOpen ? random(2000, 5000) : 140);
        }
    } else if (now - wifiPageDrawnAt >= 1000) {
        drawWifiScreen();            // Wi-Fi 页每秒刷新一次状态
    }

    delay(5);
}
