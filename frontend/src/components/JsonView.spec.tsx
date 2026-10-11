import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JsonView } from './JsonView';

describe('JsonView', () => {
  it('pretty-prints parseable JSON', () => {
    const { container } = render(<JsonView raw='{"event":"shipment.created","id":"shp_42"}' />);
    expect(screen.queryByTestId('json-fallback-label')).not.toBeInTheDocument();
    const pre = container.querySelector('.json-pre');
    expect(pre?.textContent).toContain('"event": "shipment.created"');
    expect(pre?.textContent).toContain('"id": "shp_42"');
  });

  it('falls back to raw text when the payload is not JSON, and labels it', () => {
    render(<JsonView raw='plain text payload' />);
    expect(screen.getByTestId('json-fallback-label')).toBeInTheDocument();
    expect(screen.getByText('raw text')).toBeInTheDocument();
    // The pre still contains the raw text.
    expect(screen.getByText('plain text payload')).toBeInTheDocument();
  });
});
