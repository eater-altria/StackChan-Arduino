# 阶段 3（采用）：本地唤醒词「海丽海丽」· 方案 A（esp-sr MultiNet，免训练）

复用 xiaozhi 的 `CustomWakeWord` 思路：用 esp-sr 的 **中文 MultiNet** 命令词识别，
直接写拼音 `hai li hai li`，**不训练模型**，纯离线。

> 代码很简单（照搬 xiaozhi 几十行）。真正的成本在**让设备 flash 里有中文 MultiNet 模型**——
> 这是方案 A 在 Arduino 下唯一的体力活，外加一个版本匹配的坑（见步骤 2）。

---

## 前置条件

- arduino-esp32 / M5Stack 板包 3.x（**自带 esp-sr**，无需另装库）。
- 开发板 **M5CoreS3**，16MB flash，**PSRAM 开启**。
- 分区方案：**`ESP SR 16M (3MB APP/7MB SPIFFS/2.9MB MODEL)`**
  —— 它会建 `model` 分区并**自动烧 srmodels.bin**。
- **不要**在 sketch 里放自定义 `partitions.csv`（[issue #12358](https://github.com/espressif/arduino-esp32/issues/12358)：自定义分区不会自动烧模型）。

---

> ✅ **已实测确认（M5Stack 板包 3.3.7 / arduino-esp32 3.3 / IDF 5.5）**：
> 读预编译库的 sdkconfig（`tools/esp32s3-libs/3.3.7/sdkconfig`）得知，预置 `srmodels.bin` 只含
> **`wn9_hiesp`(英文唤醒词) + `mn5_en`(英文命令词)**，`CONFIG_SR_MN_CN_NONE=y` —— **没有任何中文模型**。
> 所以「海丽海丽」**必然要做步骤 2**。下面诊断 sketch 仍建议跑一遍，确认分区/烧录链路通。
>
> esp-sr 头文件细节：此版本 `esp_srmodel_init` 在 **`model_path.h`**（不是 `esp_srmodel.h`）；
> 现成诊断工程见 [`tools/sr_model_check/`](tools/sr_model_check/)。

## 步骤 1 · 诊断：确认分区方案 + 看 model 分区里有什么

用 [`tools/sr_model_check/`](tools/sr_model_check/)（已修正头文件），**分区方案务必选 `ESP SR 16M`** 后烧录。

```cpp
#include <M5Unified.h>
extern "C" {
  #include "model_path.h"      // 此版本 esp-sr：esp_srmodel_init / filter 在这里
}
void setup() {
  M5.begin(); Serial.begin(115200); delay(500);
  srmodel_list_t* models = esp_srmodel_init("model");
  if (!models || models->num <= 0) { Serial.println("model 分区为空/未选 ESP SR 分区方案"); return; }
  for (int i = 0; i < models->num; i++)
    Serial.printf("model[%d] = %s\n", i, models->model_name[i]);
}
void loop() {}
```

预期输出 `wn9_hiesp` + `mn5_en`（无 `*_cn`）→ 证实需要 **步骤 2**。
若打印「分区为空」→ 是没选 `ESP SR 16M` 分区方案。

---

## 步骤 2 · 替换为含中文 MultiNet 的 srmodels.bin（必做）

**要替换的文件（已确认的真实路径，macOS）**：
```
~/Library/Arduino15/packages/m5stack/tools/esp32s3-libs/3.3.7/esp_sr/srmodels.bin
```
机制：选 `ESP SR 16M` 分区方案后，Arduino 构建会把这个文件拷到 `{build.path}/srmodels.bin`，
再烧到 flash 偏移 **`0xD10000`**（见 boards.txt 的 `esp_sr_16.upload.extra_flags`）。
所以**替换这个源文件**即可让你的中文模型被烧进去。**先备份原文件。**

### 怎么得到中文 srmodels.bin

> ✅ **版本已实测**：板包 esp-sr = **2.3.1**（`versions.txt`），与 xiaozhi 的 2.3.0 同代 → 用官方 esp-sr v2.3.1 打包即可，无版本坑。
> 中文 MultiNet 选 **mn7_cn**（最新，esp-sr 2.3.x 主推，拼音命令词）；若加载失败再退 **mn6_cn**。

> GitHub 上**没有 v2.3.1 这个 git tag**（别 `git clone -b v2.3.1`）；2.3.1 是组件注册表版本，用下面的 zip 直链下，版本完全对得上。

```bash
# 1) 下载并解压 esp-sr 2.3.1 源码（含模型数据 + 打包脚本）
cd ~/Downloads
curl -L -o esp-sr-2.3.1.zip \
  "https://components-file.espressif.com/components/espressif/esp-sr/2.3.1/espressif__esp-sr-v2.3.1.zip"
unzip -q esp-sr-2.3.1.zip -d esp-sr-2.3.1
cd esp-sr-2.3.1            # 若里面还套一层目录，cd 进含 model/ 的那层

# 2) 写一个最小 sdkconfig：选中文 MultiNet7 + 保留英文唤醒词占位
cat > sr_sdkconfig <<'EOF'
CONFIG_SR_WN_WN9_HIESP=y
CONFIG_SR_MN_CN_MULTINET7_QUANT=y
EOF

# 3) 打包（movemodel.py 会自动调 pack_model.py）
#    注意 -d2 给 esp-sr【根目录】(.)，脚本内部会自己加 /model；给 model 会拼成 model/model 报错
mkdir -p out
python3 model/movemodel.py -d1 sr_sdkconfig -d2 . -d3 out
ls -la out/srmodels/srmodels.bin          # 产物

# 4) 备份英文版并替换
DEST=~/Library/Arduino15/packages/m5stack/tools/esp32s3-libs/3.3.7/esp_sr/srmodels.bin
cp "$DEST" ~/srmodels_en.bak
cp out/srmodels/srmodels.bin "$DEST"
```

- movemodel.py 参数：`-d1 sdkconfig  -d2 model目录  -d3 输出目录`，产物固定在 `<输出>/srmodels/srmodels.bin`。
- 命令词用**拼音**：代码里 `esp_mn_commands_add(1, "hai li hai li")`（与 xiaozhi 的 `"xiao tu dou"` 同套写法）。
- 若 mn7_cn 运行时加载失败，改 `CONFIG_SR_MN_CN_MULTINET6_QUANT=y` 重打。
- 若 movemodel.py 报缺 python 模块，按提示 `pip3 install <模块>`。

**做法 (b) 借现成中文 srmodels.bin**
从 esp-box 中文 demo / 他人产物拿，**esp-sr 版本必须和板包对得上**，否则加载失败。

> ⚠️ 替换 tools 里的 srmodels.bin 会影响**所有**用 ESP_SR 的 sketch；**板包升级后会被覆盖**，需重做。
> 建议把你的中文 `srmodels.bin` 存一份到本仓库（如 `hardware-Arduino/tools/srmodels_cn/`）备查。

---

## 步骤 3 · 识别代码（移植 xiaozhi CustomWakeWord 核心）

合并进 `hardware-Arduino.ino`（**不要新建第二个 .ino**）。这段不需要 AFE，
和 xiaozhi 的 `custom_wake_word.cc` 一样，把单声道 PCM 直接喂给 MultiNet：

```cpp
#include <M5Unified.h>
extern "C" {
  #include "model_path.h"             // esp_srmodel_init / esp_srmodel_filter / srmodel_list_t
  #include "esp_mn_iface.h"           // ESP_MN_PREFIX
  #include "esp_mn_models.h"          // esp_mn_handle_from_name
  #include "esp_mn_speech_commands.h" // esp_mn_commands_add / clear
  #include "esp_process_sdkconfig.h"  // esp_mn_commands_update
}

static esp_mn_iface_t*     g_mn      = nullptr;
static model_iface_data_t* g_mn_data = nullptr;
static int                 g_chunk   = 0;
static int16_t*            g_buf     = nullptr;

void wakewordSetup() {
    srmodel_list_t* models = esp_srmodel_init("model");
    char* mn = esp_srmodel_filter(models, ESP_MN_PREFIX, "cn");  // 中文 MultiNet
    if (!mn) { Serial.println("找不到中文 MultiNet 模型，先做步骤2"); return; }
    Serial.printf("MultiNet: %s\n", mn);

    g_mn      = esp_mn_handle_from_name(mn);
    g_mn_data = g_mn->create(mn, 3000);              // 3s 命令窗口
    g_mn->set_det_threshold(g_mn_data, 0.30f);       // 阈值：越小越敏感(xiaozhi默认0.2)

    esp_mn_commands_clear();
    esp_mn_commands_add(1, (char*)"hai li hai li");  // ★ 拼音，空格分隔
    esp_mn_commands_update();
    g_mn->print_active_speech_commands(g_mn_data);

    g_chunk = g_mn->get_samp_chunksize(g_mn_data);   // 每次 detect 的样本数(通常512≈32ms)
    g_buf   = (int16_t*)heap_caps_malloc(g_chunk * sizeof(int16_t), MALLOC_CAP_DEFAULT);
}

// 识别到「海丽海丽」返回 true
bool wakewordPoll() {
    if (!g_mn || !g_buf) return false;
    if (!M5.Mic.record(g_buf, g_chunk, 16000)) return false;
    while (M5.Mic.isRecording()) delay(1);

    esp_mn_state_t st = g_mn->detect(g_mn_data, g_buf);
    if (st == ESP_MN_STATE_DETECTED) {
        esp_mn_results_t* r = g_mn->get_results(g_mn_data);
        Serial.printf(">>> 海丽海丽 id=%d prob=%.2f\n", r->command_id[0], r->prob[0]);
        g_mn->clean(g_mn_data);
        return true;
    }
    if (st == ESP_MN_STATE_TIMEOUT) g_mn->clean(g_mn_data);
    return false;
}
```

接到现有结构（复用阶段 2 的 `alertUntil` 让眼睛瞪大）：

```cpp
// setup() 里：保留 M5.Speaker.end(); M5.Mic.begin();，然后
wakewordSetup();

// loop() 里：
if (wakewordPoll()) {
    alertUntil = millis() + 1500;        // 眼睛瞪大 1.5s
    // TODO: 接「被唤醒」动作 / 进入对话
}
```

> MultiNet 的 `detect` 自带命令窗口状态机，**无需手动去抖**——返回 `DETECTED` 即命中。
> chunk 很小（~32ms），录音不会明显卡眨眼；要更丝滑可把 `wakewordPoll()` 放到 core0 任务。

---

## 步骤 4 · 调参与坑

- **阈值** `set_det_threshold`：误触发多→调大（0.4~0.6），漏识别→调小（0.2）。
- **拼音写法**：声调不写，按 esp-sr 中文 MultiNet 规则用空格分音节（`hai li hai li`）。
- **无 AFE**：直接喂 M5.Mic 单声道（和 xiaozhi 一致）→ 距离近、噪声下易误触发；后续可加 wakenet 门控或 AFE 降噪。
- **MultiNet 连续跑**较吃 CPU（S3 没问题，但功耗高于 wakenet 门控方案）。

---

## 方案 A vs 方案 C 一句话

- **A（本文）**：省了采集/训练，代码照搬 xiaozhi；代价是**搞中文模型 + esp-sr 版本匹配**这一次性体力活。
- **C**（[WAKEWORD.md](WAKEWORD.md)，备选）：免动模型分区，但要自己录音训练。

## 验收

近距离正常语速念「海丽海丽」→ 串口打印 `prob`、眼睛瞪大；日常说别的话基本不误触发即达标。
