// Lets a plain `node --experimental-transform-types` child process import the SDK's TypeScript
// sources, whose relative imports name the emitted `.js` files.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND" || !/^\.\.?\/.*\.js$/.test(specifier)) throw error;
      return next(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});
