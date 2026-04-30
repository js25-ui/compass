import 'server-only';
import {
  actionByBL,
  demoTargets,
  dilByBL,
  feedByBL,
  memoByBL,
  metricsByBL,
  mcByBL,
  monitorByBL,
  quickQByBL,
  type ActionData,
  type BusinessLine,
  type DemoTarget,
  type DiligenceItem,
  type FeedItem,
  type Memo,
  type Metric,
  type MonitorData,
  type MonteCarloConfig,
} from './demo-data';
import { hasSupabaseEnv } from './db/client';
import {
  dbGetAction,
  dbGetDiligence,
  dbGetFeed,
  dbGetMemo,
  dbGetMetrics,
  dbGetMonitor,
  dbGetMonteCarlo,
  dbGetTargetById,
  dbGetTargetsByBL,
} from './db/queries';

function isBusinessLine(value: string): value is BusinessLine {
  return value === 'ecm' || value === 'dcm' || value === 'alts';
}

async function tryDb<T>(fetch: () => Promise<T>, fallback: () => T): Promise<T> {
  if (!hasSupabaseEnv()) return fallback();
  try {
    return await fetch();
  } catch (err) {
    console.warn('[compass/data] DB read failed, falling back to demo data:', err);
    return fallback();
  }
}

export async function getTarget(id: string): Promise<DemoTarget | null> {
  return tryDb(
    async () => {
      const row = await dbGetTargetById(id);
      if (!row) return null;
      if (!row.business_line || !isBusinessLine(row.business_line)) return null;
      return {
        id: row.id,
        bl: row.business_line,
        title: row.name,
        ticker: row.ticker ?? undefined,
      };
    },
    () => demoTargets.find(t => t.id === id) ?? null,
  );
}

export async function getTargetsByBL(bl: BusinessLine): Promise<DemoTarget[]> {
  return tryDb(
    async () => {
      const rows = await dbGetTargetsByBL(bl);
      return rows
        .filter((r): r is typeof r & { business_line: BusinessLine } =>
          Boolean(r.business_line) && isBusinessLine(r.business_line!),
        )
        .map(r => ({
          id: r.id,
          bl: r.business_line,
          title: r.name,
          ticker: r.ticker ?? undefined,
        }));
    },
    () => demoTargets.filter(t => t.bl === bl),
  );
}

export async function getFeed(targetId: string, bl: BusinessLine): Promise<FeedItem[]> {
  return tryDb(
    async () => {
      const items = await dbGetFeed(targetId);
      return items.length > 0 ? items : feedByBL[bl];
    },
    () => feedByBL[bl],
  );
}

export async function getDiligence(targetId: string, bl: BusinessLine): Promise<DiligenceItem[]> {
  return tryDb(
    async () => {
      const items = await dbGetDiligence(targetId);
      return items.length > 0 ? items : dilByBL[bl];
    },
    () => dilByBL[bl],
  );
}

export async function getMonteCarlo(targetId: string, bl: BusinessLine): Promise<MonteCarloConfig> {
  return tryDb(
    async () => (await dbGetMonteCarlo(targetId)) ?? mcByBL[bl],
    () => mcByBL[bl],
  );
}

export async function getMemo(targetId: string, bl: BusinessLine): Promise<Memo> {
  return tryDb(
    async () => (await dbGetMemo(targetId)) ?? memoByBL[bl],
    () => memoByBL[bl],
  );
}

export async function getMonitor(targetId: string, bl: BusinessLine): Promise<MonitorData> {
  return tryDb(
    async () => (await dbGetMonitor(targetId)) ?? monitorByBL[bl],
    () => monitorByBL[bl],
  );
}

export async function getAction(targetId: string, bl: BusinessLine): Promise<ActionData> {
  return tryDb(
    async () => (await dbGetAction(targetId)) ?? actionByBL[bl],
    () => actionByBL[bl],
  );
}

export async function getMetrics(targetId: string, bl: BusinessLine): Promise<Metric[]> {
  return tryDb(
    async () => {
      const m = await dbGetMetrics(targetId);
      return m.length > 0 ? m : metricsByBL[bl];
    },
    () => metricsByBL[bl],
  );
}

export function getQuickResearch(bl: BusinessLine): string[] {
  return quickQByBL[bl];
}
