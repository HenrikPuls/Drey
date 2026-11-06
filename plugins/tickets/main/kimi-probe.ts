/**
 * The Kimi Code worker's probe (E10-8): is the `kimi` CLI installed, does it
 * have a provider to talk to (`kimi login` done or a provider added), and
 * which models does its config offer. Feeds the model picker's note; a
 * failed probe is an answer, not an error — the worker stays selectable
 * (the CLI may be installed later) and the run fails with the CLI's own
 * message.
 */
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface KimiProbe {
  readonly installed: boolean;
  /** `kimi --version`, e.g. `2.4.1`. */
  readonly version: string | null;
  /** At least one provider with models (`kimi provider list`): logged in or configured. */
  readonly configured: boolean;
  readonly models: readonly string[];
  /** One line for the picker: what is missing, or null when ready. */
  readonly note: string | null;
}

/** The model aliases of Kimi's `config.toml`: its `[models."provider/alias"]` headers. */
export function parseKimiModels(toml: string): string[] {
  const seen = new Set<string>();
  for (const match of toml.matchAll(/^\[models\."([^"\r\n]+)"\]/gm)) {
    seen.add(match[1]!);
  }
  return [...seen];
}

/** True when `kimi provider list` names a provider with at least one model. */
export function hasKimiProvider(output: string): boolean {
  return output
    .split(/\r?\n/)
    .some((line) => {
      const models = /\bmodels=(\d+)/.exec(line);
      return models !== null && Number(models[1]) > 0;
    });
}

export interface KimiProbeSeams {
  readonly exec: (cmd: string, args: readonly string[]) => Promise<string>;
  readonly readConfig: () => Promise<string | null>;
}

export const nodeKimiProbeSeams = (exec: KimiProbeSeams['exec']): KimiProbeSeams => ({
  exec,
  readConfig: () => {
    const home = process.env['KIMI_HOME'];
    const file = path.join(home !== undefined && home !== '' ? home : path.join(os.homedir(), '.kimi-code'), 'config.toml');
    return fsp.readFile(file, 'utf8').catch(() => null);
  },
});

export async function probeKimi(seams: KimiProbeSeams): Promise<KimiProbe> {
  let version: string;
  try {
    version = (await seams.exec('kimi', ['--version'])).trim().split(/\r?\n/)[0] ?? '';
  } catch {
    return { installed: false, version: null, configured: false, models: [], note: 'Kimi Code is not installed ("kimi" is not on PATH); type a model as provider/alias.' };
  }
  const configured = await seams.exec('kimi', ['provider', 'list']).then(hasKimiProvider, () => false);
  const models = parseKimiModels((await seams.readConfig()) ?? '');
  return {
    installed: true,
    version: version === '' ? null : version,
    configured,
    models,
    note: configured ? null : 'Kimi Code is installed but has no provider — run "kimi login" in a terminal.',
  };
}
