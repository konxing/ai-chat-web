/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: [
    '@prisma/client',
    'argon2',
    'nodemailer',
    'mammoth',
    'unpdf',
    'file-type',
    'undici'
  ],
  experimental: {
    serverActions: { bodySizeLimit: '1mb' }
  }
};

export default nextConfig;
