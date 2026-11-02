# 药盒端对接说明（给同学 A）

## 1. 连接参数

| 项 | 值 |
|---|---|
| 接入地址 | `382f09a250.st1.iotda-device.cn-north-4.myhuaweicloud.com` |
| 端口 | `1883`（不加密，ESP32 内存压力小） |
| 设备ID | `6ae6fbd37f2e6c302fa9050f_pillbox_01` |
| 服务ID | `PillBox` |
| 设备密钥 | 单独发，不写在这里 |

MQTT 鉴权（**这一块最容易卡，务必按下面的写法**）：

| 参数 | 怎么算 |
|---|---|
| ClientId | `{设备ID}_0_1_{时间戳}` —— 注意第 4 段是 **`1`**（校验时间戳），不是 0 |
| Username | 设备ID |
| Password | `HMAC-SHA256(key = 时间戳, data = 设备密钥)`，小写十六进制 |
| 时间戳 | 当前 **UTC** 时间，格式 `yyyyMMddHH`，精确到小时 |

**Password 的两个坑（我们踩过，实测确认）：**

1. **key 和 data 是反的**：时间戳当 HMAC 的 key，设备密钥当消息体。
   写反成 `HMAC(密钥, 时间戳)` 会一直返回 `Bad username or password`，而且这个错**华为云不会告诉你是顺序问题**，只会说密码错，极难查。
2. **ClientId 第 4 段必须是 `1`**：`1` = 校验时间戳（推荐），`0` = 不校验。写成 `_0_0_` 配上注时间戳的密码，一样连不上。

实测可用的值（UTC 2026-11-02 08 点，可用来对答案）：

```
时间戳    2026110208
ClientId  6ae6fbd37f2e6c302fa9050f_pillbox_01_0_1_2026110208
Username  6ae6fbd37f2e6c302fa9050f_pillbox_01
Password  67f84a53a9ee6a409e34a3562d02097dde04cdb517f87b4eec0c971c4c7845aa
```

连不上按这个顺序查：① 时间戳是不是 UTC（不是北京时间）② ClientId 是不是 `_0_1_` ③ HMAC 的 key/data 有没有写反 ④ 密钥有没有多复制空格。

> ESP32 端算法（Arduino）：
> ```cpp
> String ts = "2026110208";                      // 当前 UTC 整点
> // key = 时间戳字符串，message = 设备密钥
> ```
> 用 `mbedtls_md_hmac` 或 `HMAC` 库时，别把两个参数顺序搞反。


---

## 2. 你要发的：属性上报

**Topic**

```
$oc/devices/6ae6fbd37f2e6c302fa9050f_pillbox_01/sys/properties/report
```

**报文格式**（必须套 `services` 数组）

```json
{
  "services": [{
    "service_id": "PillBox",
    "properties": {
      "state": "idle",
      "next_time": "12:30",
      "weight_g": 128.5,
      "lid_open": false,
      "taken_today": 1,
      "total_today": 3
    }
  }]
}
```

属性上报**支持只发变化的字段**，不必每次全发。例如开盖时只发：

```json
{"services":[{"service_id":"PillBox","properties":{"lid_open":true,"state":"opened"}}]}
```

### 什么时候发

| 时机 | 发哪些字段 |
|---|---|
| 开机 / 每 60 秒心跳 | `state` `next_time` `weight_g` `taken_today` `total_today` |
| 打开盒盖 | `lid_open: true` `state: "opened"` |
| 关闭盒盖 | `lid_open: false` `state: "idle"` |
| 到点提醒 | `state: "reminding"` |
| **确认服药完成** | 状态字段 + 下面那一组事件字段 |

### 服药完成时额外要发的（重要）

```json
{
  "services": [{
    "service_id": "PillBox",
    "properties": {
      "state": "idle",
      "taken_today": 2,
      "event_seq": 2,
      "event_drug_name": "二甲双胍",
      "event_dose": "1片",
      "event_plan_time": "12:30",
      "event_actual_time": "12:28",
      "event_status": "early"
    }
  }]
}
```

`event_seq` **每次服药 +1，不能重复**。小程序靠它判断“来了一条新记录”，序号重复会导致记录被去重丢掉。

`event_status` 取值只能是：`ontime`（按时）/ `early`（提前）/ `late`（延迟）/ `missed`（漏服）。

---

## 3. 服药怎么判定（最核心，写错这一步整个功能就废了）

硬件只有两个传感器：

- **磁簧开关**：只知道盒盖开 / 关（`lid_open`）
- **HX711 + 1KG 称重**：只知道托盘总重量（`weight_g`），实际精度约 0.3g

**没有任何一个传感器能直接告诉你"他吃了没有"。** 所以一次服药必须靠「开盖 + 掉重量」两个条件一起判。

### 要维护的变量

| 变量 | 含义 |
|---|---|
| `base_weight` | 基准重量（克），存在 Flash 里，断电不丢 |
| `taken_today` | 今日已完成次数 |
| `event_seq` | 事件序号，每次服药 +1 |

### 判定流程

1. **开机时**（盒盖是关的）→ `base_weight = 当前 weight_g`，上报一次属性
2. **`lid_open` 由 false → true**（开盖）→ 上报 `lid_open:true, state:"opened"`
3. **`lid_open` 由 true → false**（关盖）→ 等 1~2 秒读数稳定后判断：
   - `base_weight - weight_g >= 0.3` → **算一次服药**
     - `taken_today += 1`，`event_seq += 1`
     - 上报完整事件组（见第 2 节的 `event_*` 字段）
   - 差值 < 0.3 → **不算**（只是开盖看一眼）
   - **无论算不算，关盖后都执行 `base_weight = weight_g`**，下次从新基准开始比
