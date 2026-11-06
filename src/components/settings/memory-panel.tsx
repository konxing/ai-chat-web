'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Archive, ArchiveRestore, Brain, History, Pencil, Scale, Trash2, X } from 'lucide-react';
import { apiFetch, errorMessage, timeAgo } from '@/lib/client-api';
import { Alert, EmptyState, LoadingBlock, Spinner, useConfirm, useToast } from '@/components/ui';
import { MemoryCandidatesPanel } from './memory-candidates-panel';
import { FailedTasksPanel } from './failed-tasks-panel';
import {
  CONFIDENCE_BAND_LABELS,
  CONTEXT_LABELS,
  ORIGIN_LABELS,
  RECONSOLIDATION_LABELS,
  REVISION_ACTION_LABELS,
  TYPE_LABELS,
  describeAccessCap,
  describeAccessCount,
  describeArchivedListCap,
  describeConfidenceFactor,
  describeMemoryListCap,
  describeValidRange
} from '@/lib/cognitive/memory-display';
import type { MemoryDto, MemoryRevisionDto } from '@/lib/cognitive/memories';
import type { ReconsolidationFlag } from '@/lib/cognitive/reconsolidation';
import type { ExclusionDto } from '@/lib/cognitive/exclusions';
import type { EvidenceDto } from '@/lib/cognitive/evidence';
import type { ConfidenceBand, ConfidenceFactor } from '@/lib/cognitive/confidence';

/**
 * 记忆管理那一屏：看到系统记住了什么，并逐条更正、归档、撤回、永久删除。
 *
 * 五条约束决定了这里的形状：
 * 一、一屏只有一个展开区。列表行上五个按钮——更正 / 归档 / 版本 / 证据 / 永久删除——
 *    各自打开自己的表单，同时只开一个，否则页面上会堆出好几套输入框，
 *    谁也说不清哪套是当前要提交的。
 * 二、版本链点一次往前取一版。服务端的边只回答「这一版是怎么来的」，
 *    所以全链要一格一格走，不该在这里假设链很短就一次拉完。
 * 三、归档、撤回和永久删除是三个不同强度的动作，界面上必须能看出区别：
 *    归档是任务书 7.2 的 ARCHIVE——只盖一个 archivedAt，正文、版本、证据、向量全留着，
 *    下面的「已归档」区块里随时恢复；撤回覆写的是来源标记，这一屏没有恢复的入口；
 *    永久删除是不可逆的「这条从来没存在过」。
 *    所以行上的按钮位给了归档，撤回收在它的展开区里作为一个链接——可逆的排在前面。
 * 四、永久删除过的内容会进排除表，不会被自动记回来。那张表必须看得见、撤得掉，
 *    否则就成了一条没有任何入口能解开的静默封禁——用户只会发现 AI 再也记不住某些话。
 * 五、归档也必须有回来的入口。「已归档」区块和排除表同一职责：一个动作能不能逆，
 *    看的是界面给不给逆的地方，不是服务端有没有留着那一列。
 */

interface ChainEntry {
  memory: MemoryDto;
  revisions: MemoryRevisionDto[];
}

/** 一屏只开一个展开区，所以这些形态得是一份类型：加一栏只许改一处。 */
type PanelKind = 'edit' | 'archive' | 'retract' | 'history' | 'purge' | 'evidence';

type Panel = { kind: PanelKind; id: string } | null;

/** 置信度旁表：只有档位和因子，分数不出服务端。 */
interface ConfidenceEntry {
  band: ConfidenceBand;
  factors: ConfidenceFactor[];
}

const BAND_BADGE: Record<ConfidenceBand, string> = {
  high: 'badge badge-green !px-2 !py-0.5 !text-[10.5px]',
  medium: 'chip !px-2 !py-0.5 !text-[10.5px]',
  low: 'badge badge-amber !px-2 !py-0.5 !text-[10.5px]'
};

const CONTENT_MAX = 1000;
const REASON_MAX = 500;

