import 'katex/dist/katex.min.css';
import type { ReactNode } from 'react';

// KaTeX 的样式与字体只在 /chat 段需要，放在根 layout 会让登录页也下载它。
export default function ChatLayout({ children }: { children: ReactNode }) {
  return children;
}
