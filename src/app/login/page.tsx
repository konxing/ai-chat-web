import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CircleCheck } from 'lucide-react';
import { getPageUser } from '@/lib/auth';
import { getSystemSettings } from '@/lib/config';
import { prisma } from '@/lib/prisma';
import { AdminContact } from '@/components/auth/admin-contact';
import { AuthShell } from '@/components/auth/auth-shell';
import { LoginForm } from '@/components/auth/forms';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '登录' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ setup?: string }> }) {
  const user = await getPageUser();
  if (user) redirect('/chat');
  const firstLogin = (await searchParams).setup === 'complete';
  const settings = await getSystemSettings();
  const adminEmail = firstLogin || settings.registrationOpen
    ? null
    : ((await prisma.user.findFirst({
        where: { role: 'OWNER', status: 'ACTIVE' },
        select: { email: true },
        orderBy: { createdAt: 'asc' }
      }))?.email ?? null);
  return (
    <AuthShell
      siteName={settings.siteName}
      title={firstLogin ? '首次登录' : '登录'}
      subtitle={firstLogin ? '使用刚刚创建的管理员账号登录。' : '输入用户名或邮箱，进入你的对话空间。'}
      footer={firstLogin ? null : (
        <>
          还没有账号？
          {settings.registrationOpen ? (
            <Link href="/register" className="ml-1 text-aurora-300 hover:underline">
              邮箱注册
            </Link>
          ) : (
            <AdminContact email={adminEmail} />
          )}
        </>
      )}
    >
      {firstLogin ? (
        <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-aurora-400/25 bg-aurora-400/[0.08] p-3.5 text-sm leading-6 text-[#cfe7df]">
          <CircleCheck aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-aurora-300" />
          <div>
            <p className="font-medium text-aurora-300">初始化完成</p>
            <p>登录后，可在「管理后台 → 全局模型」中添加聊天模型。</p>
          </div>
        </div>
      ) : null}
      <LoginForm />
    </AuthShell>
  );
}
