'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Eye, EyeOff, Mail, ShieldCheck } from 'lucide-react';
import { apiFetch, codeSentMessage, errorMessage } from '@/lib/client-api';
import { Alert, Spinner } from '@/components/ui';

function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  placeholder = '输入密码',
  disabled
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        type={show ? 'text' : 'password'}
        className="field pr-11"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        disabled={disabled}
        required
      />
      <button
        type="button"
        className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-white/35 transition hover:bg-white/5 hover:text-white/70"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? '隐藏密码' : '显示密码'}
        tabIndex={-1}
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

export function LoginForm({ registrationOpen }: { registrationOpen: boolean }) {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await apiFetch('/api/auth/login', {
        json: { identifier: identifier.trim(), password }
      });
      router.replace('/chat');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div>
        <label className="label" htmlFor="identifier">
          用户名或邮箱
        </label>
        <input
          id="identifier"
          className="field"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          autoComplete="username"
          placeholder="例如：xiaoming 或 name@example.com"
          autoFocus
          required
          maxLength={254}
        />
      </div>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="label mb-0" htmlFor="password">
            密码
          </label>
          <Link href="/forgot" className="text-[12px] text-white/40 transition hover:text-aurora-300">
            忘记密码？
          </Link>
        </div>
        <PasswordInput id="password" value={password} onChange={setPassword} autoComplete="current-password" />
      </div>
      <button type="submit" className="btn-primary w-full py-3" disabled={busy}>
        {busy ? <Spinner /> : <ShieldCheck className="h-4 w-4" />}
        {busy ? '正在验证…' : '进入澄境'}
      </button>
      {registrationOpen ? (
        <p className="pt-1 text-center text-[13px] text-white/35">
          还没有账号？
          <Link href="/register" className="ml-1.5 text-aurora-300 transition hover:text-aurora-200">
            使用邮箱注册
          </Link>
        </p>
      ) : (
        <p className="pt-1 text-center text-[12px] text-white/25">本空间当前仅限管理员创建账号</p>
      )}
    </form>
  );
}

