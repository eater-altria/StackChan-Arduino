/**
 * StackChan 配网 App
 *
 * 流程：扫描附近的 StackChan（BLE，按配网服务 UUID 过滤）→ 连接 →
 *       让机器人扫描 Wi-Fi → 选网络输密码 → 下发凭据 → 实时显示连接结果。
 * 协议见 src/ble/protocol.ts（与固件 hardware-Arduino/wifi_ble.cpp 对应）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Device } from 'react-native-ble-plx';
import { StackChanBLE } from './src/ble/StackChanBLE';
import {
  RobotWifiStatus,
  WifiNetwork,
  buildConnectCmd,
  buildForgetCmd,
  buildScanCmd,
  buildServerCmd,
  dedupeNetworks,
} from './src/ble/protocol';

const ble = new StackChanBLE();

/** server /speakers 返回的 HA 音箱与当前播报输出（见 assistant-server/server.js） */
interface Speaker {
  entity_id: string;
  name: string;
  state: string;
}
interface OutputConfig {
  mode: 'robot' | 'ha';
  entityId: string;
  name: string;
}

const STATE_TEXT: Record<RobotWifiStatus['state'], string> = {
  IDLE: '未连接',
  CONNECTING: '连接中…',
  CONNECTED: '已连接',
  FAIL: '连接失败',
};

const STATE_COLOR: Record<RobotWifiStatus['state'], string> = {
  IDLE: '#8e8e93',
  CONNECTING: '#f0a020',
  CONNECTED: '#34c759',
  FAIL: '#ff3b30',
};

function signalBars(rssi: number): string {
  if (rssi >= -55) {
    return '▂▄▆█';
  }
  if (rssi >= -67) {
    return '▂▄▆';
  }
  if (rssi >= -78) {
    return '▂▄';
  }
  return '▂';
}

