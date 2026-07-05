# 本地唤醒词「Hi 瓦力」：esp-sr WakeNet 预置模型（免训练）

用 esp-sr 自带的 **WakeNet 预置唤醒词模型**（官方训练好的，免采集、免训练、免调阈值），
本项目选 **`wn9_hiwalle_tts2`（「Hi 瓦力」）**。纯离线，代码见 `hardware-Arduino.ino` 的
`wakenetSetup()` / `wakeTask()`。

> 唯一的体力活：板包预置的 `srmodels.bin` 里**没有**这个模型，要用 esp-sr 的打包脚本
> 重打一份替换进板包（步骤 2）。一次性工作，板包升级后需重做。

---

## 前置条件

- arduino-esp32 / M5Stack 板包 3.x（**自带 esp-sr**，无需另装库）。
- 开发板 **M5CoreS3**，16MB flash，**PSRAM 开启**。
- 分区方案：**`ESP SR 16M (3MB APP/7MB SPIFFS/2.9MB MODEL)`**
  —— 它会建 `model` 分区并**自动烧 srmodels.bin**（到 flash 偏移 `0xD10000`，
  见 boards.txt 的 `esp_sr_16.upload.extra_flags`）。
- **不要**在 sketch 里放自定义 `partitions.csv`（[issue #12358](https://github.com/espressif/arduino-esp32/issues/12358)：自定义分区不会自动烧模型）。

> ✅ **已实测（M5Stack 板包 3.3.7 / arduino-esp32 3.3 / IDF 5.5）**：预置 `srmodels.bin` 只含
> `wn9_hiesp`（英文唤醒词「Hi ESP」）+ `mn5_en`，**没有「Hi 瓦力」** → 步骤 2 必做。
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

- 输出含 `wn9_hiwalle_tts2` → 模型已就位，直接烧主 sketch 即可；
- 输出是 `wn9_hiesp` 等 → 需要**步骤 2**；
- 打印「分区为空」→ 没选 `ESP SR 16M` 分区方案。

---

## 步骤 2 · 重打含「Hi 瓦力」的 srmodels.bin（必做一次）

**要替换的文件（已确认的真实路径，macOS）**：
```
~/Library/Arduino15/packages/m5stack/tools/esp32s3-libs/3.3.7/esp_sr/srmodels.bin
```
机制：选 `ESP SR 16M` 分区方案后，Arduino 构建会把这个文件拷到 `{build.path}/srmodels.bin`
再烧进 flash，所以**替换这个源文件**即可。**先备份原文件。**

> ✅ **版本已实测**：板包 esp-sr = **2.3.1**（`versions.txt`）→ 用官方 esp-sr v2.3.1 的模型
> 数据和打包脚本，版本完全匹配。
>
> GitHub 上**没有 v2.3.1 这个 git tag**（别 `git clone -b v2.3.1`）；2.3.1 是组件注册表
> 版本，用下面的 zip 直链下载。

```bash
# 1) 下载并解压 esp-sr 2.3.1 源码（含模型数据 + 打包脚本）
cd ~/Downloads
curl -L -o esp-sr-2.3.1.zip \
  "https://components-file.espressif.com/components/espressif/esp-sr/2.3.1/espressif__esp-sr-v2.3.1.zip"
unzip -q esp-sr-2.3.1.zip -d esp-sr-2.3.1
cd esp-sr-2.3.1            # 若里面还套一层目录，cd 进含 model/ 的那层

# 2) 最小 sdkconfig：只选「Hi 瓦力」WakeNet 模型
cat > sr_sdkconfig <<'EOF'
CONFIG_SR_WN_WN9_HIWALLE_TTS2=y
EOF

# 3) 打包（movemodel.py 会自动调 pack_model.py）
#    注意 -d2 给 esp-sr【根目录】(.)，脚本内部会自己加 /model；给 model 会拼成 model/model 报错
mkdir -p out
python3 model/movemodel.py -d1 sr_sdkconfig -d2 . -d3 out
ls -la out/srmodels/srmodels.bin          # 产物

# 4) 备份预置版并替换
DEST=~/Library/Arduino15/packages/m5stack/tools/esp32s3-libs/3.3.7/esp_sr/srmodels.bin
cp "$DEST" ~/srmodels_orig.bak
cp out/srmodels/srmodels.bin "$DEST"
```

- movemodel.py 参数：`-d1 sdkconfig  -d2 model目录  -d3 输出目录`，产物固定在 `<输出>/srmodels/srmodels.bin`。
- 若 movemodel.py 报缺 python 模块，按提示 `pip3 install <模块>`。

### 换别的预置唤醒词

esp-sr 2.3.1 内置 **50+ 个**训练好的唤醒词（「小爱同学」「你好小智」「Hi StackChan」等），
清单看解压目录的 `model/wakenet_model/`（目录名即模型名）。想换词只需把 sdkconfig 里的
`CONFIG_SR_WN_...` 换成对应项重打即可，固件代码零改动
（`esp_srmodel_filter(models, ESP_WN_PREFIX, NULL)` 自动取分区里的 WakeNet 模型）。

> ⚠️ 替换 tools 里的 srmodels.bin 会影响**所有**用 ESP_SR 的 sketch；**板包升级后会被覆盖**，需重做。
> 建议把打好的 `srmodels.bin` 存一份到本仓库（如 `hardware-Arduino/tools/srmodels_cn/`）备查。

---

## 步骤 3 · 固件侧说明（已在主 sketch 实现）

识别代码在 `hardware-Arduino.ino`（`wakenetSetup()` + `wakeTask()`），要点：

- `esp_srmodel_filter(models, ESP_WN_PREFIX, NULL)` 取分区里的 WakeNet 模型，
  `esp_wn_handle_from_name()` 拿接口，`detect()` 返回 `WAKENET_DETECTED` 即唤醒；
- M5.Mic 单声道 16kHz 直接喂 `detect()`（无 AFE）；**麦克风任务必须
  `task_priority=15` 绑 core1**，否则被舵机任务饿死丢音、唤醒率暴跌；
- 命中后冷却 800ms 防同句重复触发；
- **坏指针陷阱**：此模型上 `get_word_name()` 返回坏指针（printf %s 直接崩），
  `clean()` 疑似同类问题——**都不要调用**，唤醒词名直接写死在日志里。

## 验收

近距离正常语速喊「Hi 瓦力」→ 串口打印 `>>> Hi 瓦力! 唤醒`、机器人眨眼进入对话；
日常说别的话基本不误触发即达标。

---

## 历史备注

曾试过 MultiNet 中文命令词方案（拼音 `hai li hai li` 当唤醒词「海丽海丽」）：能跑通但
识别率不足（prob≈0.49、需手调阈值），已弃用改 WakeNet 预置模型；也评估过 Edge Impulse
自训 TFLite 关键词模型，未采用。当前方案免训练、免调阈值，识别率稳定。
