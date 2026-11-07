import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { loadChatPage } from '@/lib/chat-page';
import { ChatWorkspace } from '@/components/chat/chat-workspace';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '对话'
};

export default async function ChatPage({
  searchParams
}: {
  searchParams: Promise<{ resume?: string }>;
}) {
  const params = await searchParams;
  const data = await loadChatPage();
  // 从后台「返回对话」带着 resume=1：回到最近活跃的那个会话，而不是空白新对话页。
  // 「开启新对话」走的是不带标记的 /chat，仍然是空白页，两者不冲突。
  if (params.resume === '1' && data.chats.length > 0) {
    redirect(`/chat/${data.chats[0].id}`);
  }
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