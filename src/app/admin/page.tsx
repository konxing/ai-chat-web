import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getPageUser } from '@/lib/auth';
import { AdminWorkspace } from '@/components/admin/admin-workspace';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '管理后台'
};

export default async function AdminPage() {
  const user = await getPageUser();
  if (!user) redirect('/login');
  if (user.status !== 'ACTIVE') redirect('/login?disabled=1');
  if (user.role !== 'OWNER') redirect('/chat');

  return <AdminWorkspace owner={{ username: user.username, displayName: user.displayName }} />;
}
