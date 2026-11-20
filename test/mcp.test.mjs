/**
 * dsh-video-comments — MCP 协议层测试。
 *
 * 真实拉起 mcp/server.mjs，走完整握手并抽查工具：
 * 工具清单、未知工具报错、bili_video 全链路（真实网络请求）。
 * 发布者提示词相关用例通过 test/mock-fetch.mjs（--import 预加载）mock 掉
 * 子进程里的 global fetch，不碰真实网络。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "../mcp/dsh-plugin.mjs";

const SERVER = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));
const MOCK_FETCH = fileURLToPath(new URL("./mock-fetch.mjs", import.meta.url));

function startServer({ env = {}, preload = "" } = {}) {
  const args = [];
  if (preload) args.push("--import", pathToFileURL(preload).href);
  args.push(SERVER);
  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const pending = new Map();
  let nextId = 1;
  const rl = createInterface({ input: child.stdout, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });
  let stderrBuf = "";
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk;
  });

  function request(method, params) {
    const id = nextId++;
    const message = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    const promise = new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`请求超时: ${method}\nstderr: ${stderrBuf.slice(-400)}`));
        }
      }, 60_000);
    });
    child.stdin.write(JSON.stringify(message) + "\n");
    return promise;
  }

  function notify(method, params) {
    const message = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    child.stdin.write(JSON.stringify(message) + "\n");
  }

  async function close() {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }

  return { request, notify, close };
}

async function handshake(server) {
  const init = await server.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "video-cm-test", version: "0.0.0" },
  });
  server.notify("notifications/initialized");
  return init;
}

test("MCP 握手与工具清单（7 个）", async () => {
  const server = startServer();
  try {
    const init = await handshake(server);
    assert.equal(init.result.protocolVersion, "2024-11-05");
    assert.equal(init.result.serverInfo.name, "dsh-video-comments");
    const list = await server.request("tools/list");
    const names = list.result.tools.map((t) => t.name);
    assert.deepEqual(
      [...names].sort(),
      ["bili_comment", "bili_comments", "bili_owner_prompt", "bili_search", "bili_video", "douyin_open", "douyin_video"],
    );
    for (const tool of list.result.tools) {
      assert.equal(tool.inputSchema.type, "object");
    }
  } finally {
    await server.close();
  }
});

test("未知工具返回 isError", async () => {
  const server = startServer();
  try {
    await handshake(server);
    const call = await server.request("tools/call", { name: "no_such_tool", arguments: {} });
    assert.equal(call.result.isError, true);
  } finally {
    await server.close();
  }
});

const STABLE_BV = "BV1GJ411x7h7"; // 【官方 MV】Never Gonna Give You Up（索尼音乐中国，长期有效）

test("bili_video / bili_comments 全链路（真实网络）", async (t) => {
  const server = startServer();
  try {
    await handshake(server);
    const video = await server.request("tools/call", {
      name: "bili_video",
      arguments: { url_or_bvid: STABLE_BV },
    });
    const videoPayload = JSON.parse(video.result.content[0].text);
    if (video.result.isError) {
      t.skip(`视频信息不可用：${videoPayload.error}`);
      return;
    }
    assert.equal(videoPayload.ok, true);
    assert.equal(videoPayload.bvid, STABLE_BV);
    assert.ok(videoPayload.title, "应有标题");
    assert.ok(videoPayload.stat, "应有播放数据");

    const comments = await server.request("tools/call", {
      name: "bili_comments",
      arguments: { url_or_bvid: STABLE_BV, page: 1 },
    });
    const commentsPayload = JSON.parse(comments.result.content[0].text);
    if (comments.result.isError) {
      t.skip(`评论区不可用：${commentsPayload.error}`);
      return;
    }
    assert.equal(commentsPayload.ok, true);
    assert.ok(Array.isArray(commentsPayload.comments));
  } finally {
    await server.close();
  }
});

test("bili_search：无凭据时返回明确的登录提示（诚实报错）", async (t) => {
  const server = startServer();
  try {
    await handshake(server);
    const search = await server.request("tools/call", {
      name: "bili_search",
      arguments: { keyword: "Never Gonna Give You Up" },
    });
    const payload = JSON.parse(search.result.content[0].text);
    if (!search.result.isError) {
      assert.equal(payload.ok, true);
      assert.ok(payload.results.length > 0, "搜索应有结果");
      return;
    }
    assert.ok(
      payload.error.includes("-101") || payload.error.includes("登录") || payload.error.includes("凭据"),
      `应给出登录相关提示，实际: ${payload.error}`,
    );
  } finally {
    await server.close();
  }
});

test("bili_comment 未确认/无凭据时明确拒绝（不发任何请求）", async () => {
  const server = startServer();
  try {
    await handshake(server);
    const noConfirm = await server.request("tools/call", {
      name: "bili_comment",
      arguments: { url_or_bvid: "BV1GJ411x7h7", text: "test", confirm: false },
    });
    const noConfirmPayload = JSON.parse(noConfirm.result.content[0].text);
    assert.equal(noConfirm.result.isError, true);
    assert.ok(noConfirmPayload.error.includes("confirm"), "应提示需要 confirm");

    const confirmed = await server.request("tools/call", {
      name: "bili_comment",
      arguments: { url_or_bvid: "BV1GJ411x7h7", text: "test", confirm: true },
    });
    const confirmedPayload = JSON.parse(confirmed.result.content[0].text);
    assert.equal(confirmed.result.isError, true);
    const mentionsCreds =
      confirmedPayload.error.includes("SESSDATA") || confirmedPayload.error.includes("凭据");
    assert.ok(mentionsCreds, `无凭据时应明确提示配置方法，实际: ${confirmedPayload.error}`);
  } finally {
    await server.close();
  }
});

/* ────────────────────────── 发布者提示词（mock fetch） ────────────────────────── */

