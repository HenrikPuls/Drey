import { TestBed } from '@angular/core/testing';
import { ChatService } from './chat.service';

describe('ChatService', () => {
  let service: ChatService;

  beforeEach(() => {
    service = TestBed.inject(ChatService);
  });

  it('defaults to the document scope and an empty query', () => {
    expect(service.scope()).toBe('doc');
    expect(service.query()).toBe('');
    expect(service.canSubmit()).toBe(false);
  });

  it('can submit only once the query has non-whitespace content', () => {
    service.setQuery('   ');
    expect(service.canSubmit()).toBe(false);
    service.setQuery('  was ist retention?  ');
    expect(service.canSubmit()).toBe(true);
  });

  it('toggles the scope', () => {
    service.setScope('all');
    expect(service.scope()).toBe('all');
  });
});
