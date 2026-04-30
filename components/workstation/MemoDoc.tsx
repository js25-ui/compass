import { memoByBL, type BusinessLine } from '@/lib/demo-data';

interface MemoDocProps {
  bl: BusinessLine;
}

export function MemoDoc({ bl }: MemoDocProps) {
  const memo = memoByBL[bl];
  return (
    <div className="stage-content">
      <div className="stage-intro">
        <h3>Memo</h3>
        <p>Auto-drafted from research, diligence, and model output.</p>
      </div>
      <div className="memo-doc">
        <h1>{memo.title}</h1>
        <div className="memo-meta">DRAFT · Prepared by Compass · April 30, 2026</div>
        <div dangerouslySetInnerHTML={{ __html: memo.content }} />
      </div>
    </div>
  );
}
