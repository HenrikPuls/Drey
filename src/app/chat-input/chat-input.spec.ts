import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ChatInput } from './chat-input';
import { ChatService } from '../services/chat.service';

describe('ChatInput', () => {
  let fixture: ComponentFixture<ChatInput>;
  let chat: ChatService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ChatInput] }).compileComponents();
    fixture = TestBed.createComponent(ChatInput);
    chat = TestBed.inject(ChatService);
    fixture.detectChanges();
  });

  it('mirrors the field into the service and keeps send disabled until there is text', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const field = compiled.querySelector('.field') as HTMLTextAreaElement;
    const send = compiled.querySelector('.send') as HTMLButtonElement;

    expect(send.disabled).toBe(true);

    field.value = 'retention?';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(chat.query()).toBe('retention?');
    expect(send.disabled).toBe(false);
  });

  it('switches scope from the toggle chips', () => {
    const chips = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
      '.scope',
    );
    chips[1].click();
    fixture.detectChanges();
    expect(chat.scope()).toBe('all');
    expect(chips[1].classList.contains('on')).toBe(true);
  });
});
