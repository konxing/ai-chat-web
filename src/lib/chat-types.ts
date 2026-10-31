export interface ChatSummaryDto {
  id: string;
  title: string;
  preview: string;
  modelId: string | null;
  providerId: string | null;
  providerName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentDto {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: 'IMAGE' | 'FILE' | 'AUDIO';
  hasText: boolean;
  createdAt: string;
}

export interface ChatMessageDto {
  id: string;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM';
  content: string;
  modelId: string | null;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  attachments: AttachmentDto[];
  createdAt: string;
}

export interface ChatDetailDto {
  id: string;
  title: string;
  modelId: string | null;
  providerId: string | null;
  providerName: string | null;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessageDto[];
  hasOlder: boolean;
}

export interface ProviderDto {
  id: string;
  ownerType: 'GLOBAL' | 'USER';
  name: string;
  baseUrl: string;
  modelId: string;
  capabilities: Array<'text' | 'vision' | 'files' | 'audio'>;
  params: { temperature?: number; maxTokens?: number } | null;
  enabled: boolean;
  isDefault: boolean;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatUser {
  id: string;
  username: string;
  displayName: string | null;
  role: 'OWNER' | 'USER';
}

export interface ChatSettings {
  siteName: string;
  maintenanceNotice: string;
  maxUploadMB: number;
}

export interface AdminUserDto {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  role: 'OWNER' | 'USER';
  status: 'ACTIVE' | 'DISABLED';
  displayName: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  chats: number;
  messages: number;
  activeSessions: number;
  providers: number;
}

export interface IpRuleDto {
  id: string;
  cidr: string;
  label: string;
  enabled: boolean;
  expiresAt: string | null;
  status: 'active' | 'expired' | 'disabled';
  createdBy: string | null;
  lastMatchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
