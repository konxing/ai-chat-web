'use client';

import {
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
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Copy,
  Download,
  FileText,
  LogOut,
  Menu,
  MessageSquarePlus,
  Mic,
  Paperclip,
  Pencil,
  Search,
  Settings,
  Shield,
  Square,
  Trash2,
  X
} from 'lucide-react';
import { apiFetch, csrfHeader, errorMessage, formatBytes, imageUrl, timeAgo } from '@/lib/client-api';
import { cn } from '@/lib/cn';
import { BrandMark } from '@/components/brand';
import { Modal, Spinner } from '@/components/ui';
import { Markdown } from '@/components/chat/markdown';
import type {
  AttachmentDto,
  ChatDetailDto,
  ChatMessageDto,
  ChatSettings,
  ChatSummaryDto,
  ChatUser,
  ProviderDto
} from '@/lib/chat-types';

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
  '帮我把这段话写得更温和一些：',
  '用简单的比喻解释一下量子纠缠',
  '为明天的家庭晚餐设计一份菜单',
  '把这份 PDF 的要点总结成清单'
];

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
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamError, setStreamError] = useState('');
  const [localProviderId, setLocalProviderId] = useState<string>(
    initialChat?.providerId ?? providers.find((p) => p.isDefault)?.id ?? providers[0]?.id ?? ''
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
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

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeIdRef = useRef<string | null>(initialChat?.id ?? null);
  const chatIdRef = useRef<string | null>(initialChat?.id ?? null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedProviderId = chat?.providerId ?? localProviderId;
  const selectedProvider = providers.find((p) => p.id === selectedProviderId) ?? null;
  const hasAudioProvider = providers.some((p) => p.capabilities.includes('audio'));
  const speechSupported = typeof window !== 'undefined' && Boolean(getSpeechRecognition());

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  useEffect(() => {
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
      if (err instanceof Error && 'status' in err && (err as { status?: number }).status === 404) {
        router.replace('/chat');
      }
    }
  }, [router]);

  const selectChat = useCallback(
    async (id: string) => {
      if (sending) abortRef.current?.abort();
      activeIdRef.current = id;
      chatIdRef.current = id;
      setSidebarOpen(false);
      setAccountOpen(false);
      setStreamText('');
      setStreamError('');
      setOptimisticUser(null);
      setPending([]);
      try {
        const data = await apiFetch<{ chat: ChatDetailDto }>(`/api/chats/${id}`);
        setChat(data.chat);
        if (data.chat.providerId) setLocalProviderId(data.chat.providerId);
        window.history.replaceState(null, '', `/chat/${id}`);
      } catch (err) {
        setNotice(errorMessage(err));
      }
    },
    [sending]
  );

  const startNewChat = useCallback(() => {
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

  const ensureChat = useCallback(async (): Promise<string | null> => {
    if (chatIdRef.current) return chatIdRef.current;
    try {
      const data = await apiFetch<{ chat: ChatSummaryDto }>('/api/chats', {
        json: selectedProviderId ? { providerId: selectedProviderId } : {}
      });
      const created = data.chat;
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
        messages: []
      });
      setChats((prev) => [created, ...prev]);
      window.history.replaceState(null, '', `/chat/${created.id}`);
      return created.id;
    } catch (err) {
      setNotice(errorMessage(err));
      return null;
    }
  }, [selectedProviderId]);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const chatId = await ensureChat();
      if (!chatId) return;
      setUploading(true);
      try {
        for (const file of files.slice(0, 12)) {
          const form = new FormData();
          form.append('file', file);
          form.append('chatId', chatId);
          const data = await apiFetch<{ attachment: AttachmentDto }>('/api/upload', {
            method: 'POST',
            body: form
          });
          setPending((prev) => [...prev, data.attachment]);
        }
      } catch (err) {
        setNotice(errorMessage(err));
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [ensureChat]
  );

  const removePending = useCallback(async (id: string) => {
    setPending((prev) => prev.filter((item) => item.id !== id));
    try {
      await apiFetch(`/api/files/${id}`, { method: 'DELETE', json: {} });
    } catch {
      /* file may already be tied to a message */
    }
  }, []);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (sending) return;
    if (!content && pending.length === 0) return;
    setStreamError('');
    setNotice('');
    const chatId = await ensureChat();
    if (!chatId) return;
    const attachments = pending;
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
    setDraft('');
    setPending([]);
    setSending(true);
    setStreamText('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch(`/api/chats/${chatId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...csrfHeader()
        },
        body: JSON.stringify({ content, attachmentIds: attachments.map((a) => a.id) }),
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
        setStreamError(message);
        setOptimisticUser(null);
        await refreshChat(chatId);
        return;
      }
      if (!response.body) {
        setStreamError('当前浏览器不支持流式响应');
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
            };
            try {
              event = JSON.parse(data);
            } catch {
              continue;
            }
            if (event.type === 'delta' && event.text) {
              accumulated += event.text;
              setStreamText(accumulated);
            } else if (event.type === 'error') {
              setStreamError(event.error?.message || '模型调用失败，请稍后重试');
            } else if (event.type === 'partial') {
              setStreamError(event.error?.message || '回答中断，已保存部分内容');
              finished = true;
            } else if (event.type === 'done') {
              finished = true;
            }
          }
        }
      }
      if (!finished && accumulated && !controller.signal.aborted) {
        setStreamError('连接意外结束，已保存已生成的内容');
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setStreamError(errorMessage(err));
      }
    } finally {
      abortRef.current = null;
      setSending(false);
      if (controller.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      await refreshChat(chatId);
      await refreshChats();
      setStreamText('');
    }
  }, [draft, pending, sending, ensureChat, refreshChat, refreshChats]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

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
      setRecording(false);
    };
    recognition.onend = () => setRecording(false);
    recognitionRef.current = recognition;
    setRecording(true);
    setRecordSeconds(0);
    recognition.start();
  }, [appendTranscript]);

  const stopSpeechRecognition = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setRecording(false);
  }, []);

  const startRecording = useCallback(async () => {
    if (recording) {
      if (recognitionRef.current) {
        stopSpeechRecognition();
        return;
      }
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      return;
    }
    if (!hasAudioProvider) {
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
        stream.getTracks().forEach((track) => track.stop());
        if (recordTimerRef.current) clearInterval(recordTimerRef.current);
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        if (blob.size < 400) return;
        const form = new FormData();
        form.append('audio', new File([blob], `voice-${Date.now()}.webm`, { type: 'audio/webm' }));
        setNotice('正在转写语音…');
        try {
          const data = await apiFetch<{ text: string }>('/api/stt', { method: 'POST', body: form });
          appendTranscript(data.text);
          setNotice('语音已转写');
        } catch (err) {
          setNotice(errorMessage(err));
          if (speechSupported) startSpeechRecognition();
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
    <div className="flex h-dvh overflow-hidden bg-transparent">
      {sidebarOpen ? (
        <button
          type="button"
          aria-label="关闭侧栏"
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-[86%] max-w-[330px] flex-col border-r border-white/[0.07] bg-[#080b12]/95 backdrop-blur-2xl transition-transform duration-300 lg:static lg:z-auto lg:w-[300px] lg:translate-x-0 xl:w-[320px]',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <Link href="/chat" className="flex min-w-0 items-center gap-2.5" onClick={startNewChat}>
            <BrandMark size={30} />
            <span className="truncate text-[15px] font-semibold text-white/90">{settings.siteName}</span>
          </Link>
          <button type="button" className="btn-icon lg:hidden" onClick={() => setSidebarOpen(false)} aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-3 pt-2">
          <button type="button" onClick={startNewChat} className="btn-ghost w-full justify-start gap-2 border-white/10 py-2.5 text-[13px]">
            <MessageSquarePlus className="h-4 w-4 text-aurora-300" />
            开启新对话
            <span className="ml-auto hidden rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-white/25 sm:inline">
              ⌘ K
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
              className="w-full rounded-lg border border-white/[0.07] bg-white/[0.03] py-2 pl-8 pr-3 text-[12.5px] text-white/80 outline-none placeholder:text-white/25 focus:border-white/15"
            />
          </div>
        </div>

        <div className="mt-3 flex-1 overflow-y-auto px-2 pb-2">
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
                      className={cn(
                        'w-full rounded-lg px-3 py-2.5 text-left transition',
                        active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className={cn('truncate text-[13px]', active ? 'text-white' : 'text-white/70')}>{item.title}</span>
                        <span className="ml-auto shrink-0 text-[10px] text-white/20">{timeAgo(item.updatedAt)}</span>
                      </div>
                      {item.preview ? <p className="mt-0.5 truncate text-[11px] text-white/30">{item.preview}</p> : null}
                    </button>
                    <div className="absolute right-1.5 top-1.5 hidden items-center gap-0.5 rounded-md bg-[#0b1019]/90 p-0.5 shadow-lg group-hover:flex">
                      <button
                        type="button"
                        className="btn-icon h-6 w-6"
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
                        className="btn-icon h-6 w-6 text-red-300/70 hover:text-red-300"
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
              <span className="block text-[10px] text-white/30">{user.role === 'OWNER' ? '所有者' : '家庭成员'}</span>
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
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-white/[0.06] bg-[#080b12]/55 px-3 backdrop-blur-xl sm:px-4">
          <button type="button" className="btn-icon lg:hidden" onClick={() => setSidebarOpen(true)} aria-label="打开侧栏">
            <Menu className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[13.5px] font-medium text-white/85">{chat?.title || '新对话'}</h1>
            <p className="hidden truncate text-[10.5px] text-white/30 sm:block">
              {selectedProvider ? `${selectedProvider.name} · ${selectedProvider.modelId}` : '尚未选择模型'}
            </p>
          </div>
          <div className="relative flex items-center gap-1.5">
            <select
              aria-label="选择模型"
              value={selectedProviderId}
              onChange={(e) => void changeModel(e.target.value)}
              disabled={providers.length === 0 || sending}
              className="max-w-[190px] appearance-none rounded-lg border border-white/10 bg-white/[0.04] py-1.5 pl-2.5 pr-7 text-[11.5px] text-white/70 outline-none transition hover:border-white/20 disabled:opacity-40 sm:max-w-[240px]"
            >
              {providers.length === 0 ? <option value="">未配置模型</option> : null}
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id} className="bg-[#0c111b]">
                  {provider.name} · {provider.modelId}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 h-3 w-3 text-white/30" />
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

        <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-smooth">
          <div className="mx-auto w-full max-w-3xl px-4 pb-8 pt-6 sm:px-6">
            {!hasMessages ? (
              <div className="flex min-h-[calc(100dvh-16rem)] flex-col items-center justify-center text-center">
                <div className="relative mb-6 flex h-16 w-16 items-center justify-center">
                  <div className="absolute inset-0 rounded-full bg-aurora-400/20 blur-xl" />
                  <BrandMark size={56} />
                </div>
                <h2 className="text-[24px] font-light tracking-wide text-white sm:text-[28px]">
                  {greeting()}，{user.displayName || user.username}
                </h2>
                <p className="mt-2 max-w-md text-[13px] leading-relaxed text-white/35">
                  这是一个只属于家人的 AI 空间。可以聊天、读文档、看图片，也可以切换不同的模型。
                </p>
                {providers.length === 0 ? (
                  <div className="mt-6 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3 text-[12.5px] text-amber-200/80">
                    尚未配置可用模型。请前往{' '}
                    <Link href="/settings" className="underline">
                      设置 · 模型
                    </Link>{' '}
                    添加，或联系管理员。
                  </div>
                ) : null}
                <div className="mt-8 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => {
                        setDraft(suggestion);
                        textareaRef.current?.focus();
                      }}
                      className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-3.5 py-3 text-left text-[12.5px] leading-relaxed text-white/45 transition hover:border-aurora-400/25 hover:bg-aurora-400/[0.05] hover:text-white/75"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-7">
                {messages.map((message) =>
                  message.role === 'SYSTEM' ? null : (
                    <MessageBubble key={message.id} message={message} />
                  )
                )}
                {optimisticUser ? <MessageBubble message={optimisticUser} optimistic /> : null}
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
              <div className="mb-2 flex items-center gap-2 text-[11.5px] text-white/35">
                <Spinner className="h-3 w-3" /> 正在加密保存文件…
              </div>
            ) : null}

            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              className="rounded-2xl border border-white/[0.09] bg-[#0d121c]/90 shadow-[0_18px_50px_-24px_rgba(0,0,0,0.9)] backdrop-blur-xl transition focus-within:border-aurora-400/30 focus-within:ring-2 focus-within:ring-aurora-400/10"
            >
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onComposerKeyDown}
                rows={1}
                placeholder={selectedProvider ? `给 ${selectedProvider.name} 发消息…` : '尚未配置模型，仍可先输入内容'}
                className="max-h-[200px] min-h-[52px] w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed text-white/90 outline-none placeholder:text-white/25"
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
                  aria-label={recording ? '停止录音' : '语音输入'}
                  title={recording ? '停止录音' : '语音输入'}
                  disabled={sending}
                >
                  {recording ? <Square className="h-3.5 w-3.5 fill-current" /> : <Mic className="h-4 w-4" />}
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
                    disabled={(!draft.trim() && pending.length === 0) || uploading}
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
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submitRename();
          }}
        />
      </Modal>

      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="删除这段对话？"
        description="对话内容与其附件将被永久删除，此操作无法撤销。"
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
        <div className="pointer-events-none fixed bottom-24 left-1/2 z-[90] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 rounded-xl border border-white/10 bg-[#101520]/95 px-4 py-2.5 text-center text-[12px] text-white/75 shadow-2xl backdrop-blur-xl">
          {notice}
        </div>
      ) : null}
    </div>
  );
}

