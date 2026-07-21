/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: {
    // Ensures instrumentation.ts runs so the auto-sync scheduler starts
    instrumentationHook: true,
  },
};

module.exports = nextConfig;
