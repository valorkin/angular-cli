/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { BuilderContext, BuilderOutput, createBuilder } from '@angular-devkit/architect';
import { EmittedFiles, WebpackLoggingCallback, runWebpack } from '@angular-devkit/build-webpack';
import { getSystemPath, join, json, normalize, resolve, tags, virtualFs } from '@angular-devkit/core';
import { NodeJsSyncHost } from '@angular-devkit/core/node';
import * as fs from 'fs';
import * as ora from 'ora';
import * as path from 'path';
import { Observable, from } from 'rxjs';
import { concatMap, map, switchMap } from 'rxjs/operators';
import { ScriptTarget } from 'typescript';
import * as webpack from 'webpack';
import { ExecutionTransformer } from '../transforms';
import {
  BuildBrowserFeatures,
  deleteOutputDir,
  normalizeAssetPatterns,
  normalizeOptimization,
  normalizeSourceMaps,
  urlJoin,
} from '../utils';
import { BundleActionExecutor } from '../utils/action-executor';
import { WebpackConfigOptions } from '../utils/build-options';
import { ThresholdSeverity, checkBudgets } from '../utils/bundle-calculator';
import { findCachePath } from '../utils/cache-path';
import { colors } from '../utils/color';
import { copyAssets } from '../utils/copy-assets';
import { cachingDisabled } from '../utils/environment-options';
import { i18nInlineEmittedFiles } from '../utils/i18n-inlining';
import { I18nOptions } from '../utils/i18n-options';
import {
  IndexHtmlTransform,
  writeIndexHtml,
} from '../utils/index-file/write-index-html';
import { ensureOutputPaths } from '../utils/output-paths';
import {
  InlineOptions,
  ProcessBundleFile,
  ProcessBundleOptions,
  ProcessBundleResult,
} from '../utils/process-bundle';
import { readTsconfig } from '../utils/read-tsconfig';
import { augmentAppWithServiceWorker } from '../utils/service-worker';
import { assertCompatibleAngularVersion } from '../utils/version';
import {
  BrowserWebpackConfigOptions,
  generateI18nBrowserWebpackConfigFromContext,
  getIndexInputFile,
  getIndexOutputFile,
} from '../utils/webpack-browser-config';
import {
  getAotConfig,
  getBrowserConfig,
  getCommonConfig,
  getNonAotConfig,
  getStatsConfig,
  getStylesConfig,
  getWorkerConfig,
  normalizeExtraEntryPoints,
} from '../webpack/configs';
import { NgBuildAnalyticsPlugin } from '../webpack/plugins/analytics';
import { markAsyncChunksNonInitial } from '../webpack/utils/async-chunks';
import {
  BundleStats,
  createWebpackLoggingCallback,
  generateBuildStats,
  generateBuildStatsTable,
  generateBundleStats,
  statsErrorsToString,
  statsHasErrors,
  statsHasWarnings,
  statsWarningsToString,
} from '../webpack/utils/stats';
import { Schema as BrowserBuilderSchema } from './schema';

const cacheDownlevelPath = cachingDisabled ? undefined : findCachePath('angular-build-dl');

export type BrowserBuilderOutput = json.JsonObject &
  BuilderOutput & {
    baseOutputPath: string;
    outputPaths: string[];
    /**
     * @deprecated in version 9. Use 'outputPaths' instead.
     */
    outputPath: string;
  };

// todo: the below should be cleaned once dev-server support the new i18n
interface ConfigFromContextReturn {
  config: webpack.Configuration;
  projectRoot: string;
  projectSourceRoot?: string;
  i18n: I18nOptions;
}