export function MemoryPanel() {
  const { push } = useToast();
  const { confirm } = useConfirm();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  /**
   * 「暂停长期记忆写入」（任务书 7.3）。和总开关同一个 null 口径：读不出来就显示「状态未知」，
   * 不许假装它是没暂停的——那会让用户在一次失败的读取之后以为自己还在记录。
   */
  const [paused, setPaused] = useState<boolean | null>(null);
  const [flagBusy, setFlagBusy] = useState(false);

  const [memories, setMemories] = useState<MemoryDto[]>([]);
  /** 归档的那一份（任务书 7.2）：和当前有效的那一份分开显示，恢复只有在这里才有入口。 */
  const [archived, setArchived] = useState<MemoryDto[]>([]);
  /** 两份列表各有 200 行的读取上限，到顶了得说出来（口径同时间线和洞察那屏）。 */
  const [capped, setCapped] = useState(false);
  const [archivedCapped, setArchivedCapped] = useState(false);
  const [chats, setChats] = useState<Record<string, string>>({});
  const [confidence, setConfidence] = useState<Record<string, ConfidenceEntry>>({});
  /** 再巩固标记与访问次数（任务书 7.1）：两份旁表，都不参与置信度那一份算分。 */
  const [reviews, setReviews] = useState<Record<string, ReconsolidationFlag[]>>({});
  const [access, setAccess] = useState<Record<string, number>>({});
  const [accessWindow, setAccessWindow] = useState(0);
  const [accessCapped, setAccessCapped] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceDto[]>([]);
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [exclusions, setExclusions] = useState<ExclusionDto[]>([]);
  const [exclusionsError, setExclusionsError] = useState('');
  const [removingId, setRemovingId] = useState('');

  const [panel, setPanel] = useState<Panel>(null);
  const [chain, setChain] = useState<ChainEntry[]>([]);
  const [chainBusy, setChainBusy] = useState(false);

  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState('');
  const [busyId, setBusyId] = useState('');
  /** 批量删除的忙碌标记：'all' 或 'chat:<id>'，和单条用的 busyId 分开，免得互相禁用。 */
  const [bulkBusy, setBulkBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{
        memories: MemoryDto[];
        archived: MemoryDto[];
        capped: boolean;
        archivedCapped: boolean;
        chats: Record<string, string>;
        confidence: Record<string, ConfidenceEntry>;
        reviews: Record<string, ReconsolidationFlag[]>;
        access: Record<string, number>;
        accessWindow: number;
        accessCapped: boolean;
      }>('/api/account/cognitive/memories');
      setMemories(data.memories);
      setArchived(data.archived ?? []);
      setCapped(data.capped);
      setArchivedCapped(data.archivedCapped);
      setChats(data.chats);
      setConfidence(data.confidence ?? {});
      setReviews(data.reviews ?? {});
      setAccess(data.access ?? {});
      setAccessWindow(data.accessWindow ?? 0);
      setAccessCapped(data.accessCapped === true);
      setLoadError('');
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  /** 排除表单独读：它读不出来时记忆列表照样要能看，两件事不该互相拖住。 */
  const loadExclusions = useCallback(async () => {
    try {
      const data = await apiFetch<{ exclusions: ExclusionDto[] }>('/api/account/cognitive/exclusions');
      setExclusions(data.exclusions);
      setExclusionsError('');
    } catch (err) {
      setExclusionsError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
    void loadExclusions();
    void (async () => {
      try {
        const data = await apiFetch<{ preferences: { memoryEnabled: boolean; memoryWritePaused: boolean } }>(
          '/api/account/cognitive'
        );
        setEnabled(data.preferences.memoryEnabled);
        setPaused(data.preferences.memoryWritePaused);
      } catch {
        // 开关读不到就保持 null：界面显示「状态未知」，而不是假装它是关着的。
      }
    })();
  }, [load, loadExclusions]);

  async function toggleEnabled() {
    if (enabled === null || flagBusy) return;
    setFlagBusy(true);
    try {
      const data = await apiFetch<{ preferences: { memoryEnabled: boolean; memoryWritePaused: boolean } }>(
        '/api/account/cognitive',
        { method: 'PATCH', json: { memoryEnabled: !enabled } }
      );
      setEnabled(data.preferences.memoryEnabled);
      // 两个控件读的是同一份偏好行，切完一个必须跟着另一个的最新值走，否则界面会出现
      // 「总开关已关闭 + 暂停已恢复」这种库里并不存在的组合。
      setPaused(data.preferences.memoryWritePaused);
      push(data.preferences.memoryEnabled ? '长期记忆已打开' : '长期记忆已关闭');
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setFlagBusy(false);
    }
  }

  /**
   * 暂停长期记忆写入（任务书 7.3 的第五臂）。它和上面那个总开关不是一件事，所以分开摆：
   * 关掉总开关是「这个模块不工作」——读侧也不再注入；暂停写入是「还记不记新东西」——
   * 已记住的照常带入对话。这句差别必须出现在反馈里，不然用户只能靠猜。
   */
  async function togglePaused() {
    if (paused === null || flagBusy) return;
    setFlagBusy(true);
    try {
      const data = await apiFetch<{ preferences: { memoryEnabled: boolean; memoryWritePaused: boolean } }>(
        '/api/account/cognitive',
        { method: 'PATCH', json: { memoryWritePaused: !paused } }
      );
      setEnabled(data.preferences.memoryEnabled);
      setPaused(data.preferences.memoryWritePaused);
      push(data.preferences.memoryWritePaused ? '已暂停新的记忆写入，已记住的内容照常带入对话' : '已恢复新的记忆写入');
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setFlagBusy(false);
    }
  }

  function close() {
    setPanel(null);
    setChain([]);
    setEvidence([]);
    setDraft('');
    setReason('');
    setFormError('');
  }

  /** 再点同一个按钮收起；点别的按钮就换到那一栏——同时只有一个展开区。 */
  function reopen(kind: PanelKind, memory: MemoryDto) {
    if (panel && panel.kind === kind && panel.id === memory.id) {
      close();
      return false;
    }
    close();
    setPanel({ kind, id: memory.id });
    return true;
  }

  async function openHistory(memory: MemoryDto) {
    if (!reopen('history', memory)) return;
    setChainBusy(true);
    try {
      const data = await apiFetch<ChainEntry>(`/api/account/cognitive/memories/${encodeURIComponent(memory.id)}`);
      setChain([data]);
    } catch (err) {
      push(errorMessage(err), 'error');
      setPanel(null);
    } finally {
      setChainBusy(false);
    }
  }

  /** 证据和版本链一样，点一次取一条记忆的：说明文字是密文，不该为没人看的行白解一遍。 */
  async function openEvidence(memory: MemoryDto) {
    if (!reopen('evidence', memory)) return;
    setEvidenceBusy(true);
    try {
      const data = await apiFetch<{ evidence: EvidenceDto[] }>(
        `/api/account/cognitive/memories/${encodeURIComponent(memory.id)}/evidence`
      );
      setEvidence(data.evidence);
    } catch (err) {
      push(errorMessage(err), 'error');
      setPanel(null);
    } finally {
      setEvidenceBusy(false);
    }
  }

  async function loadPrevious(entry: ChainEntry) {
    const previousId = entry.revisions.find((edge) => edge.previousId)?.previousId;
    if (!previousId) return;
    setChainBusy(true);
    try {
      const data = await apiFetch<ChainEntry>(
        `/api/account/cognitive/memories/${encodeURIComponent(previousId)}`
      );
      setChain((current) => [...current, data]);
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setChainBusy(false);
    }
  }

  function startEdit(memory: MemoryDto) {
    if (!reopen('edit', memory)) return;
    setDraft(memory.content);
  }

  async function submitEdit(memory: MemoryDto) {
    if (!draft.trim()) {
      setFormError('记忆正文不能为空');
      return;
    }
    if (!reason.trim()) {
      setFormError('改记忆要写明理由');
      return;
    }
    setBusyId(memory.id);
    try {
      await apiFetch(`/api/account/cognitive/memories/${encodeURIComponent(memory.id)}`, {
        method: 'PATCH',
        json: { content: draft, reason }
      });
      push('已按新说法更新，旧版本仍保留');
      close();
      await load();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusyId('');
    }
  }

  /** 归档不要理由：它是「先收起来」，不是「这条说错了」——要写理由的那两个是更正和撤回。 */
  async function submitArchive(memory: MemoryDto) {
    setBusyId(memory.id);
    try {
      await apiFetch(`/api/account/cognitive/memories/${encodeURIComponent(memory.id)}/archive`, {
        method: 'POST'
      });
      push('已归档，这条不再进入对话');
      close();
      await load();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusyId('');
    }
  }

  /** 恢复只清 archivedAt 这一列，回来的正是当初收起来的那一条。 */
  async function submitRestore(memory: MemoryDto) {
    if (busyId) return;
    setBusyId(memory.id);
    try {
      await apiFetch(`/api/account/cognitive/memories/${encodeURIComponent(memory.id)}/restore`, {
        method: 'POST'
      });
      push('已恢复，这条重新作为当前有效记忆');
      await load();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setBusyId('');
    }
  }

  async function submitRetract(memory: MemoryDto) {
    if (!reason.trim()) {
      setFormError('撤回记忆要写明理由');
      return;
    }
    setBusyId(memory.id);
    try {
      await apiFetch(`/api/account/cognitive/memories/${encodeURIComponent(memory.id)}/retract`, {
        method: 'POST',
        json: { reason }
      });
      push('已撤回，这条不再用于对话');
      close();
      await load();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusyId('');
    }
  }

  /** 永久删除一条。不可逆，所以走的是行内展开区 + 明说不可恢复，不给「一键删掉」的顺手路径。 */
  async function submitPurge(memory: MemoryDto) {
    setBusyId(memory.id);
    try {
      await apiFetch(`/api/account/cognitive/memories/${encodeURIComponent(memory.id)}`, { method: 'DELETE' });
      push('已永久删除');
      close();
      await Promise.all([load(), loadExclusions()]);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusyId('');
    }
  }

  /**
   * 忘记某次对话产生的全部记忆，对话本身保留。
   * 确认框里不报条数：列表只有当前有效的那些，被取代过的和已撤回的行也在删除范围内，
   * 客户端数出来的数字会偏小——不可逆的操作宁可少说，等删完再报服务端返回的真实条数。
   */
  async function purgeByChat(memory: MemoryDto) {
    const chatId = memory.chatId;
    if (!chatId || bulkBusy) return;
    const ok = await confirm({
      title: '忘记这次对话产生的记忆？',
      description: '这次对话产生的记忆会一起删掉，不可恢复。对话本身保留。',
      confirmText: '删除记忆',
      tone: 'danger'
    });
    if (!ok) return;
    setBulkBusy(`chat:${chatId}`);
    try {
      const data = await apiFetch<{ purged: number }>(
        `/api/account/cognitive/memories?scope=chat&chatId=${encodeURIComponent(chatId)}`,
        { method: 'DELETE' }
      );
      push(`已删除 ${data.purged} 条记忆`);
      close();
      await Promise.all([load(), loadExclusions()]);
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setBulkBusy('');
    }
  }

  /**
   * 忘记某个主题（任务书 7.3 的第二臂）。「主题」就是这一行上那枚情境标签，七个值之一——
   * 界面不拿一个用户现编的词当范围，因为库里就没有那一列。
   *
   * 确认框里那三句各守一条边界，少一句就是撒谎：
   * 一、原对话保留。三条批量删除都不碰会话，但这一臂最容易被人读成「把这个话题整个抹掉」，
   *    所以这一句不能省（任务书：「用户仅要求忘记记忆时，不得擅自删除原会话」）。
   * 二、决策记录不在范围内。按会话那一臂会顺带清掉那一次对话关联的决策，这一臂不会——
   *    决策行既没有情境也没有来源会话列，够不着「某个主题」。
   * 三、删完之后同一个主题的新说法还会照常记下来。删除建的是「原句排除」，挡的是逐字重复；
   *    同义改写归「记忆策略」那一层管，那是要用户另外确认的另一个动作，不许藏在删除里顺手改掉。
   *
   * 和按会话那一路一样，确认框不报条数：客户端只看得见当前有效的那几十条，
   * 被取代过的和已撤回的行也在删除范围内，数出来的数字会偏小。
   */
  async function purgeByContext(memory: MemoryDto) {
    if (bulkBusy) return;
    const context = memory.context;
    const ok = await confirm({
      title: `忘记「${CONTEXT_LABELS[context]}」这个主题的全部记忆？`,
      description:
        '这个主题下记住的内容会一起删掉，不可恢复。对话本身保留，其它主题和决策记录都不动。同一个主题的新说法还会照常记下来；要让它不再记，去「记忆策略」里关掉这个主题的写入。',
      confirmText: '删除记忆',
      tone: 'danger'
    });
    if (!ok) return;
    setBulkBusy(`context:${context}`);
    try {
      const data = await apiFetch<{ purged: number }>(
        `/api/account/cognitive/memories?scope=context&context=${encodeURIComponent(context)}`,
        { method: 'DELETE' }
      );
      push(`已删除 ${data.purged} 条记忆`);
      close();
      // 排除表跟着重读：这一臂顺手建起来的原句排除，不刷新就等于没告诉用户它生效了。
      await Promise.all([load(), loadExclusions()]);
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setBulkBusy('');
    }
  }

  async function purgeAll() {
    if (bulkBusy) return;
    const ok = await confirm({
      title: '清空全部长期记忆？',
      description: '删掉系统记住的所有内容，不可恢复。对话记录、附件和账号都不动。',
      confirmText: '清空',
      tone: 'danger'
    });
    if (!ok) return;
    setBulkBusy('all');
    try {
      const data = await apiFetch<{ purged: number }>('/api/account/cognitive/memories?scope=all', {
        method: 'DELETE'
      });
      push(`已清空 ${data.purged} 条记忆`);
      close();
      await load();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setBulkBusy('');
    }
  }

  async function cancelExclusion(id: string) {
    if (removingId) return;
    setRemovingId(id);
    try {
      await apiFetch(`/api/account/cognitive/exclusions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      push('已撤销，之后可以重新记住');
      await loadExclusions();
    } catch (err) {
      push(errorMessage(err), 'error');
    } finally {
      setRemovingId('');
    }
  }

  // 两份列表各自的上限说明：没到上限就是空串，界面据此一个字都不摆。
  const capNote = describeMemoryListCap(capped, memories.length);
  const archivedCapNote = describeArchivedListCap(archivedCapped, archived.length);
  // 访问窗口截断了也要说：不然「最近 200 轮」听起来像全部历史。
  const accessCapNote = describeAccessCap(accessCapped, accessWindow);

  return (
    <section className="panel p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold text-white">长期记忆</h2>
          <p className="mt-1 text-[12.5px] text-white/40">
            下面是系统关于你记住的内容。更正会留下旧版本，归档随时可以恢复；永久删除不可恢复。
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-[13px] text-white/70">
          <input
            type="checkbox"
            checked={enabled === true}
            disabled={enabled === null || flagBusy}
            onChange={toggleEnabled}
            className="accent-emerald-400"
          />
          {enabled === null ? '开关状态未知' : enabled ? '已打开' : '已关闭'}
        </label>
      </div>
      {enabled === true ? (
        <label className="mt-3 flex items-center gap-2 text-[12.5px] text-white/55">
          <input
            type="checkbox"
            checked={paused === true}
            disabled={paused === null || flagBusy}
            onChange={togglePaused}
            className="accent-emerald-400"
          />
          {/*
            这一行只在总开关真开着时才摆出来：关着的模块本来就不写，再挂一个「暂停」就是假交互。
            三个状态都得说得出话——未知时不许假装没暂停，那会让一次失败的读取变成一句假承诺。
          */}
          {paused === null
            ? '暂停长期记忆写入（状态未知）'
            : paused
              ? '暂停长期记忆写入：已暂停'
              : '暂停长期记忆写入'}
        </label>
      ) : null}
      {enabled === false ? (
        <Alert tone="info" className="mt-4">
          关闭只停止新的读写，已存下的记忆仍在下面这份列表里。要逐条停掉，用「归档」。
        </Alert>
      ) : null}

      {/*
        待确认那块排在记忆列表**上面**，也不跟着总开关消失：那些句子是没答过的原话，
        关掉长期记忆之后用户更需要一个地方把它们答掉（口径同 `candidates/route.ts` 头上的裁决）。
      */}
      <MemoryCandidatesPanel onConfirmed={() => void load()} />

      {/*
        「没记上的句子」排在待确认下面、记忆列表上面，同样不跟着总开关消失（任务书 §6 要求④）。
        它读的是后台欠账表的调度列，一行记忆都不解密，所以这一屏没有闸门可问。
      */}
      <FailedTasksPanel />

      <div className="mt-5 space-y-2.5">
        {loadError ? <Alert tone="error">{loadError}</Alert> : null}
        {capNote ? <Alert tone="info">{capNote}</Alert> : null}
      {accessCapNote ? <Alert tone="info">{accessCapNote}</Alert> : null}
        {loading ? (
          <LoadingBlock label="加载记忆" />
        ) : memories.length === 0 ? (
          <EmptyState
            icon={<Brain className="h-5 w-5" />}
            title="还没有记住的内容"
            description="打开长期记忆后，你在对话里明确说过的信息会出现在这里。"
          />
        ) : (
          memories.map((memory) => {
            const isEdit = panel?.kind === 'edit' && panel.id === memory.id;
            const isArchive = panel?.kind === 'archive' && panel.id === memory.id;
            const isRetract = panel?.kind === 'retract' && panel.id === memory.id;
            const isHistory = panel?.kind === 'history' && panel.id === memory.id;
            const isPurge = panel?.kind === 'purge' && panel.id === memory.id;
            const isEvidence = panel?.kind === 'evidence' && panel.id === memory.id;
            const band = confidence[memory.id]?.band;
            // 再巩固标记和访问次数：服务端没给条目就是「没算过 / 没带过」，界面不许自己补。
            const flags = reviews[memory.id] ?? [];
            const count = access[memory.id];
            const chatPurgeBusy = bulkBusy === `chat:${memory.chatId}`;
            const contextPurgeBusy = bulkBusy === `context:${memory.context}`;
            return (
              <div key={memory.id} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-white/85">
                      {memory.content}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <span className="chip !px-2 !py-0.5 !text-[10.5px]">{TYPE_LABELS[memory.type]}</span>
                      <span className="chip !px-2 !py-0.5 !text-[10.5px]">{CONTEXT_LABELS[memory.context]}</span>
                      <span
                        className={
                          memory.origin === 'inferred' || memory.origin === 'hypothesis'
                            ? 'badge badge-amber !px-2 !py-0.5 !text-[10.5px]'
                            : 'chip !px-2 !py-0.5 !text-[10.5px]'
                        }
                      >
                        {ORIGIN_LABELS[memory.origin]}
                      </span>
                      {/* 抽取器存的都是「时间未知」，每条都挂这个标签就成了噪音；只在真有时间信息时显示。 */}
                      {memory.precision !== 'unknown' && memory.validFrom ? (
                        <span className="chip !px-2 !py-0.5 !text-[10.5px]">{describeValidRange(memory)}</span>
                      ) : null}
                      {memory.version > 1 ? (
                        <span className="chip !px-2 !py-0.5 !text-[10.5px]">第 {memory.version} 版</span>
                      ) : null}
                      {/* 算不出档位就不挂标签：这张表是后加的，老记忆可能还没有账可查。 */}
                      {band ? (
                        <span className={BAND_BADGE[band]}>{CONFIDENCE_BAND_LABELS[band]}</span>
                      ) : null}
                      {/*
                        再巩固标记（任务书 7.1）用中性的 chip，不给琥珀色徽章：
                        这三条只回答「凭据变了，值得回看一眼」，不是「这条有问题」。
                        真过期的那条，档位自己会掉到「可信度低」，颜色在那儿已经说过了。
                      */}
                      {flags.length > 0
                        ? flags.map((flag) => (
                            <span key={flag} className="chip !px-2 !py-0.5 !text-[10.5px]">
                              {RECONSOLIDATION_LABELS[flag]}
                            </span>
                          ))
                        : null}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-white/30">
                      <span>记于 {timeAgo(memory.recordedAt)}</span>
                      {/* 只有被带进过提示词的才报次数：没有条目就是「这些轮里没带过」，不摆一个 0。 */}
                      {count !== undefined ? <span>{describeAccessCount(accessWindow, count)}</span> : null}
                      {memory.chatId ? (
                        chats[memory.chatId] ? (
                          <Link
                            href={`/chat/${encodeURIComponent(memory.chatId)}`}
                            className="inline-block max-w-[260px] truncate align-bottom text-white/45 underline-offset-2 hover:text-white/80 hover:underline"
                          >
                            来自：{chats[memory.chatId]}
                          </Link>
                        ) : (
                          <span>来自：原对话已删除</span>
                        )
                      ) : null}
                      {/* 原对话已经不在了就不给这个入口：确认文案说「对话本身保留」，那时会是假话。 */}
                      {memory.chatId && chats[memory.chatId] ? (
                        <button
                          type="button"
                          className="text-white/35 underline-offset-2 hover:text-red-300 hover:underline disabled:cursor-not-allowed disabled:opacity-45"
                          disabled={Boolean(bulkBusy)}
                          onClick={() => void purgeByChat(memory)}
                        >
                          {chatPurgeBusy ? '删除中…' : '忘记这次对话产生的记忆'}
                        </button>
                      ) : null}
                      {/*
                        「忘记这个主题」和上面那句不是一件事，所以两个入口都摆着：
                        按会话删的是「那一次说过的」，按主题删的是「这一类说过的」，
                        一条记忆同时落在两个范围里，删完另一个还剩。
                        这一臂不需要原对话在场，所以它挂在每一行上，不受 chats[memory.chatId] 限制。
                      */}
                      <button
                        type="button"
                        className="text-white/35 underline-offset-2 hover:text-red-300 hover:underline disabled:cursor-not-allowed disabled:opacity-45"
                        disabled={Boolean(bulkBusy)}
                        onClick={() => void purgeByContext(memory)}
                      >
                        {contextPurgeBusy ? '删除中…' : '忘记这个主题'}
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                      onClick={() => startEdit(memory)}
                    >
                      <Pencil className="h-3.5 w-3.5" /> 更正
                    </button>
                    <button
                      type="button"
                      className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                      onClick={() => reopen('archive', memory)}
                    >
                      <Archive className="h-3.5 w-3.5" /> 归档
                    </button>
                    <button
                      type="button"
                      className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                      onClick={() => void openHistory(memory)}
                    >
                      <History className="h-3.5 w-3.5" /> 版本
                    </button>
                    <button
                      type="button"
                      className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                      onClick={() => void openEvidence(memory)}
                    >
                      <Scale className="h-3.5 w-3.5" /> 证据
                    </button>
                    <button
                      type="button"
                      className="btn-ghost !px-2.5 !py-1.5 !text-[12px] hover:text-red-300"
                      onClick={() => reopen('purge', memory)}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> 永久删除
                    </button>
                  </div>
                </div>

                {isEdit ? (
                  <div className="mt-3 space-y-2.5 border-t border-white/[0.06] pt-3">
                    <div>
                      <label className="label">新的说法</label>
                      <textarea
                        className="field min-h-[88px]"
                        maxLength={CONTENT_MAX}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="label">为什么改</label>
                      <input
                        className="field"
                        maxLength={REASON_MAX}
                        placeholder="例如：项目已经换到 PostgreSQL"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </div>
                    {formError ? <Alert tone="error">{formError}</Alert> : null}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn-primary !px-3 !py-1.5 !text-[12px]"
                        disabled={busyId === memory.id}
                        onClick={() => void submitEdit(memory)}
                      >
                        {busyId === memory.id ? <Spinner /> : null} 保存新版本
                      </button>
                      <button type="button" className="btn-ghost !px-3 !py-1.5 !text-[12px]" onClick={close}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : null}

                {isArchive ? (
                  <div className="mt-3 space-y-2.5 border-t border-white/[0.06] pt-3">
                    <div className="text-[12.5px] font-medium text-white/70">把这条收起来？</div>
                    <p className="text-[11.5px] leading-relaxed text-white/35">
                      收起后这条不再进入对话，也不会再被当作洞察的证据。正文和版本都留着，随时可以恢复。
                    </p>
                    <button
                      type="button"
                      className="block text-[11.5px] text-white/35 underline-offset-2 hover:text-white/60 hover:underline"
                      onClick={() => reopen('retract', memory)}
                    >
                      撤回这条（写明理由，这一屏没有恢复入口）
                    </button>
                    {formError ? <Alert tone="error">{formError}</Alert> : null}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn-primary !px-3 !py-1.5 !text-[12px]"
                        disabled={busyId === memory.id}
                        onClick={() => void submitArchive(memory)}
                      >
                        {busyId === memory.id ? <Spinner /> : <Archive className="h-3.5 w-3.5" />} 确认归档
                      </button>
                      <button type="button" className="btn-ghost !px-3 !py-1.5 !text-[12px]" onClick={close}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : null}

                {isRetract ? (
                  <div className="mt-3 space-y-2.5 border-t border-white/[0.06] pt-3">
                    <div>
                      <label className="label">撤回理由</label>
                      <input
                        className="field"
                        maxLength={REASON_MAX}
                        placeholder="例如：这已经不是我的情况"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </div>
                    <p className="text-[11.5px] text-white/35">撤回后这条不再进入对话，也不会再被更新。</p>
                    {formError ? <Alert tone="error">{formError}</Alert> : null}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn-danger !px-3 !py-1.5 !text-[12px]"
                        disabled={busyId === memory.id}
                        onClick={() => void submitRetract(memory)}
                      >
                        {busyId === memory.id ? <Spinner /> : <X className="h-3.5 w-3.5" />} 确认撤回
                      </button>
                      <button type="button" className="btn-ghost !px-3 !py-1.5 !text-[12px]" onClick={close}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : null}

                {isHistory ? (
                  <div className="mt-3 space-y-3 border-t border-white/[0.06] pt-3">
                    {chainBusy && chain.length === 0 ? <LoadingBlock label="加载版本链" /> : null}
                    {chain.map((entry, index) => {
                      const previousId = entry.revisions.find((edge) => edge.previousId)?.previousId;
                      return (
                        <div key={entry.memory.id} className="space-y-1.5">
                          <div className="text-[11.5px] text-white/35">
                            第 {entry.memory.version} 版 · {timeAgo(entry.memory.recordedAt)}
                            {index === 0 ? '' : ' · 已被取代'}
                          </div>
                          <div className="whitespace-pre-wrap break-words text-[13px] text-white/70">
                            {entry.memory.content}
                          </div>
                          {entry.revisions.map((revision) => (
                            <div key={revision.id} className="text-[11.5px] text-white/40">
                              {REVISION_ACTION_LABELS[revision.action]}：{revision.reason} ·{' '}
                              {timeAgo(revision.createdAt)}
                            </div>
                          ))}
                          {previousId ? (
                            <button
                              type="button"
                              className="btn-ghost !px-2.5 !py-1 !text-[12px]"
                              disabled={chainBusy}
                              onClick={() => void loadPrevious(entry)}
                            >
                              {chainBusy ? <Spinner /> : null} 上一版
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {isEvidence ? (
                  <div className="mt-3 space-y-2.5 border-t border-white/[0.06] pt-3">
                    <div className="text-[12.5px] font-medium text-white/70">支持与反对的证据</div>
                    <p className="text-[11.5px] text-white/35">
                      证据只回答「这条记忆凭什么在这里」，不改变它的内容。
                    </p>
                    {(confidence[memory.id]?.factors ?? []).length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {(confidence[memory.id]?.factors ?? []).map((factor, index) => (
                          <span key={index} className="chip !px-2 !py-0.5 !text-[10.5px]">
                            {describeConfidenceFactor(factor)}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {evidenceBusy ? (
                      <LoadingBlock label="加载证据" />
                    ) : evidence.length === 0 ? (
                      <p className="text-[12px] text-white/40">
                        没有额外证据：这条记忆只有它自己那一次陈述。
                      </p>
                    ) : (
                      <ul className="space-y-1.5">
                        {evidence.map((entry) => (
                          <li key={entry.id} className="text-[11.5px] text-white/45">
                            {entry.kind === 'supports' ? '支持' : '反对'} ·{' '}
                            {describeConfidenceFactor({ kind: 'origin', origin: entry.origin })} ·{' '}
                            {timeAgo(entry.createdAt)}
                            {entry.note ? <span className="block text-white/35">{entry.note}</span> : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}

                {isPurge ? (
                  <div className="mt-3 space-y-2.5 border-t border-white/[0.06] pt-3">
                    <p className="text-[12.5px] leading-relaxed text-white/60">
                      这条记忆和它的历史版本会一起从数据库里删掉，不可恢复。原对话记录不动。
                    </p>
                    {formError ? <Alert tone="error">{formError}</Alert> : null}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn-danger !px-3 !py-1.5 !text-[12px]"
                        disabled={busyId === memory.id}
                        onClick={() => void submitPurge(memory)}
                      >
                        {busyId === memory.id ? <Spinner /> : <Trash2 className="h-3.5 w-3.5" />} 确认永久删除
                      </button>
                      <button type="button" className="btn-ghost !px-3 !py-1.5 !text-[12px]" onClick={close}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {/* 没有归档过就整块不渲染：一段「已归档」的空标题只会让人以为系统收起了什么自己看不到的东西。 */}
      {archived.length > 0 ? (
        <div className="mt-6 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
          <h3 className="text-[13.5px] font-medium text-white/85">已归档</h3>
          <p className="mt-1 text-[11.5px] leading-relaxed text-white/40">
            这些内容不参与对话，也不会被当作洞察的证据。要重新使用，点「恢复」。
          </p>
          {archivedCapNote ? <Alert tone="info" className="mt-2">{archivedCapNote}</Alert> : null}
          <ul className="mt-3 space-y-2.5">
            {archived.map((memory) => (
              <li key={memory.id} className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-[12.5px] text-white/70">{memory.content}</span>
                  <span className="mt-0.5 block text-[11px] text-white/30">
                    已归档 · 记于 {timeAgo(memory.recordedAt)}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn-ghost shrink-0 !px-2.5 !py-1 !text-[12px]"
                  disabled={Boolean(busyId)}
                  onClick={() => void submitRestore(memory)}
                >
                  {busyId === memory.id ? <Spinner /> : <ArchiveRestore className="h-3.5 w-3.5" />} 恢复
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 空表时整块不渲染：没有排除项却摆一段解释，只会让人以为系统在瞒着什么。 */}
      {exclusions.length > 0 ? (
        <div className="mt-6 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
          <h3 className="text-[13.5px] font-medium text-white/85">不再自动记住的内容</h3>
          <p className="mt-1 text-[11.5px] leading-relaxed text-white/40">
            你永久删除过的内容不会被自动记回来。要允许它重新被记住，点「撤销」。
          </p>
          {exclusionsError ? (
            <Alert tone="error" className="mt-3">
              {exclusionsError}
            </Alert>
          ) : null}
          <ul className="mt-3 space-y-2.5">
            {exclusions.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-[12.5px] text-white/70">{entry.content}</span>
                  <span className="mt-0.5 block text-[11px] text-white/30">排除于 {timeAgo(entry.createdAt)}</span>
                </span>
                <button
                  type="button"
                  className="btn-ghost shrink-0 !px-2.5 !py-1 !text-[12px]"
                  disabled={removingId === entry.id}
                  onClick={() => void cancelExclusion(entry.id)}
                >
                  {removingId === entry.id ? <Spinner /> : null} 撤销
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 一条记忆都没有时不放这个按钮：一个「清空全部」的空控件只会让人怀疑它到底删了什么。 */}
      {memories.length > 0 ? (
        <div className="mt-6 rounded-xl border border-red-400/20 bg-red-400/[0.04] p-4">
          <h3 className="text-[13.5px] font-medium text-red-200">清空全部长期记忆</h3>
          <p className="mt-1 text-[11.5px] leading-relaxed text-white/40">
            删掉系统记住的所有内容，不可恢复。对话记录、附件和账号都不动。
          </p>
          <button
            type="button"
            className="btn-danger !mt-3 !px-3 !py-1.5 !text-[12px]"
            disabled={Boolean(bulkBusy)}
            onClick={() => void purgeAll()}
          >
            {bulkBusy === 'all' ? <Spinner /> : <Trash2 className="h-3.5 w-3.5" />} 清空全部长期记忆
          </button>
        </div>
      ) : null}
    </section>
  );
}
