/**
 * dsh-video-comments — 测试专用 fetch mock（--import 预加载进 server 子进程）。
 *
 * 用法：spawn 时给子进程加 `--import <本文件 file:// URL>` 并设置环境变量
 * DSH_VC_MOCK_ROUTES 指向一个 JSON 文件：
 *   { "URL 子串": 响应体, ... }
 * 匹配规则：按对象键的插入顺序取第一个命中的子串；未命中返回 HTTP 404（可测降级路径）。
 * 未设置 DSH_VC_MOCK_ROUTES 时不做任何替换 —— 真实网络测试不受影响。
 *
 * 生产代码零改动：只替换子进程里的 globalThis.fetch。
 */
import { readFileSync } from "node:fs";

const routesFile = process.env.DSH_VC_MOCK_ROUTES;
if (routesFile) {
  const routes = JSON.parse(readFileSync(routesFile, "utf8"));
  const entries = Object.entries(routes);
  globalThis.fetch = async (url) => {
    const target = String(url);
    for (const [pattern, body] of entries) {
      if (target.includes(pattern)) {
        return {
          ok: true,
          status: 200,
          json: async () => body,
          text: async () => JSON.stringify(body),
        };
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ code: -404, message: "mock: no route matched" }),
      text: async () => "",
    };
  };
}
