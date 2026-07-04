/*
  assistant.cpp —— 实现见 assistant.h 顶部说明
  --------------------------------------------
  内存：录音缓冲 256KB、回答音频最大 2MB，都在 PSRAM；
  网络：明文 HTTP（局域网内的 assistant-server），超时 90s；
  I2S：麦/扬共享，播放前 Mic.end()→Speaker.begin()，播完反向切回，
       Mic 的 config（priority=15/core1）保存在 M5.Mic 里，重新 begin 后依然生效。
*/
#include "assistant.h"
#include "wifi_ble.h"
#include <M5Unified.h>
#include <WiFi.h>
#include <HTTPClient.h>

// ── 录音参数 ─────────────────────────────────────────────────────
static const int      REC_RATE        = 16000;
static const size_t   REC_CHUNK       = 512;              // 32ms
static const size_t   REC_MAX_SAMPLES = REC_RATE * 8;     // 最长 8s（256KB）
static const int      RMS_SPEECH      = 500;   // 说话判定基础阈值（近距离说话 rms≈1800+，隔远会低）
static const int      RMS_SPEECH_MAX  = 900;   // 自适应阈值上限（再高隔一米说话就听不见了）
static const float    NOISE_MULT      = 2.5f;  // 阈值 = 底噪 × 该倍数（夹在上下限之间）
static const int      NOISE_CHUNKS    = 6;     // 用 ~192ms 估环境底噪（在播提示音之前测！）
static const int      WARMUP_CHUNKS   = 3;     // 扬声器切回麦克风后丢弃的杂波块（~96ms）
static const int      ONSET_WINDOW    = 6;     // 起音判定窗口：最近 6 块里……
static const int      ONSET_HITS      = 4;     // ……至少 4 块超阈值才算「开口」（说话有起伏，别要求连续）
static const uint32_t MIN_SPEECH_MS   = 250;   // 有效语音低于这个时长 → 当杂音整段丢弃
static const int      PREROLL_CHUNKS  = 10;    // 开口前保留 ~320ms 前滚，不漏第一个字
static const uint32_t SILENCE_END_MS  = 2000;  // 说话后静音这么久 → 结束（给足句间停顿）
static const uint32_t WAIT_SPEECH_MS  = 5000;  // 一直没说话 → 取消
// ── 播放/网络参数 ────────────────────────────────────────────────
static const size_t   RESP_MAX_BYTES  = 2 * 1024 * 1024;  // 回答音频上限
static const uint32_t HTTP_TIMEOUT_MS = 90000;
static const uint8_t  SPEAK_VOLUME    = 240;  // 0~255，嫌吵改小

static volatile AssistantState s_state    = AS_IDLE;
static volatile bool           s_trigger  = false;
static volatile bool           s_wakeAck  = false;  // wakeTask 已停止碰麦克风
static volatile uint32_t       s_wakeAtMs = 0;      // 唤醒词命中时刻（计时用）
static int16_t*                s_recBuf   = nullptr;

// ── 单轮交互计时（串口 [计时] 行，全链路分解）─────────────────────
struct InteractionTiming {
    uint32_t wakeAt;       // 唤醒词命中（.ino 传入，0=未知）
    uint32_t trigAt;       // 触发对话（唤醒后）
    uint32_t promptNegMs;  // /prompt/play 协商往返
    bool     promptRemote; // 提示音是否由音箱播
    uint32_t promptMs;     // 提示音阶段（本地播放 / 远端等待）
    uint32_t noiseMs;      // 底噪测量
    uint32_t listenAt;     // 开始等待开口
    uint32_t onsetAt;      // 检测到说话
    uint32_t recEndAt;     // 录音结束（VAD 判停，含尾静音）
    uint32_t headerAt;     // 收到 server 响应头（本地播路径 ≈ STT 完成）
    uint32_t firstAudioAt; // 收到首块回答音频
    uint32_t playEndAt;    // 播放结束
    bool     remotePlay;   // 回答由音箱播（headerAt 即 server 全部处理完）
};
static InteractionTiming g_tm;