export async function buildBrowserWebpackConfigFromContext(
  options: BrowserBuilderSchema,
  context: BuilderContext,
  host: virtualFs.Host<fs.Stats> = new NodeJsSyncHost(),
  differentialLoadingMode = false,
): Promise<ConfigFromContextReturn> {
  const webpackPartialGenerator = (wco: BrowserWebpackConfigOptions) => [
    getCommonConfig(wco),
    getBrowserConfig(wco),
    getStylesConfig(wco),
    getStatsConfig(wco),
    getAnalyticsConfig(wco, context),
    getCompilerConfig(wco),
    wco.buildOptions.webWorkerTsConfig ? getWorkerConfig(wco) : {},
  ];

  return generateI18nBrowserWebpackConfigFromContext(
    options,
    context,
    webpackPartialGenerator,
    host,
    differentialLoadingMode,
  );
}

function getAnalyticsConfig(
  wco: WebpackConfigOptions,
  context: BuilderContext,
): webpack.Configuration {
  if (context.analytics) {
    // If there's analytics, add our plugin. Otherwise no need to slow down the build.
    let category = 'build';
    if (context.builder) {
      // We already vetted that this is a "safe" package, otherwise the analytics would be noop.
      category =
        context.builder.builderName.split(':')[1] || context.builder.builderName || 'build';
    }

    // The category is the builder name if it's an angular builder.
    return {
      plugins: [new NgBuildAnalyticsPlugin(
        wco.projectRoot,
        context.analytics,
        category,
        !!wco.tsConfig.options.enableIvy,
      )],
    };
  }

  return {};
}

function getCompilerConfig(wco: WebpackConfigOptions): webpack.Configuration {
  if (wco.buildOptions.main || wco.buildOptions.polyfills) {
    return wco.buildOptions.aot ? getAotConfig(wco) : getNonAotConfig(wco);
  }

  return {};
}

async function initialize(
  options: BrowserBuilderSchema,
  context: BuilderContext,
  host: virtualFs.Host<fs.Stats>,
  differentialLoadingMode: boolean,
  webpackConfigurationTransform?: ExecutionTransformer<webpack.Configuration>,
): Promise<{
  config: webpack.Configuration;
  projectRoot: string;
  projectSourceRoot?: string;
  i18n: I18nOptions;
}> {
  const originalOutputPath = options.outputPath;

  // Assets are processed directly by the builder except when watching
  const adjustedOptions = options.watch ? options : { ...options, assets: [] };

  const {
    config,
    projectRoot,
    projectSourceRoot,
    i18n,
  } = await buildBrowserWebpackConfigFromContext(adjustedOptions, context, host, differentialLoadingMode);

  // Validate asset option values if processed directly
  if (options.assets?.length && !adjustedOptions.assets?.length) {
    normalizeAssetPatterns(
      options.assets,
      new virtualFs.SyncDelegateHost(host),
      normalize(context.workspaceRoot),
      normalize(projectRoot),
      projectSourceRoot === undefined ? undefined : normalize(projectSourceRoot),
    ).forEach(({ output }) => {
      if (output.startsWith('..')) {
        throw new Error('An asset cannot be written to a location outside of the output path.');
      }
    });
  }

  let transformedConfig;
  if (webpackConfigurationTransform) {
    transformedConfig = await webpackConfigurationTransform(config);
  }

  if (options.deleteOutputPath) {
    deleteOutputDir(context.workspaceRoot, originalOutputPath);
  }

  return { config: transformedConfig || config, projectRoot, projectSourceRoot, i18n };
}

