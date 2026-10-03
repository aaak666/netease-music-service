# netease-music-service

本地运行的网易云音乐服务：用**自己的网易云 VIP 账号 cookie** 解析/下载无损音乐，支持歌单、每日推荐、官方排行榜的批量下载与网页在线试听，附带一个零依赖的 Web UI。

> 仅供个人学习与自用，请勿用于商业用途或分发下载内容。

## 功能

- **单曲 / 歌单 / 排行榜下载**：粘贴链接或 ID（自动从 URL 抠 ID），支持批量，默认无损 FLAC；同批次内出现同名歌时全组自动加"歌名 - 歌手"后缀，绝不互相覆盖
- **歌单增量下载（默认开启）**：`downloads\` 下已有同名歌单文件夹时自动复用——音频+歌词都在的歌跳过、只缺歌词的补 `.lrc`、缺音频的才下载；只增不删，无需手动挑新歌；"已存在"的判定**优先按歌曲 ID**（批次目录维护 `.ncm-index.json` 的 id→文件名映射，只增不删），ID 不在索引才回退按歌名认领——同名歌、以及磁盘旧文件其实属于已移出歌单的另一首时都不会被误判为"已存在"（无索引/损坏的历史目录自动回退歌名匹配）；勾选"音质不同也补下"（**缺省关闭**，仅显式勾选才补）后，之前下过 320k 的歌会补上无损（旧文件保留、已有歌词不重写）。批次目录名带歌单 ID，同名的不同歌单互不干扰
- **每批独立子文件夹**：歌单用歌单名、榜单用榜单名，其余用下载启动时间戳，重名自动加序号
- **单曲批量排队**：一次粘贴多个链接 → 逐个入队 → 一键按顺序下载
- **网页在线试听**：单曲 / 歌单 / 榜单 / 每日推荐四种加载方式，播放控制、音量调节、LRC 歌词面板（高亮 + 自动滚动居中）
- **每日推荐**、**相似歌曲**、**心动模式**；私人电台（FM/雷达/漫游）仅保留 HTTP/编程接口（Web UI 已移除入口）
- **音质档位**：仅 320k MP3 与无损 FLAC，取不到自动降级（仅当网易确认该档位无资源；网络错误会重试而不是悄悄换成低音质）
- **元数据自动写入**：TITLE/ARTIST/ALBUM + 封面直接内嵌（MP3=ID3v2.3，FLAC=PICTURE 块），不留临时文件
- **批次结果报告**：每批下载结束在批次文件夹落一份 `下载结果.txt`（计数 + 失败/跳过明细）。**中途取消或失败同样会落**——半途而废的批次恰恰最需要事后核对；重启服务也能翻查
- **运行日志**：控制台 + `logs/service.log` 双写（超 2MB 自动轮转，占用封顶 ~4MB）——服务启停、任务创建/完成/失败/取消、手机推送重试与断连中止都有带时间戳的落盘记录，任务卡片日志重启即没，这份是事后排查用的
- **歌词下载**：同名 `.lrc`，有翻译歌词的自动把译文插到原文行下方（网页歌词面板同口径，含译文）
- **Meting 兼容端点** `/meting`：可接入 APlayer/MetingJS 播放器
- **全局串行任务队列**：同一时刻只跑一个下载任务，避免风控与临时文件冲突；排队中/进行中的任务可在网页任务卡片点"取消"（或 `DELETE /api/job/:id`），排队任务直接摘除，进行中任务当前歌曲完成后停止
- **下载位置可选（全局目的地）**：Web UI 全局选项条里可把下载文件夹换成**任何资源管理器能选到的地方**——「选择文件夹…」弹原生对话框（任意本地盘/U盘/网络路径），「手机文件夹…」添加 Android 设备目录（ADB 直写，**零本地磁盘写入**）；两类目的地与 `downloads\` 同一套产品口径：每批独立子文件夹（歌单名 `[歌单ID]`/榜单名/时间戳）、歌单增量（跳过已有、补缺歌词、只增不删、按 ID 认领）、`.ncm-index.json` 索引、元数据内嵌、音质档位与重试分级。手机直写逐文件 md5 校验（不符自动删半成品）；**USB 断连/接触不良有恢复宽限**——推送失败后等设备回来从内存重推（不重新下载），推送停滞（USB 半死、adb 挂起超时）同样按断连征兆处理，宽限耗尽才中止整批并如实提示，已完成部分重跑自动续上；目的地配置存 `destinations.json`（gitignore），重启不丢
- **ADB 状态灯**：Web UI 实时显示 ADB 基础可用性（就绪含设备型号 / 未授权 / 无设备 / 未安装），添加手机目的地前先探测设备目录可写（建目录→写探针→读回→删除全链路）。**手机已插线却显示"未检测到设备"时**：请在手机屏幕的「USB 用途」里选"管理文件/传输文件"（仅充电模式探不到），并允许"USB 调试"授权弹窗——提示文案会带上这个指引

## 快速上手（零命令）

| 操作 | 方式 |
|---|---|
| 启动服务 | 双击 `启动服务.bat` → 自动停旧实例、清扫半成品（只删 `.part`/`.tagtmp`，用户自放文件保留）、打开 `http://127.0.0.1:3000`（自定义端口先设 `PORT` 环境变量，浏览器地址跟随） |
| 停止服务 | 双击 `停止服务.bat`（只停确认是本服务的进程，端口被别人占用时不动手）；自定义端口用 `node stop.js <port>`（缺省跟服务 `PORT`，默认 3000） |
| 扫码登录 / cookie 续期 | 双击 `扫码登录.bat` → 手机网易云 App 扫码，cookie 自动写入 `cookie.txt` |
| 跑全部测试 | `npm test`（先单元后集成；集成测试需要 cookie 和网络）。**磁盘友好**：单测默认跑在**内存文件系统**上，全程零真实磁盘写入（保护 SSD，161 条用例与断言不变）；`npm run test:unit:io` 切换真实落盘做文件系统级验证。集成测试是**全流程验证**（真实下载约百 MB，仅必要时跑）：写入系统临时目录，结束时连同失败/中断路径自动清空，项目目录零写入、零残留 |
| 下载位置 | `downloads\`，每批一个独立子文件夹 |

网页顶部有登录状态指示灯：绿=已登录，红=未登录/已过期（点"重新扫码登录"即可；服务未响应时同样红灯提示）。

## 架构

```
server.js              HTTP 薄门面：纯路由 + 常量，不写业务
src/core/              底层原子能力：cookie/quality/raw/retry/song/playlist/
                       lyric/url/download/login/recommend/chart/tag/error/adb/dialog
