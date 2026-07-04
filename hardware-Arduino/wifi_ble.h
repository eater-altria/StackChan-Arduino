/*
  wifi_ble.h —— BLE Wi-Fi 配网 + 状态查询（配套 app-RN 手机 App）
  ---------------------------------------------------------------
  职责：
  - 开机以 "StackChan-XXXX" 广播 BLE GATT 服务，等手机 App 连接；
  - App 可触发 Wi-Fi 扫描（结果经 BLE 通知回传）、下发 SSID/密码让机器人联网；
  - 连接成功的凭据存 NVS(Preferences)，下次开机自动重连；
  - 向 UI 提供 wifiBleGetInfo() 查询当前 Wi-Fi / BLE 状态（右滑信息页用）。

  协议（与 app-RN/src/ble/protocol.ts 必须保持一致）：
  - 服务 8e400001-...，特征 CMD(写)/DATA(通知)/STAT(读+通知)；
  - 消息为 UTF-8 文本，字段用 \x1F 分隔，每条消息以 \n 结尾；
  - App→机器人 (CMD)：SCAN / CONNECT<US>ssid<US>pwd / FORGET / STATUS / SERVER<US>url
  - 机器人→App (DATA)：SCAN_BEGIN<US>n、AP<US>ssid<US>rssi<US>sec<US>ch ×n、SCAN_END、SCAN_FAIL
  - 机器人→App (STAT)：WIFI<US>state<US>ssid<US>ip<US>rssi<US>serverUrl，
    state ∈ IDLE|CONNECTING|CONNECTED|FAIL；serverUrl 为语音助手后端地址（可为空）
*/
#pragma once
#include <Arduino.h>

struct WifiInfo {
    bool   bleConnected;  // 手机 App 是否已连上 BLE
    String bleName;       // BLE 广播名 StackChan-XXXX
    String state;         // IDLE | CONNECTING | CONNECTED | FAIL
    String ssid;          // 当前/目标 SSID
    String ip;            // 已连接时的 IP
    int    rssi;          // 已连接时的信号强度 dBm
    String mac;           // 本机 WiFi MAC
    String savedSsid;     // NVS 里保存的 SSID（开机自动重连用）
    String serverUrl;     // 语音助手后端地址（assistant-server，手机 App 配置）
};

void     wifiBleSetup();          // setup() 里调（wakenetSetup 之后）
void     wifiBleLoop();           // loop() 里每圈调，非阻塞
WifiInfo wifiBleGetInfo();        // UI 查询当前状态
String   wifiBleGetServerUrl();   // assistant 模块取服务器地址（线程安全）
