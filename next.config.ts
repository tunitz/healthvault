import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  // Next 16 blocks dev resources for origins it doesn't know; the smoke tests and
  // browser checks hit 127.0.0.1 instead of localhost.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
