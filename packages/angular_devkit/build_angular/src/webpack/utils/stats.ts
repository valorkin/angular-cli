/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
// tslint:disable
// TODO: cleanup this file, it's copied as is from Angular CLI.
import { logging, tags } from '@angular-devkit/core';
import { WebpackLoggingCallback } from '@angular-devkit/build-webpack';
import * as path from 'path';
import * as textTable from 'text-table';
import { colors as ansiColors, removeColor } from '../../utils/color';

export function formatSize(size: number): string {
  if (size <= 0) {
    return '0 bytes';
  }

  const abbreviations = ['bytes', 'kB', 'MB', 'GB'];
  const index = Math.floor(Math.log(size) / Math.log(1024));

  return `${+(size / Math.pow(1024, index)).toPrecision(3)} ${abbreviations[index]}`;
}

export type BundleStatsData = [files: string, names: string, size: string];

export interface BundleStats {
  initial: boolean;
  stats: BundleStatsData;
};

export function generateBundleStats(
  info: {
    size?: number;
    files: string[];
    names?: string[];
    entry: boolean;
    initial: boolean;
    rendered?: boolean;
  },
  colors: boolean,
): BundleStats {
  const g = (x: string) => (colors ? ansiColors.greenBright(x) : x);
  const c = (x: string) => (colors ? ansiColors.cyanBright(x) : x);

  const size = typeof info.size === 'number' ? formatSize(info.size) : '-';
  const files = info.files.filter(f => !f.endsWith('.map')).map(f => path.basename(f)).join(', ');
  const names = info.names?.length ? info.names.join(', ') : '-';
  const initial = !!(info.entry || info.initial);

  return {
    initial,
    stats: [g(files), names, c(size)],
  }
}

export function generateBuildStatsTable(data: BundleStats[], colors: boolean): string {
  const changedEntryChunksStats: BundleStatsData[] = [];
  const changedLazyChunksStats: BundleStatsData[] = [];
  for (const {initial, stats} of data) {
    if (initial) {
      changedEntryChunksStats.push(stats);
    } else {
      changedLazyChunksStats.push(stats);
    }
  }

  const bundleInfo: string[][] = [];

  const bold = (x: string) => colors ? ansiColors.bold(x) : x;
  const dim = (x: string) => colors ? ansiColors.dim(x) : x;

  // Entry chunks
  if (changedEntryChunksStats.length) {
    bundleInfo.push(
      ['Initial Chunk Files', 'Names', 'Size'].map(bold),
      ...changedEntryChunksStats,
    );
  }

  // Seperator
  if (changedEntryChunksStats.length && changedLazyChunksStats.length) {
    bundleInfo.push([]);
  }

  // Lazy chunks
  if (changedLazyChunksStats.length) {
    bundleInfo.push(
      ['Lazy Chunk Files', 'Names', 'Size'].map(bold),
    ...changedLazyChunksStats,
    );
  }

  return textTable(bundleInfo, {
    hsep: dim(' | '),
    stringLength: s => removeColor(s).length,
  });
}

export function generateBuildStats(hash: string, time: number, colors: boolean): string {
  const w = (x: string) => colors ? ansiColors.bold.white(x) : x;
  return `Build at: ${w(new Date().toISOString())} - Hash: ${w(hash)} - Time: ${w('' + time)}ms`;
}

export function statsToString(json: any, statsConfig: any) {
  const colors = statsConfig.colors;
  const rs = (x: string) => colors ? ansiColors.reset(x) : x;

  const changedChunksStats: BundleStats[] = [];
  for (const chunk of json.chunks) {
    if (!chunk.rendered) {
      continue;
    }

    const assets = json.assets.filter((asset: any) => chunk.files.includes(asset.name));
    const summedSize = assets.filter((asset: any) => !asset.name.endsWith(".map")).reduce((total: number, asset: any) => { return total + asset.size }, 0);
    changedChunksStats.push(generateBundleStats({ ...chunk, size: summedSize }, colors));
  }

  const unchangedChunkNumber = json.chunks.length - changedChunksStats.length;
  const statsTable = generateBuildStatsTable(changedChunksStats, colors);

  if (unchangedChunkNumber > 0) {
    return '\n' + rs(tags.stripIndents`
      ${statsTable}

      ${unchangedChunkNumber} unchanged chunks

      ${generateBuildStats(json.hash, json.time, colors)}
      `);
  } else {
    return '\n' + rs(tags.stripIndents`
      ${statsTable}

      ${generateBuildStats(json.hash, json.time, colors)}
      `);
  }
}

