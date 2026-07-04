/**
 * StackChan BLE 配网协议 —— 与固件 hardware-Arduino/wifi_ble.cpp 必须保持一致
 *
 * 消息为 UTF-8 文本：字段用 \x1F (US) 分隔，每条消息以 \n 结尾。
 * - App → 机器人 (CHAR_CMD 写)：SCAN / CONNECT<US>ssid<US>pwd / FORGET / STATUS / SERVER<US>url
 * - 机器人 → App (CHAR_DATA 通知)：SCAN_BEGIN<US>n、AP<US>ssid<US>rssi<US>sec<US>ch、SCAN_END、SCAN_FAIL
 * - 机器人 → App (CHAR_STAT 读+通知)：WIFI<US>state<US>ssid<US>ip<US>rssi<US>serverUrl
 *   （serverUrl 为语音助手后端地址，可为空；旧固件无此字段，解析时兼容）
 */

export const WIFI_SERVICE = '8e400001-f315-4f60-9fb8-838830daea50';
export const CHAR_CMD = '8e400002-f315-4f60-9fb8-838830daea50';
export const CHAR_DATA = '8e400003-f315-4f60-9fb8-838830daea50';
export const CHAR_STAT = '8e400004-f315-4f60-9fb8-838830daea50';

export const US = '\x1f';

export type RobotWifiState = 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'FAIL';

export interface RobotWifiStatus {
  state: RobotWifiState;
  ssid: string;
  ip: string;
  rssi: number;
  /** 语音助手后端地址（assistant-server），空串 = 未配置 */
  serverUrl: string;
}

export interface WifiNetwork {
  ssid: string;
  rssi: number;
  secure: boolean;
  channel: number;
}

export type ScanEvent =
  | { type: 'begin'; count: number }
  | { type: 'ap'; network: WifiNetwork }
  | { type: 'end' }
  | { type: 'fail' };

export const buildScanCmd = (): string => 'SCAN';
export const buildStatusCmd = (): string => 'STATUS';
export const buildForgetCmd = (): string => 'FORGET';
export const buildConnectCmd = (ssid: string, password: string): string =>
  `CONNECT${US}${ssid}${US}${password}`;
export const buildServerCmd = (url: string): string => `SERVER${US}${url.trim()}`;

/** 解析 CHAR_STAT 的一行状态消息（不含末尾 \n），非法消息返回 null */
export function parseStatusLine(line: string): RobotWifiStatus | null {
  const f = line.split(US);
  if (f[0] !== 'WIFI' || f.length < 5) {
    return null;
  }
  const state = f[1] as RobotWifiState;
  if (!['IDLE', 'CONNECTING', 'CONNECTED', 'FAIL'].includes(state)) {
    return null;
  }
  return {
    state,
    ssid: f[2],
    ip: f[3],
    rssi: Number(f[4]) || 0,
    serverUrl: f[5] ?? '', // 旧固件消息只有 5 个字段
  };
}

/** 解析 CHAR_DATA 的一行扫描消息（不含末尾 \n），非法消息返回 null */
export function parseScanLine(line: string): ScanEvent | null {
  const f = line.split(US);
  switch (f[0]) {
    case 'SCAN_BEGIN':
      return { type: 'begin', count: Number(f[1]) || 0 };
    case 'AP':
      if (f.length < 5) {
        return null;
      }
      return {
        type: 'ap',
        network: {
          ssid: f[1],
          rssi: Number(f[2]) || 0,
          secure: f[3] === '1',
          channel: Number(f[4]) || 0,
        },
      };
    case 'SCAN_END':
      return { type: 'end' };
    case 'SCAN_FAIL':
      return { type: 'fail' };
    default:
      return null;
  }
}

/** 同名 SSID 去重（保留信号最强的），并按信号从强到弱排序 */
export function dedupeNetworks(list: WifiNetwork[]): WifiNetwork[] {
  const best = new Map<string, WifiNetwork>();
  for (const n of list) {
    const prev = best.get(n.ssid);
    if (!prev || n.rssi > prev.rssi) {
      best.set(n.ssid, n);
    }
  }
  return [...best.values()].sort((a, b) => b.rssi - a.rssi);
}