const MOCK_BV = "BV1MOCK0000x"; // 匹配 /BV[0-9A-Za-z]{10}/ 的假 BV 号

const MOCK_ROUTES = {
  "/x/web-interface/view?bvid=": {
    code: 0,
    data: {
      bvid: MOCK_BV,
      aid: 42,
      title: "测试视频",
      desc: "评论区自由回复",
      owner: { mid: 111, name: "测试UP主" },
      duration: 100,
      tname: "测试分区",
      pubdate: 1700000000,
      stat: { view: 10, danmaku: 2, reply: 3, like: 4, coin: 5, favorite: 6, share: 7 },
    },
  },
  "/x/v2/reply?type=1&oid=42&pn=1": {
    code: 0,
    data: {
      page: { count: 3 },
      replies: [
        {
          rpid: 1,
          member: { mid: 111, uname: "测试UP主" },
          like: 9,
          ctime: 1700000000,
          content: { message: "提示词A：只在带提问二字的评论下回复" },
        },
        {
          rpid: 2,
          member: { mid: 222, uname: "路人甲" },
          like: 1,
          ctime: 1700000001,
          content: { message: "普通评论，不是UP主发的" },
        },
      ],
    },
  },
  "/x/v2/reply?type=1&oid=42&pn=2": {
    code: 0,
    data: {
      page: { count: 3 },
      replies: [
        {
          rpid: 3,
          member: { mid: 111, uname: "测试UP主" },
          like: 2,
          ctime: 1700000002,
          content: { message: "提示词B：不要回复任何评论" },
        },
      ],
    },
  },
  // pn=3 故意不配路由（mock 命不中返回 404）：验证翻页失败时拾取降级而非整体报错
};

