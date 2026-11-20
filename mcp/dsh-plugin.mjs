/**
 * dsh-video-comments — DSH 宿主适配器（cordis 入口）
 *
 * 形状与 dsh-game-control 一致：把本包的 MCP stdio 服务器通过
 * DSH 内置的 @deepseek-ai/dsh-mcp-client 桥接挂进宿主，
 * 模型看到 mcp__video__<tool> 这一组视频浏览/评论工具。
 *
 * Config（用户设置，模型/AI 无权修改）：视频发布者提示词的拾取策略。
 * 本插件零依赖，不 import schemastery；导出的是一个 JSON Schema 描述对象，
 * 并自带 Standard Schema V1 的 `~standard.validate`（同步校验 + 补默认值）——
 * DSH loader 的 resolveConfig 正是走 `Config['~standard'].validate(config)`。
 * 校验结果（含默认值）传给 apply，再经环境变量下发给 stdio 子进程。
 */
import { fileURLToPath } from "node:url";

export const name = "video-comments";

/** MCP 工具要注册进宿主工具注册表，必须等 tools 服务就绪。 */
export const inject = ["tools"];

/* ────────────────────────── 发布者提示词设置 ────────────────────────── */

export const OWNER_PROMPT_MODES = ["ignore", "relaxed", "strict"];
export const OWNER_PROMPT_SOURCES = ["description", "owner_comment"];
export const DEFAULT_OWNER_PROMPT_CONFIG = Object.freeze({
  ownerPromptMode: "ignore",
  ownerPromptSources: Object.freeze(["description"]),
});

const issue = (message, path) => ({ message, path: [path] });

/**
 * 同步校验并规范化 owner prompt 设置：
 *   ownerPromptMode    枚举 ignore/relaxed/strict，默认 ignore
 *   ownerPromptSources 数组且元素只允许 description/owner_comment，去重，非空，默认 ["description"]
 * 返回 Standard Schema V1 的结果形状：{ value } 或 { issues }。
 */
function validateOwnerPromptConfig(value) {
  const merged = { ...DEFAULT_OWNER_PROMPT_CONFIG, ...(value && typeof value === "object" ? value : null) };
  const issues = [];

  if (!OWNER_PROMPT_MODES.includes(merged.ownerPromptMode)) {
    issues.push(issue(`ownerPromptMode 必须是 ${OWNER_PROMPT_MODES.join(" / ")} 之一`, "ownerPromptMode"));
  }

  const sources = merged.ownerPromptSources;
  if (!Array.isArray(sources)) {
    issues.push(issue("ownerPromptSources 必须是数组", "ownerPromptSources"));
  } else if (sources.length === 0) {
    issues.push(issue("ownerPromptSources 至少要有一个来源", "ownerPromptSources"));
  } else {
    const invalid = sources.filter((s) => !OWNER_PROMPT_SOURCES.includes(s));
    if (invalid.length) {
      issues.push(
        issue(`ownerPromptSources 含不支持的来源：${invalid.join("、")}（只支持 ${OWNER_PROMPT_SOURCES.join(" / ")}）`, "ownerPromptSources"),
      );
    }
  }

  if (issues.length) return { issues };

  // 输出只含这两个键；sources 去重且保持用户给的顺序
  return {
    value: {
      ownerPromptMode: merged.ownerPromptMode,
      ownerPromptSources: [...new Set(sources)].filter((s) => OWNER_PROMPT_SOURCES.includes(s)),
    },
  };
}

export const Config = {
  type: "object",
  properties: {
    ownerPromptMode: {
      type: "string",
      enum: OWNER_PROMPT_MODES,
      default: "ignore",
      description:
        "视频发布者提示词：ignore=无视（默认，工具输出不带任何提示词）；relaxed=轻松（提示词作偏好参考）；strict=严格（提示词是是否回复的唯一依据）",
    },
    ownerPromptSources: {
      type: "array",
      items: { type: "string", enum: OWNER_PROMPT_SOURCES },
      default: [...DEFAULT_OWNER_PROMPT_CONFIG.ownerPromptSources],
      description: "提示词拾取来源（多选）：description=视频简介；owner_comment=发布者在评论区发的评论",
    },
  },
  additionalProperties: false,
  "~standard": {
    version: 1,
    vendor: "dsh-video-comments",
    validate: validateOwnerPromptConfig,
  },
};

export function bridgeConfig(extraEnv = {}) {
  return {
    serverName: "video",
    transport: "stdio",
    command: process.execPath,
    args: [fileURLToPath(new URL("./server.mjs", import.meta.url))],
    env: { ELECTRON_RUN_AS_NODE: "1", ...extraEnv },
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
  };
}

/**
 * @param ctx 宿主 cordis 上下文
 * @param config 已被 Config['~standard'].validate 规范化的设置
 */
export async function apply(ctx, config) {
  const merged = { ...DEFAULT_OWNER_PROMPT_CONFIG, ...(config ?? null) };
  // 正常路径 config 已校验过；这里再 fail-closed 一次，直接裸调用 apply 也不会把坏值传下去
  const mode = OWNER_PROMPT_MODES.includes(merged.ownerPromptMode) ? merged.ownerPromptMode : "ignore";
  const sources = Array.isArray(merged.ownerPromptSources)
    ? merged.ownerPromptSources.filter((s) => OWNER_PROMPT_SOURCES.includes(s))
    : [];
  const env = {
    DSH_VC_OWNER_PROMPT_MODE: mode,
    DSH_VC_OWNER_PROMPT_SOURCES:
      (mode === "ignore" || sources.length ? sources : DEFAULT_OWNER_PROMPT_CONFIG.ownerPromptSources).join(","),
  };
  const bridge = await import("@deepseek-ai/dsh-mcp-client");
  const connection = ctx.plugin(bridge, bridgeConfig(env));
  await connection;
}
