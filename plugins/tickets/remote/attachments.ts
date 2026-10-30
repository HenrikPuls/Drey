/**
 * Images in the phone client's text fields (req-66 R8): a paste or a
 * picked file is uploaded to the desk, saved under the tickets vault's
 * reserved `tickets/attachments/` folder, and embedded at the caret as
 * `![](../attachments/<file>)`. The desk sniffs the type from the bytes
 * and derives the name — the client sends base64 and nothing else.
 */
import type { AttachmentReply } from '../shared/remote-protocol';
import type { Ctx } from './context';
import { h, toast } from './dom';

const MAX_BYTES = 6 * 1024 * 1024;
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // 32 KB steps: String.fromCharCode is a call with many arguments.
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/** `![](../attachments/<file>)` on its own line, at the caret; the
 * bubbling input event is what makes the refine draft save. */
function insertAtCaret(area: HTMLTextAreaElement, embed: string): void {
  const at = area.selectionStart;
  const end = area.selectionEnd;
  const before = area.value.slice(0, at);
  const after = area.value.slice(end);
  const lead = before === '' || before.endsWith('\n') ? '' : '\n';
  const trail = after === '' || after.startsWith('\n') ? '' : '\n';
  area.value = `${before}${lead}${embed}${trail}${after}`;
  const caret = at + lead.length + embed.length;
  area.setSelectionRange(caret, caret);
  area.dispatchEvent(new Event('input', { bubbles: true }));
}

async function uploadAndInsert(ctx: Ctx, area: HTMLTextAreaElement, file: File): Promise<void> {
  if (file.size > MAX_BYTES) {
    toast(`"${file.name}" is larger than 6 MB.`, 'error');
    return;
  }
  const dataBase64 = base64Of(await file.arrayBuffer());
  try {
    const reply = await ctx.api.post<AttachmentReply>('/api/attachments', { dataBase64 });
    if (!reply.ok || reply.file === undefined) {
      toast(reply.error ?? 'The image was not uploaded.', 'error');
      return;
    }
    const name = reply.file.split('/').pop() ?? reply.file;
    insertAtCaret(area, `![](../attachments/${name})`);
    toast('Image inserted');
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error');
  }
}

/** The controls row under a field: the Image button, its hidden file
 * input and the one-line hint. Hidden on a read-only device. */
export function imageControls(ctx: Ctx, area: HTMLTextAreaElement): HTMLElement {
  const input = h('input', { class: 'attach-input', attrs: { type: 'file', accept: ACCEPT, tabindex: '-1', 'aria-hidden': 'true' } });
  input.addEventListener('change', () => {
    for (const file of Array.from(input.files ?? [])) {
      void uploadAndInsert(ctx, area, file);
    }
    input.value = '';
  });
  const row = h(
    'div',
    { class: 'attach-row' },
    h(
      'button',
      {
        class: 'btn attach-btn',
        text: 'Image',
        attrs: { type: 'button', 'aria-label': 'Insert an image', title: 'Insert an image' },
        on: { click: () => input.click() },
      },
    ),
    h('span', { class: 'small', text: 'Paste or pick an image; it is uploaded and embedded.' }),
    input,
  );
  if (ctx.state.readOnly) {
    row.hidden = true;
  }
  return row;
}

/** An image pasted into the field uploads and embeds; a text paste stays a text paste. */
export function bindImagePaste(ctx: Ctx, area: HTMLTextAreaElement): void {
  area.addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    for (const file of files) {
      void uploadAndInsert(ctx, area, file);
    }
  });
}