static void printTiming() {
    auto seg = [](uint32_t from, uint32_t to) -> long {
        return (from && to && to >= from) ? (long)(to - from) : -1;
    };
    Serial.printf("[计时] 唤醒->触发 %ldms | 提示音协商 %lums%s | 提示音 %lums | 底噪 %lums"
                  " | 等开口 %ldms | 说话+判停 %ldms | 上传->首包 %ldms%s | 首块音频 +%ldms"
                  " | 播放 %ldms | 全程 %ldms\n",
                  seg(g_tm.wakeAt, g_tm.trigAt),
                  (unsigned long)g_tm.promptNegMs, g_tm.promptRemote ? "(远端)" : "(本地)",
                  (unsigned long)g_tm.promptMs,
                  (unsigned long)g_tm.noiseMs,
                  seg(g_tm.listenAt, g_tm.onsetAt),
                  seg(g_tm.onsetAt, g_tm.recEndAt),
                  seg(g_tm.recEndAt, g_tm.headerAt),
                  g_tm.remotePlay ? "(=server全程,远端播)" : "(≈STT)",
                  seg(g_tm.headerAt, g_tm.firstAudioAt),
                  seg(g_tm.firstAudioAt, g_tm.playEndAt),
                  seg(g_tm.wakeAt ? g_tm.wakeAt : g_tm.trigAt,
                      g_tm.playEndAt ? g_tm.playEndAt : millis()));
}

// 唤醒提示音（server /prompt 的 TTS，如「我在听」）：空闲时预取，缓存 PSRAM
static uint8_t* s_promptBuf       = nullptr;
static size_t   s_promptBytes     = 0;
static int      s_promptRate      = 24000;
static String   s_promptFromUrl;             // 缓存来自哪个 serverUrl（地址变了要重取）
static uint32_t s_promptLastTryAt = 0;
static const uint32_t PROMPT_RETRY_MS = 30000;

AssistantState assistantGetState() { return s_state; }
bool           assistantBusy()     { return s_state != AS_IDLE || s_trigger; }
void           assistantAckPause(bool paused) { s_wakeAck = paused; }

void assistantTrigger(uint32_t wakeAtMs) {
    if (s_state == AS_IDLE) {
        s_wakeAtMs = wakeAtMs;
        s_trigger  = true;
    }
}

// ── 提示音预协商（唤醒瞬间发起，抢在正式流程前推送音箱）───────────
static volatile bool s_prePromptReq = false;
static bool          s_preRemote    = false;  // 协商结果：提示音是否走音箱
static uint32_t      s_preAt        = 0;      // 推送发起时刻（0=无有效预协商）
static uint32_t      s_preNegMs     = 0;

void assistantPrePrompt() {
    if (s_state == AS_IDLE) s_prePromptReq = true;
}

// 等 wakeTask 确认已让出麦克风（它 32ms 一圈，最多等 1s）
static bool waitWakeAck() {
    for (int i = 0; i < 100 && !s_wakeAck; i++) vTaskDelay(pdMS_TO_TICKS(10));
    if (!s_wakeAck) Serial.println("[assist] 唤醒任务未让出麦克风");
    return s_wakeAck;
}

// 采一块音频并算 rms；失败返回 -1
static int recordChunkRms(int16_t* chunk) {
    if (!M5.Mic.record(chunk, REC_CHUNK, REC_RATE)) { vTaskDelay(1); return -1; }
    while (M5.Mic.isRecording()) vTaskDelay(1);
    uint64_t sq = 0;
    for (size_t i = 0; i < REC_CHUNK; i++) sq += (int32_t)chunk[i] * chunk[i];
    return (int)sqrtf((float)(sq / REC_CHUNK));
}

// 估环境底噪 → 自适应阈值。必须在播「我在听」**之前**调用：
// 用户此时还在等提示音、不会开口，测出来的才是真底噪。
// （曾在提示音后测：用户闻声即答，人声混进底噪把阈值顶到上限，机器人反而聋了）
static int measureThreshold() {
    int16_t  chunk[REC_CHUNK];
    uint32_t sum = 0;
    int      cnt = 0;
    while (cnt < NOISE_CHUNKS) {
        int rms = recordChunkRms(chunk);
        if (rms < 0) continue;
        sum += rms;
        cnt++;
    }
    int floorRms  = sum / NOISE_CHUNKS;
    int threshold = constrain((int)(floorRms * NOISE_MULT), RMS_SPEECH, RMS_SPEECH_MAX);
    Serial.printf("[assist] 底噪 rms=%d → 阈值=%d\n", floorRms, threshold);
    return threshold;
}

