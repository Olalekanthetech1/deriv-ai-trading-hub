/** @type {import('next').NextConfig} */

function getConfiguredOrigin() {
  const raw = process.env.APP_URL?.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const configuredOrigin = getConfiguredOrigin();
const apiHeaders = [
  { key: 'Cache-Control', value: 'no-store' },
  ...(configuredOrigin
    ? [
        { key: 'Access-Control-Allow-Credentials', value: 'true' },
        { key: 'Access-Control-Allow-Origin', value: configuredOrigin },
        { key: 'Access-Control-Allow-Methods', value: 'GET,DELETE,PATCH,POST,PUT,OPTIONS' },
        { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization, X-Admin-Token, X-CSRF-Token, X-Requested-With, Accept, X-Api-Version' },
      ]
    : []),
];

const nextConfig = {
  transpilePackages: ['@deriv/core'],
  output: 'standalone',
  experimental: {
    serverActions: {
      allowedOrigins: [
        '*.run.app',
        '*.europe-west2.run.app',
        '*.googleusercontent.com',
        'localhost:3000',
        '127.0.0.1:3000',
      ],
    },
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
      {
        source: '/_next/(.*)',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, HEAD, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: '*' },
        ],
      },
      {
        source: '/api/(.*)',
        headers: apiHeaders,
      },
    ];
  },
};

module.exports = nextConfig;
