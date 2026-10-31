import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getPageUser } from '@/lib/auth';
import { getSystemSettings } from '@/lib/config';
import { prisma } from '@/lib/prisma';
import { AdminContact } from '@/components/auth/admin-contact';
import { AuthShell } from '@/components/auth/auth-shell';
import { LoginForm } from '@/components/auth/forms';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '登录' };

export default async function LoginPage() {
  const user = await getPageUser();
  if (user) redirect('/chat');
  const settings = await getSystemSettings();
  const adminEmail = settings.registrationOpen
    ? null
    : ((await prisma.user.findFirst({
        where: { role: 'OWNER', status: 'ACTIVE' },
        select: { email: true },
        orderBy: { createdAt: 'asc' }
      }))?.email ?? null);
  return (
    <AuthShell
      siteName={settings.siteName}
      title="欢迎回来"
      subtitle="使用已授权账号登录。连续登录失败会触发临时限制。"
      footer={
        <>
          还没有账号？
          {settings.registrationOpen ? (
            <Link href="/register" className="ml-1 text-white/60 hover:text-aurora-300">
              邮箱注册
            </Link>
          ) : (
            <AdminContact email={adminEmail} />
          )}
        </>
      }
    >
      <LoginForm registrationOpen={settings.registrationOpen} />
    </AuthShell>
  );
}
