import { describe, expect, it } from 'vitest';
import type { VerificationReport } from '../contracts/verify';
import { parseVerificationSection, renderVerificationSection, upsertVerificationSection } from './verification';

const FULL: VerificationReport = {
  testedAt: '2026-11-01T14:32:00Z',
  tester: 'verify@engine',
  environment: 'Electron 34.2.0 on win32',
  criteria: [
    { command: 'npm run build', passed: true, screenshot: 'verify-20261101-143200-01.png', note: null },
    { command: 'npm test', passed: false, screenshot: null, note: 'no screenshot: the app never became ready' },
    { command: 'npm run lint', passed: true, screenshot: 'verify-20261101-143200-02.png', note: 'judge: clean' },
  ],
  findings: ['The settings page stayed blank until the reload.'],
};

const TICKET_FILE = `---
id: T-0102
title: "The smoke ticket"
---

## Description

The body.

## Plan

### Acceptance criteria

- [x] \`npm run build\`

## Log

- '2026-11-01T13:00:00Z' owner@desk — created in inbox
`;

describe('renderVerificationSection', () => {
  it('writes the canonical shape the spec documents', () => {
    expect(renderVerificationSection(FULL)).toBe(
      [
        '## Verification',
        '',
        'Tested on 2026-11-01T14:32:00Z by verify@engine — Electron 34.2.0 on win32.',
        '',
        '### Criteria',
        '',
        '- [x] `npm run build` → ![](../attachments/verify-20261101-143200-01.png)',
        '- [ ] `npm test` — no screenshot: the app never became ready',
        '- [x] `npm run lint` → ![](../attachments/verify-20261101-143200-02.png) — judge: clean',
        '',
        '### Findings',
        '',
        '- The settings page stayed blank until the reload.',
        '',
      ].join('\n'),
    );
  });

  it('omits the Findings block when there is nothing to say', () => {
    const text = renderVerificationSection({ ...FULL, findings: [] });
    expect(text).not.toContain('### Findings');
    expect(text.endsWith('judge: clean\n')).toBe(true);
  });

  it('omits the environment clause when it is empty', () => {
    const text = renderVerificationSection({ ...FULL, environment: '', criteria: [], findings: [] });
    expect(text).toContain('Tested on 2026-11-01T14:32:00Z by verify@engine.');
    expect(text).not.toContain(' — ');
  });
});

describe('parseVerificationSection', () => {
  it('round-trips what the writer wrote', () => {
    expect(parseVerificationSection(renderVerificationSection(FULL))).toEqual(FULL);
  });

  it('returns null when the ticket was never verified', () => {
    expect(parseVerificationSection(TICKET_FILE)).toBeNull();
  });

  it('forgives a hand-edited section instead of failing', () => {
    const text = `${TICKET_FILE}\n## Verification\n\nTested on 2026-11-01T15:00:00Z by owner@phone.\n\n### Criteria\n\n- [x] \`npm run build\`\nsome prose between the bullets\n- [ ] \`npm test\` → ![](../attachments/verify-x.png)\n\n### Findings\n\n- hand note\n`;
    const parsed = parseVerificationSection(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.testedAt).toBe('2026-11-01T15:00:00Z');
    expect(parsed!.environment).toBe('');
    expect(parsed!.criteria).toEqual([
      { command: 'npm run build', passed: true, screenshot: null, note: null },
      { command: 'npm test', passed: false, screenshot: 'verify-x.png', note: null },
    ]);
    expect(parsed!.findings).toEqual(['hand note']);
  });

  it('never reads past the section into the Log', () => {
    const text = `${TICKET_FILE}## Verification\n\nTested on 2026-11-01T15:00:00Z by verify@engine.\n\n### Criteria\n\n- [x] \`npm run build\`\n`;
    const parsed = parseVerificationSection(text);
    expect(parsed!.criteria).toHaveLength(1);
    expect(parsed!.findings).toEqual([]);
  });
});

describe('upsertVerificationSection', () => {
  const SECTION = renderVerificationSection(FULL);

  it('inserts before ## Log when the ticket has no section yet', () => {
    const result = upsertVerificationSection(TICKET_FILE, SECTION);
    expect(result.indexOf('## Verification')).toBeGreaterThan(result.indexOf('## Plan'));
    expect(result.indexOf('## Verification')).toBeLessThan(result.indexOf('## Log'));
    // Everything outside the section survives untouched.
    expect(result).toContain('## Description\n\nThe body.');
    expect(result).toContain("- '2026-11-01T13:00:00Z' owner@desk — created in inbox");
  });

  it('replaces an existing section instead of adding a second one', () => {
    const once = upsertVerificationSection(TICKET_FILE, SECTION);
    const next: VerificationReport = { ...FULL, testedAt: '2026-11-01T16:00:00Z', findings: [] };
    const twice = upsertVerificationSection(once, renderVerificationSection(next));
    expect(twice.match(/## Verification/g)).toHaveLength(1);
    expect(twice).toContain('Tested on 2026-11-01T16:00:00Z');
    expect(twice).not.toContain('The settings page stayed blank');
    expect(twice).toContain('## Description\n\nThe body.');
  });

  it('appends at the end when the file has no ## Log', () => {
    const noLog = TICKET_FILE.slice(0, TICKET_FILE.indexOf('## Log'));
    const result = upsertVerificationSection(noLog, SECTION);
    expect(result.trimEnd().endsWith('The settings page stayed blank until the reload.')).toBe(true);
    expect(result).toContain('## Plan');
  });

  it('keeps exactly one blank line before the following heading', () => {
    const once = upsertVerificationSection(TICKET_FILE, SECTION);
    const at = once.indexOf('- The settings page stayed blank until the reload.');
    expect(once.slice(at).startsWith('- The settings page stayed blank until the reload.\n\n## Log')).toBe(true);
  });
});

describe('the Video chapter (E11-1)', () => {
  const WITH_VIDEO: VerificationReport = {
    ...FULL,
    video: 'verify-20261101-143200-T-0102.webm',
    videoChapters: [
      { atMs: 3_000, label: 'npm run build' },
      { atMs: 75_000, label: 'npm run lint' },
    ],
  };

  it('writes the player and the chapters between Criteria and Findings and reads them back', () => {
    const text = renderVerificationSection(WITH_VIDEO);
    expect(text).toContain(
      '### Video\n\n![](../videos/verify-20261101-143200-T-0102.webm)\n\n- 0:03 npm run build\n- 1:15 npm run lint\n\n### Findings',
    );
    const back = parseVerificationSection(text)!;
    expect(back.video).toBe('verify-20261101-143200-T-0102.webm');
    expect(back.videoChapters).toEqual(WITH_VIDEO.videoChapters);
    expect(back.findings).toEqual(FULL.findings);
    expect(back.criteria).toEqual(FULL.criteria);
  });

  it('writes nothing for a tests proof and keeps the not-kept line for an over-cap recording', () => {
    expect(renderVerificationSection(FULL)).not.toContain('### Video');
    const removed = renderVerificationSection({ ...FULL, videoNotKept: 'Video not kept: 31.2 MB exceeds the 25 MB limit.' });
    expect(removed).toContain('### Video\n\nVideo not kept: 31.2 MB exceeds the 25 MB limit.');
    const back = parseVerificationSection(removed)!;
    expect(back.videoNotKept).toBe('Video not kept: 31.2 MB exceeds the 25 MB limit.');
    expect(back.video).toBeUndefined();
  });
});