4. 每次上报都带上 `taken_today` `total_today` `weight_g` `lid_open` `state`

### 为什么必须"关盖才判"

- 手伸进去拿药时托盘会晃，读数瞬间可能掉到 100g，这时候判会误触发
- 你打开盖子看一眼又关上，这种不该算服药

**关盖后读数稳定，才是可信的**；而且关盖是个明确动作，用户不会连着开好几次。

### 三个容易翻车的实现细节

1. **上电后等 1~2 秒再取基准**。HX711 上电有零点漂移，刚上电的读数是错的。基准一偏，后面全错。
2. **读数取平均**。连读 10 次求平均再判断，单次读数会被震动干扰。
3. **`base_weight` 必须存 Flash/EEPROM**。断电重启后丢了，基准就归零，全部判错。

### 断网怎么办

判定**全在设备本地做**，不依赖网络。网断了照样累计在本地，网恢复后把当前状态整体上报一次即可，不需要补发历史事件（小程序只看当前快照）。

### 自查表：三种典型错误

| 现象 | 原因 |
|---|---|
| 小程序首页数字一直不动 | 只上报了 `weight_g`，忘了上报 `taken_today` |
| 开盖看一眼就 +1 | 少了"重量必须下降 ≥0.3g"这个条件 |
| 一天只有第一次算得对 | 关盖后没更新 `base_weight`，一直拿最早那个基准在比 |

---

## 4. 你要收的：计划下发

**订阅**

```
$oc/devices/6ae6fbd37f2e6c302fa9050f_pillbox_01/sys/commands/#
```

**收到的内容**

```json
{
  "service_id": "PillBox",
  "command_name": "set_plan",
  "paras": {
    "drug_name": "二甲双胍",
    "dose": "1片",
    "times": "08:00,12:30,19:00"
  }
}
```

`times` 是**英文逗号分隔的字符串**，不是数组。用 `split(",")` 拆开。

拆完有几个时间点，就是每天服药几次（对应 `total_today`）。

**必须回执，而且必须快**。实测：平台从投递开始**只等约 20 秒**，超时就把这条命令判为失败（错误码 `IOTDA.014111`），小程序端会弹「下发失败」。

所以固件里收到命令后要**立刻回执，不要等处理完再回**：先回 `result_code: 0`，再去接线、响蜂鸣器、改状态。顺序反了必然超时。

```
Topic: $oc/devices/6ae6fbd37f2e6c302fa9050f_pillbox_01/sys/commands/response/request_id={收到的request_id}
```

```json
{"result_code": 0, "response_name": "set_plan_response", "paras": {"result": 0}}
```

### 可选命令：`tare`（去皮 / 标定基准）

**如果你按第 3 节做了"开机和关盖时自动更新基准"，这条命令可以不实现**——收到就回 `result_code:0`、什么都不做，也不会报错。

它唯一的用途：**手动告诉设备"现在这个重量算满的"**。什么时候用得上：

- 中途补药 / 换药，不想关机重开
- 演示时数字明显不对，想一键复位基准

| 参数 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `base_g` | decimal | 否 | 直接指定基准重量；不传就现场称一次当前重量当基准 |

```json
{"result_code": 0, "response_name": "tare_response", "paras": {"result": 0}}
```

---

## 5. 字段总表

| 字段 | 类型 | 方向 | 说明 |
|---|---|---|---|
| `state` | string | 上报 | `idle` / `reminding` / `opened` |
| `next_time` | string | 上报 | 下一次提醒，`HH:MM` |
| `weight_g` | decimal | 上报 | 药重，克，保留 1~2 位小数 |
| `lid_open` | boolean | 上报 | 盒盖是否打开 |
| `taken_today` | int | 上报 | 今日已完成次数 |
| `total_today` | int | 上报 | 今日计划次数 |
| `event_seq` | int | 上报 | 事件序号，自增，**不能重复** |
| `event_drug_name` | string | 上报 | 本次药品名 |
| `event_dose` | string | 上报 | 本次用量 |
| `event_plan_time` | string | 上报 | 计划时间 `HH:MM` |
| `event_actual_time` | string | 上报 | 实际时间 `HH:MM` |
| `event_status` | string | 上报 | `ontime` / `early` / `late` / `missed` |
| `drug_name` | string | 下发 | 药品名称 |
| `dose` | string | 下发 | 每次用量 |
| `times` | string | 下发 | 逗号分隔的时间点 |
| `base_g` | decimal | 下发 | `tare` 命令的参数，去皮基准重量（选填） |
| `result` | int | 回执 | 0 = 成功 |

---

## 6. 四条硬规矩

1. **服药判定全在设备端做**，云端只搬运。别指望小程序帮你判断“这次算不算服药完成”，它只显示设备报上来的 `taken_today`。
2. **时间用 `HH:MM` 字符串比较**，ESP32 里字符串比大小就能判断到没到点，不用做时间运算。
3. **字段名一个字都不能改**。`plan_time` 写成 `planTime`，小程序那边会静默拿不到值，不会报错，最难查。
4. **收到命令 20 秒内必须回执**，且先回执再处理业务。超时平台就判失败，小程序弹「下发失败」。
