# PrismMeet · 棱镜会议

免费、开源的多人远程会议工具。**LiveKit SFU** 媒体面 + Node 后端 + Electron 桌面客户端。

- 官网 / 下载：https://meeting.prismglory.org
- 能力：多人音视频、屏幕共享、实时聊天 / 弹幕、主持人管控（禁麦 / 禁摄像头 / 禁弹幕 / 全体静音 / 移出 / 锁定会议 / 人数上限 / 开始时间）、断线重连。
- License: MIT

本仓库提供**服务端**与**桌面客户端**的完整源码。

## 目录结构
```
v2.0/server/      Node 后端 (Express + ws + JSON 文件存储) + 内置会议前端 public/
v2.0/desktop/     Electron 桌面客户端（app:// 协议加载 server/public 作为 UI）
```
会议前端（`server/public`）由后端直接托管，桌面端通过 `extraResource` 随包携带同一份，
因此**一套 UI 同时服务于网页与桌面端**。

## 快速开始

桌面客户端无论「源码运行」还是「打包二进制」**都连同一个生产后端**
`https://meeting.prismglory.org/pmapi`，账户与会议数据完全互通。
源码运行相当于未编译的生产版：改完代码重开即生效，免打包。

```bash
cd v2.0/desktop && npm install && npm start
```

### 本地全栈开发
需要三个进程，用 `PM_API_BASE` 让客户端指向本地后端：

```bash
# 1) LiveKit dev 服务器（自行从 LiveKit 官方获取二进制；--dev 模式的 key/secret 固定为 devkey/secret）
livekit-server --dev --bind 127.0.0.1

# 2) 后端（默认连 dev LiveKit：ws://127.0.0.1:7880）
cd v2.0/server && npm install
PORT=4010 JWT_SECRET=devsecret PM_EXPOSE_CODE=1 node src/index.js

# 3) 桌面端指向本地后端
PM_API_BASE=http://localhost:4010 npm start --prefix v2.0/desktop
```

> ⚠️ `PM_EXPOSE_CODE=1` 会把短信验证码明文放进 HTTP 响应，任何人据此即可接管账号，
> **仅限本地测试，绝不可用于生产环境**。

### 环境变量

| 变量 | 说明 |
|---|---|
| `PORT` | 后端监听端口（默认 4000） |
| `JWT_SECRET` | 登录 token 签名密钥（**生产必须设置为随机值**，更换会使全部已发 token 失效） |
| `LIVEKIT_URL` | 客户端连接的 LiveKit 地址，形如 `wss://<域名>/pmlk`；**填对外域名，不要填机器 IP** |
| `LIVEKIT_HTTP` | 后端调用 LiveKit 服务端 API 的地址（通常 `http://127.0.0.1:7880`） |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | 与 LiveKit 配置一致 |
| `PM_API_BASE` | 覆盖桌面端内置的后端地址（本地调试用） |

短信验证码通道通过环境变量配置（见 `server/src/sms.js`），未配置时 `/api/auth/send-code`
返回 503，可改用密码登录。

## 默认会议策略（常被误认为故障）
新建会议默认 **禁止参会者开麦克风 / 开摄像头 / 发弹幕**（主持人豁免），见 `server/src/store.js`。
所以刚建好的会议里，别人进来是没有画面也没有声音的 —— 主持人需在会中「设置」里打开
「允许参与者开麦克风」「允许参与者开摄像头」。

## 构建桌面客户端
```bash
cd v2.0/desktop
npm run pack:win        # = 生成 build-info.json + @electron/packager 产出免安装版
# 产物：dist-pkg/PrismMeet-win32-x64/ → 压缩为 PrismMeet-v<版本>-Windows-x64.zip 发布
npm run dist:mac        # macOS（需在 Mac 上执行）
```
> electron-builder 的 nsis 安装包在无管理员 / 未开开发者模式的 Windows 上会因 winCodeSign
> 解压符号链接而失败；本项目改用 @electron/packager 产出免安装版并压缩为 zip。

### 用户数据目录 / 升级即重新登录
每次打包都会生成唯一 `buildId`（`build/gen-build-info.mjs` → `build-info.json`），
打包版据此使用独立的用户数据目录：

```
C:\Users\<用户名>\AppData\Roaming\prismmeet-desktop\builds\<buildId>\
```

启动时会自动清除其它 `buildId` 的目录，以及 2.0.0 及更早版本直接写在
`prismmeet-desktop\` 根目录下的旧数据。因此**用户下载新版本后拿到的是空目录，必须重新登录**。
源码运行不启用此机制；`PM_USER_DATA` 可覆盖路径。

登录态存在该目录的 `Local Storage`（`pm_token` / `pm_user`，origin `app://local`）；
账号与会议数据都在服务端，删除本地目录只相当于退出登录 + 清缓存。

> 版本号需要同时改 4 处：`desktop/package.json`（含 `pack:win` 的 `--app-version`）、
> `server/public/js/api.js` 的 `APP_VERSION`、`server/src/index.js` 里 runtime-config 的默认值。
> `APP_VERSION` 变化会清掉本地 `pm_token`（强制重新登录）。

## 部署架构（参考）
可以单机部署，也可以拆成「边缘 + 应用」两层：

| 角色 | 承担内容 |
|---|---|
| 边缘（反向代理） | 域名 + TLS + 静态官网；把 `/pmapi/*` 反代到后端、`/pmlk/*` 反代到 LiveKit |
| 应用 | 后端服务 + LiveKit（`7880`/`7881` TCP、`50000-50100` UDP）+ 数据文件 |

要点：
- LiveKit 的媒体流由客户端**直连应用节点的 UDP 端口**，不经过反向代理，这些端口必须对外放行。
- 若反代与应用不在同一台机器，注意反代到后端时的 `Host` 头处理
  （部分云厂商会对未备案域名的明文 HTTP 做拦截）。
- 客户端只硬编码**一个**后端域名，LiveKit 地址等由 `/api/livekit/config` 与
  `/api/runtime-config` 在运行时下发，因此更换应用服务器无需更新客户端。

> 具体的服务器、域名解析与运维细节属私有信息，不在本仓库记录。

## 架构要点
- **媒体**：LiveKit SFU（每端只上行一路、由服务器转发，支持 simulcast 三档）。
- **适配器同接口**：`public/js/livekit-client.js` 复刻了 `rtc.js` 中 `MeshClient` 的方法与事件，
  因此 `meeting.js` 与整套 UI 无需改动即可切换媒体层；`?mesh=1` 可回退到 Mesh 实现。
- **会管**：会议号即 LiveKit room，用户 id 即 identity；主持人持 `roomAdmin`，
  管控经服务端 `RoomServiceClient` 权威执行（`mutePublishedTrack` / `removeParticipant`），
  策略通过 **room metadata** 下发；入会限制（锁定 / 未开始 / 满员）在签发 token 时拦截。
- **聊天 / 弹幕**：LiveKit data channel（`publishData` / `DataReceived`）。
- **桌面端**：`app://` 自定义协议加载内置 UI，经绝对地址连后端；`prismmeet://join/<id>` 深链；
  用浏览器打开会议链接则引导下载客户端。
- **可选扩展**：`server/src/ext/*.js` 若存在会在启动时按文件名顺序自动挂载，
  约定默认导出 `register({ app, requireAuth, store })`，可用于按部署追加自定义路由。
