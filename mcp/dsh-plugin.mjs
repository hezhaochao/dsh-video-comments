/**
 * dsh-video-comments — DSH 宿主适配器（cordis 入口）
 *
 * 形状与 dsh-game-control 一致：把本包的 MCP stdio 服务器通过
 * DSH 内置的 @deepseek-ai/dsh-mcp-client 桥接挂进宿主，
 * 模型看到 mcp__video__<tool> 这一组视频浏览/评论工具。
 */
import { fileURLToPath } from "node:url";

export const name = "video-comments";

/** MCP 工具要注册进宿主工具注册表，必须等 tools 服务就绪。 */
export const inject = ["tools"];

export function bridgeConfig() {
  return {
    serverName: "video",
    transport: "stdio",
    command: process.execPath,
    args: [fileURLToPath(new URL("./server.mjs", import.meta.url))],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
  };
}

/**
 * @param ctx 宿主 cordis 上下文
 */
export async function apply(ctx) {
  const bridge = await import("@deepseek-ai/dsh-mcp-client");
  const connection = ctx.plugin(bridge, bridgeConfig());
  await connection;
}