src/service/           能力层：naming（命名/歌词/封面规则唯一出处）、
                       pipeline（批量下载统一骨架，本地/手机共用）、
                       重试降级、拉批循环、批量容错、缓存、
                       歌单增量(incremental)、批次目录/清扫(storage)、
                       任务编排(job)、下载位置(dest)、手机直写管线(phone)、
                       ADB 状态(adb)、参数校验(params)、实例管理(instance)
public/                Web UI（Neumorphism 风格，零外部依赖）：
                       index.html（结构）+ app.js（逻辑）+ style.css（样式）
test/unit.test.js      单测入口：按序调度分件（桩/内存文件系统/收集器在 unit.harness.js）
test/unit.*.js         单测分件，按领域拆分：core 基础 / tag-lyric / fetchers / platform /
                       download / storage / incremental / queue / phone-adb / job / server
test/integration.test.js  集成测试（需 cookie，含真实下载与产物校验）
login.js               扫码登录 CLI：cookie 写入 cookie.txt（"扫码登录.bat"即包装它）
stop.js                停服 CLI：按端口识别并停止本服务进程（"停止服务.bat"即包装它）
tools/phone-fill.js    手机歌单补齐应急 CLI：直连设备对账补缺，不走服务队列
```

**分层纪律**：core 只提供**控制流原语**（一次外部交互、一次纯映射，以及 `retry.js` 的 `withTimeout/withRetry`——等多久、重试几次这类策略参数由调用方决定）；循环编排、组装、业务策略一律放 service。改 core 后跑 `npm test` 回归。

引擎为 npm 包 `NeteaseCloudMusicApi`（社区维护版）。`core/raw(module, params)` 是透传原语——要用任何未封装的网易接口时直接调它。

## 环境要求

- Node ≥ 20.3（使用全局 fetch / AbortSignal.any）
- cookie 存放在 `cookie.txt`（已 gitignore），也可用环境变量 `NCM_COOKIE` / `MUSIC_U`

## HTTP API 摘要

- `POST /api/download` — 后台下载任务，`source` 支持 `daily / fm / simi / playlist / chart / song / songs`（心动模式试听走 `/recommend/heart`），返回 `{ jobId, count, label, folder, skipped }`（`skipped` = 歌单增量跳过的已存在歌数）
- `GET /api/job/:id` — 轮询任务进度（`queued/running/done/error/cancelled`）
- `DELETE /api/job/:id` — 取消任务（排队中直接摘除，进行中当前歌曲完成后停止；`done/error` 返回 400，`cancelled` 幂等返回 ok）
- `GET /api/jobs`、`/api/charts`、`/api/status`、`/api/ping`
- `GET /api/login/start|status|qr` — 网页内扫码登录
- `GET /api/open-folder?name=&dest=` — 打开某批次下载目录（`dest` 指目的地；phone 目的地返回 400）
- `GET /api/dest`、`POST /api/dest`（action: pick 弹原生文件夹对话框 / addLocal / addPhone）、`POST /api/dest/active`、`DELETE /api/dest/:id` — 下载位置管理
- `GET /api/adb` — ADB 基础可用性（ready/unauthorized/no-device/no-adb/error + 设备型号）
- `/meting`（`lrc` 含译文、与下载同口径；显式空 `level` 同样 400）、`/recommend/*`、`/chart/*` — Meting 兼容与推荐/榜单原语
- 非法音质一律 400；旧 `/download/*` 端点已改为返回 jobId 的任务端点

## 安全说明

服务**缺省只监听本机 `127.0.0.1`**——局域网内的其他设备访问不到（自己用浏览器打开 `http://127.0.0.1:3000` 不受任何影响）。服务本身仍无鉴权、CORS 全开（按所有者指示不做加固）：确需手机或其他设备访问时，以 `HOST=0.0.0.0` 启动显式放开（接入外部播放器再配合 `SELF_BASE`），**此时请勿连入不可信局域网，cookie 泄露风险自负**。`cookie.txt` 已默认 gitignore，请勿提交。

## 许可

ISC
