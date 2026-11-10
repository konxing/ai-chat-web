import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'AI Chat',
    template: '%s · AI Chat'
  },
  description: '用于日常交流、提问和讨论的私有 AI 对话平台，仅限授权网络访问。',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'same-origin'
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: '#07090f',
  colorScheme: 'dark',
  viewportFit: 'cover'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
