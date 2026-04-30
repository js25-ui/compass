import { notFound } from 'next/navigation';
import { Workspace } from '@/components/workstation/Workspace';
import {
  getAction,
  getDiligence,
  getFeed,
  getMemo,
  getMetrics,
  getMonitor,
  getMonteCarlo,
  getQuickResearch,
  getTarget,
} from '@/lib/data';
import { businessLineNames, type BusinessLine } from '@/lib/demo-data';

function isBusinessLine(value: string): value is BusinessLine {
  return value in businessLineNames;
}

interface PageProps {
  params: Promise<{ bl: string; target: string }>;
}

export default async function WorkspacePage({ params }: PageProps) {
  const { bl: blParam, target: targetId } = await params;
  if (!isBusinessLine(blParam)) notFound();
  const bl: BusinessLine = blParam;

  const target = await getTarget(targetId);
  if (!target || target.bl !== bl) notFound();

  const [feed, metrics, diligence, monteCarlo, memo, monitor, action] = await Promise.all([
    getFeed(targetId, bl),
    getMetrics(targetId, bl),
    getDiligence(targetId, bl),
    getMonteCarlo(targetId, bl),
    getMemo(targetId, bl),
    getMonitor(targetId, bl),
    getAction(targetId, bl),
  ]);
  const quickQs = getQuickResearch(bl);

  return (
    <Workspace
      bl={bl}
      title={target.title}
      feed={feed}
      metrics={metrics}
      quickQs={quickQs}
      diligence={diligence}
      monteCarlo={monteCarlo}
      memo={memo}
      monitor={monitor}
      action={action}
    />
  );
}
