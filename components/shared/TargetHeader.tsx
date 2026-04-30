import { businessLineFull, businessLineNames, subtagsByBL, type BusinessLine } from '@/lib/demo-data';

interface TargetHeaderProps {
  bl: BusinessLine;
  title: string;
}

export function TargetHeader({ bl, title }: TargetHeaderProps) {
  const subtag = subtagsByBL[bl][0].name;
  const meta = `${businessLineFull[bl]} · ${subtag} · 9 documents · 142K tokens indexed`;
  return (
    <div className="target-header">
      <div className="target-header-left">
        <h2>{title}</h2>
        <p>{meta}</p>
      </div>
      <div>
        <span className="target-pill">{businessLineNames[bl]}</span>
        <button className="back-btn">Export</button>
      </div>
    </div>
  );
}