export function RegisterForm({ registrationOpen }: { registrationOpen: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const startCountdown = () => {
    setCountdown(60);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCountdown((value) => {
        if (value <= 1 && timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        return Math.max(0, value - 1);
      });
    }, 1000);
  };

  const requestCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError('');
    setInfo('');
    if (!registrationOpen) {
      setError('站点当前未开放注册');
      return;
    }
    if (username.trim().length < 3) {
      setError('用户名至少 3 个字符');
      return;
    }
    setBusy(true);
    try {
      const data = await apiFetch<{ channel?: string }>('/api/auth/register/request', {
        json: { username: username.trim(), email: email.trim() }
      });
      setStep(2);
      setInfo(codeSentMessage(data.channel, email.trim()));
      startCountdown();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (countdown > 0 || busy) return;
    setError('');
    setBusy(true);
    try {
      const data = await apiFetch<{ channel?: string }>('/api/auth/register/request', {
        json: { username: username.trim(), email: email.trim() }
      });
      setInfo(codeSentMessage(data.channel, email.trim()));
      startCountdown();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    try {
      await apiFetch('/api/auth/register/verify', {
        json: { email: email.trim(), code: code.trim(), password }
      });
      router.replace('/chat');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  if (!registrationOpen) {
    return (
      <div className="space-y-4">
        <Alert tone="warning">站点当前未开放注册。如需加入，请联系家庭管理员为你创建账号。</Alert>
        <Link href="/login" className="btn-ghost w-full">
          <ArrowLeft className="h-4 w-4" /> 返回登录
        </Link>
      </div>
    );
  }

  if (step === 1) {
    return (
      <form onSubmit={requestCode} className="space-y-4">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div>
          <label className="label" htmlFor="reg-username">
            用户名
          </label>
          <input
            id="reg-username"
            className="field"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            placeholder="3–32 位，可由中英文、数字、_ 或 - 组成"
            maxLength={32}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="reg-email">
            邮箱
          </label>
          <input
            id="reg-email"
            type="email"
            className="field"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="用于接收验证码与找回密码"
            maxLength={254}
            required
          />
        </div>
        <button type="submit" className="btn-primary w-full py-3" disabled={busy}>
          {busy ? <Spinner /> : <Mail className="h-4 w-4" />}
          {busy ? '正在发送…' : '发送验证码'}
        </button>
        <p className="text-center text-[12px] leading-relaxed text-white/25">
          注册前请确认你已获得家庭管理员授权。
        </p>
      </form>
    );
  }

  return (
    <form onSubmit={verify} className="space-y-4">
      {info ? <Alert tone="info">{info}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <button
        type="button"
        onClick={() => {
          setStep(1);
          setError('');
        }}
        className="inline-flex items-center gap-1.5 text-[12.5px] text-white/40 transition hover:text-white/70"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> 修改用户名或邮箱
      </button>
      <div>
        <label className="label" htmlFor="reg-code">
          邮箱验证码
        </label>
        <div className="flex gap-2">
          <input
            id="reg-code"
            className="field flex-1 text-center text-lg tracking-[0.45em]"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            required
          />
          <button type="button" className="btn-ghost shrink-0 px-3 text-[12px]" onClick={resend} disabled={countdown > 0 || busy}>
            {countdown > 0 ? `${countdown}s` : '重新发送'}
          </button>
        </div>
      </div>
      <div>
        <label className="label" htmlFor="reg-password">
          设置密码
        </label>
        <PasswordInput
          id="reg-password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          placeholder="至少 10 位，包含两类字符"
        />
      </div>
      <div>
        <label className="label" htmlFor="reg-confirm">
          确认密码
        </label>
        <PasswordInput id="reg-confirm" value={confirm} onChange={setConfirm} autoComplete="new-password" placeholder="再次输入密码" />
      </div>
      <button type="submit" className="btn-primary w-full py-3" disabled={busy || code.length !== 6}>
        {busy ? <Spinner /> : <ArrowRight className="h-4 w-4" />}
        {busy ? '正在创建…' : '创建账号并进入'}
      </button>
    </form>
  );
}

export function ForgotForm() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const startCountdown = () => {
    setCountdown(60);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCountdown((value) => {
        if (value <= 1 && timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        return Math.max(0, value - 1);
      });
    }, 1000);
  };

  const request = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await apiFetch<{ message: string }>('/api/auth/password/forgot', {
        json: { email: email.trim() }
      });
      setInfo(data.message);
      setStep(2);
      startCountdown();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    try {
      await apiFetch('/api/auth/password/reset', {
        json: { email: email.trim(), code: code.trim(), password }
      });
      setStep(3);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (step === 3) {
    return (
      <div className="space-y-4">
        <Alert tone="success">密码已重置，所有旧的登录会话已失效。请使用新密码重新登录。</Alert>
        <Link href="/login" className="btn-primary w-full py-3">
          返回登录
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {info && step === 2 ? <Alert tone="info">{info}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div>
        <label className="label" htmlFor="forgot-email">
          注册邮箱
        </label>
        <input
          id="forgot-email"
          type="email"
          className="field"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          placeholder="name@example.com"
          disabled={step === 2}
          maxLength={254}
        />
      </div>
      {step === 2 ? (
        <form onSubmit={reset} className="space-y-4">
          <div>
            <label className="label" htmlFor="forgot-code">
              邮箱验证码
            </label>
            <div className="flex gap-2">
              <input
                id="forgot-code"
                className="field flex-1 text-center text-lg tracking-[0.45em]"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                required
              />
              <button type="button" className="btn-ghost shrink-0 px-3 text-[12px]" onClick={() => request()} disabled={countdown > 0 || busy}>
                {countdown > 0 ? `${countdown}s` : '重新发送'}
              </button>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="forgot-password">
              新密码
            </label>
            <PasswordInput id="forgot-password" value={password} onChange={setPassword} autoComplete="new-password" placeholder="至少 10 位，包含两类字符" />
          </div>
          <div>
            <label className="label" htmlFor="forgot-confirm">
              确认新密码
            </label>
            <PasswordInput id="forgot-confirm" value={confirm} onChange={setConfirm} autoComplete="new-password" placeholder="再次输入新密码" />
          </div>
          <button type="submit" className="btn-primary w-full py-3" disabled={busy || code.length !== 6}>
            {busy ? <Spinner /> : null} 重置密码
          </button>
          <button
            type="button"
            className="w-full text-center text-[12.5px] text-white/35 transition hover:text-white/60"
            onClick={() => {
              setStep(1);
              setError('');
            }}
          >
            使用其他邮箱
          </button>
        </form>
      ) : (
        <button type="button" className="btn-primary w-full py-3" onClick={() => request()} disabled={busy || !email}>
          {busy ? <Spinner /> : <Mail className="h-4 w-4" />} 发送重置验证码
        </button>
      )}
    </div>
  );
}
