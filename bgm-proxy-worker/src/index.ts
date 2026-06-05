/**
 * Bangumi API 透明代理 — 部署在 Cloudflare Workers 上。
 * 解决腾讯云北京机房无法直连 api.bgm.tv（日本 IP 192.133.77.133）的问题。
 *
 * 所有请求透传到 https://api.bgm.tv，保留原始请求的 header（Authorization、User-Agent 等）。
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const target = 'https://api.bgm.tv' + url.pathname + url.search;

    const headers = new Headers(request.headers);
    headers.set('User-Agent', 'my-ai-app-demo/1.0 (bgm-proxy-worker)');
    headers.delete('CF-Connecting-IP');

    const response = await fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
    });

    const respHeaders = new Headers(response.headers);
    respHeaders.set('Access-Control-Allow-Origin', '*');
    respHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: respHeaders,
    });
  },
};
