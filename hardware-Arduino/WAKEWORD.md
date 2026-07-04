# 阶段 3（备选）：本地唤醒词「海丽海丽」（方案 C：Edge Impulse + TFLite）

> ⚠️ 已改走**方案 A**（esp-sr MultiNet，见 [WAKEWORD-A-espsr.md](WAKEWORD-A-espsr.md)）。本文作为备选保留。


完全离线、纯 Arduino IDE 工作流。模型训练好后以 Arduino 库（含 `.h` 模型）编进固件，
**不需要** esp-sr、不需要模型分区、不需要 esptool 刷 `srmodels.bin`。

```
录音样本 ──> Edge Impulse(云端训练 MFCC+NN, int8) ──> 导出 Arduino 库(.zip)
   └─> Arduino IDE 安装库 ──> M5.Mic 采集 PCM ──> run_classifier_continuous()
        ──> 识别到「海丽海丽」── 眼睛瞪大/触发动作
```

---

## 步骤 1 · 采集训练数据

关键词识别本质是分类，建议 **3 个类别**：

| 类别 | 内容 | 建议量 |
|------|------|--------|
| `haili` | 「海丽海丽」反复念，多人/多语速/多距离/多音量 | ≥ 100 条 / 3~5 分钟 |
| `noise` | 你实际使用环境的背景音、静音、风扇/键盘声 | 5~10 分钟 |
| `unknown` | 其它词句、相近发音、日常对话 | 5~10 分钟 |

- 样本统一 **1 秒、16kHz、单声道**（与 `M5.Mic` 一致）。
- 采集方式：
  - 入门：用手机/电脑在 Edge Impulse 网页端直接录。
  - **更准**：用 CoreS3 自己的麦克风录一部分——同一只麦克风、同样的噪声特性，识别率明显更好。
    可用 `edge-impulse-data-forwarder` 把设备串口的 PCM 流喂给 Edge Impulse（进阶，先用手机也行）。
- 多找几个人录「海丽海丽」，泛化更好；负样本越贴近真实环境越能压低误触发。

## 步骤 2 · Edge Impulse 建项目 + 设计 Impulse

