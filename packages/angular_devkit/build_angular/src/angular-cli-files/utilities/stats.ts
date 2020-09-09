/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
// tslint:disable
// TODO: cleanup this file, it's copied as is from Angular CLI.
import { tags, terminal } from '@angular-devkit/core';
import * as path from 'path';


const { bold, green, red, reset, white, yellow } = terminal;

export function formatSize(size: number): string {
  if (size <= 0) {
    return '0 bytes';
  }

  const abbreviations = ['bytes', 'kB', 'MB', 'GB'];
  const index = Math.floor(Math.log(size) / Math.log(1024));

  return `${+(size / Math.pow(1024, index)).toPrecision(3)} ${abbreviations[index]}`;
}

export function generateBundleStats(
  info: {
    id: string | number;
    size?: number;
    files: string[];
    names?: string[];
    entry: boolean;
    initial: boolean;
    rendered?: boolean;
  },
  colors: boolean,
): string {
  const g = (x: string) => (colors ? bold(green(x)) : x);
  const y = (x: string) => (colors ? bold(yellow(x)) : x);

  const id = info.id ? y(info.id.toString()) : '';
  const size = typeof info.size === 'number' ? ` ${formatSize(info.size)}` : '';
  const files = info.files.map(f => path.basename(f)).join(', ');
  const names = info.names ? ` (${info.names.join(', ')})` : '';
  const initial = y(info.entry ? '[entry]' : info.initial ? '[initial]' : '');
  const flags = ['rendered', 'recorded']
    .map(f => (f && (info as any)[f] ? g(` [${f}]`) : ''))
    .join('');

  return `chunk {${id}} ${g(files)}${names}${size} ${initial}${flags}`;
}

export function generateBuildStats(hash: string, time: number, colors: boolean): string {
  const w = (x: string) => colors ? bold(white(x)) : x;
  return `Date: ${w(new Date().toISOString())} - Hash: ${w(hash)} - Time: ${w('' + time)}ms`
}

export function statsToString(json: any, statsConfig: any) {
  const colors = statsConfig.colors;
  const rs = (x: string) => colors ? reset(x) : x;
  const w = (x: string) => colors ? bold(white(x)) : x;

  const changedChunksStats = json.chunks
    .filter((chunk: any) => chunk.rendered)
    .map((chunk: any) => {
      const assets = json.assets.filter((asset: any) => chunk.files.indexOf(asset.name) != -1);
      const summedSize = assets.filter((asset: any) => !asset.name.endsWith(".map")).reduce((total: number, asset: any) => { return total + asset.size }, 0);
      return generateBundleStats({ ...chunk, size: summedSize }, colors);
    });

  const unchangedChunkNumber = json.chunks.length - changedChunksStats.length;

  if (unchangedChunkNumber > 0) {
    return '\n' + rs(tags.stripIndents`
      Date: ${w(new Date().toISOString())} - Hash: ${w(json.hash)}
      ${unchangedChunkNumber} unchanged chunks
      ${changedChunksStats.join('\n')}
      Time: ${w('' + json.time)}ms
      `);
  } else {
    return '\n' + rs(tags.stripIndents`
      ${changedChunksStats.join('\n')}
      Date: ${w(new Date().toISOString())} - Hash: ${w(json.hash)} - Time: ${w('' + json.time)}ms
      `);
  }
}

// TODO(#16193): Don't emit this warning in the first place rather than just suppressing it.
const ERRONEOUS_WARNINGS_FILTER = (warning: string) => ![
  /multiple assets emit different content.*3rdpartylicenses\.txt/i,
].some(msg => msg.test(warning));

export function statsWarningsToString(json: any, statsConfig: any): string {
  const colors = statsConfig.colors;
  const rs = (x: string) => colors ? reset(x) : x;
  const y = (x: string) => colors ? bold(yellow(x)) : x;
  const warnings = [...json.warnings];
  if (json.children) {
    warnings.push(...json.children
      .map((c: any) => c.warnings)
      .reduce((a: string[], b: string[]) => [...a, ...b], [])
    );
  }

  return rs('\n' + warnings
    .map((warning: any) => `${warning}`)
    .filter(ERRONEOUS_WARNINGS_FILTER)
    .map((warning: string) => y(`WARNING in ${warning}`))
    .join('\n\n'));
}

export function statsErrorsToString(json: any, statsConfig: any): string {
  const colors = statsConfig.colors;
  const rs = (x: string) => colors ? reset(x) : x;
  const r = (x: string) => colors ? bold(red(x)) : x;
  const errors = [...json.errors];
  if (json.children) {
    errors.push(...json.children
      .map((c: any) => c.errors)
      .reduce((a: string[], b: string[]) => [...a, ...b], [])
    );
  }

  return rs('\n' + errors
    .map((error: any) => r(`ERROR in ${error}`))
    .join('\n\n')
  );
}

export function statsHasErrors(json: any): boolean {
  return json.errors.length || !!json.children?.some((c: any) => c.errors.length);
}

export function statsHasWarnings(json: any): boolean {
  return json.warnings.filter(ERRONEOUS_WARNINGS_FILTER).length ||
    !!json.children?.some((c: any) => c.warnings.filter(ERRONEOUS_WARNINGS_FILTER).length);
}
