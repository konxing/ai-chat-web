'use client';

import { useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const text = ref.current?.innerText ?? '';
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="code-block group">
      <button type="button" className="code-copy btn-icon h-8 w-8 border-white/10 bg-black/50" onClick={copy} aria-label="复制代码">
        {copied ? <Check className="h-3.5 w-3.5 text-aurora-300" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          rehypeKatex,
          [rehypeHighlight, { detect: true, ignoreMissing: true }]
        ]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ href, children: linkChildren }) => {
            const safe = typeof href === 'string' && /^(https?:|mailto:|\/)/i.test(href);
            if (!safe) return <span>{linkChildren}</span>;
            const external = /^https?:/i.test(href);
            return (
              <a
                href={href}
                target={external ? '_blank' : undefined}
                rel={external ? 'noopener noreferrer nofollow' : undefined}
              >
                {linkChildren}
              </a>
            );
          },
          img: ({ src, alt }) => {
            const value = typeof src === 'string' ? src : '';
            if (!value.startsWith('/api/files/') && !value.startsWith('data:image/')) {
              return <span className="text-white/40">[图片]</span>;
            }
            // eslint-disable-next-line @next/next/no-img-element
            return <img src={value} alt={alt || ''} loading="lazy" referrerPolicy="no-referrer" />;
          }
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
