import { CHAT_STICKERS, isChatSticker, type ChatSticker } from './chat-stickers';

const PREFIX = '[[STICKER:';
const SUFFIX = ']]';
const CATALOG = Object.entries(CHAT_STICKERS).map(([id, { alt }]) => `${id}=${alt}`).join('，');

export function stickerReplyPrompt(inCooldown: boolean): string {
  return [
    '【表情包】AI Chat 可以随回复发送本地表情包。由你根据当前对话、角色和你刚写完的回复决定要不要发，以及选哪张。',
    '默认只回文字。偶尔在确实值得庆祝、自然接梗等时刻，选一张能接住语气的图。严肃话题和对方不想要时只回文字。',
    '用户用日常说法请你发图时也可以选一张合适的；点名了就尽量匹配。直接接话，不必解释图片发送能力，不用颜文字或链接代替贴纸。',
    inCooldown ? '最近已经发过一张。除非用户本轮确实在请求表情包，否则这轮省略标记。' : '',
    '要发就在整条回复末尾另起一行追加 [[STICKER:auto:编号]]；如果是回应用户本轮的明确请求，用 [[STICKER:requested:编号]]。只选一个编号。网站会隐藏标记并显示图片。不发就省略整行。',
    CATALOG
  ].filter(Boolean).join('\n');
}

/** Keep only possible control markers buffered; ordinary text can stream immediately. */
export class StickerReply {
  private pending = '';
  private sticker?: ChatSticker;
  private markerCount = 0;

  constructor(private readonly inCooldown: boolean) {}

  push(chunk: string): string {
    this.pending += chunk;
    let visible = '';
    while (this.pending) {
      const start = this.pending.indexOf(PREFIX);
      if (start < 0) {
        let hold = Math.min(this.pending.length, PREFIX.length - 1);
        while (hold > 0 && !PREFIX.startsWith(this.pending.slice(-hold))) hold--;
        const end = this.pending.length - hold;
        visible += this.emit(this.pending.slice(0, end));
        this.pending = this.pending.slice(end);
        break;
      }

      visible += this.emit(this.pending.slice(0, start));
      this.pending = this.pending.slice(start);
      const end = this.pending.indexOf(SUFFIX, PREFIX.length);
      const newline = this.pending.indexOf('\n', PREFIX.length);
      if (newline >= 0 && (end < 0 || newline < end)) {
        this.markerCount++;
        this.sticker = undefined;
        this.pending = this.pending.slice(newline);
        continue;
      }
      if (end < 0) {
        if (this.pending.length > 64) {
          this.markerCount++;
          this.sticker = undefined;
          this.pending = PREFIX;
        }
        break;
      }

      const match = /^(auto|requested):([a-zA-Z0-9]+)$/.exec(this.pending.slice(PREFIX.length, end));
      this.markerCount++;
      const id = match?.[2];
      if (this.markerCount === 1 && isChatSticker(id) && (!this.inCooldown || match?.[1] === 'requested')) {
        this.sticker = id;
      } else {
        this.sticker = undefined;
      }
      this.pending = this.pending.slice(end + SUFFIX.length);
    }
    return visible;
  }

  finish(): { text: string; sticker?: ChatSticker } {
    const incomplete = this.pending.startsWith('[[S');
    if (incomplete) this.sticker = undefined;
    const text = incomplete ? '' : this.emit(this.pending);
    this.pending = '';
    return { text, sticker: this.sticker };
  }

  private emit(text: string): string {
    if (text.trim()) this.sticker = undefined;
    return text;
  }
}
