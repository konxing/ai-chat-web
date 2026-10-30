import { notFound, redirect } from 'next/navigation';
import { ApiError } from './http';
import { getPageUser } from './auth';
import { getSystemSettings } from './config';
import { getChatDetail, listChats } from './chats';
import { listProvidersForUser } from './providers';
import type {
  ChatDetailDto,
  ChatSettings,
  ChatSummaryDto,
  ChatUser,
  ProviderDto
} from './chat-types';

export interface ChatPageData {
  user: ChatUser;
  settings: ChatSettings;
  chats: ChatSummaryDto[];
  chat: ChatDetailDto | null;
  providers: ProviderDto[];
}

export async function loadChatPage(chatId?: string): Promise<ChatPageData> {
  const user = await getPageUser();
  if (!user) redirect('/login');
  if (user.status !== 'ACTIVE') redirect('/login?disabled=1');

  const [settings, chats, providers] = await Promise.all([
    getSystemSettings(),
    listChats(user.id),
    listProvidersForUser(user.id)
  ]);

  let chat: ChatDetailDto | null = null;
  if (chatId) {
    try {
      chat = await getChatDetail(chatId, user.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) notFound();
      throw error;
    }
  }

  return {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role
    },
    settings: {
      siteName: settings.siteName,
      maintenanceNotice: settings.maintenanceNotice,
      maxUploadMB: settings.maxUploadMB
    },
    chats,
    chat,
    providers: providers as ProviderDto[]
  };
}
