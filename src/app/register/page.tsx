import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getPageUser } from '@/lib/auth';
import { getSystemSettings } from '@/lib/config';
import { AuthShell } from '@/components/auth/auth-shell';
import { RegisterForm } from '@/components/auth/forms';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '注册' };

export default async function RegisterPage() {
  const user = await getPageUser();
  if (user) redirect('/chat');
  const settings = await getSystemSettings();
  return (
    <AuthShell
      siteName={settings.siteName}
      title="加入家庭空间"
      subtitle="通过邮箱验证创建账号。注册开关由服务器所有者控制。"
      footer={
        <>
          已有账号？
          <Link href="/login" className="ml-1 text-white/60 hover:text-aurora-300">
            返回登录
          </Link>
        </>
      }
    >
      <RegisterForm registrationOpen={settings.registrationOpen} />
    </AuthShell>
  );
}
