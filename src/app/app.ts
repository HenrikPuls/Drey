import { Component } from '@angular/core';
import { Sidebar } from './sidebar/sidebar';

/**
 * Root shell: sidebar (vault selection + file tree, milestone 2) + main
 * area placeholder. The editor that fills the main area lands with
 * milestone 3; tabs, chat input, and the rest of CLAUDE.md's layout land
 * with the milestones that give them something real to do.
 */
@Component({
  selector: 'app-root',
  imports: [Sidebar],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly ipcAvailable = typeof window !== 'undefined' && !!window.cyberNotesApi;
}
