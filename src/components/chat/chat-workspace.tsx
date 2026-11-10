'use client';

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowDown,
  ArrowUpRight,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Copy,
  Download,
  FileText,
  Lightbulb,
  History,
  LogOut,
  Menu,
  MessageSquarePlus,
  Mic,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Search,
  Settings,
  Shield,
  Square,
  Trash2,
  Utensils,
  X
} from 'lucide-react';
import { apiFetch, csrfHeader, errorMessage, formatBytes, imageUrl, timeAgo } from '@/lib/client-api';
import {
  CITATION_LOAD_FAILED_NOTE,
  CITATION_NOTE,
  citationHint,
  citationRows,
  type CitationRow
} from '@/lib/cognitive/citation-display';
import type { MemoryDto } from '@/lib/cognitive/memories';
import type { ConfidenceBand } from '@/lib/cognitive/confidence';
import { cn } from '@/lib/cn';
import dynamic from 'next/dynamic';
import { BrandMark } from '@/components/brand';
import { Modal, Spinner } from '@/components/ui';
import type {
  AttachmentDto,
  ChatDetailDto,
  ChatMessageDto,
  ChatSettings,
  ChatSummaryDto,
  ChatUser,
  ProviderDto
} from '@/lib/chat-types';

// react-markdown + katex + highlight.js 比聊天界面本身还大，且内容全来自本地库，
// 不需要出现在首屏 HTML 与首屏 JS 里：挂载后再拉这个 chunk。
const Markdown = dynamic(() => import('@/components/chat/markdown').then((mod) => mod.Markdown), {
  ssr: false
});

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function messageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
}

const SUGGESTIONS = [
  { label: '润色文字', detail: '把一段话写得更温和', prompt: '帮我把这段话写得更温和一些：', icon: Pencil },
  { label: '学个新概念', detail: '用比喻解释量子纠缠', prompt: '用简单的比喻解释一下量子纠缠', icon: Lightbulb },
  { label: '计划晚餐', detail: '为明天安排晚餐', prompt: '为明天的晚餐设计一份菜单', icon: Utensils },
  { label: '阅读文档', detail: '从 PDF 里提取要点', prompt: '把这份 PDF 的要点总结成清单', icon: FileText }
];

const SIDEBAR_COLLAPSED_KEY = 'family-ai.sidebar-collapsed';
const MAX_FILES_PER_MESSAGE = 15;
// 服务端同时只解密一个上传、最多再排两个人，客户端并发 3 刚好填满这条队而不撞 429。
const UPLOAD_CONCURRENCY = 3;

/** /api/account/cognitive/memories 的读侧形状：记忆本体加两张旁表，正是 citationRows 的输入。 */
interface CitationSource {
  memories: MemoryDto[];
  chats: Record<string, string>;
  confidence: Record<string, { band: ConfidenceBand }>;
}