/** 写一份 mock 路由文件到临时目录，返回 { env, cleanup } */
function writeMockRoutes() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-vc-owner-prompt-"));
  const routesFile = join(dir, "routes.json");
  writeFileSync(routesFile, JSON.stringify(MOCK_ROUTES));
  return {
    env: { DSH_VC_MOCK_ROUTES: routesFile },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function callTool(server, name, args = {}) {
  return server.request("tools/call", { name, arguments: args });
}

test("owner prompt：mode=ignore（默认）时输出与功能加入前一致，无附加字段", async () => {
  const mock = writeMockRoutes();
  const server = startServer({ env: mock.env, preload: MOCK_FETCH });
  try {
    await handshake(server);

    const video = await callTool(server, "bili_video", { url_or_bvid: MOCK_BV });
    const videoPayload = JSON.parse(video.result.content[0].text);
    assert.equal(video.result.isError, undefined);
    assert.equal(videoPayload.ok, true);
    assert.equal("owner_prompt_policy" in videoPayload, false, "ignore 模式不得附加策略对象");

    const comments = await callTool(server, "bili_comments", { url_or_bvid: MOCK_BV });
    const commentsPayload = JSON.parse(comments.result.content[0].text);
    assert.equal(commentsPayload.ok, true);
    assert.equal("owner_prompt_policy" in commentsPayload, false, "ignore 模式不得附加策略对象");

    const prompt = await callTool(server, "bili_owner_prompt", { url_or_bvid: MOCK_BV });
    const promptPayload = JSON.parse(prompt.result.content[0].text);
    assert.equal(prompt.result.isError, undefined);
    assert.equal(promptPayload.mode, "ignore");
    assert.equal("prompt" in promptPayload, false, "ignore 模式不得返回提示词");
    assert.equal("guidance" in promptPayload, false);
    assert.ok(promptPayload.note.includes("已关闭"));
  } finally {
    await server.close();
    mock.cleanup();
  }
});

test("owner prompt：strict 模式 bili_video/bili_comments 成功输出附带 owner_prompt_policy", async () => {
  const mock = writeMockRoutes();
  const server = startServer({
    env: {
      ...mock.env,
      DSH_VC_OWNER_PROMPT_MODE: "strict",
      DSH_VC_OWNER_PROMPT_SOURCES: "description,owner_comment",
    },
    preload: MOCK_FETCH,
  });
  try {
    await handshake(server);

    const video = await callTool(server, "bili_video", { url_or_bvid: MOCK_BV });
    const videoPayload = JSON.parse(video.result.content[0].text);
    const policy = videoPayload.owner_prompt_policy;
    assert.ok(policy, "strict 下 bili_video 应附带 owner_prompt_policy");
    assert.equal(policy.mode, "strict");
    assert.equal(typeof policy.guidance, "string");
    assert.ok(policy.guidance.includes("不可信"), "guidance 应包含不可信外部数据约束");
    assert.ok(policy.guidance.includes("唯一依据"), "strict guidance 应包含唯一依据规则");
    assert.equal(policy.prompt.description, "评论区自由回复", "description 来源应拾取简介全文");
    assert.ok(policy.prompt.owner_comment.includes("提示词A"), "owner_comment 应拾取到 UP 主第 1 页评论");
    assert.ok(policy.prompt.owner_comment.includes("提示词B"), "owner_comment 应翻页拾取到第 2 页评论");
    assert.ok(!policy.prompt.owner_comment.includes("普通评论"), "路人评论（mid 不匹配）不得混入");
    assert.equal(videoPayload.owner_mid, 111, "bili_video 应带 owner_mid 供对账");

    const comments = await callTool(server, "bili_comments", { url_or_bvid: MOCK_BV });
    const commentsPayload = JSON.parse(comments.result.content[0].text);
    assert.ok(commentsPayload.owner_prompt_policy, "strict 下 bili_comments 应附带 owner_prompt_policy");
    assert.equal(commentsPayload.owner_prompt_policy.mode, "strict");
    // 必要接线：评论带 mid，Agent 可与 owner_mid 对账识别 UP 主发言
    assert.equal(commentsPayload.comments[0].mid, 111);
    assert.equal(commentsPayload.comments[1].mid, 222);
  } finally {
    await server.close();
    mock.cleanup();
  }
});

test("owner prompt：bili_owner_prompt 按来源开关与 owner.mid 过滤拾取", async () => {
  const mock = writeMockRoutes();
  const server = startServer({
    env: {
      ...mock.env,
      DSH_VC_OWNER_PROMPT_MODE: "relaxed",
      DSH_VC_OWNER_PROMPT_SOURCES: "owner_comment",
    },
    preload: MOCK_FETCH,
  });
  try {
    await handshake(server);
    const prompt = await callTool(server, "bili_owner_prompt", { url_or_bvid: MOCK_BV });
    const payload = JSON.parse(prompt.result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.mode, "relaxed");
    assert.deepEqual(payload.sources, ["owner_comment"]);
    assert.equal("description" in payload.prompt, false, "来源未开启时不得返回简介");
    assert.ok(payload.prompt.owner_comment.includes("提示词A"), "应拾取第 1 页 UP 主评论");
    assert.ok(payload.prompt.owner_comment.includes("提示词B"), "应翻页拾取第 2 页 UP 主评论");
    assert.ok(!payload.prompt.owner_comment.includes("普通评论"), "mid 过滤：只收 UP 主自己的评论");
    assert.ok(payload.guidance.includes("不可信"));
    assert.ok(!payload.guidance.includes("唯一依据"), "relaxed 的 guidance 不应包含 strict 规则");
  } finally {
    await server.close();
    mock.cleanup();
  }
});

test("owner prompt：非法 env 值 fail-closed（mode 不认识按 ignore；sources 全不认识回落默认）", async () => {
  // ① mode 非法 → 按 ignore 处理
  const mock1 = writeMockRoutes();
  const server1 = startServer({ env: { ...mock1.env, DSH_VC_OWNER_PROMPT_MODE: "yolo" }, preload: MOCK_FETCH });
  try {
    await handshake(server1);
    const prompt = await callTool(server1, "bili_owner_prompt", { url_or_bvid: MOCK_BV });
    assert.equal(JSON.parse(prompt.result.content[0].text).mode, "ignore");
  } finally {
    await server1.close();
    mock1.cleanup();
  }

  // ② mode 合法但 sources 全非法 → 回落默认 description
  const mock2 = writeMockRoutes();
  const server2 = startServer({
    env: {
      ...mock2.env,
      DSH_VC_OWNER_PROMPT_MODE: "strict",
      DSH_VC_OWNER_PROMPT_SOURCES: "picture,subtitle",
    },
    preload: MOCK_FETCH,
  });
  try {
    await handshake(server2);
    const prompt = await callTool(server2, "bili_owner_prompt", { url_or_bvid: MOCK_BV });
    const payload = JSON.parse(prompt.result.content[0].text);
    assert.deepEqual(payload.sources, ["description"], "非法来源应回落默认 description");
    assert.equal(payload.prompt.description, "评论区自由回复");
    assert.equal("owner_comment" in payload.prompt, false);
  } finally {
    await server2.close();
    mock2.cleanup();
  }
});

test("owner prompt：Config schema 校验（缺省补默认、非法值拒绝、去重）", () => {
  const ok = Config["~standard"].validate({});
  assert.equal(ok.issues, undefined);
  assert.deepEqual(ok.value, { ownerPromptMode: "ignore", ownerPromptSources: ["description"] });

  const strict = Config["~standard"].validate({
    ownerPromptMode: "strict",
    ownerPromptSources: ["description", "owner_comment"],
  });
  assert.equal(strict.issues, undefined);
  assert.deepEqual(strict.value, {
    ownerPromptMode: "strict",
    ownerPromptSources: ["description", "owner_comment"],
  });

  const dup = Config["~standard"].validate({ ownerPromptSources: ["owner_comment", "owner_comment"] });
  assert.deepEqual(dup.value.ownerPromptSources, ["owner_comment"], "重复来源应去重");

  const badMode = Config["~standard"].validate({ ownerPromptMode: "yolo" });
  assert.ok(badMode.issues?.length, "非法 mode 应被拒绝");
  assert.ok(badMode.issues[0].message.includes("ownerPromptMode"));

  const badSources = Config["~standard"].validate({ ownerPromptSources: ["picture"] });
  assert.ok(badSources.issues?.length, "非法来源应被拒绝（插件没有画面/字幕能力）");
  assert.ok(badSources.issues[0].message.includes("picture"));

  const emptySources = Config["~standard"].validate({ ownerPromptSources: [] });
  assert.ok(emptySources.issues?.length, "空来源数组应被拒绝");

  const notArray = Config["~standard"].validate({ ownerPromptSources: "description" });
  assert.ok(notArray.issues?.length, "非数组来源应被拒绝");
});