// tslint:disable-next-line: no-big-function
export function buildWebpackBrowser(
  options: BrowserBuilderSchema,
  context: BuilderContext,
  transforms: {
    webpackConfiguration?: ExecutionTransformer<webpack.Configuration>;
    logging?: WebpackLoggingCallback;
    indexHtml?: IndexHtmlTransform;
  } = {},
): Observable<BrowserBuilderOutput> {
  const host = new NodeJsSyncHost();
  const root = normalize(context.workspaceRoot);

  const projectName = context.target?.project;
  if (!projectName) {
    throw new Error('The builder requires a target.');
  }

  const baseOutputPath = path.resolve(context.workspaceRoot, options.outputPath);
  let outputPaths: undefined | Map<string, string>;

  // Check Angular version.
  assertCompatibleAngularVersion(context.workspaceRoot, context.logger);

  return from(context.getProjectMetadata(projectName))
    .pipe(
      switchMap(async projectMetadata => {
        const sysProjectRoot = getSystemPath(
          resolve(normalize(context.workspaceRoot),
          normalize((projectMetadata.root as string) ?? '')),
        );

        const { options: compilerOptions } = readTsconfig(options.tsConfig, context.workspaceRoot);
        const target = compilerOptions.target || ScriptTarget.ES5;
        const buildBrowserFeatures = new BuildBrowserFeatures(sysProjectRoot);
        const isDifferentialLoadingNeeded = buildBrowserFeatures.isDifferentialLoadingNeeded(target);
        const differentialLoadingMode = !options.watch && isDifferentialLoadingNeeded;

        if (target > ScriptTarget.ES2015 && isDifferentialLoadingNeeded) {
          context.logger.warn(tags.stripIndent`
          WARNING: Using differential loading with targets ES5 and ES2016 or higher may
          cause problems. Browsers with support for ES2015 will load the ES2016+ scripts
          referenced with script[type="module"] but they may not support ES2016+ syntax.
        `);
        }

        const hasIE9 = buildBrowserFeatures.supportedBrowsers.includes('ie 9');
        const hasIE10 = buildBrowserFeatures.supportedBrowsers.includes('ie 10');
        if (hasIE9 || hasIE10) {
          const browsers =
            (hasIE9 ? 'IE 9' + (hasIE10 ? ' & ' : '') : '') + (hasIE10 ? 'IE 10' : '');
          context.logger.warn(
            `WARNING: Support was requested for ${browsers} in the project's browserslist configuration. ` +
              (hasIE9 && hasIE10 ? 'These browsers are' : 'This browser is') +
              ' no longer officially supported with Angular v11 and higher.' +
              '\nFor additional information: https://v10.angular.io/guide/deprecations#ie-9-10-and-mobile',
          );
        }

        return {
          ...(await initialize(options, context, host, differentialLoadingMode, transforms.webpackConfiguration)),
          buildBrowserFeatures,
          isDifferentialLoadingNeeded,
          target,
        };
      }),
      // tslint:disable-next-line: no-big-function
      switchMap(({ config, projectRoot, projectSourceRoot, i18n, buildBrowserFeatures, isDifferentialLoadingNeeded, target }) => {
        const useBundleDownleveling = isDifferentialLoadingNeeded && !options.watch;
        const startTime = Date.now();

        return runWebpack(config, context, {
          webpackFactory: require('webpack') as typeof webpack,
          logging:
            transforms.logging ||
            (useBundleDownleveling
              ? () => { }
              : createWebpackLoggingCallback(!!options.verbose, context.logger)),
        }).pipe(
          // tslint:disable-next-line: no-big-function
          concatMap(async buildEvent => {
            const { webpackStats: webpackRawStats, success, emittedFiles = [] } = buildEvent;
            if (!webpackRawStats) {
              throw new Error('Webpack stats build result is required.');
            }

            // Fix incorrectly set `initial` value on chunks.
            const extraEntryPoints = normalizeExtraEntryPoints(options.styles || [], 'styles')
              .concat(normalizeExtraEntryPoints(options.scripts || [], 'scripts'));
            const webpackStats = {
              ...webpackRawStats,
              chunks: markAsyncChunksNonInitial(webpackRawStats, extraEntryPoints),
            };

            if (!success && useBundleDownleveling) {
              // If using bundle downleveling then there is only one build
              // If it fails show any diagnostic messages and bail
              if (statsHasWarnings(webpackStats)) {
                context.logger.warn(statsWarningsToString(webpackStats, { colors: true }));
              }
              if (statsHasErrors(webpackStats)) {
                context.logger.error(statsErrorsToString(webpackStats, { colors: true }));
              }

              return { success };
            } else if (success) {
              outputPaths = ensureOutputPaths(baseOutputPath, i18n);

              let noModuleFiles: EmittedFiles[] | undefined;
              let moduleFiles: EmittedFiles[] | undefined;
              let files: EmittedFiles[] | undefined;

              const scriptsEntryPointName = normalizeExtraEntryPoints(
                options.scripts || [],
                'scripts',
              ).map(x => x.bundleName);

              if (isDifferentialLoadingNeeded && options.watch) {
                moduleFiles = emittedFiles;
                files = moduleFiles.filter(
                  x => x.extension === '.css' || (x.name && scriptsEntryPointName.includes(x.name)),
                );
                if (i18n.shouldInline) {
                  const success = await i18nInlineEmittedFiles(
                    context,
                    emittedFiles,
                    i18n,
                    baseOutputPath,
                    Array.from(outputPaths.values()),
                    scriptsEntryPointName,
                    // tslint:disable-next-line: no-non-null-assertion
                    webpackStats.outputPath!,
                    target <= ScriptTarget.ES5,
                    options.i18nMissingTranslation,
                  );
                  if (!success) {
                    return { success: false };
                  }
                }
              } else if (isDifferentialLoadingNeeded) {
                moduleFiles = [];
                noModuleFiles = [];

                // Common options for all bundle process actions
                const sourceMapOptions = normalizeSourceMaps(options.sourceMap || false);
                const actionOptions: Partial<ProcessBundleOptions> = {
                  optimize: normalizeOptimization(options.optimization).scripts,
                  sourceMaps: sourceMapOptions.scripts,
                  hiddenSourceMaps: sourceMapOptions.hidden,
                  vendorSourceMaps: sourceMapOptions.vendor,
                  integrityAlgorithm: options.subresourceIntegrity ? 'sha384' : undefined,
                };

                let mainChunkId;
                const actions: ProcessBundleOptions[] = [];
                let workerReplacements: [string, string][] | undefined;
                const seen = new Set<string>();
                for (const file of emittedFiles) {
                  // Assets are not processed nor injected into the index
                  if (file.asset) {
                    // WorkerPlugin adds worker files to assets
                    if (file.file.endsWith('.worker.js')) {
                      if (!workerReplacements) {
                        workerReplacements = [];
                      }
                      workerReplacements.push([
                        file.file,
                        file.file.replace(/\-(es20\d{2}|esnext)/, '-es5'),
                      ]);
                    } else {
                      continue;
                    }
                  }

                  // Scripts and non-javascript files are not processed
                  if (
                    file.extension !== '.js' ||
                    (file.name && scriptsEntryPointName.includes(file.name))
                  ) {
                    if (files === undefined) {
                      files = [];
                    }
                    files.push(file);
                    continue;
                  }

                  // Ignore already processed files; emittedFiles can contain duplicates
                  if (seen.has(file.file)) {
                    continue;
                  }
                  seen.add(file.file);

                  if (file.name === 'vendor' || (!mainChunkId && file.name === 'main')) {
                    // tslint:disable-next-line: no-non-null-assertion
                    mainChunkId = file.id!.toString();
                  }

                  // All files at this point except ES5 polyfills are module scripts
                  const es5Polyfills = file.file.startsWith('polyfills-es5');
                  if (!es5Polyfills) {
                    moduleFiles.push(file);
                  }

                  // Retrieve the content/map for the file
                  // NOTE: Additional future optimizations will read directly from memory
                  // tslint:disable-next-line: no-non-null-assertion
                  let filename = path.join(webpackStats.outputPath!, file.file);
                  const code = fs.readFileSync(filename, 'utf8');
                  let map;
                  if (actionOptions.sourceMaps) {
                    try {
                      map = fs.readFileSync(filename + '.map', 'utf8');
                      if (es5Polyfills) {
                        fs.unlinkSync(filename + '.map');
                      }
                    } catch { }
                  }

                  if (es5Polyfills) {
                    fs.unlinkSync(filename);
                    filename = filename.replace(/\-es20\d{2}/, '');
                  }

                  const es2015Polyfills = file.file.startsWith('polyfills-es20');

                  // Record the bundle processing action
                  // The runtime chunk gets special processing for lazy loaded files
                  actions.push({
                    ...actionOptions,
                    filename,
                    code,
                    map,
                    // id is always present for non-assets
                    // tslint:disable-next-line: no-non-null-assertion
                    name: file.id!,
                    runtime: file.file.startsWith('runtime'),
                    ignoreOriginal: es5Polyfills,
                    optimizeOnly: es2015Polyfills,
                  });

                  // ES2015 polyfills are only optimized; optimization check was performed above
                  if (es2015Polyfills) {
                    continue;
                  }

                  // Add the newly created ES5 bundles to the index as nomodule scripts
                  const newFilename = es5Polyfills
                    ? file.file.replace(/\-es20\d{2}/, '')
                    : file.file.replace(/\-(es20\d{2}|esnext)/, '-es5');
                  noModuleFiles.push({ ...file, file: newFilename });
                }

                const processActions: typeof actions = [];
                let processRuntimeAction: ProcessBundleOptions | undefined;
                const processResults: ProcessBundleResult[] = [];
                for (const action of actions) {
                  // If SRI is enabled always process the runtime bundle
                  // Lazy route integrity values are stored in the runtime bundle
                  if (action.integrityAlgorithm && action.runtime) {
                    processRuntimeAction = action;
                  } else {
                    processActions.push({ replacements: workerReplacements, ...action });
                  }
                }

                const executor = new BundleActionExecutor(
                  { cachePath: cacheDownlevelPath, i18n },
                  options.subresourceIntegrity ? 'sha384' : undefined,
                );

                // Execute the bundle processing actions
                try {
                  const dlSpinner = ora('Generating ES5 bundles for differential loading...').start();
                  for await (const result of executor.processAll(processActions)) {
                    processResults.push(result);
                  }

                  // Runtime must be processed after all other files
                  if (processRuntimeAction) {
                    const runtimeOptions = {
                      ...processRuntimeAction,
                      runtimeData: processResults,
                      supportedBrowsers: buildBrowserFeatures.supportedBrowsers,
                    };
                    processResults.push(
                      await import('../utils/process-bundle').then(m => m.process(runtimeOptions)),
                    );
                  }

                  dlSpinner.succeed('ES5 bundle generation complete.');

                  if (i18n.shouldInline) {
                    const spinner = ora('Generating localized bundles...').start();

                    const inlineActions: InlineOptions[] = [];
                    const processedFiles = new Set<string>();
                    for (const result of processResults) {
                      if (result.original) {
                        inlineActions.push({
                          filename: path.basename(result.original.filename),
                          code: fs.readFileSync(result.original.filename, 'utf8'),
                          map:
                            result.original.map &&
                            fs.readFileSync(result.original.map.filename, 'utf8'),
                          outputPath: baseOutputPath,
                          es5: false,
                          missingTranslation: options.i18nMissingTranslation,
                          setLocale: result.name === mainChunkId,
                        });
                        processedFiles.add(result.original.filename);
                        if (result.original.map) {
                          processedFiles.add(result.original.map.filename);
                        }
                      }
                      if (result.downlevel) {
                        inlineActions.push({
                          filename: path.basename(result.downlevel.filename),
                          code: fs.readFileSync(result.downlevel.filename, 'utf8'),
                          map:
                            result.downlevel.map &&
                            fs.readFileSync(result.downlevel.map.filename, 'utf8'),
                          outputPath: baseOutputPath,
                          es5: true,
                          missingTranslation: options.i18nMissingTranslation,
                          setLocale: result.name === mainChunkId,
                        });
                        processedFiles.add(result.downlevel.filename);
                        if (result.downlevel.map) {
                          processedFiles.add(result.downlevel.map.filename);
                        }
                      }
                    }

                    let hasErrors = false;
                    try {
                      for await (const result of executor.inlineAll(inlineActions)) {
                        if (options.verbose) {
                          context.logger.info(
                            `Localized "${result.file}" [${result.count} translation(s)].`,
                          );
                        }
                        for (const diagnostic of result.diagnostics) {
                          spinner.stop();
                          if (diagnostic.type === 'error') {
                            hasErrors = true;
                            context.logger.error(diagnostic.message);
                          } else {
                            context.logger.warn(diagnostic.message);
                          }
                          spinner.start();
                        }
                      }

                      // Copy any non-processed files into the output locations
                      await copyAssets(
                        [
                          {
                            glob: '**/*',
                            // tslint:disable-next-line: no-non-null-assertion
                            input: webpackStats.outputPath!,
                            output: '',
                            ignore: [...processedFiles].map(f =>
                              // tslint:disable-next-line: no-non-null-assertion
                              path.relative(webpackStats.outputPath!, f),
                            ),
                          },
                        ],
                        Array.from(outputPaths.values()),
                        '',
                      );
                    } catch (err) {
                      spinner.fail(colors.redBright('Localized bundle generation failed.'));

                      return { success: false, error: mapErrorToMessage(err) };
                    }

                    if (hasErrors) {
                      spinner.fail(colors.redBright('Localized bundle generation failed.'));
                    } else {
                      spinner.succeed('Localized bundle generation complete.');
                    }

                    if (hasErrors) {
                      return { success: false };
                    }
                  }
                } finally {
                  executor.stop();
                }

                type ArrayElement<A> = A extends ReadonlyArray<infer T> ? T : never;
                function generateBundleInfoStats(
                  bundle: ProcessBundleFile,
                  chunk: ArrayElement<webpack.Stats.ToJsonOutput['chunks']> | undefined,
                ): BundleStats {
                  return generateBundleStats(
                    {
                      size: bundle.size,
                      files: bundle.map ? [bundle.filename, bundle.map.filename] : [bundle.filename],
                      names: chunk?.names,
                      entry: !!chunk?.names.includes('runtime'),
                      initial: !!chunk?.initial,
                      rendered: true,
                    },
                    true,
                  );
                }

                const bundleInfoStats: BundleStats[] = [];
                for (const result of processResults) {
                  const chunk = webpackStats.chunks?.find((chunk) => chunk.id.toString() === result.name);

                  if (result.original) {
                    bundleInfoStats.push(generateBundleInfoStats(result.original, chunk));
                  }

                  if (result.downlevel) {
                    bundleInfoStats.push(generateBundleInfoStats(result.downlevel, chunk));
                  }
                }

                const unprocessedChunks = webpackStats.chunks?.filter((chunk) => !processResults
                  .find((result) => chunk.id.toString() === result.name),
                ) || [];
                for (const chunk of unprocessedChunks) {
                  const asset = webpackStats.assets?.find(a => a.name === chunk.files[0]);
                  bundleInfoStats.push(generateBundleStats({ ...chunk, size: asset?.size }, true));
                }

                context.logger.info(
                  '\n' +
                  generateBuildStatsTable(bundleInfoStats, colors.enabled) +
                  '\n\n' +
                  generateBuildStats(
                    webpackStats?.hash || '<unknown>',
                    Date.now() - startTime,
                    true,
                  ),
                );

                // Check for budget errors and display them to the user.
                const budgets = options.budgets || [];
                const budgetFailures = checkBudgets(budgets, webpackStats, processResults);
                for (const { severity, message } of budgetFailures) {
                  const msg = `budgets: ${message}`;
                  switch (severity) {
                    case ThresholdSeverity.Warning:
                      webpackStats.warnings.push(msg);
                      break;
                    case ThresholdSeverity.Error:
                      webpackStats.errors.push(msg);
                      break;
                    default:
                      assertNever(severity);
                  }
                }

                if (statsHasWarnings(webpackStats)) {
                  context.logger.warn(statsWarningsToString(webpackStats, { colors: true }));
                }
                if (statsHasErrors(webpackStats)) {
                  context.logger.error(statsErrorsToString(webpackStats, { colors: true }));

                  return { success: false };
                }
              } else {
                files = emittedFiles.filter(x => x.name !== 'polyfills-es5');
                noModuleFiles = emittedFiles.filter(x => x.name === 'polyfills-es5');
                if (i18n.shouldInline) {
                  const success = await i18nInlineEmittedFiles(
                    context,
                    emittedFiles,
                    i18n,
                    baseOutputPath,
                    Array.from(outputPaths.values()),
                    scriptsEntryPointName,
                    // tslint:disable-next-line: no-non-null-assertion
                    webpackStats.outputPath!,
                    target <= ScriptTarget.ES5,
                    options.i18nMissingTranslation,
                  );
                  if (!success) {
                    return { success: false };
                  }
                }
              }

              // Copy assets
              if (!options.watch && options.assets?.length) {
                try {
                  await copyAssets(
                    normalizeAssetPatterns(
                      options.assets,
                      new virtualFs.SyncDelegateHost(host),
                      root,
                      normalize(projectRoot),
                      projectSourceRoot === undefined ? undefined : normalize(projectSourceRoot),
                    ),
                    Array.from(outputPaths.values()),
                    context.workspaceRoot,
                  );
                } catch (err) {
                  return { success: false, error: 'Unable to copy assets: ' + err.message };
                }
              }

              for (const [locale, outputPath] of outputPaths.entries()) {
                let localeBaseHref;
                if (i18n.locales[locale] && i18n.locales[locale].baseHref !== '') {
                  localeBaseHref = urlJoin(
                    options.baseHref || '',
                    i18n.locales[locale].baseHref ?? `/${locale}/`,
                  );
                }

                try {
                  if (options.index) {
                    await generateIndex(
                      outputPath,
                      options,
                      root,
                      files,
                      noModuleFiles,
                      moduleFiles,
                      transforms.indexHtml,
                      // i18nLocale is used when Ivy is disabled
                      locale || options.i18nLocale,
                      localeBaseHref || options.baseHref,
                    );
                  }

                  if (options.serviceWorker) {
                    await augmentAppWithServiceWorker(
                      host,
                      root,
                      normalize(projectRoot),
                      normalize(outputPath),
                      localeBaseHref || options.baseHref || '/',
                      options.ngswConfigPath,
                    );
                  }
                } catch (err) {
                  return { success: false, error: mapErrorToMessage(err) };
                }
              }
            }

            return { success };
          }),
          map(
            event =>
              ({
                ...event,
                baseOutputPath,
                outputPath: baseOutputPath,
                outputPaths: outputPaths && Array.from(outputPaths.values()) || [baseOutputPath],
              } as BrowserBuilderOutput),
          ),
        );
    }),
  );
}

