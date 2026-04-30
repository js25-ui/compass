import type { MonitorData } from '@/lib/demo-data';

interface MonitorPanelProps {
  data: MonitorData;
}

function changeClass(change: string): string {
  if (change.includes('+') || change === 'up') return ' up';
  if (change.includes('−') || change === 'down') return ' down';
  return '';
}

export function MonitorPanel({ data }: MonitorPanelProps) {
  return (
    <div className="stage-content">
      <div className="stage-intro">
        <h3>Monitor</h3>
        <p>Post-execution tracking and anomaly detection.</p>
      </div>
      <div className="kpi-grid">
        {data.kpis.map(k => (
          <div key={k.label} className="kpi-card">
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value">{k.value}</div>
            <div className={`kpi-change${changeClass(k.change)}`}>{k.change}</div>
          </div>
        ))}
      </div>
      <div className="data-card">
        <h3>Active Alerts and Anomalies</h3>
        {data.alerts.map(a => (
          <div key={a.title} className="alert-item">
            <div className={`alert-icon ${a.type}`}>{a.type === 'green' ? '✓' : '!'}</div>
            <div className="alert-content">
              <h5>{a.title}</h5>
              <p>{a.msg}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
