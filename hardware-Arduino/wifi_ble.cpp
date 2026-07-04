/*
  wifi_ble.cpp —— 实现见 wifi_ble.h 顶部说明
  ------------------------------------------
  设计要点：
  - BLE 回调（协议栈任务上下文）里不做任何耗时事：命令拷进 FreeRTOS 队列，
    统一在 loop 的 wifiBleLoop() 里处理，避免和 core0 的 wake 任务抢时间；
  - Wi-Fi 扫描用异步 scanNetworks(true)，loop 里轮询 scanComplete()，全程不阻塞；
  - 用板包自带 BLE 库（3.3.7 底层是 NimBLE，省内存），零额外库依赖。
    NimBLE 对 NOTIFY 特征自动创建 0x2902 描述符，不要手动 addDescriptor(BLE2902)（已废弃）。
*/
#include "wifi_ble.h"
#include <WiFi.h>
#include <Preferences.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

// UUID —— 与 app-RN/src/ble/protocol.ts 保持一致
static const char* SVC_UUID  = "8e400001-f315-4f60-9fb8-838830daea50";
static const char* CMD_UUID  = "8e400002-f315-4f60-9fb8-838830daea50";  // App 写命令
static const char* DATA_UUID = "8e400003-f315-4f60-9fb8-838830daea50";  // 通知：扫描结果
static const char* STAT_UUID = "8e400004-f315-4f60-9fb8-838830daea50";  // 读+通知：Wi-Fi 状态

static const char US = '\x1f';  // 字段分隔符（SSID 里几乎不可能出现）

// ── BLE 对象与连接状态 ────────────────────────────────────────────
static BLEServer*         s_server  = nullptr;
static BLECharacteristic* s_chData  = nullptr;
static BLECharacteristic* s_chStat  = nullptr;
static volatile bool      s_bleConnected = false;
static String             s_bleName;

// ── 命令队列（BLE 写回调 → loop 处理）────────────────────────────
struct CmdMsg { char data[160]; };  // CONNECT+ssid(32)+pwd(64) 最长约 106 字节
static QueueHandle_t s_cmdQueue = nullptr;

// ── Wi-Fi 状态机 ─────────────────────────────────────────────────
enum WifiState { W_IDLE, W_CONNECTING, W_CONNECTED, W_FAIL };
static WifiState     s_state = W_IDLE;
static String        s_targetSsid, s_targetPwd;  // 正在尝试连接的目标
static unsigned long s_connectStartAt = 0;
static bool          s_scanQueued = false;
static bool          s_scanning   = false;
static unsigned long s_lastPollAt = 0;
static Preferences   s_prefs;

// 语音助手 server 地址：loop 任务写（SERVER 命令），assistant 任务读 → 加锁
static String            s_serverUrl;
static SemaphoreHandle_t s_serverUrlMutex = nullptr;

String wifiBleGetServerUrl() {
    if (!s_serverUrlMutex) return String();  // wifiBleSetup 之前调用
    xSemaphoreTake(s_serverUrlMutex, portMAX_DELAY);
    String url = s_serverUrl;
    xSemaphoreGive(s_serverUrlMutex);
    return url;
}

static void setServerUrl(const String& url) {
    if (!s_serverUrlMutex) { s_serverUrl = url; return; }
    xSemaphoreTake(s_serverUrlMutex, portMAX_DELAY);
    s_serverUrl = url;
    xSemaphoreGive(s_serverUrlMutex);
}

static const unsigned long CONNECT_TIMEOUT_MS = 20000;
static const unsigned long POLL_INTERVAL_MS   = 300;

static const char* stateToken(WifiState st) {
    switch (st) {
        case W_CONNECTING: return "CONNECTING";
        case W_CONNECTED:  return "CONNECTED";
        case W_FAIL:       return "FAIL";
        default:           return "IDLE";
    }
}

// ── 发送辅助 ─────────────────────────────────────────────────────
// DATA 特征发一条消息；notify 之间留间隔，避免 Bluedroid 队列拥塞丢包
static void bleNotifyData(const String& line) {
    if (!s_chData || !s_bleConnected) return;
    String msg = line + "\n";
    s_chData->setValue(msg);
    s_chData->notify();
    vTaskDelay(pdMS_TO_TICKS(15));
}

