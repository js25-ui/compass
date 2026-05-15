import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // Legacy routes from the pre-three-tab structure. /ask was the chat
      // landing; /workstation was the deal-room. Both were removed in the
      // restructure, but bookmarks and external links may still hit them.
      { source: '/ask', destination: '/chat', permanent: true },
      { source: '/ask/conversation', destination: '/chat/conversation', permanent: true },
      { source: '/workstation', destination: '/chat', permanent: true },
      { source: '/workstation/:path*', destination: '/chat', permanent: true },
    ];
  },
};

export default nextConfig;
