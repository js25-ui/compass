import { SourceCitations, type CitedSource } from './SourceCitations';

interface UserMessageProps {
  text: string;
  time: string;
}

export function UserMessage({ text, time }: UserMessageProps) {
  return (
    <div className="chat-msg chat-msg-user fade-in">
      <div className="chat-msg-meta">
        <span>You</span>
        <span>{time}</span>
      </div>
      <div className="chat-msg-content">{text}</div>
    </div>
  );
}

interface AssistantMessageProps {
  html: string;
  sources: CitedSource[];
  time: string;
  latencyMs: number;
  confidence?: { score: number };
  citationAccuracy?: { score: number };
}

export function AssistantMessage({ html, sources, time, latencyMs, confidence, citationAccuracy }: AssistantMessageProps) {
  const seconds = (latencyMs / 1000).toFixed(1);
  return (
    <div className="chat-msg chat-msg-assistant fade-in">
      <div className="chat-msg-meta">
        <span>Compass</span>
        <span>
          {`${time} · ${seconds}s`}
          {confidence ? <span className={`conf-pill ${confTier(confidence.score)}`}>Conf {confidence.score}/100</span> : null}
          {citationAccuracy ? <span className={`cit-pill ${citTier(citationAccuracy.score)}`}>Citations {citationAccuracy.score}%</span> : null}
        </span>
      </div>
      <div className="chat-msg-content" dangerouslySetInnerHTML={{ __html: html }} />
      <SourceCitations sources={sources} />
    </div>
  );
}

function confTier(score: number): string {
  if (score >= 75) return 'conf-high';
  if (score >= 50) return 'conf-med';
  return 'conf-low';
}

function citTier(score: number): string {
  if (score >= 90) return 'conf-high';
  if (score >= 60) return 'conf-med';
  return 'conf-low';
}
