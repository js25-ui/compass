import type { CitationSource } from '@/lib/demo-data';
import { SourceCitations } from './SourceCitations';

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
  sources: CitationSource[];
  time: string;
  latencyMs: number;
}

export function AssistantMessage({ html, sources, time, latencyMs }: AssistantMessageProps) {
  const seconds = (latencyMs / 1000).toFixed(1);
  return (
    <div className="chat-msg chat-msg-assistant fade-in">
      <div className="chat-msg-meta">
        <span>Compass</span>
        <span>{`${time} · ${seconds}s`}</span>
      </div>
      <div className="chat-msg-content" dangerouslySetInnerHTML={{ __html: html }} />
      <SourceCitations sources={sources} />
    </div>
  );
}
