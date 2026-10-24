#!/usr/bin/env node
/**
 * dsh-video-comments — MCP stdio 服务器（零依赖、裸 JSON-RPC 实现）
 *
 * 协议：newline-delimited JSON-RPC 2.0，MCP 2024-11-05。
 *
 * 工具（模型看到的名称为 mcp__video__<name>）：
 *   bili_search   — B 站搜索视频（wbi 签名）
 *   bili_video    — 视频信息（标题/简介/UP主/数据）
 *   bili_comments — 读评论区
 *   bili_comment  — 发评论（需凭据 + confirm + 限速）
 *   douyin_video  — 抖音视频元信息（分享页 og 标签）
 *   douyin_open   — 在默认浏览器打开抖音链接
 *
 * 纪律：任何失败都回 isError 结果；stdout 只输出协议消息；写操作三重防护
 * （confirm 显式确认、凭据文件、内存限速）。
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import * as bili from "./bili.mjs";

const VERSION = "0.1.0";
const IS_WINDOWS = process.platform === "win32";
const DOUYIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/* ────────────────────────── 工具定义 ────────────────────────── */

const obj = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const TOOLS = [
  {
    name: "bili_search",
    description:
      "Search Bilibili videos by keyword. Returns bvid/title/author/play counts. Use a result's bvid with bili_video / bili_comments afterwards.",
    inputSchema: obj(
      {
        keyword: { type: "string", description: "Search keyword (Chinese works)." },
        page: { type: "integer", description: "Page number, default 1." },
      },
      ["keyword"],
    ),
  },
  {
    name: "bili_video",
    description:
      "Get a Bilibili video's metadata: title, description, uploader, duration, category and full stats (play/danmaku/reply/like/coin). Accepts a BV id or a video URL.",
    inputSchema: obj(
      { url_or_bvid: { type: "string", description: "BV id (BVxxxxxxxxxx) or video URL." } },
      ["url_or_bvid"],
    ),
  },
  {
    name: "bili_comments",
    description:
      "Read a Bilibili video's comment section (top/pinned comments plus one page of replies with user/like/time). Read first, then decide what to say.",
    inputSchema: obj({
      url_or_bvid: { type: "string", description: "BV id or video URL." },
      page: { type: "integer", description: "Page number, default 1 (20 comments per page)." },
      sort: { type: "integer", description: "0 = by time, 1 = by like, 2 = hot. Default 1." },
    }),
  },
  {
    name: "bili_comment",
    description:
      "Post a comment on a Bilibili video AS THE CONFIGURED USER (credentials file with SESSDATA/bili_jct required). Personal assistant use: one comment, rate-limited to one per 30s. You MUST set confirm=true and the comment text must be thoughtful and relevant — never spam.",
    inputSchema: obj(
      {
        url_or_bvid: { type: "string", description: "BV id or video URL." },
        text: { type: "string", description: "Comment text (max 1000 chars)." },
        confirm: { type: "boolean", description: "Must be true to actually post." },
      },
      ["url_or_bvid", "text"],
    ),
  },
  {
    name: "douyin_video",
    description:
      "Fetch a Douyin video's public metadata (og:title / og:description / cover) from its share page. Works best with https://www.douyin.com/video/<id> URLs; heavy anti-crawler means this can fail — the error says so honestly.",
    inputSchema: obj(
      { url: { type: "string", description: "Douyin video URL or share text containing it." } },
      ["url"],
    ),
  },
  {
    name: "douyin_open",
    description:
      "Open a Douyin (or any) URL in the user's default browser so they can watch it. Windows only. Use it to hand content to the human or to let a browser-control skill interact with the real logged-in page.",
    inputSchema: obj(
      { url: { type: "string", description: "URL to open." } },
      ["url"],
    ),
  },
];

/* ────────────────────────── 抖音实现 ────────────────────────── */