1. [edgeimpulse.com](https://edgeimpulse.com) 注册，新建项目，数据类型选 **Audio**。
2. 上传/录制数据，按类别打标签，划分 train/test（默认 80/20）。
3. **Create Impulse**：
   - Time series：**Window size 1000ms**，**Window increase 250ms**，**Frequency 16000Hz**。
   - Processing block：**MFCC**（语音关键词标准选择，参数用默认即可）。
   - Learning block：**Classification (NN)**，输出 3 类 `haili / noise / unknown`。
4. 生成特征（Generate features），看类别在特征空间是否可分。

## 步骤 3 · 训练 + 验证

1. NN Classifier 用默认网络训练，看准确率/混淆矩阵；不够就加样本（尤其 `unknown`）。
2. 开 **EON Compiler**，模型量化选 **int8**（更小更快，适合 ESP32-S3）。
3. 在 **Deployment → 选目标设备 ESP32** 看预估延迟/RAM（应在几十~一百多 ms、几百 KB）。
4. 用 **Live classification** 现场测几条，确认能分辨「海丽海丽」与其它词再导出。

## 步骤 4 · 导出 Arduino 库并安装

1. **Deployment → Arduino library → Build**，下载 `.zip`。
2. Arduino IDE：**项目 → 包含库 → 添加 .ZIP 库**，选刚下载的 zip。
3. 库里会有头文件 `<你的项目名>_inferencing.h`（下面代码以此为准）。
4. 开发板菜单确认：**PSRAM 开启**、分区给足 App 空间（模型编进固件，App 会变大）。

## 步骤 5 · 集成到现有 sketch

把识别接到阶段 2 已有的「眼睛 + 麦克风」结构上：识别到唤醒词就复用 `alertUntil`
让眼睛瞪大（后续可换成专门的"被唤醒"表情/动作）。

> 注意：Arduino 一个 sketch 文件夹只编译该文件夹里的 `.ino`。下面是要**合并进
> `hardware-Arduino.ino`** 的关键片段（不要新建第二个 `.ino` 到同目录）。

```cpp
#include <M5Unified.h>
#include <hai_li_inferencing.h>   // ← 改成你导出的项目头文件名

// run_classifier_continuous 每次喂一个「切片」(默认 1s 窗口 / 4 = 250ms)
static int16_t   ei_slice[EI_CLASSIFIER_SLICE_SIZE];
static const int HAILI_IDX = 0;       // ← 按导出库里类别顺序填「haili」的下标
static const float WAKE_THRESHOLD = 0.80f;  // 置信度阈值，调
static int   hitCount = 0;            // 连续命中计数，去抖

// Edge Impulse 取数回调：把 int16 PCM 转 float
static int ei_get_data(size_t offset, size_t length, float* out) {
    numpy::int16_to_float(&ei_slice[offset], out, length);
    return 0;
}

void wakewordSetup() {
    run_classifier_init();            // setup() 里调用一次
}

// 返回 true 表示这一刻识别到「海丽海丽」
bool wakewordPoll() {
    // 1) 采集一个切片（250ms @16k）。阻塞式，简单可靠。
    if (!M5.Mic.record(ei_slice, EI_CLASSIFIER_SLICE_SIZE, EI_CLASSIFIER_FREQUENCY)) return false;
    while (M5.Mic.isRecording()) { delay(1); }

    // 2) 连续推理
    signal_t signal;
    signal.total_length = EI_CLASSIFIER_SLICE_SIZE;
    signal.get_data     = &ei_get_data;
    ei_impulse_result_t result = {0};
    if (run_classifier_continuous(&signal, &result, false) != EI_IMPULSE_OK) return false;

    // 3) 阈值 + 去抖（连续 2 个窗口超阈值才算，压误触发）
    float p = result.classification[HAILI_IDX].value;
    if (p >= WAKE_THRESHOLD) {
        if (++hitCount >= 2) { hitCount = 0; return true; }
    } else {
        hitCount = 0;
    }
    return false;
}
```

在 `loop()` 里：

```cpp
    if (wakewordPoll()) {
        alertUntil = millis() + 1500;     // 复用阶段2：眼睛瞪大 1.5s
        Serial.println(">>> 海丽海丽 detected!");
        // TODO: 这里接「被唤醒」动作 / 进入对话状态等
    }
```

> setup() 里记得调用 `wakewordSetup();`，并保留阶段 2 的 `M5.Speaker.end(); M5.Mic.begin();`。

## 步骤 6 · 调参与降误触发

- **阈值** `WAKE_THRESHOLD`：从 0.8 起，误触发多就调高、漏识别多就调低。
- **去抖** `hitCount`：要求连续 N 个窗口命中；N 越大越稳但越迟钝。
- **样本回灌**：把现场误触发的声音作为 `unknown` 重新训练，是最有效的提升手段。
- 若 `unknown` 总被误判成 `haili`，多半是 `haili` 样本太单一——加人、加距离、加噪声背景。

## 性能与注意事项

- ESP32-S3 @240MHz + PSRAM，int8 模型单次推理约几十~百余 ms，可满足 ~4Hz 连续识别。
- **阻塞采集会让眨眼略卡**：要眼睛丝滑，可把 `wakewordPoll()` 放到 **core 0 的 FreeRTOS 任务**里跑，
  主 `loop()` 只管动画，用全局标志通信（第二版优化，先跑通单循环版）。
- `run_classifier_continuous` 依赖连续喂数据维护 MFCC 状态，**不要**用能量阈值去掐它的输入。
- 采样率务必和 `EI_CLASSIFIER_FREQUENCY`(16000) 一致——别和阶段 2 的 16k 冲突。

## 验收标准

近距离（0.5~1m）正常语速念「海丽海丽」，眼睛瞪大、串口打印 `detected`；
日常说别的话基本不误触发，即达标。之后再做"被唤醒"表情和后续交互。
