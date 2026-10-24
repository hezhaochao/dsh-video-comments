/**
 * dsh-video-comments — MCP 协议层测试。
 *
 * 真实拉起 mcp/server.mjs，走完整握手并抽查工具：
 * 工具清单、未知工具报错、bili_video 全链路（真实网络请求）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));

function startServer() {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
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

test("MCP 握手与工具清单（6 个）", async () => {
  const server = startServer();
  try {
    const init = await handshake(server);
    assert.equal(init.result.protocolVersion, "2024-11-05");
    assert.equal(init.result.serverInfo.name, "dsh-video-comments");
    const list = await server.request("tools/list");
    const names = list.result.tools.map((t) => t.name);
    assert.deepEqual(
      [...names].sort(),
      ["bili_comment", "bili_comments", "bili_search", "bili_video", "douyin_open", "douyin_video"],
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
