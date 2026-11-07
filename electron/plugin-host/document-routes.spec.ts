import { describe, expect, it } from 'vitest';
import type { DocumentRoute } from '../../shared/plugin-api';
import { DocumentRoutes } from './document-routes';

function route(owned: boolean, title: DocumentRoute['title']): DocumentRoute {
  return {
    owns: () => owned,
    save: () => Promise.reject(new Error('not used')),
    ...(title === undefined ? {} : { title }),
  };
}

describe('DocumentRoutes.titleOf (SDK 1.51)', () => {
  it('asks a route that does not own the document', () => {
    const routes = new DocumentRoutes();
    routes.set('tickets', 'Tickets', route(false, () => 'T-0017 · A title'));
    expect(routes.titleOf('v', 'tickets/20-prioritized/T-0017.md', '')).toBe('T-0017 · A title');
  });

  it('takes the first route that names the document; none keeps the file name', () => {
    const routes = new DocumentRoutes();
    expect(routes.titleOf('v', 'a.md', '')).toBeNull();
    routes.set('a', 'A', route(false, undefined));
    routes.set('b', 'B', route(false, () => null));
    expect(routes.titleOf('v', 'a.md', '')).toBeNull();
    routes.set('c', 'C', route(false, () => 'C names it'));
    expect(routes.titleOf('v', 'a.md', '')).toBe('C names it');
  });

  it('a route whose title throws does not fail the read, and the next one still answers', () => {
    const routes = new DocumentRoutes();
    routes.set('a', 'A', route(false, () => {
      throw new Error('boom');
    }));
    expect(routes.titleOf('v', 'a.md', '')).toBeNull();
    routes.set('b', 'B', route(false, () => 'B names it'));
    expect(routes.titleOf('v', 'a.md', '')).toBe('B names it');
  });

  it('a title does not make the document refused: only owning does', () => {
    const routes = new DocumentRoutes();
    routes.set('tickets', 'Tickets', route(false, () => 'A title'));
    expect(routes.refusal('v', 'a.md')).toBeNull();
  });
});
