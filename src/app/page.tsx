import { redirect } from 'next/navigation';
import { getPageUser } from '@/lib/auth';
import { getSystemSettings } from '@/lib/config';
import { IntroLanding } from '@/components/intro-landing';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const user = await getPageUser();
  if (user) redirect('/chat');
  const settings = await getSystemSettings();
  return <IntroLanding siteName={settings.siteName} registrationOpen={settings.registrationOpen} />;
}
