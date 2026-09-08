// Auto-generated index for kernel32 module
// This file aggregates all atomic implementations
// Generated from directory scan: src/worker/modules/kernel32

import { IModule } from '../../core/module';
import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';

import { exports as atom } from './atom';
import { exports as fls } from './fls';
import { exports as locale } from './locale';
import { exports as environment } from './environment';
import { exports as module } from './module/module';
import { exports as vista_runtime } from './vista-runtime';
import { exports as file_io } from './file-io';
import { exports as tls } from './tls';
import { exports as time } from './time/time';
import { exports as resource } from './resource';
import { exports as profile } from './profile';
import { exports as util } from './util';
import { exports as memory } from './memory';
import { exports as command } from './command/command';
import { exports as error } from './error';
import { exports as exception } from './exception';
import { exports as sync } from './sync';
import { exports as process_ } from './process/process';

export class Kernel32 implements IModule {
    name = 'kernel32';
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        // atom functions
        Object.assign(this.exports, atom);
        // fls functions
        Object.assign(this.exports, fls);
        // locale functions
        Object.assign(this.exports, locale);
        // environment functions
        Object.assign(this.exports, environment);
        // module functions
        Object.assign(this.exports, module);
        // vista-runtime functions
        Object.assign(this.exports, vista_runtime);
        // file-io functions
        Object.assign(this.exports, file_io);
        // tls functions
        Object.assign(this.exports, tls);
        // time functions
        Object.assign(this.exports, time);
        // resource functions
        Object.assign(this.exports, resource);
        // profile functions
        Object.assign(this.exports, profile);
        // util functions
        Object.assign(this.exports, util);
        // memory functions
        Object.assign(this.exports, memory);
        // command functions
        Object.assign(this.exports, command);
        // error functions
        Object.assign(this.exports, error);
        // exception functions
        Object.assign(this.exports, exception);
        // sync functions
        Object.assign(this.exports, sync);
        // process functions
        Object.assign(this.exports, process_);
    }
}