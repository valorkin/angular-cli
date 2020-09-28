/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import * as cssNano from 'cssnano';
import { ProcessOptions, Result } from 'postcss';
import { Compiler, compilation } from 'webpack';
import { RawSource, SourceMapSource } from 'webpack-sources';
import { addWarning } from '../../utils/webpack-diagnostics';
import { isWebpackFiveOrHigher } from '../../utils/webpack-version';

export interface OptimizeCssWebpackPluginOptions {
  sourceMap: boolean;
  test: (file: string) => boolean;
}

const PLUGIN_NAME = 'optimize-css-webpack-plugin';

function hook(
  compiler: Compiler,
  action: (
    compilation: compilation.Compilation,
    chunks: Iterable<compilation.Chunk>,
  ) => Promise<void>,
) {
  compiler.hooks.compilation.tap('optimize-css-webpack-plugin', (compilationInstance) => {
    const optimizeChunkAssets = (chunks: compilation.Chunk) => action(compilationInstance, chunks);
    if (isWebpackFiveOrHigher()) {
      // webpack 5 migration "guide"
      // https://github.com/webpack/webpack/blob/07fc554bef5930f8577f91c91a8b81791fc29746/lib/Compilation.js#L527-L532
      const stage = (compilation?.Compilation as unknown as {PROCESS_ASSETS_STAGE_OPTIMIZE: number})?.PROCESS_ASSETS_STAGE_OPTIMIZE;
      // tslint:disable-next-line: no-any
      (compilationInstance.hooks as any)
        .processAssets.tap({name: PLUGIN_NAME, stage}, optimizeChunkAssets);
    } else {
      compilationInstance.hooks.optimizeChunkAssets
        .tapPromise(PLUGIN_NAME, optimizeChunkAssets);
    }
  });
}

export class OptimizeCssWebpackPlugin {
  private readonly _options: OptimizeCssWebpackPluginOptions;

  constructor(options: Partial<OptimizeCssWebpackPluginOptions>) {
    this._options = {
      sourceMap: false,
      test: file => file.endsWith('.css'),
      ...options,
    };
  }

  apply(compiler: Compiler): void {
    hook(compiler, (compilation: compilation.Compilation, chunks: Iterable<compilation.Chunk>) => {
      const files: string[] = [...compilation.additionalChunkAssets];

      for (const chunk of chunks) {
        if (!chunk.files) {
          continue;
        }

        for (const file of chunk.files) {
          files.push(file);
        }
      }

      const actions = files
        .filter(file => this._options.test(file))
        .map(async file => {
          const asset = compilation.assets[file];
          if (!asset) {
            return;
          }

          let content: string | Buffer;
          // tslint:disable-next-line: no-any
          let map: any;
          if (this._options.sourceMap && asset.sourceAndMap) {
            const sourceAndMap = asset.sourceAndMap({});
            content = sourceAndMap.source;
            map = sourceAndMap.map;
          } else {
            content = asset.source();
          }

          if (typeof content !== 'string') {
            content = content.toString();
          }

          if (content.length === 0) {
            return;
          }

          const cssNanoOptions: cssNano.CssNanoOptions = {
            preset: ['default', {
              // Disable SVG optimizations, as this can cause optimizations which are not compatible in all browsers.
              svgo: false,
              // Disable `calc` optimizations, due to several issues. #16910, #16875, #17890
              calc: false,
            }],
          };

          const postCssOptions: ProcessOptions = {
            from: file,
            map: map && { annotation: false, prev: map },
          };

          const output = await new Promise<Result>((resolve, reject) => {
            // the last parameter is not in the typings
            // tslint:disable-next-line: no-any
            (cssNano.process as any)(content, postCssOptions, cssNanoOptions)
              .then(resolve)
              .catch(reject);
          });

          for (const { text } of output.warnings()) {
            addWarning(compilation, text);
          }

          let newSource;
          if (output.map) {
            newSource = new SourceMapSource(
              output.css,
              file,
              // tslint:disable-next-line: no-any
              output.map.toString() as any,
              content,
              map,
            );
          } else {
            newSource = new RawSource(output.css);
          }
          //TODO_WEBPACK_5 webpack-sources@2 has buffers() property, but @types\webpack-sources has to be updated
          //@ts-ignore
          compilation.assets[file] = newSource;
        });

      return Promise.all(actions).then(() => {});
    });
  }
}
