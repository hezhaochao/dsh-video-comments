/**
 * dsh-video-comments — B 站 API 客户端（零依赖，Node 20+ 原生 fetch）
 *
 * 端点与签名算法来自社区整理的 bilibili-API-collect 文档：
 *   - 匿名 buvid3：/x/frontend/finger/spi
 *   - wbi 签名：nav 取 img/sub key → 固定置换表取 32 位 mixin key →
 *     参数排序拼 query + wts → md5(query + mixin_key) 得 w_rid
 *   - 搜索走 wbi 端点；视频信息与评论列表为公开端点；
 *     发评论需要用户自己的 SESSDATA/bili_jct（凭据文件，永不外传）
 *
 * 写操作纪律：
 *   - 内存限速：两次写入之间至少 VIDEO_CM_MIN_INTERVAL_MS（默认 30s）
 *   - 长度上限 1000 字符
 *   - 调用方必须显式传 confirm=true（MCP 工具层再校验一次）
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
// 风控要求「像浏览器」：缺 sec-ch-ua / Sec-Fetch 系列头会 412 劫持到验证页（真机踩过）
function browserHeaders(referer) {
  return {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Referer: referer || "https://www.bilibili.com/",
    Origin: "https://www.bilibili.com",
    "sec-ch-ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    "sec-ch-ua-mobile": "?0",
    'sec-ch-ua-platform': '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
  };
}
const WBI_MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];
const COMMENT_MAX_LEN = 1000;

export function credsFile() {
  return process.env.VIDEO_CM_CREDS_FILE || path.join(os.homedir(), ".dsh", "video-credentials.json");
}

let credsCache = null;
function loadCreds() {
  if (credsCache) return credsCache;
  try {
    const raw = JSON.parse(readFileSync(credsFile(), "utf8"));
    credsCache = {
      SESSDATA: typeof raw.SESSDATA === "string" ? raw.SESSDATA : "",
      bili_jct: typeof raw.bili_jct === "string" ? raw.bili_jct : "",
      buvid3: typeof raw.buvid3 === "string" ? raw.buvid3 : "",
    };
  } catch {
    credsCache = { SESSDATA: "", bili_jct: "", buvid3: "" };
  }
  return credsCache;
}

export function hasWriteCreds() {
  const c = loadCreds();
  return Boolean(c.SESSDATA && c.bili_jct);
}

/* ────────────────────────── 基础请求 ────────────────────────── */

let anonBuvid = "";
async function ensureBuvid() {
  const c = loadCreds();
  if (c.buvid3) return c.buvid3;
  if (anonBuvid) return anonBuvid;
  try {
    const res = await fetch("https://api.bilibili.com/x/frontend/finger/spi", {
      headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/" },
    });
    const body = await res.json();
    if (body?.code === 0 && body?.data?.b_3) {
      anonBuvid = body.data.b_3;
    }
  } catch {
    /* 匿名 buvid 拿不到就不带，公开端点大多仍可用 */
  }
  return anonBuvid;
}

async function biliFetch(url, { cookie = "", method = "GET", form = null, referer = "" } = {}) {
  const headers = browserHeaders(referer);
  if (cookie) headers.Cookie = cookie;
  const init = { headers, method };
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(form).toString();
  }
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const body = await res.json();
  if (body?.code !== 0) {
    const err = new Error(`B站 API ${body?.code}: ${body?.message || "未知错误"}`);
    err.biliCode = body?.code;
    throw err;
  }
  return body.data;
}

/* ────────────────────────── wbi 签名 ────────────────────────── */

let wbiCache = { key: "", at: 0 };
async function wbiKey() {
  if (wbiCache.key && Date.now() - wbiCache.at < 3600_000) return wbiCache.key;
  const data = await biliFetch("https://api.bilibili.com/x/web-interface/nav");
  const img = String(data?.wbi_img?.img_url || "").split("/").pop()?.split(".")[0] || "";
  const sub = String(data?.wbi_img?.sub_url || "").split("/").pop()?.split(".")[0] || "";
  const raw = img + sub;
  if (raw.length < 32) throw new Error("wbi key 获取失败");
  let mixin = "";
  for (const i of WBI_MIXIN_TAB) {
    if (raw[i] !== undefined) mixin += raw[i];
  }
  wbiCache = { key: mixin.slice(0, 32), at: Date.now() };
  return wbiCache.key;
}

