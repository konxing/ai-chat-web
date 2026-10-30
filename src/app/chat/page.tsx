import type { Metadata } from 'next';
import { loadChatPage } from '@/lib/chat-page';
import { ChatWorkspace } from '@/components/chat/chat-workspace';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '对话'
};

export default async function ChatPage() {
  const data = await loadChatPage();
  return (
    <ChatWorkspace
      user={data.user}
      settings={data.settings}
      initialChats={data.chats}
      initialChat={data.chat}
      providers={data.providers}
    />
  );
}
