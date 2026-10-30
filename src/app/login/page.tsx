import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getPageUser } from '@/lib/auth';
import { getSystemSettings } from '@/lib/config';
import { AuthShell } from '@/components/auth/auth-shell';
import { LoginForm } from '@/components/auth/forms';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '登录' };

export default async function LoginPage() {
  const user = await getPageUser();
  if (user) redirect('/chat');
  const settings = await getSystemSettings();
  return (
    <AuthShell
      siteName={settings.siteName}
      title="欢迎回来"
      subtitle="使用家庭账号登录。连续登录失败会触发临时限制。"
      footer={
        <>
          还没有账号？
          <Link href={settings.registrationOpen ? '/register' : '/login'} className="ml-1 text-white/60 hover:text-aurora-300">
            {settings.registrationOpen ? '邮箱注册' : '联系管理员'}
          </Link>
        </>
      }
    >
      <LoginForm registrationOpen={settings.registrationOpen} />
    </AuthShell>
  );
}