function generateIndex(
  baseOutputPath: string,
  options: BrowserBuilderSchema,
  root: string,
  files: EmittedFiles[] | undefined,
  noModuleFiles: EmittedFiles[] | undefined,
  moduleFiles: EmittedFiles[] | undefined,
  transformer?: IndexHtmlTransform,
  locale?: string,
  baseHref?: string,
): Promise<void> {
  const host = new NodeJsSyncHost();

  return writeIndexHtml({
    host,
    outputPath: join(normalize(baseOutputPath), getIndexOutputFile(options)),
    indexPath: join(normalize(root), getIndexInputFile(options)),
    files,
    noModuleFiles,
    moduleFiles,
    baseHref,
    deployUrl: options.deployUrl,
    sri: options.subresourceIntegrity,
    scripts: options.scripts,
    styles: options.styles,
    postTransform: transformer,
    crossOrigin: options.crossOrigin,
    lang: locale,
  }).toPromise();
}

function mapErrorToMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return undefined;
}

function assertNever(input: never): never {
  throw new Error(`Unexpected call to assertNever() with input: ${
      JSON.stringify(input, null /* replacer */, 4 /* tabSize */)}`);
}

export default createBuilder<json.JsonObject & BrowserBuilderSchema>(buildWebpackBrowser);
