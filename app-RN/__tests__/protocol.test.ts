/**
 * BLE 配网协议编解码测试（纯 TS，无原生依赖）
 * 协议定义须与固件 hardware-Arduino/wifi_ble.cpp 一致。
 */
import {
  US,
  buildConnectCmd,
  buildServerCmd,
  dedupeNetworks,
  parseScanLine,
  parseStatusLine,
} from '../src/ble/protocol';

describe('parseStatusLine', () => {
  it('解析已连接状态（带 serverUrl 字段）', () => {
    expect(
      parseStatusLine(
        `WIFI${US}CONNECTED${US}MyHome${US}192.168.1.23${US}-52${US}http://192.168.1.5:8300`,
      ),
    ).toEqual({
      state: 'CONNECTED',
      ssid: 'MyHome',
      ip: '192.168.1.23',
      rssi: -52,
      serverUrl: 'http://192.168.1.5:8300',
    });
  });

  it('兼容无 serverUrl 的旧固件消息', () => {
    expect(parseStatusLine(`WIFI${US}CONNECTED${US}MyHome${US}192.168.1.23${US}-52`)).toEqual({
      state: 'CONNECTED',
      ssid: 'MyHome',
      ip: '192.168.1.23',
      rssi: -52,
      serverUrl: '',
    });
  });

  it('拒绝非法消息', () => {
    expect(parseStatusLine('GARBAGE')).toBeNull();
    expect(parseStatusLine(`WIFI${US}WEIRD${US}x${US}y${US}0`)).toBeNull();
  });
});

describe('parseScanLine', () => {
  it('解析 AP 记录', () => {
    expect(parseScanLine(`AP${US}Cafe Wi-Fi${US}-70${US}1${US}6`)).toEqual({
      type: 'ap',
      network: { ssid: 'Cafe Wi-Fi', rssi: -70, secure: true, channel: 6 },
    });
  });

  it('解析扫描边界消息', () => {
    expect(parseScanLine(`SCAN_BEGIN${US}12`)).toEqual({ type: 'begin', count: 12 });
    expect(parseScanLine('SCAN_END')).toEqual({ type: 'end' });
    expect(parseScanLine('SCAN_FAIL')).toEqual({ type: 'fail' });
    expect(parseScanLine('NOPE')).toBeNull();
  });
});

describe('buildConnectCmd', () => {
  it('拼出固件期望的字段顺序', () => {
    expect(buildConnectCmd('MyHome', 'pass1234')).toBe(`CONNECT${US}MyHome${US}pass1234`);
  });
});

describe('buildServerCmd', () => {
  it('拼出 SERVER 命令并去掉首尾空白', () => {
    expect(buildServerCmd(' http://192.168.1.5:8300 ')).toBe(
      `SERVER${US}http://192.168.1.5:8300`,
    );
  });
});

describe('dedupeNetworks', () => {
  it('同名保留信号最强并按强度排序', () => {
    const out = dedupeNetworks([
      { ssid: 'A', rssi: -80, secure: true, channel: 1 },
      { ssid: 'B', rssi: -50, secure: false, channel: 6 },
      { ssid: 'A', rssi: -60, secure: true, channel: 11 },
    ]);
    expect(out.map(n => [n.ssid, n.rssi])).toEqual([
      ['B', -50],
      ['A', -60],
    ]);
  });
});