// ── 录音（能量 VAD）。返回样本数，0 = 没人说话/杂音/失败 ──────────
// 防误触三道闸：①阈值来自 measureThreshold()（提示音前的真底噪）；
// ②起音判定：最近 ONSET_WINDOW 块里 ONSET_HITS 块超阈值（说话音量有
//   起伏，连续判定会把正常人声拒之门外；磕碰声只有 1~3 块，仍过不了）；
// ③结束后有效语音不足 MIN_SPEECH_MS 整段丢弃，不上传。
// 开口确认前只保留 PREROLL_CHUNKS 的滚动缓冲：不漏第一个字，
// 等待期的静音也不吃 8s 录音预算。
static size_t recordUtterance(int threshold) {
    int16_t chunk[REC_CHUNK];

    // 提示音刚播完，扬声器→麦克风切换的头几块是重启杂波，丢掉
    for (int i = 0; i < WARMUP_CHUNKS;) {
        if (recordChunkRms(chunk) >= 0) i++;
    }

    size_t   len = 0;
    bool     speech = false;
    uint8_t  onsetBits = 0;                // 最近 ONSET_WINDOW 块的超阈值位图
    uint32_t speechMs = 0, silenceMs = 0, waitedMs = 0, lastWaitLogMs = 0;
    g_tm.listenAt = millis();

    while (len + REC_CHUNK <= REC_MAX_SAMPLES) {
        int rms = recordChunkRms(chunk);
        if (rms < 0) continue;

        // 开口前维持 ~320ms 滚动前滚缓冲；确认开口后顺序累积
        if (!speech && len >= (size_t)PREROLL_CHUNKS * REC_CHUNK) {
            memmove(s_recBuf, s_recBuf + REC_CHUNK,
                    (len - REC_CHUNK) * sizeof(int16_t));
            len -= REC_CHUNK;
        }
        memcpy(s_recBuf + len, chunk, REC_CHUNK * sizeof(int16_t));
        len += REC_CHUNK;

        bool over = (rms >= threshold);
        if (!speech) {
            onsetBits = ((onsetBits << 1) | (over ? 1 : 0)) & ((1 << ONSET_WINDOW) - 1);
            if (__builtin_popcount(onsetBits) >= ONSET_HITS) {   // 起音确认
                speech        = true;
                speechMs      = ONSET_HITS * 32;
                g_tm.onsetAt  = millis();
                Serial.printf("[assist] 检测到说话 rms=%d\n", rms);
            } else {
                waitedMs += 32;
                if (waitedMs - lastWaitLogMs >= 1000) {          // 每秒报一次电平，方便调阈值
                    lastWaitLogMs = waitedMs;
                    Serial.printf("[assist] 等待说话… rms=%d (阈值 %d)\n", rms, threshold);
                }
                if (waitedMs >= WAIT_SPEECH_MS) {
                    Serial.println("[assist] 超时没检测到说话，取消");
                    return 0;
                }
            }
        } else if (over) {
            speechMs += 32;
            silenceMs = 0;
        } else {
            silenceMs += 32;
            if (silenceMs >= SILENCE_END_MS) break;              // 说完了
        }
    }
    if (!speech) return 0;
    g_tm.recEndAt = millis();
    if (speechMs < MIN_SPEECH_MS) {                              // 短促声响 → 杂音
        Serial.printf("[assist] 有效语音仅 %lums，按杂音丢弃\n", (unsigned long)speechMs);
        return 0;
    }
    Serial.printf("[assist] 录音 %.1fs（有效语音 %.1fs）\n",
                  (float)len / REC_RATE, speechMs / 1000.0f);
    return len;
}

