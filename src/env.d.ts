// Ambient type augmentations for Worker bindings that aren't visible to
// `wrangler types` — i.e. secrets set via `wrangler secret put`, which
// don't live in wrangler.jsonc. Merges with the generated Cloudflare.Env
// in worker-configuration.d.ts.

declare namespace Cloudflare {
  interface Env {
    UGRC_API_KEY: string;
  }
}
