'use client';

import { useId, useState } from 'react';
import { Mail } from 'lucide-react';

export function AdminContact({ email }: { email: string | null }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  if (!email) {
    return <span className="ml-1 text-white/60">联系管理员</span>;
  }

  return (
    <span className="ml-1 inline-flex flex-col items-center">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="text-white/60 transition hover:text-aurora-300"
      >
        联系管理员
      </button>
      {open ? (
        <span
          id={panelId}
          className="mt-2 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-white/45"
        >
          管理员邮箱
          <a
            href={`mailto:${email}`}
            className="inline-flex items-center gap-1 text-white/85 transition hover:text-aurora-300"
          >
            <Mail className="h-3.5 w-3.5" />
            {email}
          </a>
        </span>
      ) : null}
    </span>
  );
}
