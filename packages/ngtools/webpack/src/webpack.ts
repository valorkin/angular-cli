import {Stats as FsStats} from "fs";

/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
// import { InputFileSystem } from 'webpack';
interface InputFileSystem {
  readFile: (
    arg0: string,
    arg1: (arg0: NodeJS.ErrnoException, arg1: Buffer) => void
  ) => void;
  readJson?: (
    arg0: string,
    arg1: (arg0: Error | NodeJS.ErrnoException, arg1?: any) => void
  ) => void;
  readlink: (
    arg0: string,
    arg1: (arg0: NodeJS.ErrnoException, arg1: string | Buffer) => void
  ) => void;
  readdir: (
    arg0: string,
    arg1: (arg0: NodeJS.ErrnoException, arg1: string[]) => void
  ) => void;
  stat: (
    arg0: string,
    arg1: (arg0: NodeJS.ErrnoException, arg1: FsStats) => void
  ) => void;
  realpath?: (
    arg0: string,
    arg1: (arg0: NodeJS.ErrnoException, arg1: string) => void
  ) => void;
  purge?: (arg0: string) => void;
  join?: (arg0: string, arg1: string) => string;
  relative?: (arg0: string, arg1: string) => string;
  dirname?: (arg0: string) => string;
}

// Declarations for (some) Webpack types. Only what's needed.

// tslint:disable-next-line:no-any
export interface Callback<T = any> {
  (err?: Error | null, result?: T): void;
}

export interface NormalModuleFactoryRequest {
  request: string;
  // context: { issuer: string };
  context: string;
  contextInfo: { issuer: string };
  typescriptPathMapped?: boolean;
}

export interface NodeWatchFileSystemInterface {
  inputFileSystem: InputFileSystem;
  new(inputFileSystem: InputFileSystem): NodeWatchFileSystemInterface;
  // tslint:disable-next-line:no-any
  watch(files: any, dirs: any, missing: any, startTime: any, options: any, callback: any,
        // tslint:disable-next-line:no-any
        callbackUndelayed: any): any;
}
