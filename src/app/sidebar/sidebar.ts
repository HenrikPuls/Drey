import { Component, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { VaultService } from '../services/vault.service';
import { VaultFileEntry } from '../../../shared/ipc-api';

/**
 * Milestone 2 slice of the sidebar: vault selection + file tree only. The
 * rest of CLAUDE.md's sidebar layout (calendar, open-tabs list, settings
 * entry) is built alongside the milestones that give it something real to
 * show (tabs need the editor, settings needs actual settings) rather than
 * as empty placeholder chrome now.
 */
@Component({
  imports: [NgTemplateOutlet],
  selector: 'app-sidebar',
  styleUrl: './sidebar.css',
  templateUrl: './sidebar.html',
})
export class Sidebar {
  protected readonly vault = inject(VaultService);
  protected readonly selectedPath = signal<string | null>(null);

  protected onSelectVault(): void {
    void this.vault.selectVault();
  }

  protected onEntryClick(entry: VaultFileEntry): void {
    if (entry.type !== 'file') {
      return;
    }
    // Just a visual selection for now -- actually opening the file into
    // the editor lands with milestone 3.
    this.selectedPath.set(entry.relativePath);
  }
}
