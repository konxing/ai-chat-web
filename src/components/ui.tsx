'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { AlertTriangle, CheckCircle2, Loader2, X, XCircle, Lock } from 'lucide-react';
import { cn } from '@/lib/cn';

/* ------------------------------- Modal ------------------------------- */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = '520px'
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/65 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="panel max-h-[92vh] w-full overflow-y-auto rounded-b-none rounded-t-2xl p-5 sm:rounded-2xl sm:p-6"
        style={{ maxWidth: width }}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">{title}</h2>
            {description ? <p className="mt-1 text-[13px] leading-relaxed text-white/45">{description}</p> : null}
          </div>
          <button type="button" className="btn-icon shrink-0" onClick={onClose} aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
        {footer ? <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ------------------------------- Spinner ------------------------------- */

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin', className)} />;
}

export function LoadingBlock({ label = '加载中' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-white/40">
      <Spinner /> {label}
    </div>
  );
}

/* ------------------------------- Alerts ------------------------------- */

export function Alert({
  tone = 'error',
  children,
  className
}: {
  tone?: 'error' | 'success' | 'info' | 'warning';
  children: ReactNode;
  className?: string;
}) {
  const styles = {
    error: 'border-red-400/25 bg-red-400/[0.08] text-red-200',
    success: 'border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-200',
    info: 'border-sky-400/25 bg-sky-400/[0.08] text-sky-200',
    warning: 'border-amber-400/25 bg-amber-400/[0.08] text-amber-200'
  }[tone];
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'error' ? XCircle : AlertTriangle;
  return (
    <div className={cn('flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-[13px] leading-relaxed', styles, className)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/* ------------------------------- Reauth ------------------------------- */

interface ReauthContextValue {
  requestPassword: (reason: string) => Promise<string | null>;
}

const ReauthContext = createContext<ReauthContextValue | null>(null);

export function ReauthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ reason: string; resolve: (value: string | null) => void } | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const requestPassword = useCallback((reason: string) => {
    return new Promise<string | null>((resolve) => {
      setPassword('');
      setError('');
      setBusy(false);
      setState({ reason, resolve });
      setTimeout(() => inputRef.current?.focus(), 60);
    });
  }, []);

  const close = (value: string | null) => {
    const resolve = state?.resolve;
    setState(null);
    resolve?.(value);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError('请输入管理员密码');
      return;
    }
    setBusy(true);
    const resolve = state?.resolve;
    setState(null);
    resolve?.(password);
    setBusy(false);
  };

  return (
    <ReauthContext.Provider value={{ requestPassword }}>
      {children}
      <Modal
        open={Boolean(state)}
        onClose={() => close(null)}
        title="确认管理员身份"
        description={state?.reason}
        width="440px"
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => close(null)}>
              取消
            </button>
            <button type="submit" form="reauth-form" className="btn-primary" disabled={busy}>
              {busy ? <Spinner /> : <Lock className="h-4 w-4" />} 确认
            </button>
          </>
        }
      >
        <form id="reauth-form" onSubmit={submit}>
          <label className="label" htmlFor="reauth-password">
            当前管理员密码
          </label>
          <input
            id="reauth-password"
            ref={inputRef}
            type="password"
            className="field"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError('');
            }}
            placeholder="用于二次确认，不会保存"
          />
          {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
        </form>
      </Modal>
    </ReauthContext.Provider>
  );
}

export function useReauth(): ReauthContextValue {
  const ctx = useContext(ReauthContext);
  if (!ctx) throw new Error('useReauth must be used inside ReauthProvider');
  return ctx;
}

/* ------------------------------- Confirm ------------------------------- */

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
  tone?: 'danger' | 'primary';
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ options: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);
  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => setState({ options, resolve }));
  }, []);
  const close = (value: boolean) => {
    const resolve = state?.resolve;
    setState(null);
    resolve?.(value);
  };
  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <Modal
        open={Boolean(state)}
        onClose={() => close(false)}
        title={state?.options.title ?? '确认操作'}
        description={state?.options.description}
        width="440px"
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => close(false)}>
              取消
            </button>
            <button
              type="button"
              className={state?.options.tone === 'danger' ? 'btn-danger' : 'btn-primary'}
              onClick={() => close(true)}
            >
              {state?.options.confirmText ?? '确认'}
            </button>
          </>
        }
      />
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside ConfirmProvider');
  return ctx;
}

/* ------------------------------- Toast ------------------------------- */

interface ToastItem {
  id: number;
  message: string;
  tone: 'success' | 'error' | 'info';
}

const ToastContext = createContext<{ push: (message: string, tone?: ToastItem['tone']) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((message: string, tone: ToastItem['tone'] = 'success') => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev.slice(-3), { id, message, tone }]);
    setTimeout(() => setItems((prev) => prev.filter((item) => item.id !== id)), 4200);
  }, []);
  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 left-1/2 z-[100] flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-col gap-2 sm:left-auto sm:right-6 sm:translate-x-0">
        {items.map((item) => (
          <div
            key={item.id}
            className={cn(
              'pointer-events-auto flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-[13px] shadow-2xl backdrop-blur-xl',
              item.tone === 'success' && 'border-emerald-400/25 bg-[#0b1a16]/95 text-emerald-100',
              item.tone === 'error' && 'border-red-400/25 bg-[#1c0f13]/95 text-red-100',
              item.tone === 'info' && 'border-white/10 bg-[#101520]/95 text-white/80'
            )}
          >
            {item.tone === 'success' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
            ) : item.tone === 'error' ? (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" />
            )}
            <span className="min-w-0 break-words">{item.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

/* ------------------------------- Misc ------------------------------- */

export function EmptyState({
  icon,
  title,
  description,
  action
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon ? <div className="text-white/25">{icon}</div> : null}
      <div className="text-sm font-medium text-white/70">{title}</div>
      {description ? <div className="max-w-sm text-xs leading-relaxed text-white/35">{description}</div> : null}
      {action}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex rounded-xl border border-white/10 bg-black/20 p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-lg px-3 py-1.5 text-[13px] transition',
            value === option.value ? 'bg-white/10 text-white' : 'text-white/45 hover:text-white/70'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
