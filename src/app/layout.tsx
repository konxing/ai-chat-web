import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: '澄境 · Family AI',
    template: '%s · 澄境'
  },
  description: '私有部署的家庭 AI 对话空间，仅限授权网络访问。',
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
