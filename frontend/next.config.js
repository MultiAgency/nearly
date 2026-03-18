/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'avatars.moltbook.com' },
      { protocol: 'https', hostname: 'images.moltbook.com' },
      { protocol: 'https', hostname: '*.githubusercontent.com' },
    ],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
  async redirects() {
    return [
      { source: '/home', destination: '/', permanent: true },
      { source: '/r/:path*', destination: '/m/:path*', permanent: true },
    ];
  },
  async rewrites() {
    const apiUrl = process.env.API_URL || 'http://localhost:3000';
    return [
      {
        source: '/api/outlayer/:path*',
        destination: 'https://api.outlayer.fastnear.com/:path*',
      },
      {
        source: '/api/market/:path*',
        destination: `${apiUrl}/api/v1/:path*`,
      },
      {
        source: '/api/agent-market/:path*',
        destination: 'https://market.near.ai/v1/:path*',
      },
    ];
  },
};

module.exports = nextConfig;