function MessageBubble({ message, optimistic }: { message: ChatMessageDto; optimistic?: boolean }) {
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
      <div className={cn('flex justify-end gap-3', optimistic && 'opacity-60')}>
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
                    <Download className="h-3 w-3 opacity-50" />
                  </a>
                )
              )}
            </div>
          ) : null}
          {message.content ? (
            <div className="rounded-2xl rounded-br-md border border-aurora-400/15 bg-aurora-400/[0.09] px-4 py-3 text-[14.5px] leading-relaxed text-white/90">
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
            </div>
          ) : null}
          <div className="mt-1 text-right text-[10px] text-white/20">{messageTime(message.createdAt)}</div>
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
        <div className="mb-1.5 flex items-center gap-2 text-[10.5px] text-white/25">
          <span>{message.modelId || 'AI'}</span>
          {message.status === 'PARTIAL' ? <span className="text-amber-300/60">部分回答</span> : null}
          {message.status === 'ERROR' ? <span className="text-red-300/60">出错了</span> : null}
          <span className="text-white/15">{messageTime(message.createdAt)}</span>
          <button
            type="button"
            onClick={() => void copy()}
            className="ml-auto rounded p-1 text-white/20 opacity-0 transition hover:bg-white/5 hover:text-white/60 group-hover:opacity-100"
            aria-label="复制回答"
          >
            {copied ? <Check className="h-3 w-3 text-aurora-300" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
        <Markdown>{message.content}</Markdown>
        {(message.inputTokens || message.outputTokens) && (
          <div className="mt-2 text-[10px] text-white/15">
            {message.inputTokens ?? 0} tokens 输入 · {message.outputTokens ?? 0} tokens 输出
          </div>
        )}
      </div>
    </div>
  );
}
