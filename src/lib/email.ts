import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { loadEnv } from './env';
import { log } from './logger';
import type { EmailTokenPurpose } from '@prisma/client';

let transporter: Transporter | null = null;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getTransporter(): Transporter {
  const env = loadEnv();
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    throw new Error('SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS required)');
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      requireTLS: !env.SMTP_SECURE,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000
    });
  }
  return transporter;
}

/** 当前生效的投递通道，供接口如实告知前端「验证码到底发去了哪里」。 */
export function emailChannel(): 'smtp' | 'console' | 'file' {
  const transport = loadEnv().EMAIL_TRANSPORT;
  return transport === 'smtp' ? 'smtp' : transport;
}

function subjectFor(purpose: EmailTokenPurpose): string {
  if (purpose === 'REGISTER') return '澄境 · 注册验证码';
  if (purpose === 'EMAIL_CHANGE') return '澄境 · 更换邮箱验证码';
  return '澄境 · 重置密码验证码';
}

function textFor(purpose: EmailTokenPurpose, code: string): string {
  const action = purpose === 'REGISTER' ? '注册账号' : purpose === 'EMAIL_CHANGE' ? '更换邮箱' : '重置密码';
  return [
    `你正在${action}。验证码：${code}`,
    '验证码 10 分钟内有效，仅可使用一次。',
    '如果这不是你的操作，请忽略本邮件，你的账号不会发生变化。',
    '— 家庭私人 AI 聊天'
  ].join('\n');
}

function htmlFor(purpose: EmailTokenPurpose, code: string): string {
  const action = purpose === 'REGISTER' ? '注册账号' : purpose === 'EMAIL_CHANGE' ? '更换邮箱' : '重置密码';
  return `<!doctype html><html lang="zh-CN"><body style="margin:0;background:#0b0e17;font-family:-apple-system,'Segoe UI','PingFang SC',sans-serif;color:#e7ecf5">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px">
    <div style="font-size:13px;letter-spacing:.3em;color:#4fe0b4;margin-bottom:24px">FAMILY · AI</div>
    <h1 style="font-size:22px;margin:0 0 12px">${escapeHtml(action)}验证码</h1>
    <p style="color:#9aa5b8;font-size:14px;line-height:1.7">请输入以下验证码完成${escapeHtml(action)}。验证码 10 分钟内有效，仅可使用一次。</p>
    <div style="margin:24px 0;padding:18px 20px;background:#151a27;border:1px solid #2a3348;border-radius:14px;font-size:30px;letter-spacing:.35em;color:#8ff0d0;font-weight:600;text-align:center">${escapeHtml(code)}</div>
    <p style="color:#6b7688;font-size:12px;line-height:1.7">如果这不是你的操作，请忽略本邮件，你的账号不会发生变化。</p>
  </div></body></html>`;
}

export async function sendVerificationEmail(input: {
  to: string;
  code: string;
  purpose: EmailTokenPurpose;
}): Promise<void> {
  const env = loadEnv();
  const subject = subjectFor(input.purpose);
  const text = textFor(input.purpose, input.code);
  const html = htmlFor(input.purpose, input.code);

  if (env.EMAIL_TRANSPORT === 'console') {
    // This is an explicit development transport, not a fake success.
    console.log(
      `\n[EMAIL/console] To: ${input.to}\n[EMAIL/console] Subject: ${subject}\n[EMAIL/console] Verification code: ${input.code}\n[EMAIL/console] (10 minutes, single use)\n`
    );
    log.info('email.console_delivery', { to: input.to, purpose: input.purpose });
    return;
  }

  if (env.EMAIL_TRANSPORT === 'file') {
    if (env.NODE_ENV === 'production') throw new Error('file email sink is disabled in production');
    const dir = path.resolve(env.TEST_MAIL_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const record = {
      to: input.to,
      subject,
      text,
      code: input.code,
      purpose: input.purpose,
      createdAt: new Date().toISOString()
    };
    const file = path.join(dir, 'mail.jsonl');
    await appendFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    log.info('email.file_delivery', { to: input.to, purpose: input.purpose, file });
    return;
  }

  const mailer = getTransporter();
  try {
    await mailer.sendMail({
      from: env.EMAIL_FROM,
      to: input.to,
      subject,
      text,
      html
    });
    log.info('email.smtp_delivery', { to: input.to, purpose: input.purpose });
  } catch (err) {
    log.error('email.smtp_failed', {
      to: input.to,
      purpose: input.purpose,
      error: err instanceof Error ? err.message : String(err)
    });
    throw new Error('邮件发送失败');
  }
}