// ── 读 HTTP 响应里的音频（PSRAM，调用方负责 free；/chat 与 /prompt 共用）──
static uint8_t* readAudioBody(HTTPClient& http, size_t* outBytes, int* outRate) {
    *outRate = http.header("X-Sample-Rate").toInt();
    if (*outRate <= 0) *outRate = 24000;

    int contentLen = http.getSize();  // -1 = chunked
    size_t cap = (contentLen > 0) ? (size_t)contentLen : RESP_MAX_BYTES;
    if (cap > RESP_MAX_BYTES) { Serial.println("[assist] 音频过大"); return nullptr; }

    uint8_t* buf = (uint8_t*)heap_caps_malloc(cap, MALLOC_CAP_SPIRAM);
    if (!buf) { Serial.println("[assist] PSRAM 分配失败"); return nullptr; }

    WiFiClient* stream = http.getStreamPtr();
    size_t got = 0;
    uint32_t lastData = millis();
    while (http.connected() && got < cap && millis() - lastData < 15000) {
        size_t avail = stream->available();
        if (!avail) { vTaskDelay(pdMS_TO_TICKS(5)); continue; }
        int n = stream->readBytes(buf + got, min(avail, cap - got));
        if (n > 0) { got += n; lastData = millis(); }
        if (contentLen > 0 && got >= (size_t)contentLen) break;
    }
    if (got < 4800) { free(buf); Serial.println("[assist] 音频太短/下载失败"); return nullptr; }
    *outBytes = got;
    return buf;
}

// ── 上传录音，流式接收 TTS 并边下边播（server 流式合成，首块 ~0.5s 出声）──
// 3 个 0.5s 缓冲轮转：M5.Speaker 每通道有 2 个排队槽，往第 3 个缓冲写入时
// 它上一轮的内容必然已播完，不会覆盖正在播的数据。
static bool uploadAndStreamPlay(const String& serverUrl, size_t recSamples) {
    HTTPClient http;
    http.setTimeout(HTTP_TIMEOUT_MS);
    http.setConnectTimeout(5000);
    if (!http.begin(serverUrl + "/chat")) { Serial.println("[assist] URL 非法"); return false; }
    http.addHeader("Content-Type", "application/octet-stream");
    http.addHeader("X-Device-Id", WiFi.macAddress());
    const char* keys[] = {"X-Sample-Rate", "X-Playback"};
    http.collectHeaders(keys, 2);

    int code = http.POST((uint8_t*)s_recBuf, recSamples * sizeof(int16_t));
    g_tm.headerAt = millis();  // 响应头到手：本地播≈STT 完成；远端播=server 全部处理完
    if (code != 200) {
        Serial.printf("[assist] server 返回 %d %s\n", code, http.errorToString(code).c_str());
        http.end();
        return false;
    }
    if (http.header("X-Playback") == "remote") {  // App 里选了外部音箱，server 已推给 HA
        g_tm.remotePlay = true;
        http.end();
        Serial.println("[assist] 本轮由外部音箱播报");
        return true;
    }
    int rate = http.header("X-Sample-Rate").toInt();
    if (rate <= 0) rate = 24000;
    int contentLen = http.getSize();  // 流式响应为 -1（chunked）

    static uint8_t* bufs[3] = {nullptr, nullptr, nullptr};
    const size_t BUF_BYTES = 24000;   // 0.5s @24kHz 单声道
    for (auto& b : bufs) {
        if (!b) b = (uint8_t*)heap_caps_malloc(BUF_BYTES + 1, MALLOC_CAP_SPIRAM);
    }
    if (!bufs[0] || !bufs[1] || !bufs[2]) {
        Serial.println("[assist] 播放缓冲分配失败");
        http.end();
        return false;
    }

    WiFiClient* stream = http.getStreamPtr();
    int      bi        = 0;
    size_t   total     = 0;
    bool     speakerOn = false;
    uint8_t  carry     = 0;      // PCM16 跨块的奇数字节（网络分块不保证 2 字节对齐）
    bool     hasCarry  = false;
    uint32_t lastData  = millis();

    for (;;) {
        uint8_t* buf = bufs[bi];
        size_t   got = 0;
        if (hasCarry) { buf[got++] = carry; hasCarry = false; }

        while (got < BUF_BYTES) {                       // 填满一个缓冲或流结束
            if (millis() - lastData > 15000) break;     // 数据断流超时
            size_t avail = stream->available();
            if (!avail) {
                if (!http.connected()) break;
                // 数据暂歇（LLM 正在生成下一句）→ 先播已有的，减少句间卡顿
                if (got >= 2 && millis() - lastData > 120) break;
                vTaskDelay(pdMS_TO_TICKS(3));
                continue;
            }
            int n = stream->readBytes(buf + got, min(avail, BUF_BYTES - got));
            if (n > 0) { got += n; total += n; lastData = millis(); }
            if (contentLen > 0 && total >= (size_t)contentLen) break;
        }
        if (got & 1) { carry = buf[--got]; hasCarry = true; }
        if (got < 2) break;                             // 流结束

        if (!speakerOn) {                               // 首块到手才切扬声器
            g_tm.firstAudioAt = millis();
            M5.Mic.end();
            M5.Speaker.begin();
            M5.Speaker.setVolume(SPEAK_VOLUME);
            speakerOn = true;
            s_state   = AS_SPEAK;
        }
        while (M5.Speaker.isPlaying(0) >= 2) vTaskDelay(pdMS_TO_TICKS(10));  // 等排队槽空出
        M5.Speaker.playRaw((const int16_t*)buf, got / 2, rate, false, 1, 0);
        bi = (bi + 1) % 3;
        if (total > RESP_MAX_BYTES) { Serial.println("[assist] 音频超限，截断"); break; }
    }
    http.end();

    if (speakerOn) {
        while (M5.Speaker.isPlaying()) vTaskDelay(pdMS_TO_TICKS(50));
        g_tm.playEndAt = millis();
        M5.Speaker.end();
        M5.Mic.begin();
        Serial.printf("[assist] 播报完成 %.1fs @%dHz\n", (float)total / 2 / rate, rate);
    }
    return total >= 4800;
}

