import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core';
import { ToolApprovalService } from './tool-approval.service';

/**
 * Asks before one external tool call runs (ADR-0063): which service, which
 * tool, and exactly what would be sent. Escape denies.
 */
@Component({
  selector: 'app-tool-approval-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tool-approval-dialog.html',
  styleUrl: './tool-approval-dialog.css',
})
export class ToolApprovalDialog {
  protected readonly approvals = inject(ToolApprovalService);

  protected readonly request = computed(() => this.approvals.pending());
  protected readonly waiting = computed(() => this.approvals.waiting());
  protected readonly argsText = computed(() => {
    const args = this.request()?.args ?? {};
    return Object.keys(args).length === 0 ? '(no arguments)' : JSON.stringify(args, null, 2);
  });

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.request() !== null) {
      void this.approvals.answer('deny');
    }
  }

  protected allow(): void {
    void this.approvals.answer('allow');
  }

  protected always(): void {
    void this.approvals.answer('always');
  }

  protected deny(): void {
    void this.approvals.answer('deny');
  }
}