const ERRONEOUS_WARNINGS_FILTER = (warning: string) => ![
  // TODO(#16193): Don't emit this warning in the first place rather than just suppressing it.
  /multiple assets emit different content.*3rdpartylicenses\.txt/i,
  // Webpack 5+ has no facility to disable this warning.
  // System.import is used in @angular/core for deprecated string-form lazy routes
  /System.import\(\) is deprecated and will be removed soon/i,
].some(msg => msg.test(warning));

interface WebpackDiagnostic {
  message: string;
  file?: string;
  moduleName?: string;
  loc?: string;
}

export function statsWarningsToString(json: any, statsConfig: any): string {
  const colors = statsConfig.colors;
  const c = (x: string) => colors ? ansiColors.reset.cyan(x) : x;
  const y = (x: string) => colors ? ansiColors.reset.yellow(x) : x;
  const yb = (x: string) => colors ? ansiColors.reset.yellowBright(x) : x;

  const warnings = [...json.warnings];
  if (json.children) {
    warnings.push(...json.children
      .map((c: any) => c.warnings)
      .reduce((a: string[], b: string[]) => [...a, ...b], [])
    );
  }

  let output = '';
  for (const warning of warnings as (string | WebpackDiagnostic)[]) {
    if (typeof warning === 'string') {
      if (!ERRONEOUS_WARNINGS_FILTER(warning)) {
        continue;
      }
      output += yb(`Warning: ${warning}\n\n`);
    } else {
      if (!ERRONEOUS_WARNINGS_FILTER(warning.message)) {
          continue;
      }
      const file = warning.file || warning.moduleName;
      if (file) {
        output += c(file);
        if (warning.loc) {
          output += ':' + yb(warning.loc);
        }
        output += ' - ';
      }
      if (!/^warning/i.test(warning.message)) {
        output += y('Warning: ');
      }
      output += `${warning.message}\n\n`;
    }
  }

  if (output) {
      return '\n' + output;
  }

  return '';
}

export function statsErrorsToString(json: any, statsConfig: any): string {
  const colors = statsConfig.colors;
  const c = (x: string) => colors ? ansiColors.reset.cyan(x) : x;
  const yb = (x: string) => colors ? ansiColors.reset.yellowBright(x) : x;
  const r = (x: string) => colors ? ansiColors.reset.redBright(x) : x;

  const errors = [...json.errors];
  if (json.children) {
    errors.push(...json.children
      .map((c: any) => c.errors)
      .reduce((a: string[], b: string[]) => [...a, ...b], [])
    );
  }

  let output = '';
  for (const error of errors as (string | WebpackDiagnostic)[]) {
    if (typeof error === 'string') {
      output += r(`Error: ${error}\n\n`);
    } else {
      const file = error.file || error.moduleName;
      if (file) {
        output += c(file);
        if (error.loc) {
          output += ':' + yb(error.loc);
        }
        output += ' - ';
      }
      if (!/^error/i.test(error.message)) {
        output += r('Error: ');
      }
      output += `${error.message}\n\n`;
    }
  }

  if (output) {
      return '\n' + output;
  }

  return '';
}

export function statsHasErrors(json: any): boolean {
  return json.errors.length || !!json.children?.some((c: any) => c.errors.length);
}

export function statsHasWarnings(json: any): boolean {
  return json.warnings.filter(ERRONEOUS_WARNINGS_FILTER).length ||
    !!json.children?.some((c: any) => c.warnings.filter(ERRONEOUS_WARNINGS_FILTER).length);
}

export function createWebpackLoggingCallback(
  verbose: boolean,
  logger: logging.LoggerApi,
): WebpackLoggingCallback {
  return (stats, config) => {
    // config.stats contains our own stats settings, added during buildWebpackConfig().
    const json = stats.toJson(config.stats);
    if (verbose) {
      logger.info(stats.toString(config.stats));
    } else {
      logger.info(statsToString(json, config.stats));
    }

    if (statsHasWarnings(json)) {
      logger.warn(statsWarningsToString(json, config.stats));
    }
    if (statsHasErrors(json)) {
      logger.error(statsErrorsToString(json, config.stats));
    }
  };
}
