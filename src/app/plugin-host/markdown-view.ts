import { ApplicationRef, EnvironmentInjector, Injector, createComponent } from '@angular/core';
import type { MarkdownViewHandle, MarkdownViewOptions } from '../../../shared/plugin-api/renderer';
import { MarkdownSurface } from '../editor/markdown-surface/markdown-surface';

/**
 * `ui.createMarkdownView` (SDK 1.30): the host's own Markdown surface,
 * instantiated outside any template and handed to a plugin as a plain
 * element. It needs a host element, the root environment (the surface's
 * services are root-provided) and one change-detection pass so its
 * CodeMirror view exists before the first `setContent`.
 */
export function mountMarkdownView(injector: Injector, opts: MarkdownViewOptions): MarkdownViewHandle {
  const element = document.createElement('div');
  element.className = 'plugin-markdown-view';
  element.style.display = 'flex';
  element.style.flexDirection = 'column';
  element.style.minHeight = '0';

  const ref = createComponent(MarkdownSurface, {
    environmentInjector: injector.get(EnvironmentInjector),
    hostElement: element,
  });
  ref.setInput('mode', opts.mode ?? 'live');
  ref.setInput('compact', opts.compact === true);
  ref.setInput('submitOnEnter', opts.submitOnEnter !== false);
  ref.setInput('placeholder', opts.placeholder ?? '');
  const appRef = injector.get(ApplicationRef);
  appRef.attachView(ref.hostView);
  ref.changeDetectorRef.detectChanges();

  const surface = ref.instance;
  const subscriptions = [
    surface.docChanged.subscribe((text) => opts.onChange?.(text)),
    surface.submitRequested.subscribe((text) => opts.onSubmit?.(text)),
  ];
  if (opts.content !== undefined && opts.content !== '') {
    surface.loadDocument(opts.content);
  }
  if (opts.readOnly === true) {
    surface.setEditable(false);
  }

  let disposed = false;
  return {
    element,
    setContent: (text) => {
      if (!disposed) {
        surface.setContent(text);
      }
    },
    getContent: () => surface.getContent(),
    setReadOnly: (readOnly) => {
      if (!disposed) {
        surface.setEditable(!readOnly);
      }
    },
    focus: () => surface.focus(),
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const sub of subscriptions) {
        sub.unsubscribe();
      }
      appRef.detachView(ref.hostView);
      ref.destroy();
      element.remove();
    },
  };
}