export function ChatWorkspace({
  user,
  settings,
  initialChats,
  initialChat,
  providers
}: {
  user: ChatUser;
  settings: ChatSettings;
  initialChats: ChatSummaryDto[];
  initialChat: ChatDetailDto | null;
  providers: ProviderDto[];
}) {
  const router = useRouter();
  const [chats, setChats] = useState<ChatSummaryDto[]>(initialChats);
  const [chat, setChat] = useState<ChatDetailDto | null>(initialChat);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<AttachmentDto[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamError, setStreamError] = useState('');
  const [localProviderId, setLocalProviderId] = useState<string>(
    initialChat?.providerId ?? providers.find((p) => p.isDefault)?.id ?? providers[0]?.id ?? ''
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [renameTarget, setRenameTarget] = useState<ChatSummaryDto | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ChatSummaryDto | null>(null);
  const [modalBusy, setModalBusy] = useState(false);
  const [optimisticUser, setOptimisticUser] = useState<ChatMessageDto | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [notice, setNotice] = useState('');
  const [showJump, setShowJump] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  /** 这一轮引用了哪几条记忆（任务书 8.2）：助手消息 id → 记忆 id。只活在这次会话里，刷新即清。 */
  const [citations, setCitations] = useState<Record<string, string[]>>({});

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const composerBusyRef = useRef(false);
  const navigationRef = useRef(0);
  const activeIdRef = useRef<string | null>(initialChat?.id ?? null);
  const chatIdRef = useRef<string | null>(initialChat?.id ?? null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const preferBrowserSpeechRef = useRef(false);
  const transcribingRef = useRef(false);
  const [transcribing, setTranscribing] = useState(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stickRef = useRef(true);

  /**
   * 引用清单点开时才读记忆列表，且整个会话只读一次：几条气泡可能带同一轮的引用，
   * 它们要对齐的是同一份「现在的记忆」，逐条各发一次请求既慢又可能读到两个时刻。
   * 读失败不留在缓存里——下次点开重试，免得一次网络抖动把清单永久变成错误文案。
   */
  const citationSourceRef = useRef<Promise<CitationSource> | null>(null);
  const getCitationSource = useCallback(() => {
    if (!citationSourceRef.current) {
      citationSourceRef.current = apiFetch<CitationSource>('/api/account/cognitive/memories').catch((err) => {
        citationSourceRef.current = null;
        throw err;
      });
    }
    return citationSourceRef.current;
  }, []);

  const selectedProviderId = chat?.providerId ?? localProviderId;
  const selectedProvider = providers.find((p) => p.id === selectedProviderId) ?? null;
  const attachmentWarning = selectedProvider && pending.length > 0
    ? pending.some((item) => item.kind === 'IMAGE') && !selectedProvider.capabilities.includes('vision')
      ? '当前模型不支持图片输入，请切换模型或移除图片。'
      : pending.some((item) => item.kind === 'FILE') && !selectedProvider.capabilities.includes('files')
        ? '当前模型不支持文件输入，请切换模型或移除文件。'
        : null
    : null;
  const hasAudioProvider = providers.some((p) => p.capabilities.includes('audio'));
  const speechSupported = typeof window !== 'undefined' && Boolean(getSpeechRecognition());

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  /** 用户手动上滑后停止自动跟随，避免流式输出把视图拽走。 */
  function onMessagesScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = gap < 120;
    stickRef.current = near;
    setShowJump(!near);
  }

  function jumpToBottom() {
    stickRef.current = true;
    setShowJump(false);
    scrollToBottom(true);
  }

  useEffect(() => {
    // 切换会话时回到底部并重新开始跟随。
    stickRef.current = true;
    setShowJump(false);
  }, [chat?.id]);

  useEffect(() => {
    if (!stickRef.current) return;
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => scrollToBottom(false), 30);
    return () => {
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    };
  }, [chat?.messages.length, streamText, optimisticUser?.id, scrollToBottom]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
      recognitionRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');
  }, []);

  // 认知层的相对时间（「昨天/去年」）锚的是用户墙钟：把浏览器时区同步给服务端。
  // 只在记忆模块开着、且库里存的和当前浏览器不一致时写一次；失败静默——时区是增益，不该挡聊天。
  useEffect(() => {
    const offset = -new Date().getTimezoneOffset();
    apiFetch<{ preferences: { memoryEnabled: boolean; timezoneOffsetMinutes: number | null } }>('/api/account/cognitive')
      .then(({ preferences }) => {
        if (!preferences.memoryEnabled || preferences.timezoneOffsetMinutes === offset) return undefined;
        return apiFetch('/api/account/cognitive', { method: 'PATCH', json: { timezoneOffsetMinutes: offset } });
      })
      .catch(() => undefined);
  }, []);

  const toggleSidebar = useCallback(() => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
  }, [sidebarCollapsed]);

  const filteredChats = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) => c.title.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q));
  }, [chats, search]);

  const refreshChats = useCallback(async () => {
    try {
      const data = await apiFetch<{ chats: ChatSummaryDto[] }>('/api/chats');
      setChats(data.chats);
    } catch {
      /* non-critical */
    }
  }, []);

  const refreshChat = useCallback(async (chatId: string) => {
    try {
      const data = await apiFetch<{ chat: ChatDetailDto }>(`/api/chats/${chatId}`);
      if (activeIdRef.current === chatId) {
        setChat(data.chat);
        setOptimisticUser(null);
      }
    } catch (err) {
      if (activeIdRef.current === chatId && err instanceof Error && 'status' in err && (err as { status?: number }).status === 404) {
        router.replace('/chat');
      }
    }
  }, [router]);

  const selectChat = useCallback(
    async (id: string) => {
      if (sending) abortRef.current?.abort();
      const navigation = ++navigationRef.current;
      activeIdRef.current = id;
      setSidebarOpen(false);
      setAccountOpen(false);
      setStreamText('');
      setStreamError('');
      setOptimisticUser(null);
      setPending([]);
      try {
        const data = await apiFetch<{ chat: ChatDetailDto }>(`/api/chats/${id}`);
        if (navigationRef.current !== navigation) return;
        chatIdRef.current = id;
        setChat(data.chat);
        if (data.chat.providerId) setLocalProviderId(data.chat.providerId);
        window.history.replaceState(null, '', `/chat/${id}`);
      } catch (err) {
        if (navigationRef.current !== navigation) return;
        activeIdRef.current = chatIdRef.current;
        setNotice(errorMessage(err));
      }
    },
    [sending]
  );

  const startNewChat = useCallback(() => {
    navigationRef.current++;
    abortRef.current?.abort();
    activeIdRef.current = null;
    chatIdRef.current = null;
    setChat(null);
    setOptimisticUser(null);
    setStreamText('');
    setStreamError('');
    setPending([]);
    setDraft('');
    setSidebarOpen(false);
    window.history.replaceState(null, '', '/chat');
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleSidebar();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        // 与「开启新对话」按钮上的 ⌘K 标记保持一致。
        event.preventDefault();
        startNewChat();
      } else if (event.key === 'Escape' && accountOpen) {
        setAccountOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleSidebar, startNewChat, accountOpen]);

  const ensureChat = useCallback(async (): Promise<string | null> => {
    if (activeIdRef.current !== chatIdRef.current) return null;
    if (chatIdRef.current) return chatIdRef.current;
    const navigation = navigationRef.current;
    try {
      const data = await apiFetch<{ chat: ChatSummaryDto }>('/api/chats', {
        json: selectedProviderId ? { providerId: selectedProviderId } : {}
      });
      const created = data.chat;
      setChats((prev) => [created, ...prev.filter((item) => item.id !== created.id)]);
      if (navigationRef.current !== navigation) return null;
      activeIdRef.current = created.id;
      chatIdRef.current = created.id;
      setChat({
        id: created.id,
        title: created.title,
        modelId: created.modelId,
        providerId: created.providerId,
        providerName: created.providerName,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        messages: [],
        hasOlder: false
      });
      window.history.replaceState(null, '', `/chat/${created.id}`);
      return created.id;
    } catch (err) {
      if (navigationRef.current === navigation) setNotice(errorMessage(err));
      return null;
    }
  }, [selectedProviderId]);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!files.length || composerBusyRef.current) return;
      const remaining = MAX_FILES_PER_MESSAGE - pending.length;
      if (remaining <= 0) {
        setNotice(`一条消息最多 ${MAX_FILES_PER_MESSAGE} 个附件，请先移除部分附件`);
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }
      const navigation = navigationRef.current;
      const overflow = Math.max(0, files.length - remaining);
      const queue = files.slice(0, remaining);
      const count = queue.length;
      const uploaded: Array<AttachmentDto | undefined> = new Array(count);
      let nextIndex = 0;
      composerBusyRef.current = true;
      setUploading(true);
      let firstError = '';
      try {
        const chatId = await ensureChat();
        if (!chatId || navigationRef.current !== navigation) return;
        await Promise.all(
          Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, async () => {
            while (navigationRef.current === navigation && nextIndex < count) {
              const index = nextIndex++;
              const file = queue[index]!;
              try {
                const form = new FormData();
                form.append('file', file);
                form.append('chatId', chatId);
                const data = await apiFetch<{ attachment: AttachmentDto }>('/api/upload', {
                  method: 'POST',
                  body: form
                });
                uploaded[index] = data.attachment;
              } catch (err) {
                // 一张失败不该拖垮后面十几张：记下第一个原因，其余继续传完。
                if (!firstError) firstError = errorMessage(err);
              }
            }
          })
        );
        if (navigationRef.current === navigation) {
          setPending((prev) => [...prev, ...uploaded.filter((item) => item !== undefined)]);
        }
      } finally {
        composerBusyRef.current = false;
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
      if (navigationRef.current !== navigation) return;
      if (firstError) setNotice(firstError);
      else if (overflow > 0) {
        setNotice(
          `一条消息最多 ${MAX_FILES_PER_MESSAGE} 个附件，本次只上传前 ${count} 个，另外 ${overflow} 个未上传`
        );
      }
    },
    [ensureChat, pending.length]
  );

  const removePending = useCallback(async (id: string) => {
    setPending((prev) => prev.filter((item) => item.id !== id));
    try {
      await apiFetch(`/api/files/${id}`, { method: 'DELETE', json: {} });
    } catch {
      /* file may already be tied to a message */
    }
  }, []);

  const beginEdit = useCallback((message: ChatMessageDto) => {
    if (composerBusyRef.current) return;
    setEditingId(message.id);
    setDraft(message.content);
    setPending([]);
    setStreamError('');
    textareaRef.current?.focus();
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setDraft('');
  }, []);

  const send = useCallback(async () => {
    const content = draft.trim();
    const editId = editingId;
    if (composerBusyRef.current || attachmentWarning) return;
    if (!content && pending.length === 0) return;
    setStreamError('');
    setNotice('');
    composerBusyRef.current = true;
    const navigation = navigationRef.current;
    const chatId = await ensureChat();
    if (!chatId || navigationRef.current !== navigation) {
      composerBusyRef.current = false;
      return;
    }
    const attachments = pending;
    if (editId) {
      // 编辑：本地先把该条改成新内容并截掉其后问答，流式回答接在编辑条之后。
      setChat((prev) => {
        if (!prev) return prev;
        const idx = prev.messages.findIndex((m) => m.id === editId);
        if (idx < 0) return prev;
        const kept = prev.messages.slice(0, idx + 1).map((m) => (m.id === editId ? { ...m, content } : m));
        return { ...prev, messages: kept };
      });
      setOptimisticUser(null);
    } else {
      const optimistic: ChatMessageDto = {
        id: `temp-${Date.now()}`,
        role: 'USER',
        content,
        modelId: null,
        status: 'COMPLETE',
        inputTokens: null,
        outputTokens: null,
        attachments,
        createdAt: new Date().toISOString()
      };
      setOptimisticUser(optimistic);
    }
    setDraft('');
    setPending([]);
    setSending(true);
    setStreamText('');
    const controller = new AbortController();
    abortRef.current = controller;
    let applied = false;
    let lastPaint = 0;
    try {
      const response = await fetch(`/api/chats/${chatId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...csrfHeader()
        },
        body: JSON.stringify({ content, attachmentIds: attachments.map((a) => a.id), editMessageId: editId ?? undefined }),
        credentials: 'same-origin',
        signal: controller.signal
      });
      if (!response.ok) {
        let message = `发送失败（HTTP ${response.status}）`;
        try {
          const payload = (await response.json()) as { error?: { message?: string } };
          message = payload.error?.message || message;
        } catch {
          /* ignore */
        }
        if (navigationRef.current !== navigation) return;
        setStreamError(message);
        setOptimisticUser(null);
        // 请求在进入模型前就被拒绝：服务端没有留下这条消息，把输入原样还给用户以便重试。
        setDraft(content);
        setPending(attachments);
        await refreshChat(chatId);
        return;
      }
      if (!response.body) {
        if (navigationRef.current === navigation) setStreamError('当前浏览器不支持流式响应');
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';
      let finished = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (navigationRef.current !== navigation) {
          await reader.cancel();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of raw.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let event: {
              type?: string;
              text?: string;
              error?: { message?: string };
              message?: ChatMessageDto;
              userMessage?: ChatMessageDto;
              providerId?: string;
              providerName?: string;
              modelId?: string;
              imagesSent?: number;
              imagesSkipped?: number;
              memoryIds?: string[];
            };
            try {
              event = JSON.parse(data);
            } catch {
              continue;
            }
            if (event.type === 'delta' && event.text) {
              accumulated += event.text;
              // 每个 token 都 setState 会重渲染整棵消息树；80ms 合并一次，肉眼仍是连续出字。
              const now = Date.now();
              if (now - lastPaint >= 80) {
                lastPaint = now;
                setStreamText(accumulated);
              }
            } else if (event.type === 'error') {
              setStreamError(event.error?.message || '模型调用失败，请稍后重试');
            } else if (event.type === 'partial') {
              setStreamError(event.error?.message || '回答中断，已保存部分内容');
              finished = true;
            } else if (event.type === 'done') {
              finished = true;
              const savedAssistant = event.message;
              const savedUser = event.userMessage;
              if (savedAssistant && savedUser) {
                // 服务端已经把落库后的两条消息发过来，直接接上，省掉结尾那两次刷新。
                applied = true;
                const providerId = event.providerId;
                const providerName = event.providerName;
                const modelId = event.modelId;
                setChat((prev) =>
                  prev
                    ? {
                        ...prev,
                        providerId: providerId ?? prev.providerId,
                        providerName: providerName ?? prev.providerName,
                        modelId: modelId ?? prev.modelId,
                        messages: editId
                          ? [...prev.messages.map((m) => (m.id === editId ? { ...savedUser, attachments } : m)), savedAssistant]
                          : [...prev.messages, { ...savedUser, attachments }, savedAssistant]
                      }
                    : prev
                );
                setOptimisticUser(null);
                setEditingId(null);
                setStreamText('');
                const ids = event.memoryIds ?? [];
                if (ids.length > 0) {
                  // 只留 id，不留正文：正文得在点开那一刻从当前记忆列表现取，缓存旧快照会把
                  // 「这条已经被你删掉了」读成「这条还在」。上一轮的快照因此作废。
                  // 0 条不写进 map——界面上不摆一个点开是空的入口。
                  citationSourceRef.current = null;
                  setCitations((prev) => ({ ...prev, [savedAssistant.id]: ids }));
                }
              }
              if (event.imagesSkipped) {
                setNotice(
                  `已发送前 ${event.imagesSent ?? 0} 张图片，另外 ${event.imagesSkipped} 张图片未发送给模型`
                );
              }
            }
          }
        }
      }
      if (navigationRef.current !== navigation) return;
      if (accumulated && !applied) setStreamText(accumulated);
      if (!finished && accumulated && !controller.signal.aborted) {
        setStreamError('连接意外结束，已保存已生成的内容');
      }
    } catch (err) {
      if (!controller.signal.aborted && navigationRef.current === navigation) {
        setStreamError(errorMessage(err));
      }
    } finally {
      abortRef.current = null;
      if (controller.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      if (!applied) await refreshChat(chatId);
      void refreshChats();
      if (navigationRef.current === navigation) setStreamText('');
      composerBusyRef.current = false;
      setSending(false);
    }
  }, [draft, pending, editingId, attachmentWarning, ensureChat, refreshChat, refreshChats]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const loadOlder = useCallback(async () => {
    const current = chat;
    if (!current || current.messages.length === 0) return;
    setOlderBusy(true);
    try {
      const el = scrollRef.current;
      const prevHeight = el?.scrollHeight ?? 0;
      const prevTop = el?.scrollTop ?? 0;
      const data = await apiFetch<{ messages: ChatMessageDto[]; hasOlder: boolean }>(
        `/api/chats/${current.id}/messages?before=${encodeURIComponent(current.messages[0].id)}`
      );
      if (activeIdRef.current !== current.id) return;
      // 往上翻页时不该被拽回底部：先关掉自动跟随，再按新增高度还原视觉位置。
      stickRef.current = false;
      setShowJump(true);
      setChat((latest) => latest?.id === current.id
        ? { ...latest, messages: [...data.messages, ...latest.messages], hasOlder: data.hasOlder }
        : latest);
      requestAnimationFrame(() => {
        const node = scrollRef.current;
        if (node) node.scrollTop = node.scrollHeight - prevHeight + prevTop;
      });
    } catch (err) {
      setNotice(errorMessage(err));
    } finally {
      setOlderBusy(false);
    }
  }, [chat]);

  const changeModel = useCallback(
    async (providerId: string) => {
      setLocalProviderId(providerId);
      if (!chat) return;
      try {
        const data = await apiFetch<{ providerId: string; modelId: string; providerName: string }>(
          `/api/chats/${chat.id}/model`,
          { method: 'PATCH', json: { providerId } }
        );
        setChat((prev) =>
          prev
            ? {
                ...prev,
                providerId: data.providerId,
                modelId: data.modelId,
                providerName: data.providerName
              }
            : prev
        );
        setChats((prev) =>
          prev.map((item) =>
            item.id === chat.id
              ? { ...item, providerId: data.providerId, modelId: data.modelId, providerName: data.providerName }
              : item
          )
        );
      } catch (err) {
        setNotice(errorMessage(err));
      }
    },
    [chat]
  );

  const submitRename = async () => {
    if (!renameTarget) return;
    const title = renameValue.trim();
    if (!title) return;
    setModalBusy(true);
    try {
      const data = await apiFetch<{ chats: ChatSummaryDto[] }>(`/api/chats/${renameTarget.id}`, {
        method: 'PATCH',
        json: { title }
      });
      setChats(data.chats);
      setChat((prev) => (prev && prev.id === renameTarget.id ? { ...prev, title } : prev));
      setRenameTarget(null);
    } catch (err) {
      setNotice(errorMessage(err));
    } finally {
      setModalBusy(false);
    }
  };

  const submitDelete = async () => {
    if (!deleteTarget) return;
    setModalBusy(true);
    try {
      await apiFetch(`/api/chats/${deleteTarget.id}`, { method: 'DELETE' });
      const wasActive = chat?.id === deleteTarget.id;
      setChats((prev) => prev.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
      if (wasActive) startNewChat();
    } catch (err) {
      setNotice(errorMessage(err));
    } finally {
      setModalBusy(false);
    }
  };

  const logout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST', json: {} });
    } catch {
      /* still clear locally */
    }
    router.replace('/login');
    router.refresh();
  };

  const appendTranscript = useCallback((text: string) => {
    if (!text) return;
    setDraft((prev) => (prev ? `${prev}${/[。！？，\s]$/.test(prev) ? '' : ' '}${text}` : text));
    setTimeout(() => textareaRef.current?.focus(), 30);
  }, []);

  const startSpeechRecognition = useCallback(() => {
    const Recognition = getSpeechRecognition();
    if (!Recognition) {
      setNotice('当前浏览器不支持语音输入');
      return;
    }
    const recognition = new Recognition();
    recognition.lang = 'zh-CN';
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      let text = '';
      for (let i = 0; i < event.results.length; i += 1) {
        text += event.results[i][0]?.transcript ?? '';
      }
      appendTranscript(text.trim());
    };
    recognition.onerror = () => {
      setNotice('语音识别失败，请重试或使用文字输入');
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      setRecording(false);
    };
    recognition.onend = () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      setRecording(false);
    };
    recognitionRef.current = recognition;
    setRecording(true);
    setRecordSeconds(0);
    // 这条路径以前只把秒数归零、从没起过表，所以界面上永远停在 0s。
    recordTimerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      setRecording(false);
      setNotice('无法启动浏览器语音识别，请检查麦克风权限');
    }
  }, [appendTranscript]);

  const stopSpeechRecognition = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setRecording(false);
  }, []);

  const startRecording = useCallback(async () => {
    if (transcribingRef.current) return;
    if (recording) {
      if (recognitionRef.current) {
        stopSpeechRecognition();
        return;
      }
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      return;
    }
    if (!hasAudioProvider || preferBrowserSpeechRef.current) {
      startSpeechRecognition();
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      if (speechSupported) startSpeechRecognition();
      else setNotice('当前浏览器不支持录音');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        recorderRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        if (recordTimerRef.current) clearInterval(recordTimerRef.current);
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        if (blob.size < 400) return;
        const form = new FormData();
        form.append('audio', new File([blob], `voice-${Date.now()}.webm`, { type: 'audio/webm' }));
        transcribingRef.current = true;
        setTranscribing(true);
        setNotice('正在转写语音…');
        try {
          const data = await apiFetch<{ text: string }>('/api/stt', { method: 'POST', body: form });
          appendTranscript(data.text);
          setNotice('语音已转写');
        } catch (err) {
          if (speechSupported) {
            preferBrowserSpeechRef.current = true;
            setNotice(`${errorMessage(err)}。再次点击麦克风可用浏览器识别，请重新说一遍。`);
          } else {
            setNotice(errorMessage(err));
          }
        } finally {
          transcribingRef.current = false;
          setTranscribing(false);
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      setNotice('无法访问麦克风，请检查浏览器权限');
    }
  }, [recording, hasAudioProvider, speechSupported, appendTranscript, startSpeechRecognition, stopSpeechRecognition]);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length) void uploadFiles(files);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length) void uploadFiles(files);
  };

  const onComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [draft]);

  const messages = chat?.messages ?? [];
  const hasMessages = messages.length > 0 || Boolean(optimisticUser) || Boolean(streamText);

  return (
    <div className="chat-surface flex h-dvh overflow-hidden">
      {sidebarOpen ? (
        <button
          type="button"
          aria-label="关闭侧栏"
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      <aside
        id="chat-sidebar"
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-[86%] max-w-[330px] flex-col overflow-hidden border-r border-white/[0.08] bg-[#0a0f17] transition-[transform,width,visibility] duration-300 lg:static lg:z-auto lg:min-w-0 lg:translate-x-0',
          sidebarCollapsed ? 'lg:invisible lg:w-0 lg:max-w-0' : 'lg:visible lg:w-[300px] xl:w-[320px]',
          sidebarOpen ? 'visible translate-x-0' : 'invisible -translate-x-full'
        )}
      >
        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <Link href="/chat" className="flex min-w-0 items-center gap-2.5" onClick={startNewChat}>
            <BrandMark size={30} />
            <span className="truncate text-[15px] font-semibold text-white/90">{settings.siteName}</span>
          </Link>
          <button type="button" className="btn-icon lg:hidden" onClick={() => setSidebarOpen(false)} aria-label="关闭对话侧栏">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-3 pt-2">
          <button type="button" onClick={startNewChat} className="btn-ghost w-full justify-start gap-2 border-aurora-400/20 bg-aurora-400/[0.07] py-2.5 text-[13px] hover:bg-aurora-400/10">
            <MessageSquarePlus className="h-4 w-4 text-aurora-300" />
            开启新对话
            <span className="ml-auto hidden rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-white/25 sm:inline">
              Ctrl / ⌘ K
            </span>
          </button>
        </div>

        <div className="px-3 pt-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/25" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索对话"
              aria-label="搜索对话"
              className="w-full rounded-lg border border-white/[0.07] bg-white/[0.03] py-2 pl-8 pr-3 text-[12.5px] text-white/80 outline-none placeholder:text-white/25 focus:border-white/15"
            />
          </div>
        </div>

        <div className="mt-4 flex-1 overflow-y-auto px-2 pb-2">
          <p className="mb-2 px-3 text-xs font-medium text-white/50">对话历史</p>
          {filteredChats.length === 0 ? (
            <div className="px-3 py-8 text-center text-[12px] leading-relaxed text-white/25">
              {chats.length === 0 ? '还没有对话。\n开始和 AI 聊聊吧。' : '没有匹配的对话'}
            </div>
          ) : (
            <ul className="space-y-0.5">
              {filteredChats.map((item) => {
                const active = chat?.id === item.id;
                return (
                  <li key={item.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => void selectChat(item.id)}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'w-full rounded-lg py-2.5 pl-3 pr-20 text-left transition lg:pr-3 lg:group-hover:pr-16 lg:group-focus-within:pr-16',
                        active ? 'bg-[#1b2831] shadow-[inset_2px_0_0_#4fe0b4]' : 'hover:bg-white/[0.05]'
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className={cn('truncate text-[13px]', active ? 'text-white' : 'text-white/70')}>{item.title}</span>
                        <span className="ml-auto shrink-0 text-[10px] text-white/45">{timeAgo(item.updatedAt)}</span>
                      </div>
                      {item.preview ? <p className="mt-0.5 truncate text-[11px] text-white/45">{item.preview}</p> : null}
                    </button>
                    <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-md bg-[#0b1019]/90 p-0.5 shadow-lg lg:hidden lg:group-hover:flex lg:group-focus-within:flex">
                      <button
                        type="button"
                        className="btn-icon h-8 w-8 lg:h-6 lg:w-6"
                        aria-label="重命名"
                        onClick={() => {
                          setRenameTarget(item);
                          setRenameValue(item.title);
                        }}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        className="btn-icon h-8 w-8 text-red-300/70 hover:text-red-300 lg:h-6 lg:w-6"
                        aria-label="删除"
                        onClick={() => setDeleteTarget(item)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="relative border-t border-white/[0.06] p-3">
          <button
            type="button"
            onClick={() => setAccountOpen((open) => !open)}
            className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition hover:bg-white/[0.04]"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-gradient-to-br from-aurora-400/25 to-violet-500/20 text-[12px] font-semibold text-white/85">
              {(user.displayName || user.username).slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] text-white/80">{user.displayName || user.username}</span>
              <span className="block text-[10px] text-white/30">{user.role === 'OWNER' ? '所有者' : '用户'}</span>
            </span>
            <ChevronDown className={cn('h-3.5 w-3.5 text-white/30 transition', accountOpen && 'rotate-180')} />
          </button>
          {accountOpen ? (
            <>
              <button
                type="button"
                className="fixed inset-0 z-40 cursor-default"
                aria-label="关闭菜单"
                onClick={() => setAccountOpen(false)}
              />
              <div className="absolute bottom-[68px] left-3 right-3 z-50 overflow-hidden rounded-xl border border-white/10 bg-[#0c111b] p-1 shadow-2xl">
                <Link
                  href="/settings"
                  className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[12.5px] text-white/70 hover:bg-white/[0.06] hover:text-white"
                >
                  <Settings className="h-3.5 w-3.5" /> 账号设置
                </Link>
                {user.role === 'OWNER' ? (
                  <Link
                    href="/admin"
                    className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[12.5px] text-white/70 hover:bg-white/[0.06] hover:text-white"
                  >
                    <Shield className="h-3.5 w-3.5" /> 管理后台
                  </Link>
                ) : null}
                <button
                  type="button"
                  onClick={() => void logout()}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[12.5px] text-white/70 hover:bg-white/[0.06] hover:text-white"
                >
                  <LogOut className="h-3.5 w-3.5" /> 退出登录
                </button>
              </div>
            </>
          ) : null}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[58px] shrink-0 items-center gap-2 border-b border-white/[0.08] bg-[#0d121b]/90 px-3 backdrop-blur-xl sm:h-16 sm:px-5">
          <button type="button" className="btn-icon lg:hidden" onClick={() => setSidebarOpen(true)} aria-label="打开侧栏" aria-expanded={sidebarOpen} aria-controls="chat-sidebar">
            <Menu className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="btn-icon hidden lg:inline-flex"
            onClick={toggleSidebar}
            aria-controls="chat-sidebar"
            aria-expanded={!sidebarCollapsed}
            aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
          >
            {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-white/90">{chat?.title || '新对话'}</h1>
            <p className="hidden truncate text-[11px] text-white/50 sm:block">
              {selectedProvider ? `${selectedProvider.name} · ${selectedProvider.modelId}` : '尚未选择模型'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <div className="relative flex items-center">
              <select
                aria-label="选择模型"
                value={selectedProviderId}
                onChange={(e) => void changeModel(e.target.value)}
                disabled={providers.length === 0 || sending}
                className="max-w-[42vw] appearance-none rounded-full border border-white/10 bg-white/[0.05] py-2 pl-3 pr-8 text-xs text-white/80 outline-none transition hover:border-white/25 focus-visible:ring-2 focus-visible:ring-aurora-400/60 disabled:opacity-45 sm:max-w-[240px]"
              >
                {providers.length === 0 ? <option value="">未配置模型</option> : null}
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id} className="bg-[#0c111b]">
                    {provider.name} · {provider.modelId}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 h-3 w-3 text-white/30" />
            </div>
            <Link href="/settings" className="btn-icon hidden sm:inline-flex" aria-label="设置">
              <Settings className="h-4 w-4" />
            </Link>
            {user.role === 'OWNER' ? (
              <Link href="/admin" className="btn-icon hidden sm:inline-flex" aria-label="管理后台">
                <Shield className="h-4 w-4" />
              </Link>
            ) : null}
          </div>
        </header>

        {settings.maintenanceNotice ? (
          <div className="border-b border-amber-400/15 bg-amber-400/[0.06] px-4 py-2 text-center text-[12px] text-amber-200/80">
            {settings.maintenanceNotice}
          </div>
        ) : null}

        <div ref={scrollRef} className="relative flex-1 overflow-y-auto scroll-smooth" onScroll={onMessagesScroll}>
          <div className={cn('mx-auto w-full max-w-3xl px-4 sm:px-6', hasMessages ? 'pb-8 pt-6' : 'flex min-h-full flex-col py-2')}>
            {!hasMessages ? (
              <div className="flex flex-1 flex-col items-center justify-center py-3 text-center">
                <div className="relative mb-4 flex h-14 w-14 items-center justify-center sm:h-16 sm:w-16">
                  <div className="absolute inset-0 rounded-full bg-aurora-400/15 blur-2xl" />
                  <BrandMark size={52} />
                </div>
                <h2 className="max-w-full break-words text-[clamp(1.5rem,5vw,2.25rem)] font-semibold tracking-tight text-white">
                  {greeting()}，{user.displayName || user.username}
                </h2>
                <p className="mt-2 max-w-md text-sm leading-relaxed text-white/60">
                  今天想聊点什么？
                </p>
                {providers.length === 0 ? (
                  <div className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-2.5 text-[12.5px] text-amber-200/80">
                    尚未配置可用模型。请前往{' '}
                    <Link href="/settings?tab=models" className="underline">
                      设置 · 模型
                    </Link>{' '}
                    添加，或联系管理员。
                  </div>
                ) : null}
                <div className="mt-5 grid w-full max-w-xl grid-cols-2 gap-2 sm:gap-3">
                  {SUGGESTIONS.map(({ label, detail, prompt, icon: Icon }) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => {
                        setDraft(prompt);
                        textareaRef.current?.focus();
                      }}
                      className="group min-w-0 rounded-xl border border-white/10 bg-[#151c27] p-3 text-left transition hover:border-aurora-400/40 hover:bg-[#1a2932] focus-visible:outline focus-visible:outline-2 focus-visible:outline-aurora-400 sm:px-4"
                    >
                      <span className="mb-1.5 flex items-center justify-between text-aurora-300">
                        <Icon className="h-4 w-4" aria-hidden="true" />
                        <ArrowUpRight className="hidden h-3.5 w-3.5 text-white/35 group-hover:text-aurora-300 sm:block" aria-hidden="true" />
                      </span>
                      <span className="block text-sm font-medium text-white/90">{label}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-white/60">{detail}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-7">
                {chat?.hasOlder ? (
                  <div className="flex justify-center">
                    <button type="button" className="btn-ghost text-[12px]" onClick={() => void loadOlder()} disabled={olderBusy}>
                      {olderBusy ? <Spinner /> : <History className="h-3.5 w-3.5" />} 加载更早的消息
                    </button>
                  </div>
                ) : null}
                {messages.map((message) =>
                  message.role === 'SYSTEM' ? null : (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      citationIds={citations[message.id]}
                      getCitationSource={getCitationSource}
                      onEdit={message.role === 'USER' ? beginEdit : undefined}
                    />
                  )
                )}
                {optimisticUser ? (
                  <MessageBubble message={optimisticUser} optimistic getCitationSource={getCitationSource} />
                ) : null}
                {sending || streamText ? (
                  <div className="flex gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/10 bg-aurora-400/10">
                      <Bot className="h-3.5 w-3.5 text-aurora-300" />
                    </span>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <div className="mb-1.5 flex items-center gap-2 text-[10.5px] text-white/25">
                        <span>{selectedProvider?.name ?? 'AI'}</span>
                        {selectedProvider ? <span className="text-white/15">{selectedProvider.modelId}</span> : null}
                        <span className="ml-1 flex gap-0.5">
                          <span className="h-1 w-1 animate-blink rounded-full bg-aurora-300" />
                          <span className="h-1 w-1 animate-blink rounded-full bg-aurora-300 [animation-delay:120ms]" />
                          <span className="h-1 w-1 animate-blink rounded-full bg-aurora-300 [animation-delay:240ms]" />
                        </span>
                      </div>
                      {streamText ? (
                        <Markdown>{streamText}</Markdown>
                      ) : (
                        <div className="flex items-center gap-2 text-[12px] text-white/30">
                          <Spinner className="h-3 w-3" /> 正在思考…
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            {streamError ? (
              <div className="mt-4 rounded-xl border border-red-400/20 bg-red-400/[0.06] px-4 py-3 text-[12.5px] text-red-200/80">
                {streamError}
              </div>
            ) : null}

            {showJump ? (
              <div className="pointer-events-none sticky bottom-1 z-10 flex justify-end">
                <button
                  type="button"
                  onClick={jumpToBottom}
                  className="btn-icon pointer-events-auto h-9 w-9 border-white/10 bg-[#0c111b]/90 shadow-lg backdrop-blur"
                  aria-label="回到底部"
                >
                  <ArrowDown className="h-4 w-4" />
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="shrink-0 border-t border-white/[0.05] bg-gradient-to-t from-[#07090f] via-[#07090f]/95 to-transparent px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 sm:px-6 sm:pb-5">
          <div className="mx-auto w-full max-w-3xl">
            {pending.length > 0 ? (
              <div className="mb-2 flex flex-wrap gap-2">
                {pending.map((item) => (
                  <div
                    key={item.id}
                    className="group relative flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] py-1.5 pl-2 pr-7 text-[11.5px] text-white/60"
                  >
                    {item.kind === 'IMAGE' ? (
                      <img
                        src={imageUrl(item.id)}
                        alt={item.name}
                        className="h-8 w-8 rounded object-cover"
                      />
                    ) : (
                      <FileText className="h-3.5 w-3.5 text-aurora-300/70" />
                    )}
                    <span className="max-w-[160px] truncate">{item.name}</span>
                    <span className="text-white/25">{formatBytes(item.size)}</span>
                    <button
                      type="button"
                      className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-white/30 hover:bg-white/10 hover:text-white"
                      aria-label="移除附件"
                      onClick={() => void removePending(item.id)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            {uploading ? (
              <div role="status" className="mb-2 flex items-center gap-2 text-[11.5px] text-white/35">
                <Spinner className="h-3 w-3" /> 正在加密保存文件…
              </div>
            ) : null}
            {attachmentWarning ? (
              <p id="composer-attachment-warning" role="status" className="mb-2 text-xs text-amber-200">
                {attachmentWarning}
              </p>
            ) : null}

            {editingId ? (
              <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-aurora-400/25 bg-aurora-400/[0.07] px-3 py-2 text-[12px] text-aurora-200">
                <span className="flex items-center gap-1.5">
                  <Pencil className="h-3 w-3" /> 正在编辑消息：发送后将移除其后的问答并重新回答
                </span>
                <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-white/60 hover:bg-white/10 hover:text-white" onClick={cancelEdit}>
                  取消
                </button>
              </div>
            ) : null}

            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              className="chat-composer rounded-[22px] border border-white/[0.12] transition focus-within:border-aurora-400/45 focus-within:ring-2 focus-within:ring-aurora-400/10"
            >
              <textarea
                ref={textareaRef}
                aria-label="消息内容"
                aria-describedby={attachmentWarning ? 'composer-attachment-warning' : undefined}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onComposerKeyDown}
                rows={1}
                placeholder={selectedProvider ? `给 ${selectedProvider.name} 发消息…` : '尚未配置模型，仍可先输入内容'}
                className="max-h-[200px] min-h-[52px] w-full resize-none bg-transparent px-4 pt-3.5 text-base leading-relaxed text-white/95 outline-none placeholder:text-white/50"
                disabled={sending}
              />
              <div className="flex items-center gap-1 px-2 pb-2 pt-1">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.txt,.md,.markdown,.csv,audio/*"
                  onChange={onFileChange}
                />
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="添加文件"
                  disabled={uploading || sending}
                  title="图片、PDF、DOCX、TXT、MD、CSV、音频"
                >
                  <Paperclip className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className={cn('btn-icon relative', recording && 'bg-red-400/15 text-red-200')}
                  onClick={() => void startRecording()}
                  aria-label={transcribing ? '正在转写语音' : recording ? '停止录音' : '语音输入'}
                  title={transcribing ? '正在转写语音' : recording ? '停止录音' : '语音输入'}
                  disabled={sending || transcribing}
                >
                  {transcribing ? <Spinner /> : recording ? <Square className="h-3.5 w-3.5 fill-current" /> : <Mic className="h-4 w-4" />}
                  {recording ? (
                    <span className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-red-400/20 bg-[#1a0d10] px-2 py-1 text-[10px] text-red-200">
                      {recordSeconds}s · 点击停止
                    </span>
                  ) : null}
                </button>
                <div className="flex-1" />
                {sending ? (
                  <button type="button" className="btn-ghost h-9 gap-1.5 border-white/10 px-3 text-[12px]" onClick={stopStreaming}>
                    <Square className="h-3 w-3 fill-current" /> 停止
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void send()}
                    disabled={(!draft.trim() && pending.length === 0) || uploading || Boolean(attachmentWarning)}
                    className="btn-primary h-9 w-9 shrink-0 rounded-xl p-0"
                    aria-label="发送"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
            <p className="mt-2 select-none text-center text-[10px] leading-relaxed text-white/20">
              对话会发送给所选模型服务。AI 可能出错，请自行判断重要信息。
            </p>
          </div>
        </div>
      </section>

      <Modal
        open={Boolean(renameTarget)}
        onClose={() => setRenameTarget(null)}
        title="重命名对话"
        width="420px"
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setRenameTarget(null)}>
              取消
            </button>
            <button type="button" className="btn-primary" onClick={() => void submitRename()} disabled={modalBusy || !renameValue.trim()}>
              {modalBusy ? <Spinner /> : <Check className="h-4 w-4" />} 保存
            </button>
          </>
        }
      >
        <input
          className="field"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          maxLength={60}
          data-modal-initial-focus
          aria-label="对话名称"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submitRename();
          }}
        />
      </Modal>

      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="删除这段对话？"
        description="对话内容与其附件将被永久删除，此操作无法撤销。这段对话产生的长期记忆也会一并删除。"
        width="420px"
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setDeleteTarget(null)}>
              取消
            </button>
            <button type="button" className="btn-danger" onClick={() => void submitDelete()} disabled={modalBusy}>
              {modalBusy ? <Spinner /> : <Trash2 className="h-4 w-4" />} 删除
            </button>
          </>
        }
      />

      {notice ? (
        <div role="status" className="pointer-events-none fixed bottom-24 left-1/2 z-[90] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 rounded-xl border border-white/10 bg-[#101520]/95 px-4 py-2.5 text-center text-[12px] text-white/75 shadow-2xl backdrop-blur-xl">
          {notice}
        </div>
      ) : null}
    </div>
  );
}

const MessageBubble = memo(function MessageBubble({
  message,
  optimistic,
  citationIds,
  getCitationSource,
  onEdit
}: {
  message: ChatMessageDto;
  optimistic?: boolean;
  citationIds?: string[];
  getCitationSource: () => Promise<CitationSource>;
  onEdit?: (message: ChatMessageDto) => void;
}) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'USER';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  if (isUser) {
    return (
      <div className={cn('group flex justify-end gap-3', optimistic && 'opacity-60')}>
        <div className="max-w-[85%] sm:max-w-[75%]">
          {message.attachments.length > 0 ? (
            <div className="mb-2 flex flex-wrap justify-end gap-2">
              {message.attachments.map((attachment) =>
                attachment.kind === 'IMAGE' ? (
                  <a
                    key={attachment.id}
                    href={imageUrl(attachment.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block overflow-hidden rounded-xl border border-white/10"
                  >
                    <img src={imageUrl(attachment.id)} alt={attachment.name} className="max-h-48 max-w-[220px] object-cover" />
                  </a>
                ) : (
                  <a
                    key={attachment.id}
                    href={`/api/files/${attachment.id}`}
                    className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[11.5px] text-white/60 hover:border-white/20"
                  >
                    <FileText className="h-3.5 w-3.5 text-aurora-300/70" />
                    <span className="max-w-[180px] truncate">{attachment.name}</span>
                    {attachment.textSkipped ? (
                      <span className="text-white/35">文件过大，未解析内容</span>
                    ) : null}
                    <Download className="h-3 w-3 opacity-50" />
                  </a>
                )
              )}
            </div>
          ) : null}
          {message.content ? (
            <div className="rounded-[20px] rounded-br-md border border-aurora-400/20 bg-gradient-to-br from-[#173a33] to-[#122a26] px-4 py-3 text-[15px] leading-relaxed text-white/95 shadow-[0_10px_30px_-18px_rgba(79,224,180,0.45)]">
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
            </div>
          ) : null}
          <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-white/20">
            {onEdit && !optimistic ? (
              <button
                type="button"
                onClick={() => onEdit(message)}
                className="rounded p-1 text-white/25 transition hover:bg-white/5 hover:text-white/60"
                aria-label="编辑并重发这条消息"
                title="编辑并重发（会移除其后的问答）"
              >
                <Pencil className="h-3 w-3" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void copy()}
              className="rounded p-1 text-white/25 transition hover:bg-white/5 hover:text-white/60"
              aria-label="复制这条消息"
            >
              {copied ? <Check className="h-3 w-3 text-aurora-300" /> : <Copy className="h-3 w-3" />}
            </button>
            <span>{messageTime(message.createdAt)}</span>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="group flex gap-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/10 bg-aurora-400/10">
        <Bot className="h-3.5 w-3.5 text-aurora-300" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex items-center gap-2 text-xs text-white/55">
          <span className="min-w-0 truncate font-medium text-white/80">{message.modelId || 'AI'}</span>
          {message.status === 'PARTIAL' ? <span className="text-amber-300/60">部分回答</span> : null}
          {message.status === 'ERROR' ? <span className="text-red-300/60">出错了</span> : null}
          <span className="shrink-0 text-white/45">{messageTime(message.createdAt)}</span>
          <button
            type="button"
            onClick={() => void copy()}
            className="ml-auto shrink-0 rounded-lg p-2 text-white/55 transition hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-aurora-400"
            aria-label="复制回答"
          >
            {copied ? <Check className="h-3 w-3 text-aurora-300" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
        <Markdown>{message.content}</Markdown>
        {citationIds?.length ? <CitationNote ids={citationIds} getSource={getCitationSource} /> : null}
        {(message.inputTokens || message.outputTokens) && (
          <div className="mt-2 text-[10px] text-white/15">
            {message.inputTokens ?? 0} tokens 输入 · {message.outputTokens ?? 0} tokens 输出
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * 「这一轮带上了哪几条长期记忆」（任务书 8.2）。收起态只是一句提示，点开才去取记忆原文。
 *
 * 措辞停在「带上了」，不写成「AI 根据这些记忆回答」：服务端能证明的只有这几条进了那一刻的
 * 提示词，模型用没用、怎么用，一个字都不知道。清单顶部把这句限制摆在最前面。
 *
 * 记忆正文按纯文本渲染，不走 Markdown——它是不可信数据，不该在界面里获得任何排版能力。
 */
function CitationNote({
  ids,
  getSource
}: {
  ids: string[];
  getSource: () => Promise<CitationSource>;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<CitationRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;
    // 每次展开都重算一次：引用是过去那一刻的事，清单是现在的记忆，中间用户可能已经改过口。
    // 取数在 CitationNote 外面那个 promise 里缓存，重复展开不会多打一次请求。
    try {
      const source = await getSource();
      setRows(
        citationRows({ ids, memories: source.memories, chats: source.chats, confidence: source.confidence })
      );
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        className="flex items-center gap-1 text-[11px] text-white/30 transition hover:text-aurora-300/80"
      >
        <span>{citationHint(ids.length)}</span>
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div className="mt-1.5 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3.5 py-2.5">
          <p className="text-[11px] leading-relaxed text-white/35">{CITATION_NOTE}</p>
          {failed ? (
            <p className="mt-1.5 text-[11.5px] text-white/40">{CITATION_LOAD_FAILED_NOTE}</p>
          ) : rows ? (
            <ul className="mt-1.5 space-y-2">
              {rows.map((row) => (
                <li key={row.id} className="min-w-0">
                  <p
                    className={cn(
                      'break-words text-[12.5px] leading-relaxed',
                      row.missing ? 'text-white/35' : 'text-white/70'
                    )}
                  >
                    {row.text}
                  </p>
                  {row.meta ? <p className="mt-0.5 text-[10.5px] text-white/25">{row.meta}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-1.5 flex items-center gap-2">
              <Spinner className="h-3 w-3" />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
