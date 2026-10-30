import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getPageUser } from '@/lib/auth';
import { SettingsWorkspace } from '@/components/settings/settings-workspace';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '设置'
};

export default async function SettingsPage() {
  const user = await getPageUser();
  if (!user) redirect('/login');
  if (user.status !== 'ACTIVE') redirect('/login?disabled=1');

  return (
    <SettingsWorkspace
      initialUser={{
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        status: user.status,
        emailVerified: Boolean(user.emailVerified),
        createdAt: user.createdAt.toISOString(),
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null
      }}
    />
  );
}
