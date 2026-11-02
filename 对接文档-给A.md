# 药盒端对接说明（给同学 A）

## 1. 连接参数

| 项 | 值 |
|---|---|
| 接入地址 | `382f09a250.st1.iotda-device.cn-north-4.myhuaweicloud.com` |
| 端口 | `1883`（不加密，ESP32 内存压力小） |
| 设备ID | `6ae6fbd37f2e6c302fa9050f_pillbox_01` |
| 服务ID | `PillBox` |
| 设备密钥 | 单独发，不写在这里 |

MQTT 鉴权（华为云要求，容易卡住）：

| 参数 | 怎么算 |
|---|---|
| ClientId | `{设备ID}_0_0_{时间戳}` |
| Username | 设备ID |
| Password | `HMAC-SHA256(设备密钥, 时间戳)`，转小写十六进制 |
| 时间戳 | 当前 **UTC** 时间，格式 `yyyyMMddHH`，精确到小时 |

例：UTC 时间 2026-11-01 09 点 → 时间戳 `2026110109`，
ClientId = `6ae6fbd37f2e6c302fa9050f_pillbox_01_0_0_2026110109`

连不上按这个顺序查：① 时间戳是不是 UTC（不是北京时间）② 十六进制是不是小写 ③ 密钥有没有多复制空格。

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

## 3. 你要收的：计划下发

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

**必须回执**，不回平台会判失败，小程序端会一直显示「下发失败」：

```
Topic: $oc/devices/6ae6fbd37f2e6c302fa9050f_pillbox_01/sys/commands/response/request_id={收到的request_id}
```

```json
{"result_code": 0, "response_name": "set_plan_response", "paras": {"result": 0}}
```

---

## 4. 字段总表

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
| `result` | int | 回执 | 0 = 成功 |

---

## 5. 三条硬规矩

1. **服药判定全在设备端做**，云端只搬运。别指望小程序帮你判断“这次算不算服药完成”。
2. **时间用 `HH:MM` 字符串比较**，ESP32 里字符串比大小就能判断到没到点，不用做时间运算。
3. **字段名一个字都不能改**。`plan_time` 写成 `planTime`，小程序那边会静默拿不到值，不会报错，最难查。
