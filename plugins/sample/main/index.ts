import type { MainPluginContext, MainPluginModule } from '../../../shared/plugin-api';

let saveCount = 0;

/**
 * The sample plugin's main entry (ADR-0044). Everything is namespaced to
 * this plugin: the `ping` method lands in its own allowlist, its config is
 * its own file, its log lines are prefixed.
 *
 * NOTE: never name the top-level export `module` — shadowing the CJS
 * `module` binding makes Node's module detection load the compiled file as
 * a broken ES module (the e2e suite caught exactly that).
 */
const plugin: MainPluginModule = {
  async activate(ctx: MainPluginContext) {
    ctx.ipc.handle('ping', (payload) => {
      ctx.log(`ping received: ${JSON.stringify(payload)}`);
      ctx.ipc.emit('pong', { echo: payload, at: Date.now() });
      return { ok: true, appVersion: ctx.app.appVersion };
    });

    // The save pipeline fires hooks from stage 2 on; registering early
    // proves the seam accepts hooks without one ever having fired.
    ctx.save.onNoteSaved((event) => {
      saveCount++;
      ctx.log(`note saved (#${saveCount}): ${event.path} (${event.content.length} chars)`);
    });

    const activations = ((await ctx.config.get<number>('activations')) ?? 0) + 1;
    await ctx.config.set('activations', activations);
    ctx.log(`activated (activation #${activations})`);
  },
};

export default plugin;
