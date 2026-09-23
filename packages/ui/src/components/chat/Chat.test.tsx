// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ApprovalCard,
  AssistantMessage,
  CheckpointMarker,
  DelegationCard,
  ErrorPart,
  HandoffMarker,
  MarkdownPart,
  ReasoningPart,
  StatusMark,
  StreamingCursor,
  ToolCallBlock,
} from './index';
describe('transcript components', () => {
  it('expands tool details and filtered recovery callback', () => {
    const show = vi.fn();
    render(
      <ToolCallBlock
        tool="grep"
        title="Search tests"
        args={{ pattern: 'retry' }}
        status="succeeded"
        output={{
          text: 'result',
          filtered: true,
          originalTokens: 4823,
          filteredTokens: 11,
          recoveryHandle: 'handle',
        }}
        onShowFull={show}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Search tests/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Show full' }));
    expect(show).toHaveBeenCalledWith('handle');
  });
  it('collapses reasoning by default and exposes approval decisions', () => {
    const respond = vi.fn();
    render(
      <>
        <ReasoningPart text="Inspect the flaky timer." />
        <ApprovalCard
          kind="Command"
          summary="Run tests?"
          detail="pnpm test"
          risk="low"
          onRespond={respond}
        />
      </>,
    );
    expect(screen.queryByText('Inspect the flaky timer.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Thinking/ }));
    expect(screen.getByText('Inspect the flaky timer.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(respond).toHaveBeenCalledWith('allow_once');
  });
  it('renders assistant prose, status, handoff, checkpoint, delegation, and error parts', () => {
    const restore = vi.fn(),
      review = vi.fn();
    render(
      <AssistantMessage modelName="GLM-5.3">
        <MarkdownPart content="Retrying **safely**." />
        <StatusMark status="running" />
        <StreamingCursor />
        <HandoffMarker
          from="Cerebras gpt-oss-120b"
          to="NVIDIA Nemotron 3 Ultra"
          reason="quota"
          briefingTokens={3100}
          explanation="Carried the task state."
        />
        <CheckpointMarker label="After retry fix" onRestore={restore} />
        <DelegationCard
          lane="Review"
          implementer="Codex"
          status="running"
          progress="Inspecting the diff"
          usage="1.8K tokens"
          onReviewDiff={review}
        />
        <ErrorPart message="Provider temporarily unavailable" />
      </AssistantMessage>,
    );
    expect(screen.getByText(/Retrying/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Switched/ }));
    expect(screen.getByText('Carried the task state.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review diff' }));
    expect(restore).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledOnce();
    expect(screen.getByText('Provider temporarily unavailable')).toBeTruthy();
  });
});
