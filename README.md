# dsh-video-comments 📺 看视频再评论

[![Test](https://github.com/hezhaochao/dsh-video-comments/actions/workflows/test.yml/badge.svg)](./actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.2.x-4d93f8)](https://github.com/deepseek-ai/deepseek-harness)

一个 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)插件：
给 agent 加上「看视频 → 读评论区 → 发表评论」的能力。
**B 站走官方 Web API 全链路可用**（搜索需登录态）；**抖音**匿名反爬很强，
提供尽力而为的元信息读取 + 浏览器打开，深度操作建议配合 browser-skill 类插件。

## 工具一览（装好后模型看到 `mcp__video__<名>`）

| 工具 | 作用 | 登录要求 |
|---|---|---|
| `bili_search` | 关键词搜视频（wbi 签名） | 需要（B 站搜索端点强制登录态） |
| `bili_video` | 视频信息：标题/简介/UP主/时长/播放弹幕点赞硬币 | 无需 |
| `bili_comments` | 读评论区：置顶 + 分页评论（用户/点赞/时间/内容） | 无需 |
| `bili_comment` | **发评论**（以你配置的账号身份） | 需要 |
| `douyin_video` | 抖音视频元信息（og 标签，尽力而为） | 无需（但风控可能拦） |
| `douyin_open` | 在默认浏览器打开抖音链接 | 无需 |

## 安装

```bash
# 从 GitHub
dsh plugin --profile <你的 profile> add github:hezhaochao/dsh-video-comments

# 或本地 link（开发调试；link 不会自动装 peer，见下方说明）
dsh plugin --profile <你的 profile> add link:"<本仓库绝对路径>"
```

安装后**完全退出 DSH（含托盘）再重启**。

### 配置 B 站登录凭据（发评论/搜索必须）

浏览器登录 B 站后，从开发者工具（F12 → 网络 → 任意请求的 Cookie）里复制两个值，
写入 `C:\Users\<你>\.dsh\video-credentials.json`（或用环境变量 `VIDEO_CM_CREDS_FILE` 指定别处）：

```json
{
  "SESSDATA": "把 Cookie 里的 SESSDATA 值粘到这里",
  "bili_jct": "把 Cookie 里的 bili_jct 值粘到这里（就是 csrf）",
  "buvid3": "可选，已有的话填上更稳"
}
```

- 只存你本机文件，不会上传到任何地方；不配置也能用「读」类工具
- 抖音无需凭据（本插件也不碰你的抖音登录态）

## 典型用法（对话里直接说）

> "搜索『Mysql 优化』相关视频，挑播放最高的那个，看看评论区都在讨论什么"

> "看下 BV1GJ411x7h7 的信息，然后发一条有条理的评论夸一下这个视频（确认后再发）"

模型会自行组合 `bili_search → bili_video → bili_comments → bili_comment`。

## 防刷评三重防护（内置，不可绕过）

1. **显式确认**：`bili_comment` 必须带 `confirm: true`，模型要点名确认才会发
2. **限速**：两次写入至少间隔 30 秒（环境变量 `VIDEO_CM_MIN_INTERVAL_MS` 可调）
3. **长度与内容**：单条上限 1000 字符

**用途声明**：本插件定位为个人助手的「看 + 评」能力（AI 帮你组织语言、读评论区）。
请遵守 B 站/抖音社区规范：不批量刷评、不营销引战、不发垃圾内容——
接口层没有批量能力，这是刻意设计。自动化产生的行为请以你的账号名义负责。

## 工作原理

```
DSH (cordis)
 └─ dsh-video-comments (mcp/dsh-plugin.mjs 适配器)
     └─ ctx.plugin(@deepseek-ai/dsh-mcp-client, { serverName: "video", ... })
         └─ MCP stdio 服务器（零依赖裸 JSON-RPC, 2024-11-05）
             └─ mcp/bili.mjs —— B 站 Web API 客户端
                 · 匿名 buvid3（finger/spi）
                 · wbi 签名（nav 取 key → 固定置换表 → md5）
                 · 完整浏览器头（缺 sec-ch-ua/Sec-Fetch 会被 412 风控劫持，真机踩过）
```

## 兼容性

- 声明 `engines.dsh: ">=0.2.0-rc.1 <0.3.0-0"`，已在 **v0.2.1-rc.3**（当前最新版）上
  完成安装 / 配置树组合 / 卸载验证
- Node 由 DSH 内置运行时提供（>=20，用原生 fetch）；纯 HTTP 实现，全平台可用

## 关于抖音（诚实说明）

抖音的匿名网页接口有很强的设备指纹/签名风控（2024 后分享页也改成 JS 壳），
本插件**不做**签名破解，因此：

- `douyin_video`：尽力读取 og 元信息，读不到会明确报错（不会假装成功）
- `douyin_open`：可靠，直接在浏览器打开链接给你看
- 想让 agent「看抖音内容/发抖音评论」：配合 browser-skill / computer-use 类插件
  操控你**已登录的真实浏览器**，这是唯一稳妥且符合平台规则的路子

## 开发与测试

```bash
git clone https://github.com/hezhaochao/dsh-video-comments.git
cd dsh-video-comments
npm test        # MCP 协议层 + B 站真实调用（无凭据时相关用例诚实跳过）
npm run test:live    # 纯逻辑单元测试（bvid 解析等）
```

本地真机验证插件挂载：

```bash
dsh plugin --profile zz-test add link:"<本仓库绝对路径>"
dsh --profile zz-test --dump-config   # 应能看到 id: mcp-video-comments 条目
```

## 已知限制

- 搜索强依赖登录态（B 站 2023 起收紧）；未配置凭据时会收到明确报错而不是空结果
- 发评论接口随 B 站风控演进可能变化；失败时返回 B 站原始 code/message
- 高频使用可能触发 B 站风控（验证码），属平台侧保护，请自然节奏使用
- 抖音限制见上节

## 许可

[MIT](./LICENSE) © hezhaochao
