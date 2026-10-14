// Bundle the desktop app entry (src/app/main.ts) into one CommonJS file and
// write the Node single-executable-application config for it.
//
//   node scripts/bundle-app.mjs [version]
//
// Output: dist-app/rf-ranger.cjs and dist-app/sea-config.json. Then
// `node --experimental-sea-config dist-app/sea-config.json` makes the blob
// that packaging/macos/build.sh injects into a Node binary.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2] || JSON.parse(readFileSync('package.json', 'utf8')).version;
mkdirSync('dist-app', { recursive: true });

await build({
  entryPoints: ['src/app/main.ts'],
  outfile: 'dist-app/rf-ranger.cjs',
  bundle: true,
  platform: 'node',
  // Single executable apps run CommonJS; nothing in the app path uses top-level await.
  format: 'cjs',
  target: 'node22',
  // ws loads these optional native speedups in a try/catch and works without them.
  external: ['bufferutil', 'utf-8-validate'],
  define: { 'process.env.RF_RANGER_VERSION': JSON.stringify(version) },
  legalComments: 'eof',
  logLevel: 'info',
});

writeFileSync(
  'dist-app/sea-config.json',
  JSON.stringify(
    {
      main: 'dist-app/rf-ranger.cjs',
      output: 'dist-app/sea-prep.blob',
      disableExperimentalSEAWarning: true,
      // Without a code cache or snapshot the blob isn't tied to one CPU, so a
      // single blob serves both the arm64 and x64 halves of the universal binary.
      useCodeCache: false,
      useSnapshot: false,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Bundled RF Ranger ${version}`);
