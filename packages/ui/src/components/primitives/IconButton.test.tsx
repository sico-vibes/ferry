// @vitest-environment jsdom
import { Search } from 'lucide-react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IconButton } from './index';
describe('IconButton', () => {
  it('labels and renders each variant', () => {
    render(
      <>
        <IconButton label="Search">
          <Search />
        </IconButton>
        <IconButton label="Tile" variant="tile">
          <Search />
        </IconButton>
        <IconButton label="Circle" variant="circle">
          <Search />
        </IconButton>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tile' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Circle' })).toBeTruthy();
  });
});
