import { MAX_REPLY_SEGMENTS } from './reply-presentation';

export const REPLY_BREAK_LINE = '[[MESSAGE_BREAK]]';
const BREAK = `\n${REPLY_BREAK_LINE}\n`;

type ReplyTextEvent = { type: 'delta'; text: string } | { type: 'segment' };

/** Decode model-requested bubble boundaries without delaying ordinary deltas. */
export class DialogueReplyText {
  private pending = '';
  private splitPending = false;
  content = '';
  readonly segmentOffsets: number[] = [];

  constructor(private readonly enabled: boolean, private readonly send: (event: ReplyTextEvent) => void) {}

  push(text: string) {
    this.pending += text;
    let index: number;
    while ((index = this.pending.indexOf(BREAK)) !== -1) {
      this.append(this.pending.slice(0, index));
      // Leave the closing newline available as the prefix of a following marker.
      this.pending = this.pending.slice(index + BREAK.length - 1);
      const lastOffset = this.segmentOffsets.at(-1) ?? 0;
      if (!this.content.slice(lastOffset).trim()) continue;
      if (this.enabled && this.segmentOffsets.length + 1 < MAX_REPLY_SEGMENTS) {
        this.splitPending = true;
      } else {
        this.append('\n');
      }
    }
    let hold = Math.min(this.pending.length, BREAK.length - 1);
    while (hold && !BREAK.startsWith(this.pending.slice(-hold))) hold--;
    this.append(this.pending.slice(0, this.pending.length - hold));
    this.pending = this.pending.slice(this.pending.length - hold);
  }

  finish() {
    // A line containing only a trailing boundary does not make an empty bubble.
    if (!this.pending.startsWith('\n[[MESSAGE_')) this.append(this.pending);
    this.pending = '';
    this.splitPending = false;
  }

  append(text: string) {
    if (!text) return;
    if (this.splitPending) {
      if (!text.trim()) return;
      this.splitPending = false;
      this.content += '\n\n';
      this.segmentOffsets.push(this.content.length);
      this.send({ type: 'segment' });
    }
    this.content += text;
    this.send({ type: 'delta', text });
  }
}