// 更新 STAT 特征的可读值并（若 App 在线）通知
static void pushStatus() {
    if (!s_chStat) return;
    String ssid = (s_state == W_CONNECTED) ? WiFi.SSID() : s_targetSsid;
    String ip   = (s_state == W_CONNECTED) ? WiFi.localIP().toString() : "";
    int    rssi = (s_state == W_CONNECTED) ? WiFi.RSSI() : 0;
    String msg  = String("WIFI") + US + stateToken(s_state) + US + ssid + US + ip + US + String(rssi) +
                  US + wifiBleGetServerUrl() + "\n";
    s_chStat->setValue(msg);
    if (s_bleConnected) s_chStat->notify();
    Serial.printf("[wifi] %s", msg.c_str());
}

// ── 命令处理（loop 上下文）───────────────────────────────────────
static void startConnect(const String& ssid, const String& pwd) {
    s_targetSsid = ssid;
    s_targetPwd  = pwd;
    WiFi.disconnect();
    WiFi.begin(ssid.c_str(), pwd.length() ? pwd.c_str() : nullptr);
    s_state          = W_CONNECTING;
    s_connectStartAt = millis();
    pushStatus();
}

static void handleCommand(const String& cmd) {
    Serial.printf("[ble] cmd: %s\n", cmd.c_str());
    if (cmd == "SCAN") {
        s_scanQueued = true;
    } else if (cmd.startsWith(String("CONNECT") + US)) {
        int p1 = cmd.indexOf(US);
        int p2 = cmd.indexOf(US, p1 + 1);
        if (p1 < 0 || p2 < 0) return;
        String ssid = cmd.substring(p1 + 1, p2);
        String pwd  = cmd.substring(p2 + 1);
        if (ssid.length()) startConnect(ssid, pwd);
    } else if (cmd.startsWith(String("SERVER") + US)) {
        String url = cmd.substring(cmd.indexOf(US) + 1);
        url.trim();
        while (url.endsWith("/")) url.remove(url.length() - 1);
        if (url.length() && !url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://" + url;
        }
        setServerUrl(url);
        s_prefs.begin("wifi", false);
        s_prefs.putString("server", url);
        s_prefs.end();
        Serial.printf("[assist] 服务器地址已设为: %s\n", url.c_str());
        pushStatus();  // 回推带新地址的状态，App 立即看到
    } else if (cmd == "FORGET") {
        s_prefs.begin("wifi", false);
        s_prefs.clear();
        s_prefs.end();
        WiFi.disconnect();
        s_targetSsid = "";
        s_state = W_IDLE;
        pushStatus();
    } else if (cmd == "STATUS") {
        pushStatus();
    }
}

// ── BLE 回调 ─────────────────────────────────────────────────────
class CmdCallbacks : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic* ch) override {
        String v = ch->getValue();
        if (!v.length() || !s_cmdQueue) return;
        CmdMsg msg;
        strlcpy(msg.data, v.c_str(), sizeof(msg.data));
        xQueueSend(s_cmdQueue, &msg, 0);  // 满了就丢，命令都可重发
    }
};

class ServerCallbacks : public BLEServerCallbacks {
    void onConnect(BLEServer*) override {
        s_bleConnected = true;
        Serial.println("[ble] App 已连接");
    }
    void onDisconnect(BLEServer* server) override {
        s_bleConnected = false;
        Serial.println("[ble] App 断开，恢复广播");
        server->startAdvertising();
    }
};

// ── 对外接口 ─────────────────────────────────────────────────────
void wifiBleSetup() {
    s_cmdQueue       = xQueueCreate(4, sizeof(CmdMsg));
    s_serverUrlMutex = xSemaphoreCreateMutex();

    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);

    // BLE 名：StackChan-<efuse MAC 高 16bit>
    uint64_t mac = ESP.getEfuseMac();
    char name[20];
    snprintf(name, sizeof(name), "StackChan-%04X", (uint16_t)(mac >> 32));
    s_bleName = name;

    BLEDevice::init(name);
    BLEDevice::setMTU(517);  // App 侧（Android）会请求大 MTU，扫描结果单条即可发完

    s_server = BLEDevice::createServer();
    s_server->setCallbacks(new ServerCallbacks());

    BLEService* svc = s_server->createService(SVC_UUID);

    BLECharacteristic* chCmd = svc->createCharacteristic(
        CMD_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
    chCmd->setCallbacks(new CmdCallbacks());

    s_chData = svc->createCharacteristic(DATA_UUID, BLECharacteristic::PROPERTY_NOTIFY);

    s_chStat = svc->createCharacteristic(
        STAT_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);

    svc->start();

    BLEAdvertising* adv = BLEDevice::getAdvertising();
    adv->addServiceUUID(SVC_UUID);
    adv->setScanResponse(true);
    adv->start();
    Serial.printf("[ble] 广播中：%s\n", name);

    // 加载保存的凭据与服务器地址
    s_prefs.begin("wifi", true);
    String ssid = s_prefs.getString("ssid", "");
    String pwd  = s_prefs.getString("pwd", "");
    setServerUrl(s_prefs.getString("server", ""));
    s_prefs.end();
    if (ssid.length()) {
        Serial.printf("[wifi] 自动重连保存的网络: %s\n", ssid.c_str());
        startConnect(ssid, pwd);
    } else {
        pushStatus();  // 初始化 STAT 可读值
    }
}

