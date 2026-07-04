/**
 * StackChanBLE —— react-native-ble-plx 封装
 *
 * 职责：蓝牙权限、扫描 StackChan 设备（按服务 UUID 过滤）、连接（请求大 MTU）、
 * 订阅通知（按 \n 重组消息）、发送命令。UI 只跟这个类打交道。
 */
import { PermissionsAndroid, Platform } from 'react-native';
import {
  BleManager,
  Device,
  State,
  Subscription,
} from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import {
  WIFI_SERVICE,
  CHAR_CMD,
  CHAR_DATA,
  CHAR_STAT,
  RobotWifiStatus,
  ScanEvent,
  parseStatusLine,
  parseScanLine,
} from './protocol';

export interface RobotHandlers {
  onStatus: (status: RobotWifiStatus) => void;
  onScanEvent: (event: ScanEvent) => void;
  onDisconnect: () => void;
}

const toBase64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const fromBase64 = (b64: string) => Buffer.from(b64, 'base64').toString('utf8');

export class StackChanBLE {
  readonly manager = new BleManager();
  private device: Device | null = null;
  private subs: Subscription[] = [];
  private dataBuf = '';
  private statBuf = '';

  /** Android 12+ 需要 BLUETOOTH_SCAN/CONNECT，旧版本需要定位权限；iOS 系统自动弹窗 */
  async requestPermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') {
      return true;
    }
    if (Platform.Version >= 31) {
      const res = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]);
      return Object.values(res).every(
        v => v === PermissionsAndroid.RESULTS.GRANTED,
      );
    }
    const res = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    );
    return res === PermissionsAndroid.RESULTS.GRANTED;
  }

  /** 等蓝牙打开（用户关着蓝牙时给出明确提示的机会） */
  async waitPoweredOn(timeoutMs = 5000): Promise<boolean> {
    if ((await this.manager.state()) === State.PoweredOn) {
      return true;
    }
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => {
        sub.remove();
        resolve(false);
      }, timeoutMs);
      const sub = this.manager.onStateChange(state => {
        if (state === State.PoweredOn) {
          clearTimeout(timer);
          sub.remove();
          resolve(true);
        }
      }, true);
    });
  }

  /** 扫描广播 StackChan 配网服务的设备 */
  startRobotScan(onFound: (device: Device) => void, onError: (msg: string) => void) {
    this.manager.startDeviceScan([WIFI_SERVICE], null, (error, device) => {
      if (error) {
        onError(error.message);
        return;
      }
      if (device) {
        onFound(device);
      }
    });
  }

  stopRobotScan() {
    this.manager.stopDeviceScan();
  }

  get connectedDevice(): Device | null {
    return this.device;
  }

  /** 连接机器人：请求大 MTU → 发现服务 → 订阅 DATA/STAT → 读一次当前状态 */
  async connect(deviceId: string, handlers: RobotHandlers): Promise<Device> {
    this.stopRobotScan();
    await this.disconnect(); // 清掉旧连接

    const device = await this.manager.connectToDevice(deviceId, {
      requestMTU: 517, // 保证扫描结果一条通知发得完（iOS 忽略此参数，自动协商）
    });
    await device.discoverAllServicesAndCharacteristics();
    this.device = device;
    this.dataBuf = '';
    this.statBuf = '';

    this.subs.push(
      this.manager.onDeviceDisconnected(device.id, () => {
        this.cleanup();
        handlers.onDisconnect();
      }),
    );

    // 扫描结果通知（消息可能跨包，按 \n 重组）
    this.subs.push(
      device.monitorCharacteristicForService(WIFI_SERVICE, CHAR_DATA, (error, ch) => {
        if (error || !ch?.value) {
          return;
        }
        this.dataBuf += fromBase64(ch.value);
        this.dataBuf = drainLines(this.dataBuf, line => {
          const ev = parseScanLine(line);
          if (ev) {
            handlers.onScanEvent(ev);
          }
        });
      }),
    );

    // Wi-Fi 状态通知
    this.subs.push(
      device.monitorCharacteristicForService(WIFI_SERVICE, CHAR_STAT, (error, ch) => {
        if (error || !ch?.value) {
          return;
        }
        this.statBuf += fromBase64(ch.value);
        this.statBuf = drainLines(this.statBuf, line => {
          const st = parseStatusLine(line);
          if (st) {
            handlers.onStatus(st);
          }
        });
      }),
    );

    // 读一次当前状态（订阅只推变化，初始状态靠读）
    try {
      const ch = await device.readCharacteristicForService(WIFI_SERVICE, CHAR_STAT);
      if (ch.value) {
        const st = parseStatusLine(fromBase64(ch.value).replace(/\n$/, ''));
        if (st) {
          handlers.onStatus(st);
        }
      }
    } catch {
      // 读失败不致命，固件稍后会通过通知推送
    }

    return device;
  }

  async sendCommand(cmd: string): Promise<void> {
    if (!this.device) {
      throw new Error('未连接机器人');
    }
    await this.device.writeCharacteristicWithResponseForService(
      WIFI_SERVICE,
      CHAR_CMD,
      toBase64(cmd),
    );
  }

  async disconnect(): Promise<void> {
    const device = this.device;
    this.cleanup();
    if (device) {
      try {
        await this.manager.cancelDeviceConnection(device.id);
      } catch {
        // 已断开时会抛错，忽略
      }
    }
  }

  private cleanup() {
    this.subs.forEach(s => s.remove());
    this.subs = [];
    this.device = null;
    this.dataBuf = '';
    this.statBuf = '';
  }
}

/** 从缓冲区取出所有完整行（\n 结尾）逐行回调，返回剩余的不完整部分 */
function drainLines(buf: string, onLine: (line: string) => void): string {
  let idx: number;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.length) {
      onLine(line);
    }
  }
  return buf;
}
