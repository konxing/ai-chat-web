import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getPageUser } from '@/lib/auth';
import { getSystemSettings } from '@/lib/config';
import { AuthShell } from '@/components/auth/auth-shell';
import { ForgotForm } from '@/components/auth/forms';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '重置密码' };

export default async function ForgotPage() {
  const user = await getPageUser();
  if (user) redirect('/chat');
  const settings = await getSystemSettings();
  return (
    <AuthShell
      siteName={settings.siteName}
      title="重置密码"
      subtitle="使用已绑定的邮箱重置密码。没有绑定邮箱时，请联系管理员。"
      footer={
        <>
          想起了密码？
          <Link href="/login" className="ml-1 text-white/60 hover:text-aurora-300">
            返回登录
          </Link>
        </>
      }
    >
      <ForgotForm />
    </AuthShell>
  );
}
