import type { Memo } from '@/lib/demo-data';

interface MemoDocProps {
  memo: Memo;
}

export function MemoDoc({ memo }: MemoDocProps) {
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
