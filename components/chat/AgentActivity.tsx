interface AgentActivityProps {
  lines: string[];
}

export function AgentActivity({ lines }: AgentActivityProps) {
  return (
    <div className="agent-activity fade-in">
      <div className="agent-activity-header">Agent Activity</div>
      {lines.map(line => (
        <div key={line} className="agent-line done">
          <span className="agent-tick">✓</span>
          <span>{line}</span>
        </div>
      ))}
    </div>
  );
}
