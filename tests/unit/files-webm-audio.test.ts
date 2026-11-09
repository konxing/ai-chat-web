import { describe, expect, it, vi } from 'vitest';

// MediaRecorder 纯音频 WebM 与视频同容器，file-type 嗅探为 video/webm。
vi.mock('file-type', () => ({
  fileTypeFromBuffer: vi.fn(async () => ({ mime: 'video/webm', ext: 'webm' }))
}));
vi.mock('@/lib/config', () => ({
  getSystemSettings: async () => ({ maxUploadMB: 300 })
}));

import { inspectUpload } from '@/lib/files';

const buf = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x01]);

describe('语音 WebM 类型嗅探豁免（修复语音输入被拒）', () => {
  it('嗅探 video/webm + 声明 audio/webm + .webm → 按 AUDIO 处理', async () => {
    const r = await inspectUpload({ buffer: buf, filename: 'voice-1.webm', declaredMime: 'audio/webm' });
    expect(r.kind).toBe('AUDIO');
    expect(r.mime).toBe('audio/webm');
  });

  it('声明为视频的 webm 仍被拒绝（不会把视频当音频）', async () => {
    await expect(
      inspectUpload({ buffer: buf, filename: 'clip.webm', declaredMime: 'video/webm' })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
  });

  it('非 webm 扩展名不豁免', async () => {
    await expect(
      inspectUpload({ buffer: buf, filename: 'voice.bin', declaredMime: 'audio/webm' })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
  });
});