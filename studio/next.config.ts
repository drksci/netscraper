import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // gzip would buffer the proxied SSE stream (large frame events stall), so disable it
  compress: false,
  async rewrites() {
    return [{ source: "/session/:path*", destination: `${process.env.SESSION_SERVER_URL ?? "http://127.0.0.1:7801"}/:path*` }];
  },
};

export default nextConfig;
