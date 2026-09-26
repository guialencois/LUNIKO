/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Server Actions and route handlers must never leak service-role secrets
  // to the client. Only NEXT_PUBLIC_* vars are exposed to the browser bundle.
};

export default nextConfig;