async function wbiSign(params) {
  const key = await wbiKey();
  const merged = { ...params, wts: Math.floor(Date.now() / 1000) };
  const entries = Object.entries(merged)
    .map(([k, v]) => [k, String(v).replace(/[!'()*]/g, "")])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const query = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const w_rid = createHash("md5").update(query + key).digest("hex");
  return `${query}&w_rid=${w_rid}`;
}

/* ────────────────────────── 读写限速 ────────────────────────── */

const minInterval = Number(process.env.VIDEO_CM_MIN_INTERVAL_MS || 30_000);
let lastWriteAt = 0;

async function writeGate() {
  const now = Date.now();
  const wait = lastWriteAt + minInterval - now;
  if (wait > 0) {
    const err = new Error(`写入限速：距上次写入还需 ${Math.ceil(wait / 1000)} 秒（防刷评保护，可用 VIDEO_CM_MIN_INTERVAL_MS 调整）`);
    err.rateLimited = true;
    throw err;
  }
  lastWriteAt = now;
}

/* ────────────────────────── 工具函数 ────────────────────────── */

export function parseBvid(input) {
  const s = String(input || "").trim();
  const m = s.match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}

function cleanTitle(text) {
  return String(text || "").replace(/<[^>]+>/g, "");
}

function fmtDuration(sec) {
  const s = Number(sec) || 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/* ────────────────────────── 公开接口 ────────────────────────── */

export async function biliSearch(keyword, page = 1) {
  if (!keyword) throw new Error("缺少关键词");
  const buvid = await ensureBuvid();
  const c = loadCreds();
  // 搜索端点自 2023 起强制要求登录态：有凭据带上，没有则返回明确的 -101 提示
  const cookieParts = [];
  if (buvid) cookieParts.push(`buvid3=${buvid}`);
  if (c.SESSDATA) cookieParts.push(`SESSDATA=${c.SESSDATA}`);
  const query = await wbiSign({ search_type: "video", keyword, page });
  const data = await biliFetch(`https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`, {
    cookie: cookieParts.join("; "),
    referer: "https://search.bilibili.com/",
  });
  const results = (data?.result || []).slice(0, 20).map((r) => ({
    bvid: r.bvid,
    title: cleanTitle(r.title),
    author: r.author,
    play: r.play,
    danmaku: r.video_review,
    duration: r.duration,
    pubdate: r.pubdate ? new Date(r.pubdate * 1000).toISOString().slice(0, 10) : "",
    description: cleanTitle(r.description).slice(0, 120),
  }));
  return { ok: true, keyword, page, numResults: results.length, results };
}

export async function biliVideo(input) {
  const bvid = parseBvid(input);
  if (!bvid) throw new Error("无法从输入解析 BV 号（支持 BV 号或视频 URL）");
  const data = await biliFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
    referer: `https://www.bilibili.com/video/${bvid}/`,
  });
  return {
    ok: true,
    bvid: data.bvid,
    aid: data.aid,
    title: data.title,
    description: String(data.desc || "").slice(0, 500),
    owner: data.owner?.name,
    duration: fmtDuration(data.duration),
    tname: data.tname,
    pubdate: data.pubdate ? new Date(data.pubdate * 1000).toISOString().slice(0, 10) : "",
    stat: {
      play: data.stat?.view,
      danmaku: data.stat?.danmaku,
      reply: data.stat?.reply,
      like: data.stat?.like,
      coin: data.stat?.coin,
      favorite: data.stat?.favorite,
      share: data.stat?.share,
    },
    url: `https://www.bilibili.com/video/${data.bvid}`,
  };
}

export async function biliComments(input, page = 1, sort = 1) {
  const bvid = parseBvid(input);
  if (!bvid) throw new Error("无法从输入解析 BV 号（支持 BV 号或视频 URL）");
  const view = await biliFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
    referer: `https://www.bilibili.com/video/${bvid}/`,
  });
  const oid = view.aid;
  const data = await biliFetch(
    `https://api.bilibili.com/x/v2/reply?type=1&oid=${oid}&pn=${page}&ps=20&sort=${sort}`,
    { referer: `https://www.bilibili.com/video/${bvid}/` },
  );
  const map = (r) => ({
    rpid: r.rpid,
    user: r.member?.uname,
    like: r.like,
    time: r.ctime ? new Date(r.ctime * 1000).toISOString().slice(0, 10) : "",
    message: String(r.content?.message || "").slice(0, 300),
    subReplyCount: r.rcount || 0,
  });
  const replies = (data?.replies || []).map(map);
  const top = (data?.top_replies || []).map(map);
  return {
    ok: true,
    bvid,
    title: view.title,
    page,
    total: data?.page?.count ?? 0,
    sort: sort === 2 ? "hot" : sort === 1 ? "like" : "time",
    pinned: top,
    comments: replies,
  };
}

/* ────────────────────────── 写入（需凭据） ────────────────────────── */

export async function biliPostComment(input, text, { confirm = false } = {}) {
  const bvid = parseBvid(input);
  if (!bvid) throw new Error("无法从输入解析 BV 号（支持 BV 号或视频 URL）");
  const message = String(text || "").trim();
  if (!message) throw new Error("评论内容不能为空");
  if (message.length > COMMENT_MAX_LEN) throw new Error(`评论过长（${message.length} > ${COMMENT_MAX_LEN}）`);
  if (confirm !== true) throw new Error("需要显式 confirm=true 才会发评论（确认后再调用一次）");
  if (!hasWriteCreds()) {
    throw new Error(
      `未配置 B 站登录凭据：请在 ${credsFile()} 写入 {"SESSDATA":"...","bili_jct":"..."}（浏览器登录 B 站后从 Cookie 取），或用 VIDEO_CM_CREDS_FILE 指定其他路径`,
    );
  }
  await writeGate();
  const c = loadCreds();
  const view = await biliFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
    referer: `https://www.bilibili.com/video/${bvid}/`,
  });
  const cookieParts = [`SESSDATA=${c.SESSDATA}`, `bili_jct=${c.bili_jct}`];
  const buvid = c.buvid3 || (await ensureBuvid());
  if (buvid) cookieParts.push(`buvid3=${buvid}`);
  const data = await biliFetch("https://api.bilibili.com/x/v2/reply/add", {
    method: "POST",
    cookie: cookieParts.join("; "),
    form: { oid: view.aid, type: 1, message, csrf: c.bili_jct },
  });
  return {
    ok: true,
    bvid,
    rpid: data?.rpid,
    message,
    note: "已发布（限速窗口内不能再发）",
  };
}
