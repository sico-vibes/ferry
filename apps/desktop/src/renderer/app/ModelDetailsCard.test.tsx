// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createMockFerryClient } from '@ferry/client';
import { ModelDetailsCard } from './ModelDetailsCard';

afterEach(cleanup);

it('shows unknown native capacity without presenting admission placeholders as model facts', async () => {
  const base = (await createMockFerryClient({ behavior: 'test' }).models.list())[0];
  if (!base) throw new Error('Missing model fixture');
  render(
    <ModelDetailsCard
      model={{ ...base, capacityKnown: false, contextWindow: 1, maxOutput: 1 }}
      provider={undefined}
      candidate={undefined}
    />,
  );
  expect(screen.getAllByText('Not reported')).toHaveLength(2);
  expect(screen.queryByText('1 token')).toBeNull();
  expect(
    document.querySelector('[aria-hidden="true"].v2-model-meter-bars[data-tone="info"]'),
  ).toBeNull();
});
