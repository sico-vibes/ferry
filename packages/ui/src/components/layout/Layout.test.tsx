// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Cluster, PageHeader, Section, Stack } from './index';

describe('layout primitives', () => {
  it('renders a page heading, subtitle, and primary action', () => {
    render(
      <PageHeader
        title="Explore"
        subtitle="Find a provider"
        primaryAction={<button>Add provider</button>}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Explore' })).toBeTruthy();
    expect(screen.getByText('Find a provider')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add provider' })).toBeTruthy();
  });

  it('renders card sections and spacing layout wrappers', () => {
    const { container } = render(
      <Stack gap={6}>
        <Section title="Usage">Totals</Section>
        <Cluster gap={2}>Filters</Cluster>
      </Stack>,
    );
    expect(screen.getByRole('heading', { name: 'Usage' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Usage' })).toBeTruthy();
    expect(container.querySelector('.ferry-gap-6')).toBeTruthy();
    expect(container.querySelector('.ferry-gap-2')).toBeTruthy();
  });
});