export default function App(): React.JSX.Element {
  // 阶段 1：找机器人
  const [robots, setRobots] = useState<Device[]>([]);
  const [scanningRobots, setScanningRobots] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  // 阶段 2：已连上机器人
  const [robot, setRobot] = useState<Device | null>(null);
  const [status, setStatus] = useState<RobotWifiStatus | null>(null);
  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [wifiScanning, setWifiScanning] = useState(false);
  const [pwdTarget, setPwdTarget] = useState<WifiNetwork | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  // 语音助手服务器地址（assistant-server）
  const [serverInput, setServerInput] = useState('');
  const [serverSaved, setServerSaved] = useState(false);
  // 播报设备（机器人本体 / HA 音箱）——App 直接调 server 的 HTTP 接口
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [outputCurrent, setOutputCurrent] = useState<OutputConfig | null>(null);
  const [speakersError, setSpeakersError] = useState<string | null>(null);
  const [outputBusy, setOutputBusy] = useState(false);

  const pendingAps = useRef<WifiNetwork[]>([]);
  const serverPrefilled = useRef(false);

  useEffect(() => {
    return () => {
      ble.stopRobotScan();
      ble.disconnect();
      ble.manager.destroy();
    };
  }, []);

  // ── 阶段 1：扫描 / 连接机器人 ──────────────────────────────────
  const startRobotScan = useCallback(async () => {
    setError(null);
    if (!(await ble.requestPermissions())) {
      setError('缺少蓝牙权限，请在系统设置中授权');
      return;
    }
    if (!(await ble.waitPoweredOn())) {
      setError('蓝牙未打开，请先打开手机蓝牙');
      return;
    }
    setRobots([]);
    setScanningRobots(true);
    ble.startRobotScan(
      device =>
        setRobots(prev =>
          prev.some(d => d.id === device.id) ? prev : [...prev, device],
        ),
      msg => {
        setScanningRobots(false);
        setError(`扫描失败：${msg}`);
      },
    );
    // 10 秒后自动停止
    setTimeout(() => {
      ble.stopRobotScan();
      setScanningRobots(false);
    }, 10000);
  }, []);

  const connectRobot = useCallback(async (device: Device) => {
    setConnectingId(device.id);
    setError(null);
    try {
      serverPrefilled.current = false;
      await ble.connect(device.id, {
        onStatus: st => {
          setStatus(st);
          if (!serverPrefilled.current && st.serverUrl) {
            serverPrefilled.current = true; // 输入框预填机器人当前配置，只填一次
            setServerInput(st.serverUrl);
          }
          if (st.state === 'FAIL') {
            setError('机器人连接该 Wi-Fi 失败，请检查密码后重试');
          }
        },
        onScanEvent: ev => {
          switch (ev.type) {
            case 'begin':
              pendingAps.current = [];
              break;
            case 'ap':
              pendingAps.current.push(ev.network);
              break;
            case 'end':
              setNetworks(dedupeNetworks(pendingAps.current));
              setWifiScanning(false);
              break;
            case 'fail':
              setWifiScanning(false);
              setError('机器人扫描 Wi-Fi 失败，请重试');
              break;
          }
        },
        onDisconnect: () => {
          setRobot(null);
          setStatus(null);
          setNetworks([]);
          setWifiScanning(false);
          setError('与机器人的蓝牙连接已断开');
        },
      });
      setScanningRobots(false);
      setRobot(device);
    } catch (e: any) {
      setError(`连接失败：${e?.message ?? e}`);
    } finally {
      setConnectingId(null);
    }
  }, []);

  // ── 阶段 2：Wi-Fi 扫描 / 配网 ──────────────────────────────────
  const scanWifi = useCallback(async () => {
    setError(null);
    setWifiScanning(true);
    setNetworks([]);
    try {
      await ble.sendCommand(buildScanCmd());
    } catch (e: any) {
      setWifiScanning(false);
      setError(`发送扫描命令失败：${e?.message ?? e}`);
    }
  }, []);

  const submitWifi = useCallback(async (net: WifiNetwork, pwd: string) => {
    setPwdTarget(null);
    setPassword('');
    setError(null);
    try {
      await ble.sendCommand(buildConnectCmd(net.ssid, pwd));
    } catch (e: any) {
      setError(`发送连接命令失败：${e?.message ?? e}`);
    }
  }, []);

  const onPickNetwork = useCallback(
    (net: WifiNetwork) => {
      if (net.secure) {
        setPassword('');
        setPwdTarget(net);
      } else {
        submitWifi(net, '');
      }
    },
    [submitWifi],
  );

  // ── 播报设备：从 server 拉音箱列表 / 保存选择 ──────────────────
  const loadSpeakers = useCallback(async (serverUrl: string) => {
    setSpeakersError(null);
    try {
      const r = await fetch(`${serverUrl}/speakers`);
      const j = await r.json();
      if (j.error) {
        throw new Error(j.error);
      }
      setSpeakers(j.speakers ?? []);
      setOutputCurrent(j.current ?? null);
    } catch (e: any) {
      setSpeakersError(`获取音箱列表失败：${e?.message ?? e}（确认 server 已启动）`);
    }
  }, []);

  useEffect(() => {
    if (robot && status?.serverUrl) {
      loadSpeakers(status.serverUrl);
    }
  }, [robot, status?.serverUrl, loadSpeakers]);

  const chooseOutput = useCallback(
    async (target: { mode: 'robot' | 'ha'; entityId?: string; name?: string }) => {
      if (!status?.serverUrl) {
        return;
      }
      setOutputBusy(true);
      setSpeakersError(null);
      try {
        const r = await fetch(`${status.serverUrl}/output`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(target),
        });
        const j = await r.json();
        if (j.error) {
          throw new Error(j.error);
        }
        setOutputCurrent(j.current);
      } catch (e: any) {
        setSpeakersError(`设置播报设备失败：${e?.message ?? e}`);
      } finally {
        setOutputBusy(false);
      }
    },
    [status?.serverUrl],
  );

  const saveServer = useCallback(async () => {
    setError(null);
    setServerSaved(false);
    try {
      await ble.sendCommand(buildServerCmd(serverInput));
      setServerSaved(true); // 机器人会回推带新地址的状态
    } catch (e: any) {
      setError(`保存服务器地址失败：${e?.message ?? e}`);
    }
  }, [serverInput]);

  const forgetWifi = useCallback(() => {
    Alert.alert('忘记网络', '清除机器人上保存的 Wi-Fi 并断开？', [
      { text: '取消', style: 'cancel' },
      {
        text: '确定',
        style: 'destructive',
        onPress: () => ble.sendCommand(buildForgetCmd()).catch(() => {}),
      },
    ]);
  }, []);

  const disconnectRobot = useCallback(async () => {
    await ble.disconnect();
    setRobot(null);
    setStatus(null);
    setNetworks([]);
    setWifiScanning(false);
    setError(null);
    setServerInput('');
    setServerSaved(false);
    setSpeakers([]);
    setOutputCurrent(null);
    setSpeakersError(null);
  }, []);

  // ── 渲染 ───────────────────────────────────────────────────────
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor="#101014" />
        <Text style={styles.title}>StackChan 配网</Text>
        {error && <Text style={styles.error}>{error}</Text>}

        {!robot ? (
          // ── 阶段 1：找机器人 ──
          <>
            <Pressable
              style={[styles.button, scanningRobots && styles.buttonDisabled]}
              disabled={scanningRobots}
              onPress={startRobotScan}>
              {scanningRobots ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>扫描附近的机器人</Text>
              )}
            </Pressable>
            <FlatList
              data={robots}
              keyExtractor={d => d.id}
              ListEmptyComponent={
                <Text style={styles.hint}>
                  {scanningRobots
                    ? '正在搜索 StackChan…'
                    : '点上方按钮开始搜索（确认机器人已开机）'}
                </Text>
              }
              renderItem={({ item }) => (
                <Pressable
                  style={styles.card}
                  disabled={connectingId !== null}
                  onPress={() => connectRobot(item)}>
                  <View style={styles.cardRow}>
                    <Text style={styles.cardTitle}>
                      {item.name ?? 'StackChan'}
                    </Text>
                    {connectingId === item.id ? (
                      <ActivityIndicator color="#4f9cf9" />
                    ) : (
                      <Text style={styles.cardMeta}>
                        {signalBars(item.rssi ?? -100)}
                      </Text>
                    )}
                  </View>
                  <Text style={styles.cardSub}>{item.id}</Text>
                </Pressable>
              )}
            />
          </>
        ) : (
          // ── 阶段 2：机器人 Wi-Fi 配网 ──
          <>
            <View style={styles.statusCard}>
              <View style={styles.cardRow}>
                <Text style={styles.cardTitle}>{robot.name ?? 'StackChan'}</Text>
                <Pressable onPress={disconnectRobot}>
                  <Text style={styles.link}>断开</Text>
                </Pressable>
              </View>
              <View style={styles.statusRow}>
                <View
                  style={[
                    styles.dot,
                    { backgroundColor: STATE_COLOR[status?.state ?? 'IDLE'] },
                  ]}
                />
                <Text style={styles.statusText}>
                  {STATE_TEXT[status?.state ?? 'IDLE']}
                  {status?.ssid ? `  ${status.ssid}` : ''}
                </Text>
              </View>
              {status?.state === 'CONNECTED' && (
                <>
                  <Text style={styles.cardSub}>
                    IP {status.ip}   信号 {status.rssi} dBm
                  </Text>
                  <Pressable onPress={forgetWifi}>
                    <Text style={[styles.link, styles.linkDanger]}>
                      忘记此网络
                    </Text>
                  </Pressable>
                </>
              )}
            </View>

            {/* 语音助手服务器（电脑端 assistant-server）地址 */}
            <View style={styles.statusCard}>
              <Text style={styles.cardTitle}>语音助手服务器</Text>
              <Text style={styles.cardSub}>
                {status?.serverUrl
                  ? `当前：${status.serverUrl}${serverSaved ? '（已保存）' : ''}`
                  : '未配置——电脑上启动 assistant-server 后填入其局域网地址'}
              </Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={[styles.input, styles.inputFlex]}
                  placeholder="http://192.168.x.x:8300"
                  placeholderTextColor="#666"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  value={serverInput}
                  onChangeText={t => {
                    setServerInput(t);
                    setServerSaved(false);
                  }}
                />
                <Pressable
                  style={styles.saveBtn}
                  disabled={!serverInput.trim()}
                  onPress={saveServer}>
                  <Text
                    style={[
                      styles.buttonText,
                      !serverInput.trim() && styles.linkDisabled,
                    ]}>
                    保存
                  </Text>
                </Pressable>
              </View>
            </View>

            {/* 播报设备：机器人本体 / Home Assistant 音箱 */}
            <View style={styles.statusCard}>
              <View style={styles.cardRow}>
                <Text style={styles.cardTitle}>播报设备</Text>
                <Pressable
                  onPress={() => status?.serverUrl && loadSpeakers(status.serverUrl)}>
                  <Text style={styles.link}>刷新</Text>
                </Pressable>
              </View>
              {speakersError && <Text style={styles.error}>{speakersError}</Text>}
              <Pressable
                style={styles.outputRow}
                disabled={outputBusy}
                onPress={() => chooseOutput({ mode: 'robot' })}>
                <Text style={styles.statusText}>机器人本体扬声器</Text>
                {outputCurrent?.mode !== 'ha' && <Text style={styles.link}>✓</Text>}
              </Pressable>
              <ScrollView style={styles.speakerList}>
                {speakers.map(s => (
                  <Pressable
                    key={s.entity_id}
                    style={styles.outputRow}
                    disabled={outputBusy || s.state === 'unavailable'}
                    onPress={() =>
                      chooseOutput({ mode: 'ha', entityId: s.entity_id, name: s.name })
                    }>
                    <Text
                      style={[
                        styles.statusText,
                        s.state === 'unavailable' && styles.linkDisabled,
                      ]}>
                      {s.name}
                      {s.state === 'unavailable' ? '（离线）' : ''}
                    </Text>
                    {outputCurrent?.mode === 'ha' &&
                      outputCurrent.entityId === s.entity_id && (
                        <Text style={styles.link}>✓</Text>
                      )}
                  </Pressable>
                ))}
              </ScrollView>
              {!speakers.length && !speakersError && (
                <Text style={styles.cardSub}>
                  配置好服务器后，这里会列出 Home Assistant 里的音箱
                </Text>
              )}
            </View>

            <Pressable
              style={[styles.button, wifiScanning && styles.buttonDisabled]}
              disabled={wifiScanning}
              onPress={scanWifi}>
              {wifiScanning ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>让机器人扫描 Wi-Fi</Text>
              )}
            </Pressable>

            <FlatList
              data={networks}
              keyExtractor={n => n.ssid}
              ListEmptyComponent={
                <Text style={styles.hint}>
                  {wifiScanning
                    ? '机器人正在扫描周围的 Wi-Fi…'
                    : '点上方按钮获取机器人能搜到的 Wi-Fi 列表'}
                </Text>
              }
              renderItem={({ item }) => (
                <Pressable
                  style={styles.card}
                  onPress={() => onPickNetwork(item)}>
                  <View style={styles.cardRow}>
                    <Text style={styles.cardTitle}>
                      {item.secure ? '🔒 ' : ''}
                      {item.ssid}
                    </Text>
                    <Text style={styles.cardMeta}>
                      {signalBars(item.rssi)} {item.rssi}
                    </Text>
                  </View>
                </Pressable>
              )}
            />
          </>
        )}

        {/* 密码输入弹窗 */}
        <Modal visible={pwdTarget !== null} transparent animationType="fade">
          <View style={styles.modalMask}>
            <View style={styles.modalBox}>
              <Text style={styles.modalTitle}>连接 {pwdTarget?.ssid}</Text>
              <TextInput
                style={styles.input}
                placeholder="Wi-Fi 密码"
                placeholderTextColor="#666"
                secureTextEntry
                autoFocus
                value={password}
                onChangeText={setPassword}
              />
              <View style={styles.modalActions}>
                <Pressable
                  style={styles.modalBtn}
                  onPress={() => setPwdTarget(null)}>
                  <Text style={styles.link}>取消</Text>
                </Pressable>
                <Pressable
                  style={styles.modalBtn}
                  disabled={password.length < 8}
                  onPress={() => pwdTarget && submitWifi(pwdTarget, password)}>
                  <Text
                    style={[
                      styles.link,
                      password.length < 8 && styles.linkDisabled,
                    ]}>
                    连接
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#101014', paddingHorizontal: 16 },
  title: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '700',
    marginTop: 12,
    marginBottom: 16,
  },
  error: { color: '#ff6b60', marginBottom: 8 },
  hint: { color: '#8e8e93', textAlign: 'center', marginTop: 32 },
  button: {
    backgroundColor: '#4f9cf9',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  card: {
    backgroundColor: '#1c1c22',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  statusCard: {
    backgroundColor: '#1c1c22',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  cardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardTitle: { color: '#fff', fontSize: 16, fontWeight: '600', flexShrink: 1 },
  cardMeta: { color: '#8e8e93', fontSize: 13 },
  cardSub: { color: '#8e8e93', fontSize: 12, marginTop: 4 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  statusText: { color: '#e5e5ea', fontSize: 14 },
  link: { color: '#4f9cf9', fontSize: 14, marginTop: 6 },
  linkDanger: { color: '#ff6b60' },
  linkDisabled: { color: '#555' },
  modalMask: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  modalBox: { backgroundColor: '#1c1c22', borderRadius: 16, padding: 20 },
  modalTitle: { color: '#fff', fontSize: 17, fontWeight: '600' },
  input: {
    backgroundColor: '#101014',
    borderRadius: 10,
    color: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 14,
    fontSize: 16,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 24,
    marginTop: 8,
  },
  modalBtn: { paddingVertical: 8 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  outputRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#2a2a30',
    marginTop: 4,
  },
  speakerList: { maxHeight: 190 },
  inputFlex: { flex: 1, marginTop: 10 },
  saveBtn: {
    backgroundColor: '#4f9cf9',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginTop: 10,
  },
});
