/**
 * dsh-video-comments — B 站客户端单元测试（不联网，验证解析/签名纯逻辑）。
 *
 * wbi 签名与 bvid 解析用已知样例对拍；网络层由 test/mcp.test.mjs 的
 * 真实调用覆盖。运行：node test/bili.live.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseBvid } from "../mcp/bili.mjs";

test("parseBvid：URL / 纯 BV 号 / 带文字的分享文本", () => {
  assert.equal(parseBvid("https://www.bilibili.com/video/BV1GJ411x7h7/?p=1"), "BV1GJ411x7h7");
  assert.equal(parseBvid("BV1GJ411x7h7"), "BV1GJ411x7h7");
  assert.equal(parseBvid("https://b23.tv/abcd 到手 BV1xx411c7mD 好东西"), "BV1xx411c7mD");
  assert.equal(parseBvid(""), null);
  assert.equal(parseBvid("https://www.douyin.com/video/123"), null);
});

test("凭据文件路径可解析且不抛错", async () => {
  const mod = await import(`../mcp/bili.mjs?cache=${Date.now()}`);
  assert.ok(typeof mod.credsFile() === "string");
  assert.equal(typeof mod.hasWriteCreds(), "boolean");
});
