# app-RN — StackChan 配网 App（React Native）

配套 **`hardware-Arduino/`** 固件的手机 App：通过 **BLE** 连接 StackChan 机器人，
让机器人扫描周围 Wi-Fi、下发 SSID/密码帮它联网。凭据存在机器人 NVS 里，之后开机自动重连。

> 与 `app/`（Flutter，对接 ESP-IDF 出厂固件 + Go 后端）完全独立，互不依赖。

## 功能

- 扫描附近广播配网服务的 StackChan（按服务 UUID 过滤，不会列出无关设备）；
- 连接后实时显示机器人 Wi-Fi 状态（未连接 / 连接中 / 已连接+IP+信号 / 失败）；
- 让机器人扫描 Wi-Fi → 列表选网络 → 输密码 → 下发连接，结果实时回推；
- 忘记网络（清除机器人上保存的凭据）；
- 配置**语音助手服务器地址**（电脑端 `../assistant-server/`，SERVER 命令写入机器人 NVS）。

## 代码结构

| 文件 | 职责 |
|------|------|
| `App.tsx` | 全部 UI（设备列表 → 配网页 → 密码弹窗），深色主题 |
| `src/ble/protocol.ts` | 协议常量与编解码（**与固件 `hardware-Arduino/wifi_ble.cpp` 必须一致**） |
| `src/ble/StackChanBLE.ts` | react-native-ble-plx 封装：权限、扫描、连接（请求 MTU 517）、按 `\n` 重组通知 |
| `__tests__/protocol.test.ts` | 协议编解码单元测试（`npm test`） |

## BLE 协议（改动需固件同步）

- 服务 `8e400001-f315-4f60-9fb8-838830daea50`，特征：CMD(写) / DATA(通知) / STAT(读+通知)；
- UTF-8 文本消息，字段用 `\x1F` 分隔、`\n` 结尾；
- App→机器人：`SCAN`、`CONNECT<US>ssid<US>pwd`、`FORGET`、`STATUS`、`SERVER<US>url`；
- 机器人→App：`SCAN_BEGIN/AP/SCAN_END/SCAN_FAIL`（DATA）、
  `WIFI<US>state<US>ssid<US>ip<US>rssi<US>serverUrl`（STAT，末位为语音助手服务器地址）。

## 环境与运行

需要 Node ≥ 22、iOS 侧 Xcode + CocoaPods、Android 侧 Android Studio（RN 0.86 标准环境，
参见 [RN 官方环境搭建](https://reactnative.dev/docs/set-up-your-environment)）。

```bash
npm install

# iOS（首次和原生依赖变化后需要装 Pods）
cd ios && bundle install && bundle exec pod install && cd ..
npm run ios

# Android
npm run android

# 静态检查与测试
npx tsc --noEmit
npm run lint
npm test
```

> ⚠️ **BLE 必须真机运行**，iOS 模拟器 / Android 模拟器都没有蓝牙。
> 权限已配好：Android 12+ 的 `BLUETOOTH_SCAN/CONNECT`（旧版本回退定位权限，运行时会弹窗），
> iOS 的 `NSBluetoothAlwaysUsageDescription`。

## 使用流程

1. 机器人烧好 `hardware-Arduino` 固件并开机（串口应打印 `[ble] 广播中：StackChan-XXXX`）；
2. App 点「扫描附近的机器人」→ 点设备连接；
3. 点「让机器人扫描 Wi-Fi」→ 选网络 → 输密码 → 连接；
4. 状态卡片变绿（已连接+IP）即成功；机器人屏幕**右滑**也能看到同样的 Wi-Fi 信息。
