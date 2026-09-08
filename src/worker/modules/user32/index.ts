// Auto-generated index for user32 module
// This file aggregates all atomic implementations
// Generated from directory scan: src/worker/modules/user32

import { IModule } from '../../core/module';
import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';

import { createInputExports as input } from './input';
import { createClassExports as class_ } from './class';
import { createMenuExports as menu } from './menu';
import { createMessageExports as message, registerFastPathMessageFunctions as registerFastPathmessage } from './message';
import { createDialogExports as dialog } from './dialog';
import { createWindowExports as window } from './window';
import { createSystemExports as system } from './system';
import { resetUser32SharedState } from './shared-state';

export class User32 implements IModule {
    name = 'user32';
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        // input functions
        Object.assign(this.exports, input());
        // class functions
        Object.assign(this.exports, class_());
        // menu functions
        Object.assign(this.exports, menu());
        // message functions
        Object.assign(this.exports, message());
        registerFastPathmessage(process.dispatcher);
        // dialog functions
        Object.assign(this.exports, dialog());
        // window functions
        Object.assign(this.exports, window());
        // system functions
        Object.assign(this.exports, system());
    }

    reset(): void {
        resetUser32SharedState();
    }
}