// ── 唤醒提示音：空闲时从 server 预取「我在听」，缓存 PSRAM ─────────
static void maybePrefetchPrompt() {
    String url = wifiBleGetServerUrl();
    if (!url.length() || WiFi.status() != WL_CONNECTED) return;
    if (s_promptBuf && s_promptFromUrl == url) return;            // 已缓存且地址没变
    // 限频重试；s_promptLastTryAt==0 表示从没试过 → Wi-Fi 一连上立刻取
    // （曾把「没试过」也当「刚试过」，开机 30s 内唤醒必然没有提示音）
    if (s_promptLastTryAt && millis() - s_promptLastTryAt < PROMPT_RETRY_MS) return;
    s_promptLastTryAt = millis();

    HTTPClient http;
    http.setTimeout(20000);
    http.setConnectTimeout(5000);
    if (!http.begin(url + "/prompt")) return;
    const char* keys[] = {"X-Sample-Rate"};
    http.collectHeaders(keys, 1);
    int code = http.GET();
    if (code != 200) {
        Serial.printf("[assist] 提示音获取失败 %d\n", code);
        http.end();
        return;
    }
    size_t bytes = 0;
    int    rate  = 24000;
    uint8_t* buf = readAudioBody(http, &bytes, &rate);
    http.end();
    if (!buf) return;

    if (s_promptBuf) free(s_promptBuf);
    s_promptBuf     = buf;
    s_promptBytes   = bytes;
    s_promptRate    = rate;
    s_promptFromUrl = url;
    Serial.printf("[assist] 提示音已缓存 %.1fs\n", (float)bytes / 2 / rate);
}

// ── 播放（I2S 麦→扬→麦）─────────────────────────────────────────
static void playPcm(uint8_t* pcm, size_t bytes, int rate) {
    M5.Mic.end();
    M5.Speaker.begin();
    M5.Speaker.setVolume(SPEAK_VOLUME);
    M5.Speaker.playRaw((const int16_t*)pcm, bytes / 2, rate, false, 1, 0, true);
    while (M5.Speaker.isPlaying()) vTaskDelay(pdMS_TO_TICKS(50));
    M5.Speaker.end();
    M5.Mic.begin();
}

// 问 server：提示音是否由外部音箱播报（App 里选了 HA 音箱时 server 直接推给音箱）
// 请求失败/超时按「本地播」处理，不影响对话
static bool requestRemotePrompt(const String& serverUrl) {
    HTTPClient http;
    http.setTimeout(4000);
    http.setConnectTimeout(2000);
    if (!http.begin(serverUrl + "/prompt/play")) return false;
    int    code = http.POST("");
    String body = (code == 200) ? http.getString() : String();
    http.end();
    return body.indexOf("\"remote\":true") >= 0;
}

