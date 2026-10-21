import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
// Compile with tsc first: Nest depends on emitted decorator metadata.
await mkdir('dist/runtime',{recursive:true});
const result=await build({
 entryPoints:{api:'dist/server/apps/api/src/main.js',runner:'dist/server/apps/runner/src/main.js',migrate:'dist/server/apps/api/src/migrate.js',bootstrap:'scripts/setup-admin.mjs'},
 outdir:'dist/runtime',outExtension:{'.js':'.mjs'},bundle:true,packages:'external',
 platform:'node',format:'esm',target:'node22',keepNames:true,
 minifyWhitespace:true,minifySyntax:true,legalComments:'none',sourcemap:false,metafile:true,
});
// Build evidence stays outside the runtime images.
await writeFile('dist/runtime/manifest.json',JSON.stringify(result.metafile.outputs,null,2)+'\n');
console.log('Runtime compilato: api.mjs, runner.mjs, migrate.mjs, bootstrap.mjs (senza sorgenti o source map).');
