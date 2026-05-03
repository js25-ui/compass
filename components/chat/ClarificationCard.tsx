'use client';

import { useMemo, useState } from 'react';
import type { ClarifyQuestion } from '@/lib/agents/clarify';

export interface AcknowledgementPill {
  paramId: string;
  label: string;
  source: 'current_prompt' | 'conversation_history' | 'standing_preference' | 'inferred';
}

export interface ClarificationPayload {
  taskType: string;
  assetClass: string;
  detectedTarget: { name: string; ticker?: string } | null;
  preface: string;
  questions: ClarifyQuestion[];
  acknowledgedPills?: AcknowledgementPill[];
}

interface ClarificationCardProps {
  payload: ClarificationPayload;
  disabled?: boolean;
  onSubmit: (answers: Record<string, string | number | boolean | string[]>) => void;
}

type AnswerValue = string | number | boolean | string[];

function defaultFor(q: ClarifyQuestion): AnswerValue {
  if (q.default !== undefined) {
    if (q.kind === 'multi_select' && !Array.isArray(q.default)) {
      return [String(q.default)];
    }
    return q.default;
  }
  if (q.kind === 'multi_select') return [];
  if (q.kind === 'numeric') return 0;
  if (q.kind === 'boolean') return false;
  if (q.kind === 'select' && q.options?.[0]) return q.options[0].value;
  return '';
}