// ── 一轮对话 ─────────────────────────────────────────────────────
static void runOnce() {
    g_tm = InteractionTiming{};
    g_tm.wakeAt = s_wakeAtMs;
    g_tm.trigAt = millis();

    String serverUrl = wifiBleGetServerUrl();
    if (WiFi.status() != WL_CONNECTED || !serverUrl.length()) {
        Serial.println(serverUrl.length() ? "[assist] Wi-Fi 未连接，跳过"
                                          : "[assist] 未配置服务器地址（手机App里设置），跳过");
        return;
    }

    s_state = AS_LISTEN;
    if (!waitWakeAck()) { s_state = AS_IDLE; return; }

    // 提示音协商：唤醒时预协商过就直接用结果，不再重复请求
    bool     remotePrompt;
    uint32_t pushedAt;  // 音箱推送发起时刻（算剩余等待用）
    uint32_t t;
    if (s_preAt && millis() - s_preAt < 6000) {
        remotePrompt     = s_preRemote;
        pushedAt         = s_preAt;
        g_tm.promptNegMs = s_preNegMs;
    } else {
        t = millis();
        remotePrompt     = requestRemotePrompt(serverUrl);
        g_tm.promptNegMs = millis() - t;
        pushedAt         = millis();
    }
    s_preAt = 0;  // 结果一次性使用
    g_tm.promptRemote = remotePrompt;

    int threshold;
    if (remotePrompt) {
        // 「我在听」由外部音箱播报：从推送发起算 ~1.5s 出声，预协商已提前走掉
        // 部分等待；随后在音箱说话期间测底噪——阈值被音箱声抬高，
        // 顺带抑制音箱串进机器人麦克风造成误触发
        const uint32_t SPEAKER_LATENCY_MS = 1500;
        uint32_t since = millis() - pushedAt;
        t = millis();
        if (since < SPEAKER_LATENCY_MS) vTaskDelay(pdMS_TO_TICKS(SPEAKER_LATENCY_MS - since));
        g_tm.promptMs = millis() - t;
        t = millis();
        threshold = measureThreshold();
        g_tm.noiseMs = millis() - t;
    } else {
        t = millis();
        threshold = measureThreshold();  // ★播提示音之前测底噪（用户还没开口）
        g_tm.noiseMs = millis() - t;
        t = millis();
        if (s_promptBuf && s_promptFromUrl == serverUrl) {
            playPcm(s_promptBuf, s_promptBytes, s_promptRate);  // 「我在听」
        } else {
            // 常见原因：server 没重启（无 /prompt 接口，预取 404）或还没连上
            Serial.println("[assist] 提示音未缓存，跳过（看上方是否有『提示音获取失败』日志）");
        }
        g_tm.promptMs = millis() - t;
    }
    size_t samples = recordUtterance(threshold);
    if (!samples) { s_state = AS_IDLE; printTiming(); return; }

    s_state = AS_THINK;
    bool ok = uploadAndStreamPlay(serverUrl, samples);  // 内部拿到首块音频即转 AS_SPEAK
    printTiming();
    if (!ok) {
        s_state = AS_ERROR;
        vTaskDelay(pdMS_TO_TICKS(2000));  // 屏幕短暂显示 error
        s_state = AS_IDLE;
        return;
    }
    s_state = AS_IDLE;
}

static void assistantTask(void*) {
    for (;;) {
        if (!s_trigger) {
            if (s_prePromptReq) {   // 唤醒瞬间的预协商：与点头动画并行
                s_prePromptReq = false;
                String url = wifiBleGetServerUrl();
                if (url.length() && WiFi.status() == WL_CONNECTED) {
                    uint32_t t   = millis();
                    s_preRemote  = requestRemotePrompt(url);
                    s_preNegMs   = millis() - t;
                    s_preAt      = millis();
                    if (s_preRemote) Serial.println("[assist] 提示音已提前推送音箱");
                } else {
                    s_preAt = 0;
                }
            }
            maybePrefetchPrompt();  // 空闲时预取提示音，唤醒后即刻可播
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }
        s_trigger = false;
        runOnce();
    }
}

void assistantSetup() {
    s_recBuf = (int16_t*)heap_caps_malloc(REC_MAX_SAMPLES * sizeof(int16_t), MALLOC_CAP_SPIRAM);
    if (!s_recBuf) {
        Serial.println("[assist] 录音缓冲分配失败（PSRAM 未启用？），语音助手不可用");
        return;
    }
    // core0 prio 4：与 wakeTask(5) 同核但互斥运行（busy 时 wake 暂停）
    xTaskCreatePinnedToCore(assistantTask, "assist", 10240, nullptr, 4, nullptr, 0);
    Serial.println("[assist] 就绪：唤醒→倾听→对话");
}
