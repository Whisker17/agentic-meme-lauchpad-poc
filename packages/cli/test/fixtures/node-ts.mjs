// Lets a plain `node --experimental-transform-types` process run the CLI from its TypeScript
// sources without a build: relative `.js` imports load the `.ts` file (the SDK's hook) and
// `@0xwh1sker/mantle-meme-sdk` loads the SDK's sources, as the vitest alias does.
import { registerHooks } from "node:module";
import "../../../sdk/test/fixtures/node-ts.mjs";

const sdk = new URL("../../../sdk/src/index.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@0xwh1sker/mantle-meme-sdk") return { url: sdk, shortCircuit: true };
    return next(specifier, context);
  },
});
