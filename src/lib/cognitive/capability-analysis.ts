import { prisma } from '@/lib/prisma';
import { requireDimension } from './capabilities';
import { decryptString } from '@/lib/crypto';
import { cognitiveColumnAad } from './encrypted-columns';

/** Scores are optional observations on a user-chosen 0..1 scale, not psychometric diagnoses. */
export interface CapabilityAnalysis {
  dimensionId: string;
  sampleCount: number;
  estimate: number | null;
  confidence: number;
  trend: number | null;
  evidenceCount: number;
  insufficientEvidence: boolean;
  disclaimer: string;
}
const MIN_SCORED_SAMPLES = 3;
const DISCLAIMER = '仅根据用户主动记录的任务结果估计；不代表人格、智力或临床评估。';

export function summarizeCapabilityScores(
  dimensionId: string,
  samples: readonly { kind: string; score: number | null; observedAt: Date }[]
): CapabilityAnalysis {
  const valid = samples
    .filter((row) => row.kind === 'TASK_RESULT' && row.score !== null && Number.isFinite(row.score) &&
      row.score! >= 0 && row.score! <= 1)
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const n = valid.length;
  if (n < MIN_SCORED_SAMPLES) return {
    dimensionId, sampleCount: n, estimate: null, confidence: 0,
    trend: null, evidenceCount: samples.length, insufficientEvidence: true, disclaimer: DISCLAIMER
  };
  const mean = (values: readonly { score: number | null }[]) =>
    values.reduce((sum, item) => sum + item.score!, 0) / values.length;
  const estimate = mean(valid);
  const split = Math.floor(n / 2);
  const trend = n >= 6 ? mean(valid.slice(split)) - mean(valid.slice(0, split)) : null;
  // Confidence is a sample-quantity indicator, not statistical confidence of a skill estimate.
  const confidence = Math.min(0.9, n / 20);
  return {
    dimensionId, sampleCount: n, estimate: Math.round(estimate * 1000) / 1000,
    confidence: Math.round(confidence * 100) / 100,
    trend: trend === null ? null : Math.round(trend * 1000) / 1000,
    evidenceCount: samples.length, insufficientEvidence: false, disclaimer: DISCLAIMER
  };
}

export async function analyzeCapability(userId: string, dimensionId: string): Promise<CapabilityAnalysis> {
  await requireDimension(userId, dimensionId);
  const rows = await prisma.capabilityEvidence.findMany({
    where: { userId, dimensionId }, orderBy: { observedAt: 'desc' }, take: 200,
    select: { kind: true, score: true, observedAt: true }
  });
  return summarizeCapabilityScores(dimensionId, rows);
}

/** Snapshots are created only on the user's explicit request. Never invent a score. */
export async function saveCapabilitySnapshot(userId: string, dimensionId: string) {
  const analysis = await analyzeCapability(userId, dimensionId);
  const row = await prisma.capabilitySnapshot.create({
    data: {
      userId, dimensionId, estimate: analysis.estimate,
      confidence: analysis.confidence, sampleCount: analysis.sampleCount, trend: analysis.trend
    }
  });
  return { ...analysis, snapshotId: row.id, calculatedAt: row.calculatedAt.toISOString() };
}

/** Source excerpts are decrypted only for an explicitly initiated suggestion request. */
export async function readCapabilitySuggestionContext(userId: string, dimensionId: string) {
  const dimension = await requireDimension(userId, dimensionId);
  if (!dimension.enabled) return null;
  const analysis = await analyzeCapability(userId, dimensionId);
  const title = decryptString(dimension.titleCiphertext,
    cognitiveColumnAad('CapabilityDimension', 'titleCiphertext', userId, dimensionId));
  const goal = dimension.goalCiphertext
    ? decryptString(dimension.goalCiphertext,
      cognitiveColumnAad('CapabilityDimension', 'goalCiphertext', userId, dimensionId)) : null;
  const evidence = await prisma.capabilityEvidence.findMany({
    where: { userId, dimensionId }, orderBy: { observedAt: 'desc' }, take: 8
  });
  return {
    analysis, title, goal,
    recent: evidence.map((row) => ({
      kind: row.kind, score: row.score, date: row.observedAt.toISOString().slice(0, 10),
      note: decryptString(row.noteCiphertext,
        cognitiveColumnAad('CapabilityEvidence', 'noteCiphertext', userId, row.id)).slice(0, 300)
    }))
  };
}
