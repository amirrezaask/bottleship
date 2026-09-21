import { IModule } from '../core/module';
import { Process } from '../core/process';
import { ThunkImplementation } from '../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../core/logger';

/**
 * Browser-safe replacement for Midtown Madness 2's installer-era EULA helper.
 * The title is already user-launched from GameBox, so there is no desktop EULA
 * window to show; returning TRUE follows the helper's accepted path.
 */
export class EBUEula implements IModule {
    name = 'ebueula';
    exports: Record<string, ThunkImplementation> = {};

    initialize(_process: Process): void {
        this.exports.EBUEula = () => {
            Logger.log(LogCategory.SYSTEM, 'EBUEula: accepted GameBox launch');
            return 1;
        };
    }
}