function extractDouyinUrl(input) {
  const s = String(input || "");
  const m = s.match(/https?:\/\/[^\s"'<>]*douyin\.com\/[^\s"'<>]*/);
  return m ? m[0] : s.trim();
}

async function douyinVideo(input) {
  const url = extractDouyinUrl(input);
  if (!/douyin\.com/.test(url)) throw new Error("不是抖音链接");
  const res = await fetch(url, {
    headers: { "User-Agent": DOUYIN_UA, "Accept-Language": "zh-CN,zh;q=0.9" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`分享页返回 HTTP ${res.status}`);
  const html = await res.text();
  const meta = (prop) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i"));
    if (m) return m[1];
    const m2 = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, "i"));
    return m2 ? m2[1] : "";
  };
  const title = meta("og:title") || (html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "");
  const desc = meta("og:description") || meta("description");
  const cover = meta("og:image");
  if (!title && !desc) {
    throw new Error("分享页没有返回可读的元信息（可能触发了验证页/需要登录），请换分享短链或在浏览器打开");
  }
  return {
    ok: true,
    url,
    title: title.trim().slice(0, 200),
    description: desc.trim().slice(0, 300),
    cover: cover || "",
    note: "抖音元信息来自分享页 og 标签；评论需在浏览器内操作（可配合 browser-skill 类插件）",
  };
}

function douyinOpen(url) {
  return new Promise((resolve) => {
    if (!IS_WINDOWS) {
      resolve({ ok: false, error: "douyin_open 仅支持 Windows（用默认浏览器打开）" });
      return;
    }
    const child = spawn("cmd.exe", ["/c", "start", "", url], { windowsHide: true, detached: true });
    child.on("error", (error) => resolve({ ok: false, error: String(error) }));
    child.on("spawn", () => {
      try {
        child.unref();
      } catch {
        /* ignore */
      }
      resolve({ ok: true, url, note: "已在默认浏览器打开" });
    });
  });
}

/* ────────────────────────── 工具分发 ────────────────────────── */

async function callTool(name, args) {
  const a = args ?? {};
  try {
    switch (name) {
      case "bili_search":
        return ok(await bili.biliSearch(String(a.keyword || ""), Number(a.page) || 1));
      case "bili_video":
        return ok(await bili.biliVideo(a.url_or_bvid));
      case "bili_comments":
        return ok(
          await bili.biliComments(a.url_or_bvid, Number(a.page) || 1, Number.isFinite(Number(a.sort)) ? Number(a.sort) : 1),
        );
      case "bili_comment":
        return ok(await bili.biliPostComment(a.url_or_bvid, a.text, { confirm: a.confirm === true }));
      case "douyin_video":
        return ok(await douyinVideo(a.url));
      case "douyin_open":
        return ok(await douyinOpen(String(a.url || "")));
      default:
        return err(`未知工具：${name}`);
    }
  } catch (error) {
    return err(String(error?.message || error));
  }
}

function ok(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload ?? { ok: true }) }] };
}

function err(message) {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(message) }) }], isError: true };
}

/* ────────────────────────── JSON-RPC 骨架 ────────────────────────── */

function writeMessage(message) {
  try {
    process.stdout.write(JSON.stringify(message) + "\n");
  } catch {
    /* stdout 断开时由 stdin close 负责退出 */
  }
}

function reply(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

const serverInfo = { name: "dsh-video-comments", version: VERSION };

async function dispatch(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      reply(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo });
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params?.name ?? "";
      reply(id, await callTool(name, params?.arguments));
      return;
    }
    default:
      if (id !== undefined && id !== null && method && !method.startsWith("notifications/")) {
        replyError(id, -32601, `Method not found: ${method}`);
      }
  }
}

function main() {
  process.stderr.write(`[dsh-video-comments] ready (creds: ${bili.credsFile()})\n`);
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`[dsh-video-comments] 丢弃非 JSON 行：${trimmed.slice(0, 120)}\n`);
      return;
    }
    Promise.resolve(dispatch(message)).catch((error) => {
      process.stderr.write(`[dsh-video-comments] dispatch 异常：${String(error)}\n`);
      if (message && message.id !== undefined && message.id !== null) {
        replyError(message.id, -32603, "Internal error");
      }
    });
  });
  rl.on("close", () => process.exit(0));
}

main();
