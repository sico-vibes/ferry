import { useParams } from '@tanstack/react-router';
import { AmbientGlow, DotGrid, GradientText } from '@ferry/ui';
import type { SessionId } from '@ferry/shared';
import { useSessionDetail } from '../data/queries';

function MarkTile() {
  return (
    <div className="mark-tile" aria-label="Ferry">
      <span>F</span>
    </div>
  );
}

export function HomeCanvas() {
  return (
    <div className="canvas home-canvas">
      <AmbientGlow
        glows={[
          { color: 'warm', x: '24%', y: '10%', size: 520 },
          { color: 'blue', x: '68%', y: '8%', size: 600 },
        ]}
      />
      <DotGrid radius={420} centerY="46%" />
      <div className="hero">
        <MarkTile />
        <h1>
          <GradientText>
            Build bigger with Ferry,
            <br />
            every free model, one seamless task.
          </GradientText>
        </h1>
        <p>
          Ferry routes each step to the model that still has room, and carries your task across when
          one runs dry.
        </p>
        <span className="canvas-note">Home canvas lands in A3.4</span>
      </div>
    </div>
  );
}

export function SessionCanvas() {
  const { sessionId } = useParams({ from: '/s/$sessionId' });
  const { data } = useSessionDetail(sessionId as SessionId);
  return (
    <div className="canvas placeholder-canvas">
      <div className="placeholder-card">
        <span className="eyebrow">Session</span>
        <h1>{data?.session.title ?? 'Loading chat…'}</h1>
        <p>
          {data
            ? `${String(data.messages.length)} messages in this conversation`
            : 'Preparing the conversation'}
        </p>
      </div>
    </div>
  );
}

export function PlaceholderCanvas({ title }: { title: string }) {
  return (
    <div className="canvas placeholder-canvas">
      <div className="placeholder-card">
        <span className="eyebrow">Ferry</span>
        <h1>{title}</h1>
        <p>{title} — coming next</p>
      </div>
    </div>
  );
}