void wifiBleLoop() {
    // 1) 处理 App 命令
    if (s_cmdQueue) {
        CmdMsg msg;
        while (xQueueReceive(s_cmdQueue, &msg, 0) == pdTRUE) {
            handleCommand(String(msg.data));
        }
    }

    unsigned long now = millis();

    // 2) 启动排队的扫描（连接中不扫，避免打断握手）
    if (s_scanQueued && !s_scanning && s_state != W_CONNECTING) {
        s_scanQueued = false;
        s_scanning   = true;
        WiFi.scanNetworks(true);  // 异步
        Serial.println("[wifi] 开始扫描…");
    }

    // 3) 轮询扫描结果
    if (s_scanning) {
        int n = WiFi.scanComplete();
        if (n >= 0) {
            s_scanning = false;
            bleNotifyData(String("SCAN_BEGIN") + US + String(n));
            for (int i = 0; i < n; i++) {
                String ssid = WiFi.SSID(i);
                if (!ssid.length()) continue;  // 跳过隐藏网络
                int sec = (WiFi.encryptionType(i) == WIFI_AUTH_OPEN) ? 0 : 1;
                bleNotifyData(String("AP") + US + ssid + US + String(WiFi.RSSI(i)) + US +
                              String(sec) + US + String(WiFi.channel(i)));
            }
            bleNotifyData("SCAN_END");
            WiFi.scanDelete();
            Serial.printf("[wifi] 扫描完成：%d 个网络\n", n);
        } else if (n == WIFI_SCAN_FAILED) {
            s_scanning = false;
            bleNotifyData("SCAN_FAIL");
            Serial.println("[wifi] 扫描失败");
        }
    }

    // 4) 连接状态机（低频轮询即可）
    if (now - s_lastPollAt < POLL_INTERVAL_MS) return;
    s_lastPollAt = now;

    if (s_state == W_CONNECTING) {
        if (WiFi.status() == WL_CONNECTED) {
            s_state = W_CONNECTED;
            s_prefs.begin("wifi", false);  // 连接成功才保存凭据
            s_prefs.putString("ssid", s_targetSsid);
            s_prefs.putString("pwd", s_targetPwd);
            s_prefs.end();
            pushStatus();
        } else if (now - s_connectStartAt > CONNECT_TIMEOUT_MS) {
            WiFi.disconnect();
            s_state = W_FAIL;
            pushStatus();
        }
    } else if (s_state == W_CONNECTED && WiFi.status() != WL_CONNECTED) {
        // 掉线（autoReconnect 会在后台重试）
        s_state = W_CONNECTING;
        s_connectStartAt = now;
        pushStatus();
    } else if (s_state != W_CONNECTED && s_state != W_CONNECTING && WiFi.status() == WL_CONNECTED) {
        s_state = W_CONNECTED;  // autoReconnect 自己连上了
        pushStatus();
    }
}

WifiInfo wifiBleGetInfo() {
    WifiInfo info;
    info.bleConnected = s_bleConnected;
    info.bleName      = s_bleName;
    info.state        = stateToken(s_state);
    info.ssid         = (s_state == W_CONNECTED) ? WiFi.SSID() : s_targetSsid;
    info.ip           = (s_state == W_CONNECTED) ? WiFi.localIP().toString() : "";
    info.rssi         = (s_state == W_CONNECTED) ? WiFi.RSSI() : 0;
    info.mac          = WiFi.macAddress();
    info.serverUrl    = wifiBleGetServerUrl();
    s_prefs.begin("wifi", true);
    info.savedSsid    = s_prefs.getString("ssid", "");
    s_prefs.end();
    return info;
}