export function ClarificationCard({ payload, disabled, onSubmit }: ClarificationCardProps) {
  const initial = useMemo(() => {
    const out: Record<string, AnswerValue> = {};
    for (const q of payload.questions) out[q.id] = defaultFor(q);
    return out;
  }, [payload.questions]);

  const [answers, setAnswers] = useState<Record<string, AnswerValue>>(initial);

  const setAnswer = (id: string, v: AnswerValue) => setAnswers(prev => ({ ...prev, [id]: v }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    onSubmit(answers);
  };

  return (
    <div className="clarify-card">
      <div className="clarify-header">
        <span className="clarify-tag">Scope</span>
        <span className="clarify-task">
          {payload.taskType.replace(/_/g, ' ')}
          {payload.detectedTarget?.name ? ` · ${payload.detectedTarget.name}` : ''}
          {payload.detectedTarget?.ticker ? ` (${payload.detectedTarget.ticker})` : ''}
        </span>
      </div>

      {payload.preface ? <p className="clarify-preface">{payload.preface}</p> : null}

      {payload.acknowledgedPills && payload.acknowledgedPills.length > 0 ? (
        <div className="clarify-ack">
          <div className="clarify-ack-label">What I have</div>
          <div className="clarify-ack-pills">
            {payload.acknowledgedPills.map(p => (
              <span key={p.paramId} className="clarify-ack-pill">
                <span className="clarify-ack-pill-label">{p.label}</span>
                <span className="clarify-ack-pill-source">{sourceLabelFor(p.source)}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <form className="clarify-form" onSubmit={handleSubmit}>
        {payload.questions.map(q => (
          <div key={q.id} className="clarify-question">
            <label className="clarify-question-prompt" htmlFor={`q-${q.id}`}>
              {q.prompt}
            </label>
            <QuestionInput
              question={q}
              value={answers[q.id]}
              onChange={v => setAnswer(q.id, v)}
              disabled={disabled}
            />
            {q.hint ? <div className="clarify-hint">{q.hint}</div> : null}
            {q.kind === 'numeric' && typeof answers[q.id] === 'number' && (q.min !== undefined || q.max !== undefined) && (
              <RangeWarning value={answers[q.id] as number} min={q.min} max={q.max} unit={q.unit} />
            )}
          </div>
        ))}
        <div className="clarify-actions">
          <button type="submit" className="clarify-submit" disabled={disabled}>
            {disabled ? 'Working…' : 'Run with these inputs →'}
          </button>
        </div>
      </form>
    </div>
  );
}

interface QuestionInputProps {
  question: ClarifyQuestion;
  value: AnswerValue;
  onChange: (v: AnswerValue) => void;
  disabled?: boolean;
}

function QuestionInput({ question: q, value, onChange, disabled }: QuestionInputProps) {
  const id = `q-${q.id}`;

  if (q.kind === 'select') {
    return (
      <select
        id={id}
        className="clarify-select"
        value={String(value)}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
      >
        {q.options?.map(opt => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }

  if (q.kind === 'multi_select') {
    const arr = Array.isArray(value) ? value : [];
    const toggle = (v: string) => {
      const next = arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];
      onChange(next);
    };
    return (
      <div className="clarify-chips">
        {q.options?.map(opt => {
          const active = arr.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              className={`clarify-chip${active ? ' active' : ''}`}
              onClick={() => toggle(opt.value)}
              disabled={disabled}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    );
  }

  if (q.kind === 'numeric') {
    const rangeLabel = formatRange(q.min, q.max, q.unit);
    // Intentionally no `max` HTML attr: caps are recommendations, not hard
    // limits. Soft `min` only when it's a true floor (e.g. 0 — no negative
    // multiples). The RangeWarning component surfaces values outside the
    // recommended band as advisory.
    const hardMin = q.min !== undefined && q.min <= 0 ? 0 : undefined;
    return (
      <div className="clarify-numeric">
        <input
          id={id}
          type="number"
          className="clarify-input clarify-input-numeric"
          value={typeof value === 'number' ? value : Number(value) || 0}
          step={q.step ?? guessStep(q.unit)}
          min={hardMin}
          onChange={e => onChange(Number(e.target.value))}
          disabled={disabled}
        />
        {q.unit ? <span className="clarify-unit">{q.unit}</span> : null}
        {rangeLabel ? <span className="clarify-range">{rangeLabel} (recommended)</span> : null}
      </div>
    );
  }

  if (q.kind === 'boolean') {
    return (
      <div className="clarify-chips">
        <button type="button" className={`clarify-chip${value === true ? ' active' : ''}`} onClick={() => onChange(true)} disabled={disabled}>
          Yes
        </button>
        <button type="button" className={`clarify-chip${value === false ? ' active' : ''}`} onClick={() => onChange(false)} disabled={disabled}>
          No
        </button>
      </div>
    );
  }

  return (
    <input
      id={id}
      type="text"
      className="clarify-input"
      value={String(value ?? '')}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      placeholder={q.unit ?? ''}
    />
  );
}

interface RangeWarningProps {
  value: number;
  min?: number;
  max?: number;
  unit?: string;
}

function RangeWarning({ value, min, max, unit }: RangeWarningProps) {
  let warning: string | null = null;
  if (min !== undefined && value < min) warning = `Below typical floor (${min}${unit ? ' ' + unit : ''}). Compass will still run.`;
  if (max !== undefined && value > max) warning = `Above typical ceiling (${max}${unit ? ' ' + unit : ''}). Compass will still run.`;
  if (!warning) return null;
  return <div className="clarify-warning">⚠ {warning}</div>;
}

function sourceLabelFor(source: AcknowledgementPill['source']): string {
  switch (source) {
    case 'current_prompt': return 'from your prompt';
    case 'conversation_history': return 'from earlier';
    case 'standing_preference': return 'standing preference';
    case 'inferred': return 'inferred';
    default: return source;
  }
}

function formatRange(min: number | undefined, max: number | undefined, unit: string | undefined): string {
  if (min === undefined && max === undefined) return '';
  const u = unit ? ` ${unit}` : '';
  if (min !== undefined && max !== undefined) return `typical ${min}–${max}${u}`;
  if (min !== undefined) return `min ${min}${u}`;
  return `max ${max}${u}`;
}

function guessStep(unit?: string): number {
  if (!unit) return 1;
  const u = unit.toLowerCase();
  if (u.includes('x ') || u === 'x' || u.endsWith('x')) return 0.25;     // multiples
  if (u.includes('%')) return 0.25;
  if (u.includes('bps')) return 5;
  if (u.includes('$m') || u.includes('$bn')) return 25;
  if (u.includes('year')) return 1;
  if (u.includes('month')) return 1;
  return 1;
}
