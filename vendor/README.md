# SayMiao Remote core

`saymiao-remote-core-0.1.0.tgz` is generated from Koma repository `packages/remote-core`, source commit `2cbdf0b7318277365e573fbc212461bd1e03c364` (MIT). Koma, Vgent and the shared web portal use this common source for GitHub device login, tunnel discovery, private registration and relay lifecycle.

SHA-256: `e58a086360002a680fb74210fc5c1512191d53e4a3d0ac2da15b93a6ff473597`

Regenerate from a clean, verified source commit in the Koma repository:

```sh
node packages/remote-core/scripts/pack-node.mjs /path/to/Vgent/vendor
```

Then update this provenance and run `pnpm --filter @vgent/server update @saymiao/remote-core` in Vgent to refresh the local archive integrity. Bump the package version for later core changes. The archive includes Node ESM, TypeScript declarations, license notices and its source revision. Do not edit its generated code directly. No npm publication is involved.
